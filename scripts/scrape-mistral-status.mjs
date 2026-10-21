#!/usr/bin/env node
// #1381 — browser-render status.mistral.ai (Rootly) and push what it says to the Worker.
//
// Why a browser at all, and why HEADED: the page sits behind a Cloudflare MANAGED CHALLENGE. A plain
// fetch is 403 `cf-mitigated: challenge`, and so is every headless variant tried — bundled Chromium,
// full-Chromium new-headless, and the real Chrome channel. Only a headed browser gets through, which
// on a runner means `xvfb-run`. Verified end to end from a GitHub ubuntu-latest runner in run
// 34421800205: plain fetch 403, headless 403, xvfb-headed 200 with 14 uptime charts.
//
// #1510 — headed does NOT reliably SOLVE a served challenge: in-run retries cleared it only 1 of 21
// times (measured on a diagnostic branch, since deleted). The sampled PASSING runs saw no challenge
// at all on their first navigation — the egress was not challenged that time, not that the browser
// beat Turnstile. A run that IS challenged on its first navigation is very unlikely to clear it by
// waiting, so the `isCloudflareChallenge` check below exits such a run immediately instead of
// waiting out the 60s chart timeout.
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

/** A page that rendered, but no longer satisfies the deliberately narrow Rootly v3 contract. */
export class MistralPageContractError extends Error {
  constructor(message) {
    super(message)
    this.name = 'MistralPageContractError'
  }
}

/** Rootly v3 publishes the official percentage as text, e.g. `99.66% uptime`. */
export function readOfficialUptime(text) {
  const match = /^\s*(100(?:\.0+)?|\d{1,2}(?:\.\d+)?)%\s+uptime\s*$/i.exec(String(text ?? ''))
  const pct = match ? Number(match[1]) : NaN
  return Number.isFinite(pct) && pct >= 0 && pct <= 100 ? pct : null
}

export function isRootlyV3OfficialPeriod(period) {
  return /^[A-Z][a-z]{2} \d{1,2}, \d{4} - Today$/.test(String(period ?? ''))
}

/** v3 puts every update into one text node: `Oct 13, 2026 8:06 AM UTC Fixed… Resolved`. */
export function parseV3UpdateText(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  const match = /^([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4}\s+\d{1,2}:\d{2}\s+(?:AM|PM)\s+UTC)\s+(.+?)\s+(Resolved|Identified|Investigating|Monitoring)$/.exec(flat)
  if (!match) return null
  return { at: match[1], body: match[2], status: match[3] }
}

/** Build the bounded terminal diagnostic sent after EVERY runnable Action execution.
 *
 * The Worker derives `partial` from listed/fetched itself. The scraper reports only measurements it
 * made, so it cannot accidentally disagree with the ingest-side definition. A run that did not reach
 * a usable payload retains no page counters and is explicitly `unavailable` at the Worker.
 */
