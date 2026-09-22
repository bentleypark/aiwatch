#!/usr/bin/env node
// #1381 — browser-render status.mistral.ai (Rootly) and push what it says to the Worker.
//
// Why a browser at all, and why HEADED: the page sits behind a Cloudflare MANAGED CHALLENGE. A plain
// fetch is 403 `cf-mitigated: challenge`, and so is every headless variant tried — bundled Chromium,
// full-Chromium new-headless, and the real Chrome channel. Only a headed browser gets through, which
// on a runner means `xvfb-run`. Verified end to end from a GitHub ubuntu-latest runner in run
// 34421800205: plain fetch 403, headless 403, xvfb-headed 200 with 14 uptime charts.
//
// This differs from the DeepSeek workaround (#618) it is modelled on. That page blocks on TLS
// FINGERPRINT, so any browser context clears it and `chromium.launch()` (headless) suffices there.
// Copying that launch here returns 403 every time.
//
// This script only READS and forwards. Every interpretation — timestamp parsing, the 30-day window,
// status mapping, duration, what counts as storable — lives in worker/src/parsers/rootly.ts, where
// unit tests pin it. In particular this file does NOT parse dates: the page publishes them only as
// English prose, and a second hand-written parser here would drift from the Worker's. It bounds its
// work by COUNT instead and lets the Worker decide what falls inside the window.
//
// Env:
//   WORKER_URL          — Worker origin, e.g. https://aiwatch-worker.p2c2kbf.workers.dev
//   MISTRAL_FEED_TOKEN  — Bearer token; must equal the Worker secret of the same name
//   MAX_INCIDENTS       — optional, default 80. Upper bound on incident pages read per run.
//   PACE_MS             — optional, default 700. Gap between requests; raise it if 429s appear.

const STATUS_URL = 'https://status.mistral.ai/'
// One history page covers three months. Mistral published 154 incidents across Jul 2 – Sep 4 2026,
// so at that rate a 30-day window needs ~72. This bounds a run whose page grew; whether it bounds it
// too tightly is not judged here — `rootlyWindowTruncated` measures that from each feed instead.
const DEFAULT_MAX_INCIDENTS = 80
// Gap between requests. Two paces were measured on the live page (2026-09-10): 150ms earned 429s and
// lost 3 of 93 tooltips; 700ms lost none. The Worker withholds the uptime figure on ANY loss, so the
// default is the one that was measured to lose nothing rather than a midpoint nobody tested.
const DEFAULT_PACE_MS = 700

/**
 * Retry a navigation/read with linear backoff.
 *
 * Not optional politeness: reads from this page are lossy under rate limiting, and a run without this
 * silently under-reports incidents, which reads downstream as a quieter month. The measured rates are
 * on `computeRootlyUptime` in worker/src/parsers/rootly.ts.
 */
/** An env override that must be a positive number, or the run stops. Absent falls back to the
 *  default; present-but-unusable is an operator error, and continuing would publish a feed that
 *  parses fine and means nothing. */
