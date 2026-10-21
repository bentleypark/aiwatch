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
// status-word mapping, severity weighting, what counts as storable — lives in worker/src/parsers/rootly.ts,
// where unit tests pin it. The two readings made here are the ones the page publishes only as markup: an
// icon colour becomes a status word, and a day tooltip's minutes become a share of the day. In particular this file does NOT parse dates: the page publishes them only as
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
// Gap between incident-page requests.
const DEFAULT_PACE_MS = 700

/**
 * Retry a navigation/read with linear backoff.
 *
 * Not optional politeness: reads from this page are lossy under rate limiting, and a run without this
 * silently under-reports incidents, which reads downstream as a quieter month.
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
        // response — it spends the next slot on another rejection.
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
 * `chart` is what `readV3Chart` returns per component card; `days` and `fetched` are the tooltip
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

/** The component icon's colour class → the status word `mapRootlyComponentStatus` reads. */
const V3_ICON_STATUS = [[/\btext-pothos-/, 'Operational'], [/\btext-amber-/, 'Degraded'], [/\btext-red-/, 'Major Outage']]

export const COMPONENT_STATES_WORDS = V3_ICON_STATUS.map((entry) => String(entry[1]))

export function readV3ComponentStatus(iconClass) {
  const hit = V3_ICON_STATUS.find(([re]) => re.test(String(iconClass ?? '')))
  return hit ? String(hit[1]) : 'Unknown'
}

/** The error a navigation response deserves when it is not the real page, or null when it is. */
export function navigationFailure(response, url) {
  if (isCloudflareChallenge(response?.headers())) return new Error(`cf-mitigated: challenge — served for ${url}; skipping the wait (#1510)`)
  return response?.ok() ? null : new Error(`HTTP ${response?.status() ?? 'none'} from ${url}`)
}

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
 * The roster and every day bar, as verbatim strings.
 *
 * Serialized into the browser by `page.evaluate`, so it closes over NOTHING. v3 renders each day's
 * tooltip inline (hidden), so no request is needed to read a day — and the cards lazy-load, so the
 * caller compares `cards.length` to `expected` (the page's own component index) before trusting it.
 */
export function readV3Roster(doc = document) {
  const section = doc.querySelector('[data-testid="status-page-section-system-status"]')
  let expected = 0
  try {
    expected = JSON.parse(section?.getAttribute('data-status-pages--v3--system-status-component-index-value') || '[]')
      .filter((entry) => entry?.type === 'component').length
  } catch { expected = 0 }
  const cards = [...doc.querySelectorAll('[data-component-id]')].map((card) => ({
    id: card.getAttribute('data-component-id'),
    name: (card.querySelector('h3')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
    iconClass: card.querySelector('[data-uptime-loading="icon"] span')?.className ?? '',
    bars: [...card.querySelectorAll('[data-uptime-loading="bar"]')].map((bar) => {
      const tip = bar.parentElement?.querySelector('[data-uptime-day-tooltip]')
      return {
        cls: String(bar.className ?? ''),
        text: (tip?.textContent ?? '').replace(/\s+/g, ' ').trim(),
        statuses: [...(tip?.querySelectorAll('span[title]') ?? [])].map((el) => el.getAttribute('title')),
        titles: [...(tip?.querySelectorAll('a') ?? [])].map((a) => (a.getAttribute('title') || a.textContent || '').replace(/\s+/g, ' ').trim()),
      }
    }),
  }))
  return { expected, cards }
}

const V3_BAR_CLEAN = 'bg-pothos-10'
const V3_BAR_IMPACTED = 'bg-red-v2-12'
const V3_BAR_NO_DATA = 'bg-dove-grey-5'
const MINUTES_PER_DAY = 1440

/** "July 24, 2026 Impacted 1h 5m Related …" → the day and its downtime; null without a duration after `Impacted`. */
export function parseV3DayTooltip(text) {
  const m = /^([A-Z][a-z]+ \d{1,2}, \d{4}) Impacted (?:(\d+)h)? ?(?:(\d+)m)?(?: Related .+)?$/.exec(String(text ?? ''))
  if (!m || (m[2] === undefined && m[3] === undefined)) return null
  return { date: m[1], minutes: Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) }
}

/**
 * One component's day bars → what `buildUptimeEntry` consumes.
 *
 * A bar is judged by its colour AND its tooltip, so either drifting alone lands in `unreadBars`
 * instead of reading as a clean day. `No data` bars are the days before the component existed; they
 * are not days of the window, so `barCount` excludes them — but one AFTER data began is unread.
 */
export function readV3Chart(card) {
  const impacted = []
  const days = []
  let started = false
  let leading = 0
  let unreadBars = 0
  card.bars.forEach((bar, i) => {
    const classes = new Set(bar.cls.split(/\s+/))
    if (classes.has(V3_BAR_NO_DATA) && /No data$/.test(bar.text) && !started) { leading++; return }
    started = true
    if (classes.has(V3_BAR_CLEAN) && /No incidents$/.test(bar.text)) return
    if (!classes.has(V3_BAR_IMPACTED)) { unreadBars++; return }
    impacted.push(i)
    const day = bar.statuses.length === 1 ? parseV3DayTooltip(bar.text) : null
    if (!day) return
    days.push({
      date: day.date,
      segments: [{ cls: V3_BAR_IMPACTED, width: Math.min(100, (day.minutes / MINUTES_PER_DAY) * 100) }],
      label: bar.titles.join(' | '),
    })
  })
  return { chart: { componentId: card.id, barCount: card.bars.length - leading, unreadBars, impacted }, days, fetched: days.length }
}

const V3_SECTION = '[data-testid="status-page-section-system-status"]'

/**
 * Navigate and wait for the marker that proves the real page rendered. A challenge or non-2xx is a
 * plain failure; a 2xx page that never shows the marker is the PAGE changing.
 */
export async function gotoReadable(page, url, readySelector) {
  const failure = navigationFailure(await withRetry(() => page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })), url)
  if (failure) throw failure
  await page.waitForSelector(readySelector, { state: 'attached', timeout: 60000 })
    .catch((err) => { throw new MistralPageContractError(`${url} never rendered ${readySelector}: ${err?.message ?? err}`) })
}