export function buildMistralFeedObservation(payload, delivery) {
  if (!payload?.coverage) return { delivery, ...(payload?.failure === 'page-contract' ? { failure: 'page-contract' } : {}) }
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

export async function deliverMistralFeed(workerUrl, token, state, payload, fetchImpl = fetch) {
  state.payload = payload
  if (payload.components.length === 0) throw new Error('no components read — refusing to push a blank page reading')
  const res = await fetchImpl(`${workerUrl.replace(/\/+$/, '')}/api/internal/mistral-feed`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const text = await res.text()
  if (!res.ok) {
    state.delivery = 'rejected'
    throw new Error(`push failed: HTTP ${res.status} ${text.slice(0, 300)}`)
  }
  state.delivery = 'stored'
  console.log(`[scrape] pushed: ${text.slice(0, 300)}`)
}

/** Own the terminal observation so a scraper exception cannot skip it. */
export async function runWithMistralFeedObservation(workerUrl, token, run, report = reportMistralFeedObservation) {
  const state = { payload: undefined, delivery: 'not-posted' }
  try {
    return await run(state)
  } catch (err) {
    if (err instanceof MistralPageContractError) state.payload = { failure: 'page-contract' }
    throw err
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
const COMPONENT_STATES = /\b(Operational|Affected|Degraded|Partial Outage|Major Outage|Under Maintenance|Maintenance)\b/

/** The same words, for the cross-side test — read off the regex so the two cannot diverge. */
export const COMPONENT_STATES_WORDS = COMPONENT_STATES.source.replace(/^\\b\(|\)\\b$/g, '').split('|')

/**
 * Whether a navigation response is Cloudflare's managed challenge interstitial, not the real page.
 *
 * #1510 — `page.goto` does not throw on a 403; the challenge arrives as a normal response, so the
 * old code always fell through to the 60s `waitForSelector` wait regardless (see the file header
 * for the measured evidence that the wait will not succeed). `headers()` is synchronous and
 * lower-cases header names (Playwright `Response.headers()`), so this needs no `await` and no case
 * handling of its own.
 */
export function isCloudflareChallenge(headers) {
  return (headers?.['cf-mitigated'] ?? '').toLowerCase() === 'challenge'
}

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

/** Rows → components, logging each row whose status word could not be read: its id and the row text. */
export function readComponents(rows, warn = console.warn) {
  return rows.map((r) => {
    const read = readComponentRow(r.text)
    if (read.status === null) warn(`[scrape] unreadable component row ${r.id}: ${r.text.replace(/\s+/g, ' ').trim().slice(0, 120)}`)
    return { id: r.id, ...read }
  })
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
  const v3Rows = [...(heading?.parentElement?.querySelectorAll(':scope > ul > li') ?? [])]
    .map((row) => [row.textContent])
  const panel = heading?.parentElement?.nextElementSibling
  const rows = v3Rows.length > 0 ? v3Rows : [...(panel?.children ?? [])].flatMap((container) =>
    [...container.children].map((row) =>
      // The row's content column, read per element.
      [...(row.lastElementChild?.children ?? [])].map((cell) => cell.textContent)))
  return { title: h2 ? h2.textContent.replace(/\s+/g, ' ').trim() : null, rows }
}

/** The four status words the page renders; anything else is not an update row. */
const ROOTLY_STATUSES = new Set(['Resolved', 'Identified', 'Investigating', 'Monitoring'])
/** "September 21, 2026 at 10:12 PM UTC" — shape only; `parseRootlyTimestamp` does the reading. */
const ROOTLY_STAMP = /^[A-Z][a-z]+ \d{1,2}, \d{4}(?: at)? \d{1,2}:\d{2} (?:AM|PM) UTC$/

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
    const v3 = texts.length === 1 ? parseV3UpdateText(texts[0]) : null
    const status = v3?.status ?? texts.find((c) => ROOTLY_STATUSES.has(c))
    const at = v3?.at ?? texts.find((c) => ROOTLY_STAMP.test(c))
    if (!status || !at) { dropped++; continue }
    updates.push({ status, at, body: v3?.body ?? texts.filter((c) => c !== status && c !== at).join(' ').trim() })
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
    const gotoResponse = await withRetry(() => page.goto(STATUS_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }))
    // #1510 — a served challenge is a normal (403) response, not a thrown error, so it survives
    // `withRetry` and would otherwise fall through to the 60s wait below and time out there instead.
    if (isCloudflareChallenge(gotoResponse?.headers())) {
      throw new Error('cf-mitigated: challenge — served to this run; skipping the chart wait (#1510)')
    }
    // Rootly v3 lazy-loads the cards. Typing into the documented component finder forces the full
    // roster into the DOM; the subsequent count check keeps a partial lazy load from becoming a
    // narrower, falsely clean API scope.
    await page.waitForSelector('[data-testid="status-page-section-system-status"]', { state: 'attached', timeout: 60000 })
    const search = page.locator('#status-page-component-search')
    if (await search.count() !== 1) throw new MistralPageContractError('v3 component search is missing')
    await search.fill('API')
    await page.waitForSelector('[data-component-id]', { state: 'attached', timeout: 30000 })
    const v3 = await page.evaluate(() => {
      const section = document.querySelector('[data-testid="status-page-section-system-status"]')
      const rawIndex = section?.getAttribute('data-status-pages--v3--system-status-component-index-value')
      let expected = 0
      try { expected = JSON.parse(rawIndex || '[]').filter((x) => x?.type === 'component').length } catch { expected = 0 }
      const cards = [...document.querySelectorAll('[data-component-id]')].map((card) => {
        const icon = card.querySelector('[data-uptime-loading="icon"] span')?.className || ''
        const status = /text-pothos/.test(String(icon)) ? 'Operational'
          : /text-amber/.test(String(icon)) ? 'Degraded'
            : /text-red/.test(String(icon)) ? 'Major Outage' : null
        return {
          id: card.getAttribute('data-component-id'),
          name: card.querySelector('h3')?.textContent?.replace(/\s+/g, ' ').trim(),
          status,
          uptimeText: card.querySelector('[data-controller="status-pages--v3--uptime-chart-component"]')?.textContent?.replace(/\s+/g, ' ').trim(),
          barCount: card.querySelectorAll('[data-uptime-loading="bar"]').length,
        }
      })
      const period = [...document.querySelectorAll('main *')].map((e) => e.textContent?.trim() || '')
        .find((t) => /^[A-Z][a-z]{2} \d{1,2}, \d{4} - Today$/.test(t))
      return { expected, cards, period }
    })
    if (v3.expected === 0 || v3.cards.length !== v3.expected) throw new MistralPageContractError(`v3 component roster incomplete: ${v3.cards.length}/${v3.expected}`)
    if (!isRootlyV3OfficialPeriod(v3.period)) throw new MistralPageContractError(`official uptime period is unreadable: ${v3.period ?? 'missing'}`)
    const windowDays = 90
    const components = v3.cards.map((c) => ({ id: c.id, name: c.name, status: c.status }))
    if (components.some((c) => !c.id || !c.name || !c.status)) throw new MistralPageContractError('v3 component card has unreadable id, name, or status')
    const uptime = v3.cards.map((c) => ({
      componentId: c.id, barCount: c.barCount, unreadBars: 0, coverage: { impacted: 0, fetched: 0 }, days: [],
      officialUptimePct: readOfficialUptime(c.uptimeText), officialWindowDays: windowDays,
    }))
    if (uptime.some((c) => c.barCount !== 91 || c.officialUptimePct == null)) throw new MistralPageContractError('v3 uptime card has unreadable official percentage or bar count')
    console.log(`[scrape] Rootly v3 official uptime cards=${uptime.length} windowDays=${windowDays}`)

    const today = new Date().toISOString().slice(0, 10)
    await withRetry(() => page.goto(`${STATUS_URL}history?date=${today}`, { waitUntil: 'domcontentloaded', timeout: 45000 }))
    await page.waitForSelector('a[href*="/incidents/"]', { state: 'attached', timeout: 60000 })

    // Newest-first, as the page orders them.
    const allUrls = await page.evaluate(() =>
      [...new Set([...document.querySelectorAll('a[href*="/incidents/"]')]
        .map((c) => c.getAttribute('href'))
        .filter((href) => /^\/incidents\/[0-9a-f-]{36}$/.test(href || '')))])
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
          throw new MistralPageContractError(`v3 incident page has no title element: ${url}`)
        }
        if (updates.length === 0) {
          throw new MistralPageContractError(`v3 incident page has no readable updates (${dropped} rows dropped): ${url}`)
        }
        incidents.push({ id, title: detail.title, updates })
        await new Promise((r) => setTimeout(r, paceMs))
      } catch (err) {
        if (err instanceof MistralPageContractError) throw err
        failed++
        console.warn(`[scrape] incident page failed after retries: ${url} — ${err?.message ?? err}`)
      }
    }

    const payload = {
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
    await deliverMistralFeed(WORKER_URL, TOKEN, state, payload)
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