export function envPositiveInt(name, fallback, env = process.env) {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive number, got ${JSON.stringify(raw)}`)
  }
  return n
}

export async function withRetry(fn, { attempts = 4, delayMs = 300, sleep, rateLimitMs = 5000 } = {}) {
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  let lastErr
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (i < attempts) {
        // A 429 means "you are going too fast", so the linear backoff a timeout deserves is the wrong
        // response — it spends the next slot on another rejection. Measured: a full run (93 tooltips
        // plus incident pages) earns 429s, and those were the losses that made the uptime figure be
        // withheld. Backing off an order of magnitude further is what turns them into successes.
        const rateLimited = /\b429\b/.test(String(err?.message ?? ''))
        await wait(rateLimited ? rateLimitMs * i : delayMs * i)
      }
    }
  }
  throw lastErr
}

/**
 * One chart's DOM reading → the entry the Worker consumes.
 *
 * Extracted only so a test can see it. The shape used to be an object literal inline in the scrape
 * loop, and when `unreadBars` was added to the browser-side derivation it was not added here — so
 * the Worker's half of that guard was unit-tested and green while the field never arrived, and the
 * blind-chart state it exists to refuse stayed published as a fabricated 100%. Nothing could observe
 * the pushed shape, which is the actual defect; the missing field was the symptom.
 *
 * `chart` is what `page.evaluate` returns per `turbo-frame`; `days` and `fetched` are the tooltip
 * results accumulated around it.
 */
export function buildUptimeEntry(chart, days, fetched) {
  return {
    componentId: chart.componentId,
    barCount: chart.barCount,
    // Bars whose fill we could not read, passed through EXACTLY as the derivation reported it.
    // A `?? 0` here would convert a field the browser side failed to produce into a genuine zero
    // before `isStorableRootlyFeed` ever sees the payload — laundering, at this end, the same
    // "absent and zero are the same value" hole the gate was tightened to catch at the other end.
    // The gate refuses a non-finite `unreadBars`, so an omission fails the push loudly instead.
    unreadBars: chart.unreadBars,
    coverage: { impacted: chart.impacted.length, fetched },
    days,
  }
}

/** Build the bounded terminal diagnostic sent after EVERY runnable Action execution.
 *
 * The Worker derives `partial` from listed/fetched itself. The scraper reports only measurements it
 * made, so it cannot accidentally disagree with the ingest-side definition. A run that did not reach
 * a usable payload retains no page counters and is explicitly `unavailable` at the Worker.
 */
export function buildMistralFeedObservation(payload, delivery) {
  if (!payload?.coverage) return { delivery }
  const uptimeLostTooltips = Array.isArray(payload.uptime)
    ? payload.uptime.reduce((total, chart) => total + (chart.coverage.impacted - chart.coverage.fetched), 0)
    : 0
  return {
    delivery,
    listed: payload.coverage.listed,
    fetched: payload.coverage.fetched,
    available: payload.coverage.available,
    uptimeLostTooltips,
  }
}

/** Diagnostics are fail-soft: a failed observation must not alter or indefinitely delay the scrape. */
export async function reportMistralFeedObservation(workerUrl, token, observation, fetchImpl = fetch, timeoutMs = 10_000) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(`${workerUrl.replace(/\/+$/, '')}/api/internal/mistral-feed-observation`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(observation),
      signal: controller.signal,
    })
    if (!res.ok) console.warn(`[scrape] observation push failed: HTTP ${res.status}`)
  } catch (err) {
    console.warn(`[scrape] observation push failed: ${err?.message ?? err}`)
  } finally {
    clearTimeout(timeout)
  }
}

/** Own the terminal observation so a scraper exception cannot skip it. */
export async function runWithMistralFeedObservation(workerUrl, token, run, report = reportMistralFeedObservation) {
  const state = { payload: undefined, delivery: 'not-posted' }
  try {
    return await run(state)
  } finally {
    await report(workerUrl, token, buildMistralFeedObservation(state.payload, state.delivery))
  }
}

/**
 * Status words this reader accepts. A row whose text matches none of them yields `{name: null,
 * status: null}`.
 *
 * Every word here must be one `mapRootlyComponentStatus` accepts, since the Worker maps what this
 * emits; `rootly.test.ts` holds that.
 */
const COMPONENT_STATES = /\b(Operational|Affected|Degraded|Partial Outage|Major Outage|Under Maintenance)\b/

/** The same words, for the cross-side test — read off the regex so the two cannot diverge. */
export const COMPONENT_STATES_WORDS = COMPONENT_STATES.source.replace(/^\\b\(|\)\\b$/g, '').split('|')

/**
 * One component row's text → `{name, status}`; nulls when no status word is found. `status` is the
 * matched word; `name` is what precedes it, whitespace-collapsed.
 *
 * Separated from the DOM query so the vocabulary is testable. Which element counts as a row is still
 * decided in the browser, and no test reaches that.
 */
export function readComponentRow(text) {
  const flat = text.replace(/\s+/g, ' ')
  const m = COMPONENT_STATES.exec(flat)
  return { name: m ? flat.slice(0, m.index).trim() : null, status: m ? m[1] : null }
}

/**
 * Read one incident page's DOM into verbatim strings.
 *
 * Serialized into the browser by `page.evaluate`, so it must close over NOTHING. The `doc` default is
 * what that call resolves to in the browser, and what a test overrides.
 *
 * `title` is `null` when no title ELEMENT matched — our selector is wrong, or the page moved — and
 * `''` when the element is there and the provider left it blank (#1471). The caller must not conflate
 * them: the first is a broken read, the second is an incident to name from its updates.
 */
export function readIncidentPage(doc = document) {
  const h2 = doc.querySelector('main h2')
  const heading = [...doc.querySelectorAll('main h3')].find((h) => h.textContent.trim() === 'Updates')
  // Rows come from EVERY container under the updates panel, not just the first: a layout that splits
  // them across two blocks would otherwise lose one silently, with every counter reading clean.
  const panel = heading?.parentElement?.nextElementSibling
  const rows = [...(panel?.children ?? [])].flatMap((container) =>
    [...container.children].map((row) =>
      // The row's content column, read per element.
      [...(row.lastElementChild?.children ?? [])].map((cell) => cell.textContent)))
  return { title: h2 ? h2.textContent.replace(/\s+/g, ' ').trim() : null, rows }
}

/** The four status words the page renders; anything else is not an update row. */
const ROOTLY_STATUSES = new Set(['Resolved', 'Identified', 'Investigating', 'Monitoring'])
/** "September 21, 2026 at 10:12 PM UTC" — shape only; `parseRootlyTimestamp` does the reading. */
const ROOTLY_STAMP = /^[A-Z][a-z]+ \d{1,2}, \d{4} at \d{1,2}:\d{2} (?:AM|PM) UTC$/

/**
 * Turn each update row's cell texts into `{status, at, body}`, or refuse the lot.
 *
 * Cells are identified by SHAPE, not by position: a row that renders a different number of cells
 * (an update published with no body) must not shift the timestamp into the body slot. `at` stays
 * verbatim — the Worker owns every timestamp reading.
 *
 * An unreadable row yields NO updates at all, because nothing here can tell which update it was: if
 * it was the Resolved one, the incident publishes as live with no end and re-reads identically every
 * cycle. Same refusal `normalizeRootlyIncidents` makes on a lost timestamp, decided here so the rule
 * sits in the function a test can drive rather than in the browser loop no test reaches.
 */
export function parseUpdateRows(rows) {
  const updates = []
  let dropped = 0
  for (const cells of rows ?? []) {
    const texts = (Array.isArray(cells) ? cells : [])
      .map((c) => String(c ?? '').replace(/\s+/g, ' ').trim())
    const status = texts.find((c) => ROOTLY_STATUSES.has(c))
    const at = texts.find((c) => ROOTLY_STAMP.test(c))
    if (!status || !at) { dropped++; continue }
    updates.push({ status, at, body: texts.filter((c) => c !== status && c !== at).join(' ').trim() })
  }
  return dropped > 0 ? { updates: [], dropped } : { updates, dropped }
}

async function main() {
  const WORKER_URL = process.env.WORKER_URL
  const TOKEN = process.env.MISTRAL_FEED_TOKEN
  // `Number(x || default)` reads `MAX_INCIDENTS=0` as 0 (the string is truthy) and any non-numeric
  // value as NaN — both make `slice(0, n)` return nothing, so the run reads ZERO incidents and
  // reports `{listed: 0, fetched: 0}`, which is indistinguishable from a genuinely quiet page and
  // stores as a complete reading. Refuse the run instead of scraping into a silent blank.
  const maxIncidents = envPositiveInt('MAX_INCIDENTS', DEFAULT_MAX_INCIDENTS)
  const paceMs = envPositiveInt('PACE_MS', DEFAULT_PACE_MS)
  if (!WORKER_URL || !TOKEN) {
    console.error('Missing WORKER_URL or MISTRAL_FEED_TOKEN env')
    process.exit(2)
  }

  await runWithMistralFeedObservation(WORKER_URL, TOKEN, async (state) => {
    let browser
    try {
      const { chromium } = await import('playwright')
    // headless:false is load-bearing — see the header. `channel: 'chrome'` drives the runner's
    // preinstalled Chrome, so no browser download and no `playwright install` step.
      browser = await chromium.launch({ headless: false, channel: 'chrome' })
    const page = await (await browser.newContext()).newPage()
    await withRetry(() => page.goto(STATUS_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }))
    // Wait for the real page, not a fixed delay: the uptime charts are what proves the challenge
    // cleared, and an interstitial has none.
    //
    // `state: 'attached'`, NOT the default 'visible'. A `turbo-frame` has no box of its own, so
    // Playwright never calls one visible — the default timed out after 60s having resolved all 14
    // elements every poll. Presence in the DOM is the actual signal here.
    await page.waitForSelector('turbo-frame[id^="uptime-chart-"]', { state: 'attached', timeout: 60000 })

    const componentRows = await page.evaluate(() =>
      [...document.querySelectorAll('turbo-frame[id^="uptime-chart-"]')].map((f) => ({
        id: f.id.replace('uptime-chart-', ''),
        text: (f.closest('div')?.parentElement)?.textContent ?? '',
      })))
    const components = componentRows.map((r) => ({ id: r.id, ...readComponentRow(r.text) }))

    // ── Uptime charts ──────────────────────────────────────────────────────────────────────────
    // Read BEFORE navigating away: the charts live on the main page. Only the impacted bars need a
    // tooltip (the bar fill says which), so this is a handful of requests per component rather than
    // 91. Retrieval is lossy, so each component reports impacted-vs-fetched and the Worker withholds
    // the uptime figure when they differ — a lost tooltip must never read as a clean day.
    const uptime = []
    const charts = await page.evaluate(() => [...document.querySelectorAll('turbo-frame[id^="uptime-chart-"]')].map((f) => {
      const ctrl = f.querySelector('[data-controller*="uptime-chart"]');
      const bars = [...f.querySelectorAll('rect')]
        .filter((r) => !r.hasAttribute('data-status-pages--v2--uptime-chart-component-target'));
      const filled = bars.map((r, i) => ({ i, fill: ((r.getAttribute('style') || '').match(/fill:\s*([^;]+)/) || [])[1] }));
      return {
        componentId: f.id.replace('uptime-chart-', ''),
        since: ctrl ? ctrl.getAttribute('data-status-pages--v2--uptime-chart-component-since-value') : null,
        barCount: bars.length,
        // EVERY bar carries a fill — a clean day is `3CB878`. So a bar whose fill we could not read
        // is a day we did not read, and reporting it as "not impacted" is the one direction this
        // source must never fail in. Counted, not skipped: if the inline-style shape drifts, every
        // bar lands here at once and `impacted` would otherwise read as a spotless window.
        unreadBars: filled.filter((b) => !b.fill).length,
        impacted: filled.filter((b) => b.fill && !/3CB878/i.test(b.fill)).map((b) => b.i),
      };
    }))

    for (const chart of charts) {
      if (!chart.since) { console.warn(`[scrape] chart ${chart.componentId} has no window start — skipped`); continue }
      const days = []
      let fetched = 0
      for (const idx of chart.impacted) {
        const url = `/uptime-chart-tooltip?resource_id=${chart.componentId}&resource_type=service`
          + `&since=${encodeURIComponent(chart.since)}&published=true&active_day_index=${idx}`
        try {
          const day = await withRetry(async () => {
            const r = await page.evaluate(async (u) => {
              const res = await fetch(u)
              if (!res.ok) return { ok: false, status: res.status }
              return { ok: true, html: await res.text() }
            }, url)
            if (!r.ok) throw new Error(`HTTP ${r.status}`)
            const html = r.html
            const date = (html.match(/>([A-Z][a-z]{2} \d{1,2}, \d{4}) \(UTC\)</) || [])[1] || null
            const segments = [...html.matchAll(/rounded-full (bg-[a-z0-9-]+)"\s+style="left:\s*[\d.]+%;\s*width:\s*([\d.]+)%/g)]
              .map((m) => ({ cls: m[1], width: Number(m[2]) }))
            const label = html.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, ' ')
              .replace(/\s+/g, ' ').trim()
              .replace(/^[A-Z][a-z]{2} \d{1,2}, \d{4} \(UTC\)\s*/, '')
            if (!date || segments.length === 0) throw new Error('unreadable tooltip')
            return { date, segments, label }
          }, { attempts: 4, delayMs: 300 })
          days.push(day)
          fetched++
        } catch (err) {
          console.warn(`[scrape] tooltip failed ${chart.componentId} idx=${idx}: ${err?.message ?? err}`)
        }
        await new Promise((r) => setTimeout(r, paceMs))
      }
      uptime.push(buildUptimeEntry(chart, days, fetched))
    }
    const lostTooltips = uptime.reduce((a, u) => a + (u.coverage.impacted - u.coverage.fetched), 0)
    console.log(`[scrape] uptime charts=${uptime.length} impactedDays=${uptime.reduce((a, u) => a + u.coverage.impacted, 0)} lost=${lostTooltips}`)

    const today = new Date().toISOString().slice(0, 10)
    await withRetry(() => page.goto(`${STATUS_URL}history?date=${today}`, { waitUntil: 'domcontentloaded', timeout: 45000 }))
    await page.waitForSelector('[data-status-pages--clickable-card-url-value]', { state: 'attached', timeout: 60000 })

    // Newest-first, as the page orders them.
    const allUrls = await page.evaluate(() =>
      [...document.querySelectorAll('[data-status-pages--clickable-card-url-value]')]
        .map((c) => c.getAttribute('data-status-pages--clickable-card-url-value'))
        .filter(Boolean))
    const urls = allUrls.slice(0, maxIncidents)
    if (allUrls.length > urls.length) {
      // The cap bit — expected on most runs, since the page carries a longer tail than the window
      // needs. `available` in the payload is what lets the Worker decide whether it cost real days.
      console.log(`[scrape] incident cap bit: page listed ${allUrls.length}, taking ${urls.length}`)
    }

    const incidents = []
    let failed = 0
    for (const url of urls) {
      const id = (url.match(/\/incidents\/([0-9a-f-]{36})/) || [])[1]
      if (!id) { failed++; console.warn(`[scrape] unrecognized incident URL: ${url}`); continue }
      try {
        const detail = await withRetry(async () => {
          const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
          if (!r || !r.ok()) throw new Error(`HTTP ${r ? r.status() : 'none'}`)
          return await page.evaluate(readIncidentPage);
        })
        const { updates, dropped } = parseUpdateRows(detail.rows)
        if (detail.title === null) {
          failed++
          console.warn(`[scrape] incident page has no title element — selector moved?: ${url}`)
          continue
        }
        if (updates.length === 0) {
          failed++
          console.warn(`[scrape] incident page had no readable updates (${dropped} rows dropped): ${url}`)
          continue
        }
        incidents.push({ id, title: detail.title, updates })
        await new Promise((r) => setTimeout(r, paceMs))
      } catch (err) {
        failed++
        console.warn(`[scrape] incident page failed after retries: ${url} — ${err?.message ?? err}`)
      }
    }

    state.payload = {
      fetchedAt: new Date().toISOString(),
      components,
      incidents,
      // `listed` is post-cap (what this run ATTEMPTED), so `fetched < listed` keeps meaning "reads
      // we lost". `available` is what the page offered — the Worker needs both to tell a cap that
      // merely bit (every run, by design) from one that ate days inside the 30-day window.
      coverage: { listed: urls.length, fetched: incidents.length, available: allUrls.length },
      uptime,
    }
    console.log(`[scrape] components=${components.length} attempted=${urls.length} read=${incidents.length} failed=${failed}`)
    if (state.payload.components.length === 0) throw new Error('no components read — refusing to push a blank page reading')

    const res = await fetch(`${WORKER_URL.replace(/\/+$/, '')}/api/internal/mistral-feed`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(state.payload),
    })
    const text = await res.text()
    if (!res.ok) {
      state.delivery = 'rejected'
      throw new Error(`push failed: HTTP ${res.status} ${text.slice(0, 300)}`)
    }
    state.delivery = 'stored'
    console.log(`[scrape] pushed: ${text.slice(0, 300)}`)
    } finally {
      if (browser) await browser.close()
    }
  })
}

// Only run when executed directly, so `withRetry` stays importable by the unit test.
if (process.argv[1] && process.argv[1].endsWith('scrape-mistral-status.mjs')) {
  await main().catch((err) => {
    console.error(`[scrape] ${err?.message ?? err}`)
    process.exitCode = 1
  })
}