/**
 * Scroll until the page's own component index is satisfied. The cards lazy-load, so a partial load
 * must not become a narrower, falsely clean API scope. A roster that loads short is a failed read;
 * only an unreadable index, no cards at all, or surplus cards say the page itself changed.
 */
export async function loadV3Roster(page, attempts = 20) {
  let roster
  for (let attempt = 0; attempt < attempts; attempt++) {
    roster = await page.evaluate(readV3Roster)
    if (roster.expected > 0 && roster.cards.length >= roster.expected) break
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await page.waitForTimeout(500)
  }
  if (roster.expected === 0 || roster.cards.length === 0 || roster.cards.length > roster.expected) {
    throw new MistralPageContractError(`v3 component roster disagrees with its index: ${roster.cards.length}/${roster.expected}`)
  }
  if (roster.cards.length < roster.expected) throw new Error(`v3 component roster loaded short: ${roster.cards.length}/${roster.expected}`)
  if (roster.cards.some((c) => !c.id || !c.name)) throw new MistralPageContractError('v3 component card has no id or name')
  return roster
}

/** The history page's incident URLs; links present but none matching the incident path is the PAGE changing. */
export async function readHistoryUrls(page) {
  const urls = await page.evaluate(readIncidentLinks)
  if (urls.length === 0) throw new MistralPageContractError('v3 history page has incident links but none match /incidents/<uuid>')
  return urls
}

/** Distinct incident URLs on the history page, newest first, as absolute same-origin URLs. */
export function readIncidentLinks(doc = document) {
  const base = doc.location.href
  const urls = []
  for (const a of doc.querySelectorAll('a[href*="/incidents/"]')) {
    let url
    try { url = new URL(a.getAttribute('href'), base) } catch { continue }
    if (url.origin === new URL(base).origin && /^\/incidents\/[0-9a-f-]{36}$/.test(url.pathname)) urls.push(url.href)
  }
  return [...new Set(urls)]
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
  const v3Rows = [...(heading?.parentElement?.children ?? [])].filter((el) => el.tagName === 'UL')
    .flatMap((ul) => [...ul.children])
    .map((li) => ['.text-eyebrow', '.status-page-markdown-content', '[data-role="label"]']
      .map((sel) => li.querySelector(sel)?.textContent ?? ''))
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

/** v3 appends "(54 minutes earlier)" to every update after the first. */
const stripAge = (text) => text.replace(/ \([^()]*earlier\)$/, '')

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
    const cell = texts.find((c) => ROOTLY_STAMP.test(stripAge(c)))
    if (!status || !cell) { dropped++; continue }
    updates.push({ status, at: stripAge(cell), body: texts.filter((c) => c !== status && c !== cell).join(' ').trim() })
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
    await gotoReadable(page, STATUS_URL, V3_SECTION)
    const roster = await loadV3Roster(page)
    const components = roster.cards.map((c) => ({ id: c.id, name: c.name, status: readV3ComponentStatus(c.iconClass) }))
    const uptime = roster.cards.map((card) => {
      const { chart, days, fetched } = readV3Chart(card)
      return buildUptimeEntry(chart, days, fetched)
    })
    for (const u of uptime) {
      if (u.unreadBars > 0 || u.coverage.fetched < u.coverage.impacted) console.warn(`[scrape] unreadable day bars on ${u.componentId}: unread=${u.unreadBars} impacted=${u.coverage.impacted} read=${u.coverage.fetched}`)
    }
    for (const c of components) {
      if (c.status === 'Unknown') console.warn(`[scrape] unmapped component icon on ${c.name}: ${roster.cards.find((card) => card.id === c.id)?.iconClass}`)
    }
    console.log(`[scrape] uptime charts=${uptime.length} impactedDays=${uptime.reduce((a, u) => a + u.coverage.impacted, 0)}`)

    const today = new Date().toISOString().slice(0, 10)
    await gotoReadable(page, `${STATUS_URL}history?date=${today}`, 'a[href*="/incidents/"]')

    // Newest-first, as the page orders them.
    const allUrls = await readHistoryUrls(page)
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
