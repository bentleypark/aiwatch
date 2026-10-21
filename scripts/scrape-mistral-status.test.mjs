import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Window } from 'happy-dom'
import {
  withRetry, buildUptimeEntry, envPositiveInt, parseUpdateRows, readIncidentPage,
  buildMistralFeedObservation, reportMistralFeedObservation, runWithMistralFeedObservation, deliverMistralFeed,
  isCloudflareChallenge, MistralPageContractError, readV3Roster, readV3Chart, parseV3DayTooltip,
  readV3ComponentStatus, readIncidentLinks, COMPONENT_STATES_WORDS, navigationFailure,
  gotoReadable, loadV3Roster, readHistoryUrls,
} from './scrape-mistral-status.mjs'

// #1381 — `withRetry` is the part of the scraper that decides whether a
// lost read becomes a missing incident. Reads from this page are lossy under rate limiting, so a
// regression here does not throw — it quietly under-reports, which downstream reads as a quieter month.

test('returns the first success without waiting', async () => {
  const slept = []
  const out = await withRetry(async () => 'ok', { sleep: async (ms) => slept.push(ms) })
  assert.equal(out, 'ok')
  assert.deepEqual(slept, [], 'a first-try success must not sleep')
})

test('retries a transient failure and returns the eventual success', async () => {
  let calls = 0
  const slept = []
  const out = await withRetry(async () => {
    calls++
    if (calls < 3) throw new Error('flaky')
    return 'ok'
  }, { sleep: async (ms) => slept.push(ms) })
  assert.equal(out, 'ok')
  assert.equal(calls, 3)
  assert.deepEqual(slept, [300, 600], 'backoff is linear in the attempt number')
})

test('throws the LAST error once attempts are exhausted, so the caller can count the loss', async () => {
  let calls = 0
  await assert.rejects(
    withRetry(async () => { calls++; throw new Error(`fail-${calls}`) }, { sleep: async () => {} }),
    /fail-4$/,
  )
  assert.equal(calls, 4, 'default is four attempts')
})

test('does not sleep after the final attempt', async () => {
  const slept = []
  await assert.rejects(withRetry(async () => { throw new Error('nope') }, {
    attempts: 3, sleep: async (ms) => slept.push(ms),
  }))
  assert.equal(slept.length, 2, 'three attempts means two waits, not three')
})

test('a falsy-but-valid result is returned rather than retried', async () => {
  // The failure mode a truthiness check would introduce: an empty update list is a real answer.
  let calls = 0
  const out = await withRetry(async () => { calls++; return '' }, { sleep: async () => {} })
  assert.equal(out, '')
  assert.equal(calls, 1)
})

test('backs off an ORDER OF MAGNITUDE further on a 429 than on a generic failure', async () => {
  // A 429 is the server asking for a slower rate, so the backoff a timeout deserves is the wrong
  // answer — it spends the next slot on another rejection.
  const slept = []
  await assert.rejects(withRetry(async () => { throw new Error('HTTP 429') }, {
    attempts: 3, delayMs: 300, rateLimitMs: 5000, sleep: async (ms) => slept.push(ms),
  }))
  assert.deepEqual(slept, [5000, 10000])
})

test('a non-429 failure keeps the short backoff — the two paths must not collapse', async () => {
  const slept = []
  await assert.rejects(withRetry(async () => { throw new Error('net::ERR_TIMED_OUT') }, {
    attempts: 3, delayMs: 300, rateLimitMs: 5000, sleep: async (ms) => slept.push(ms),
  }))
  assert.deepEqual(slept, [300, 600])
})

test('429 is matched as a status token, not as any occurrence of the digits', async () => {
  // "1429ms" or a body containing 429 must not trigger the long wait; only the status does.
  const slept = []
  await assert.rejects(withRetry(async () => { throw new Error('timeout after 1429ms') }, {
    attempts: 2, delayMs: 300, rateLimitMs: 5000, sleep: async (ms) => slept.push(ms),
  }))
  assert.deepEqual(slept, [300])
})

// ── Cloudflare challenge detection (#1510) ─────────────────────────────────────────────────────
// `page.goto` does not throw on a served challenge — it's a normal 403 response — so the old code
// always fell through to the 60s chart wait even on a run the measured evidence says will not clear.

test('a served challenge is detected from the response header', () => {
  assert.equal(isCloudflareChallenge({ 'cf-mitigated': 'challenge' }), true)
})

test('header name casing from Playwright is already lower-cased, and the value is matched case-insensitively', () => {
  assert.equal(isCloudflareChallenge({ 'cf-mitigated': 'Challenge' }), true)
})

test('a clean response is not a challenge', () => {
  assert.equal(isCloudflareChallenge({ 'content-type': 'text/html' }), false)
  assert.equal(isCloudflareChallenge({}), false)
})

test('a missing response (goto returned null) is not read as a challenge', () => {
  assert.equal(isCloudflareChallenge(undefined), false)
})

test('another cf-mitigated value is not treated as a challenge', () => {
  // Cloudflare's own header carries other values too; only the exact measured one short-circuits.
  assert.equal(isCloudflareChallenge({ 'cf-mitigated': 'banned' }), false)
})

// ── the pushed payload's SHAPE ──────────────────────────────────────────────────────────────────
// This block exists because of a defect it would have caught: `unreadBars` was added to the
// browser-side derivation and to the Worker's reader, with a unit test on the Worker half, and was
// never added to the object the scraper pushes. Both halves were green for a full round while
// production sent a payload missing the field.
//
// The first version of this guard parsed `RootlyUptimeComponent`'s field names out of the Worker's
// source with a regex. It was deleted rather than extended: review showed it missed a nested rename
// (`coverage.fetched`), a member modifier (`readonly`), a sibling interface, and every type change —
// a hand-written parser of an unbounded input, which this repo has a standing rule against. The
// contract is enforced where it is consumed instead: `isStorableRootlyFeed` shape-checks every
// uptime entry and REFUSES the push, so a producer that drops or mistypes a field fails in
// production, not only in CI. The round-trip assertion — that the gate accepts what this function
// emits — lives in `worker/src/parsers/__tests__/rootly.test.ts`, because node's test runner cannot
// resolve the Worker's TS imports. What is left here is the producer's side of that contract.
test('buildUptimeEntry carries the values through, not just the keys', () => {
  // A key present but always zero/empty would satisfy a presence check while losing the reading.
  const entry = buildUptimeEntry(
    { componentId: 'c1', barCount: 91, unreadBars: 2, impacted: [3, 7] },
    [{ date: 'Sep 5, 2026', label: 'x', segments: [] }],
    1,
  )
  assert.strictEqual(entry.componentId, 'c1')
  assert.strictEqual(entry.barCount, 91)
  assert.strictEqual(entry.unreadBars, 2)
  assert.deepStrictEqual(entry.coverage, { impacted: 2, fetched: 1 })  // impacted = the ARRAY's length
  assert.strictEqual(entry.days.length, 1)
})

test('buildUptimeEntry passes unreadBars through instead of defaulting it', () => {
  // A real zero survives as a zero...
  assert.strictEqual(
    buildUptimeEntry({ componentId: 'c1', barCount: 91, unreadBars: 0, impacted: [] }, [], 0).unreadBars,
    0,
  )
  // ...and an ABSENT one stays absent, so the gate is the single place that decides. The earlier
  // version of this test asserted `?? 0` here and called it correct, while its own comment said
  // omission should be refused — the assertion certified the bug the comment described.
  assert.strictEqual(
    'unreadBars' in buildUptimeEntry({ componentId: 'c1', barCount: 91, impacted: [] }, [], 0)
      ? buildUptimeEntry({ componentId: 'c1', barCount: 91, impacted: [] }, [], 0).unreadBars
      : 'MISSING',
    undefined,
    'a field the derivation did not produce must not be invented here',
  )
})

test('buildMistralFeedObservation retains a partial incident count and the independent tooltip loss', () => {
  const observation = buildMistralFeedObservation({
    coverage: { listed: 12, fetched: 8, available: 20 },
    uptime: [{ coverage: { impacted: 3, fetched: 2 } }, { coverage: { impacted: 0, fetched: 0 } }],
  }, 'stored')
  assert.deepEqual(observation, { delivery: 'stored', listed: 12, fetched: 8, available: 20, uptimeLostTooltips: 1 })
})

test('buildMistralFeedObservation makes a pre-coverage failure observable without inventing zeroes', () => {
  assert.deepEqual(buildMistralFeedObservation(undefined, 'not-posted'), { delivery: 'not-posted' })
})

test('buildMistralFeedObservation labels only an explicit Rootly contract failure', () => {
  assert.deepEqual(buildMistralFeedObservation({ failure: 'page-contract' }, 'not-posted'),
    { delivery: 'not-posted', failure: 'page-contract' })
})

test('reportMistralFeedObservation is fail-soft and uses the internal diagnostic endpoint', async () => {
  const calls = []
  await reportMistralFeedObservation('https://worker.example/', 'secret', { delivery: 'stored', listed: 1, fetched: 1, available: 1, uptimeLostTooltips: 0 }, async (url, init) => {
    calls.push({ url, init })
    return new Response('', { status: 200 })
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://worker.example/api/internal/mistral-feed-observation')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer secret')
  assert.equal(calls[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].init.body), { delivery: 'stored', listed: 1, fetched: 1, available: 1, uptimeLostTooltips: 0 })
})

test('reportMistralFeedObservation does not turn a telemetry timeout into a scraper failure', async () => {
  const warn = console.warn
  console.warn = () => {}
  try {
    let aborted = false
    await reportMistralFeedObservation('https://worker.example', 'secret', { delivery: 'not-posted' }, async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          aborted = true
          reject(new Error('telemetry timeout'))
        })
      }), 1)
    assert.equal(aborted, true)
  } finally {
    console.warn = warn
  }
})

test('runWithMistralFeedObservation reports a partial payload after a stored feed', async () => {
  const reports = []
  await runWithMistralFeedObservation('https://worker.example', 'secret', async (state) => {
    state.payload = { coverage: { listed: 12, fetched: 8, available: 20 }, uptime: [] }
    state.delivery = 'stored'
  }, async (...args) => reports.push(args))
  assert.deepEqual(reports, [[
    'https://worker.example', 'secret',
    { delivery: 'stored', listed: 12, fetched: 8, available: 20, uptimeLostTooltips: 0 },
  ]])
})

test('a plain timeout error that main() did not convert is not a page-contract failure', async () => {
  const reports = []
  await assert.rejects(
    runWithMistralFeedObservation('https://worker.example', 'secret', async () => { throw new Error('page.waitForSelector: Timeout 60000ms exceeded') }, async (...args) => reports.push(args)),
    /Timeout 60000ms/,
  )
  assert.deepEqual(reports, [['https://worker.example', 'secret', { delivery: 'not-posted' }]])
})

const partialFeed = () => ({ components: [{ name: 'API' }], coverage: { listed: 12, fetched: 8, available: 20 }, uptime: [] })

async function observeDelivery(payload, status) {
  const reports = []
  const posts = []
  let error
  const log = console.log
  console.log = () => {}
  try {
    await runWithMistralFeedObservation('https://worker.example', 'secret', (state) =>
      deliverMistralFeed('https://worker.example/', 'secret', state, payload, async (url, init) => {
        posts.push({ url, init })
        return new Response('{}', { status })
      }), async (...args) => reports.push(args[2])).catch((err) => { error = err })
  } finally {
    console.log = log
  }
  return { observation: reports[0], posts, error }
}

test('deliverMistralFeed records a stored feed with its measured coverage', async () => {
  const { observation, posts, error } = await observeDelivery(partialFeed(), 200)
  assert.equal(error, undefined)
  assert.equal(posts[0].url, 'https://worker.example/api/internal/mistral-feed')
  assert.equal(posts[0].init.method, 'POST')
  assert.equal(posts[0].init.headers.Authorization, 'Bearer secret')
  assert.deepEqual(JSON.parse(posts[0].init.body), partialFeed())
  assert.deepEqual(observation, { delivery: 'stored', listed: 12, fetched: 8, available: 20, uptimeLostTooltips: 0 })
})

test('deliverMistralFeed records a Worker refusal as rejected, keeping the coverage', async () => {
  const { observation, error } = await observeDelivery(partialFeed(), 422)
  assert.match(error?.message ?? '', /push failed: HTTP 422/)
  assert.deepEqual(observation, { delivery: 'rejected', listed: 12, fetched: 8, available: 20, uptimeLostTooltips: 0 })
})

test('deliverMistralFeed refuses a blank reading without posting, and still reports its coverage', async () => {
  const { observation, posts, error } = await observeDelivery({ ...partialFeed(), components: [] }, 200)
  assert.match(error?.message ?? '', /no components read/)
  assert.equal(posts.length, 0)
  assert.deepEqual(observation, { delivery: 'not-posted', listed: 12, fetched: 8, available: 20, uptimeLostTooltips: 0 })
})

// ── env overrides ───────────────────────────────────────────────────────────────────────────────
// `Number(process.env.X || DEFAULT)` read `MAX_INCIDENTS=0` as 0 — the string is truthy, so the
// default never applied — and any non-numeric value as NaN. Either made `slice(0, n)` return
// nothing, so the run read ZERO incidents and reported `{listed: 0, fetched: 0}`: indistinguishable
// from a genuinely quiet page, and storable as a complete reading.
test('envPositiveInt falls back only when the variable is absent or empty', () => {
  assert.strictEqual(envPositiveInt('X', 80, {}), 80)
  assert.strictEqual(envPositiveInt('X', 80, { X: '' }), 80)
  assert.strictEqual(envPositiveInt('X', 80, { X: '30' }), 30)
})

// KNOWN LIMIT, stated rather than papered over: these two tests cover the FUNCTION, not the fact
// that `main()` calls it. `main()` drives a real browser, so nothing here executes the call site —
// reverting the `maxIncidents` assignment to `Number(process.env.MAX_INCIDENTS || …)` leaves this
// file green. Verified by
// reading (`grep -n "Number(process.env" scripts/scrape-mistral-status.mjs` returns nothing). A
// source-text scanner would close it, and that is exactly the guard shape review retired earlier in
// this PR for missing renames, modifiers and types; it is not worth re-introducing for two lines.
test('envPositiveInt REFUSES the values that used to read as "scrape nothing"', () => {
  for (const bad of ['0', '-1', 'eighty', 'NaN', '  ']) {
    assert.throws(
      () => envPositiveInt('MAX_INCIDENTS', 80, { MAX_INCIDENTS: bad }),
      /MAX_INCIDENTS must be a positive number/,
      `${JSON.stringify(bad)} must stop the run, not scrape zero incidents`,
    )
  }
})

// ── Rootly v3 page (captured 2026-10-21 from status.mistral.ai) ─────────────────────────────
// Markup shapes below are the live ones: bar colour classes, the hidden inline tooltip, the
// `data-component-id` card, the component index attribute. Builders only repeat them.
const v3Tip = (date, inner) =>
  `<div data-uptime-day-tooltip="" aria-hidden="true" class="hidden">\n<div class="bg-white">\n<div class="text-eyebrow">\n ${date}\n </div>\n${inner}\n</div></div>`
const V3_CLASS = {
  clean: 'h-full w-full rounded-v2-xs bg-pothos-10 hover:bg-pothos-12',
  impacted: 'h-full w-full rounded-v2-xs bg-red-v2-12 hover:bg-red-v2-12',
  noData: 'h-full w-full rounded-v2-xs bg-dove-grey-5',
}
const v3Bar = ({ kind, date, text, titles = [] }) => {
  const inner = kind === 'clean' ? '<span class="text-base">\n No incidents\n </span>'
    : kind === 'noData' ? '<span class="text-base">\n No data\n </span>'
      : `<span title="Impacted">\n Impacted\n </span>\n<span class="w-14">\n ${text}\n </span>\n<div>\n Related\n </div>\n${titles.map((t) =>
        `<a title="${t}" href="https://status.mistral.ai/incidents/ff51dc3e-2e73-4d0e-9660-e76f166abc64">\n ${t}\n </a>`).join('')}`
  return `<div class="relative flex-1"><div class="${V3_CLASS[kind] ?? kind}" data-uptime-loading="bar"></div>${v3Tip(date, inner)}</div>`
}
const v3Card = ({ id, name, icon = 'text-pothos-12', bars }) =>
  `<div data-entry-index="0" data-component-id="${id}"><div><div data-uptime-loading="icon"><span class="w-5 h-5 ${icon}"></span></div>`
  + `<h3 class="text-md-semibold">\n  ${name}\n</h3><span data-uptime-loading="text">· 99.66% uptime</span>`
  + `<div data-controller="status-pages--v3--uptime-chart-component">${bars.map(v3Bar).join('')}</div></div></div>`
const v3Page = (cards, index) =>
  `<main><div data-testid="status-page-section-system-status" data-status-pages--v3--system-status-component-index-value='${JSON.stringify(index)}'>${cards.join('')}</div></main>`
const v3DocOf = (html, url = 'https://status.mistral.ai/') => {
  const window = new Window({ url })
  window.document.body.innerHTML = html
  return window.document
}
const BAR = {
  noData: { kind: 'noData', date: 'July 23, 2026' },
  clean: { kind: 'clean', date: 'July 28, 2026' },
  short: { kind: 'impacted', date: 'July 24, 2026', text: '1m', titles: ['Completion API Degraded - mistral-vibe-cli-fast'] },
  long: { kind: 'impacted', date: 'August 9, 2026', text: '1h 5m', titles: ['Completion API Degraded - mistral-medium-2505'] },
}
const v3Chart = (bars) => readV3Chart({ id: 'c1', bars: bars.map((b) => readV3Roster(v3DocOf(v3Page([v3Card({ id: 'c1', name: 'X', bars: [b] })], []))).cards[0].bars[0]) })

test('the roster reads ids, names, icon classes and every bar; the expected count comes from the index', () => {
  const doc = v3DocOf(v3Page([
    v3Card({ id: 'c1', name: 'Completion API', bars: [BAR.clean, BAR.short] }),
    v3Card({ id: 'c2', name: 'OCR API', icon: 'text-amber-11', bars: [BAR.clean] }),
  ], [{ type: 'component', id: 'c1' }, { type: 'component', id: 'c2' }, { type: 'component', id: 'c3' }, { type: 'group', id: 'g1' }]))
  const roster = readV3Roster(doc)
  assert.equal(roster.expected, 3, 'the index lists 3 components and one group; only components count')
  assert.deepEqual(roster.cards.map((c) => [c.id, c.name, c.bars.length]), [['c1', 'Completion API', 2], ['c2', 'OCR API', 1]])
  assert.match(roster.cards[1].iconClass, /text-amber/)
  assert.equal(roster.cards[0].bars[1].text, 'July 24, 2026 Impacted 1m Related Completion API Degraded - mistral-vibe-cli-fast')
  assert.deepEqual(roster.cards[0].bars[1].titles, ['Completion API Degraded - mistral-vibe-cli-fast'])
})

test('a page without the section reads as no components', () => {
  assert.deepEqual(readV3Roster(v3DocOf('<main><p>moved</p></main>')), { expected: 0, cards: [] })
})

test('the icon colour maps to a status word the Worker accepts; any other colour is Unknown', () => {
  assert.equal(readV3ComponentStatus('w-5 text-pothos-12'), 'Operational')
  assert.equal(readV3ComponentStatus('w-5 text-amber-11'), 'Degraded')
  assert.equal(readV3ComponentStatus('w-5 text-red-v2-12'), 'Major Outage')
  assert.equal(readV3ComponentStatus('w-5 text-tangerine-11'), 'Unknown')
  assert.equal(readV3ComponentStatus('w-5 text-dove-grey-6'), 'Unknown')
  assert.equal(readV3ComponentStatus(undefined), 'Unknown')
  assert.deepEqual(COMPONENT_STATES_WORDS, ['Operational', 'Degraded', 'Major Outage'])
})

test('a day tooltip reads as its date and minutes, and nothing else is guessed', () => {
  assert.deepEqual(parseV3DayTooltip('July 24, 2026 Impacted 1m Related Completion API Degraded'), { date: 'July 24, 2026', minutes: 1 })
  assert.deepEqual(parseV3DayTooltip('August 9, 2026 Impacted 1h 5m Related X'), { date: 'August 9, 2026', minutes: 65 })
  assert.deepEqual(parseV3DayTooltip('August 13, 2026 Impacted 0m Related X'), { date: 'August 13, 2026', minutes: 0 })
  assert.deepEqual(parseV3DayTooltip('August 9, 2026 Impacted 2h'), { date: 'August 9, 2026', minutes: 120 })
  assert.equal(parseV3DayTooltip('August 9, 2026 Impacted Related X'), null, 'no duration')
  assert.equal(parseV3DayTooltip('August 9, 2026 Impacted 2d Related X'), null, 'a unit this reader does not know')
  assert.equal(parseV3DayTooltip('August 9, 2026 Degraded 5m Related X'), null, 'another status word')
  assert.equal(parseV3DayTooltip('July 28, 2026 No incidents'), null)
})

test('a chart keeps minutes as a share of the day, excludes leading No data days, and joins titles for attribution', () => {
  const { chart, days, fetched } = v3Chart([BAR.noData, BAR.noData, BAR.clean, BAR.short, BAR.long, BAR.clean])
  assert.deepEqual(chart, { componentId: 'c1', barCount: 4, unreadBars: 0, impacted: [3, 4] },
    'barCount is the days with data; the impacted indexes still count every bar')
  assert.equal(fetched, 2)
  assert.deepEqual(days.map((d) => [d.date, d.label]), [
    ['July 24, 2026', 'Completion API Degraded - mistral-vibe-cli-fast'],
    ['August 9, 2026', 'Completion API Degraded - mistral-medium-2505'],
  ])
  assert.ok(Math.abs(days[1].segments[0].width - (65 / 1440) * 100) < 1e-9)
  assert.equal(days[1].segments[0].cls, 'bg-red-v2-12')
})

test('a bar whose colour or tooltip drifted is counted unread, never read as a clean day', () => {
  const amber = { kind: 'h-full bg-amber-v2-12', date: 'July 24, 2026', text: '5m' }
  assert.equal(v3Chart([BAR.clean, amber]).chart.unreadBars, 1, 'an impacted-looking bar in an unknown colour')
  const disagree = { kind: 'clean', date: 'July 24, 2026' }
  const tipDrift = readV3Roster(v3DocOf(v3Page([v3Card({ id: 'c1', name: 'X', bars: [disagree] })], []))).cards[0]
  tipDrift.bars[0].text = 'July 24, 2026 Impacted 5m Related X'
  assert.equal(readV3Chart(tipDrift).chart.unreadBars, 1, 'a clean colour over an impacted tooltip')
  assert.equal(v3Chart([BAR.clean, BAR.noData]).chart.unreadBars, 1, 'No data AFTER data began is a day we did not read')
})

test('a tooltip with two status rows is not read as one day, so it cannot undercount', () => {
  const card = readV3Roster(v3DocOf(v3Page([v3Card({ id: 'c1', name: 'X', bars: [BAR.clean, BAR.short] })], []))).cards[0]
  card.bars[1].statuses = ['Impacted', 'Impacted']
  const { chart, days, fetched } = readV3Chart(card)
  assert.deepEqual([chart.impacted, days.length, fetched], [[1], 0, 0])
})

test('an impacted bar whose tooltip cannot be read stays impacted but yields no day', () => {
  const lost = { kind: 'impacted', date: 'July 24, 2026', text: '2d', titles: ['X'] }
  const { chart, days, fetched } = v3Chart([BAR.clean, lost])
  assert.deepEqual([chart.impacted, days.length, fetched], [[1], 0, 0])
  assert.deepEqual(buildUptimeEntry(chart, days, fetched).coverage, { impacted: 1, fetched: 0 })
})

test('the history links are read whether the page renders them absolute (live) or relative', () => {
  const uuid = (n) => `${String(n).repeat(8)}-aaaa-bbbb-cccc-${String(n).repeat(12)}`
  const html = `<a href="https://status.mistral.ai/incidents/${uuid(1)}">a</a>`
    + `<a href="/incidents/${uuid(2)}">b</a><a href="https://status.mistral.ai/incidents/${uuid(1)}">dup</a>`
    + `<a href="https://evil.example/incidents/${uuid(3)}">other origin</a><a href="/incidents/not-a-uuid">x</a>`
  assert.deepEqual(readIncidentLinks(v3DocOf(html, 'https://status.mistral.ai/history')), [
    `https://status.mistral.ai/incidents/${uuid(1)}`, `https://status.mistral.ai/incidents/${uuid(2)}`,
  ])
})

const V3_INCIDENT = `<main><h1>Mistral AI Status</h1><h2>Completion API Degraded - mistral-medium-2505</h2>
  <div><h3>Updates</h3><ul>
    <li><span class="text-eyebrow"> Aug 9, 2026 4:30 PM UTC </span><div class="status-page-markdown-content"><p>The incident has been resolved</p></div><span data-role="label"> Resolved </span></li>
    <li><span class="text-eyebrow"> Aug 9, 2026 3:35 PM UTC (54 minutes earlier) </span><div class="status-page-markdown-content"><p>Requests are experiencing degraded service.</p></div><span data-role="label"> Investigating </span></li>
    <li><span class="text-eyebrow"> Aug 9, 2026 3:30 PM UTC (1 hour 5 minutes earlier) </span><span data-role="label"> Monitoring </span></li>
  </ul></div></main>`

test('a v3 incident page reads its title from main h2 and every update, including the age suffix and a body-less one', () => {
  const page = readIncidentPage(v3DocOf(V3_INCIDENT))
  assert.equal(page.title, 'Completion API Degraded - mistral-medium-2505')
  assert.deepEqual(parseUpdateRows(page.rows), { dropped: 0, updates: [
    { status: 'Resolved', at: 'Aug 9, 2026 4:30 PM UTC', body: 'The incident has been resolved' },
    { status: 'Investigating', at: 'Aug 9, 2026 3:35 PM UTC', body: 'Requests are experiencing degraded service.' },
    { status: 'Monitoring', at: 'Aug 9, 2026 3:30 PM UTC', body: '' },
  ] })
})

test('a challenge or a non-2xx on ANY navigation is a plain failure, never a page-contract one', () => {
  const res = (status, headers = {}) => ({ ok: () => status < 400, status: () => status, headers: () => headers })
  assert.equal(navigationFailure(res(200), 'u'), null)
  assert.match(navigationFailure(res(403, { 'cf-mitigated': 'challenge' }), 'https://x/history').message, /challenge.*https:\/\/x\/history/)
  assert.match(navigationFailure(res(429), 'u').message, /HTTP 429/)
  assert.match(navigationFailure(null, 'u').message, /HTTP none/)
  assert.ok(!(navigationFailure(res(503), 'u') instanceof MistralPageContractError))
})

const response = (status, headers = {}) => ({ ok: () => status < 400, status: () => status, headers: () => headers })
const stubPage = ({ goto = response(200), waitForSelector = async () => {}, rosters = [], urls = [] } = {}) => {
  const calls = { waited: 0, scrolls: 0 }
  return {
    calls,
    goto: async () => goto,
    waitForSelector: async (...args) => { calls.waited++; return waitForSelector(...args) },
    waitForTimeout: async () => {},
    evaluate: async (fn) => {
      if (fn === readV3Roster) return rosters.length > 1 ? rosters.shift() : rosters[0]
      if (fn === readIncidentLinks) return urls
      calls.scrolls++
    },
  }
}
const card = (id = 'c1', name = 'X') => ({ id, name, iconClass: '', bars: [] })

test('gotoReadable fails plainly on a challenge or non-2xx, before it waits for anything', async () => {
  for (const goto of [response(403, { 'cf-mitigated': 'challenge' }), response(503)]) {
    const page = stubPage({ goto })
    await assert.rejects(gotoReadable(page, 'https://x/', '#ready'), (err) => !(err instanceof MistralPageContractError))
    assert.equal(page.calls.waited, 0)
  }
})

test('gotoReadable turns a missing marker on a 2xx page into a contract failure', async () => {
  const page = stubPage({ waitForSelector: async () => { throw new Error('Timeout 60000ms exceeded') } })
  await assert.rejects(gotoReadable(page, 'https://x/', '#ready'), MistralPageContractError)
  await assert.doesNotReject(gotoReadable(stubPage(), 'https://x/', '#ready'))
})

test('the roster scrolls until the page\'s own index is satisfied, and refuses a partial or unnamed one', async () => {
  const page = stubPage({ rosters: [{ expected: 2, cards: [card('c1')] }, { expected: 2, cards: [card('c1'), card('c2')] }] })
  assert.equal((await loadV3Roster(page)).cards.length, 2)
  assert.equal(page.calls.scrolls, 1)
  await assert.rejects(loadV3Roster(stubPage({ rosters: [{ expected: 2, cards: [card('c1')] }] }), 3), (err) => !(err instanceof MistralPageContractError) && /short: 1\/2/.test(err.message))
  await assert.rejects(loadV3Roster(stubPage({ rosters: [{ expected: 1, cards: [card('c1'), card('c2')] }] }), 1), MistralPageContractError)
  await assert.rejects(loadV3Roster(stubPage({ rosters: [{ expected: 15, cards: [] }] }), 1), MistralPageContractError, 'an index with no cards is the card markup changing')
  await assert.rejects(loadV3Roster(stubPage({ rosters: [{ expected: 0, cards: [] }] }), 1), MistralPageContractError)
  await assert.rejects(loadV3Roster(stubPage({ rosters: [{ expected: 1, cards: [card('c1', '')] }] })), MistralPageContractError)
  await assert.rejects(loadV3Roster(stubPage({ rosters: [{ expected: 1, cards: [card('', 'X')] }] })), MistralPageContractError)
})

test('a history page with links but no matching incident URL is a contract failure, not a quiet page', async () => {
  await assert.rejects(readHistoryUrls(stubPage({ urls: [] })), MistralPageContractError)
  assert.deepEqual(await readHistoryUrls(stubPage({ urls: ['https://status.mistral.ai/incidents/a'] })), ['https://status.mistral.ai/incidents/a'])
})

test('v3 update rows split across two lists are all read, so a lost Resolved row cannot leave an incident open', () => {
  const doc = v3DocOf(V3_INCIDENT)
  const heading = [...doc.querySelectorAll('main h3')].find((h) => h.textContent.trim() === 'Updates')
  const first = heading.parentElement.querySelector('ul')
  const second = doc.createElement('ul')
  second.appendChild(first.lastElementChild)
  heading.parentElement.appendChild(second)
  assert.equal(parseUpdateRows(readIncidentPage(doc).rows).updates.length, 3)
})

test('a Rootly contract failure reaches the observation the Worker alerts on', async () => {
  const reports = []
  await assert.rejects(
    runWithMistralFeedObservation('https://worker.example', 'secret', async () => { throw new MistralPageContractError('moved') }, async (...args) => reports.push(args)),
    /moved/,
  )
  assert.deepEqual(reports, [['https://worker.example', 'secret', { delivery: 'not-posted', failure: 'page-contract' }]])
})

// ── update rows ─────────────────────────────────────────────────────────────────────
// The two fixtures are the `<main>` subtree of real incident pages, saved 2026-09-22 by a headed
// browser (the page is behind a Cloudflare managed challenge). `UNTITLED` is /incidents/b0a485d8-…,
// the one Mistral published with an empty `<h2>` — #1471 itself. `TITLED` is /incidents/bc85a3be-…,
// three updates including the `Monitoring` word the other lacks.
const fixture = (name) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8')
const docOf = (html) => {
  const window = new Window()
  window.document.body.innerHTML = html
  return window.document
}
const UNTITLED = () => docOf(fixture('rootly-incident-untitled.html'))
const TITLED = () => docOf(fixture('rootly-incident-titled.html'))

const CAPTURED_UNTITLED = readIncidentPage(UNTITLED()).rows

// ── the DOM read, over the real pages ─────────────────────────────────────────────────
// #1471 was a read no test could reach: the title came from a line offset in `document.body.innerText`
// and shifted by one when the provider left the title blank. These drive the shipped reader over the
// markup that produced that bug.

test('reads the real untitled page: empty title, both update rows', () => {
  const { title, rows } = readIncidentPage(UNTITLED())
  // '' — the element is THERE and the provider left it blank. Not null, which means a broken read.
  assert.strictEqual(title, '')
  assert.deepEqual(parseUpdateRows(rows).updates, [
    { status: 'Resolved', at: 'September 21, 2026 at 10:26 PM UTC', body: 'The incident has been resolved.' },
    { status: 'Investigating', at: 'September 21, 2026 at 10:12 PM UTC',
      body: 'We are currently investigating elevated error rates on Mistral Small 4.' },
  ])
})

test('reads the real titled page: the provider title, all three rows in page order', () => {
  const { title, rows } = readIncidentPage(TITLED())
  assert.strictEqual(title, 'Vibe Code Web model is experiencing failures in some existing sessions')
  assert.deepEqual(parseUpdateRows(rows).updates.map((u) => u.status),
    ['Resolved', 'Monitoring', 'Investigating'])
})

// The bug the old read produced: the start-date subtitle, one line below the blank title, became the
// incident's name. It sits in the same `<section>` as the title in the real markup.
test('never returns the start-date subtitle as the title', () => {
  for (const doc of [UNTITLED(), TITLED()]) {
    assert.ok(!/^[A-Z][a-z]+ \d{1,2}, \d{4} at /.test(readIncidentPage(doc).title ?? ''),
      'the date beside the title must never be read as the title')
  }
})

// The conflation #1471 is about, in its other direction: "our selector matched nothing" must not
// look like "the provider published no title", or a selector that moves renames every incident.
test('a page with no title element reads null, not empty', () => {
  const doc = UNTITLED()
  doc.querySelector('main h2').remove()
  assert.strictEqual(readIncidentPage(doc).title, null)
})

// The rows are read from every container under the panel, so a layout that splits them across two
// blocks cannot drop one with all the counters reading clean — losing the Resolved row that way
// publishes a permanently-ongoing incident that re-reads identically every cycle.
test('rows split across two sibling containers are all read', () => {
  const doc = UNTITLED()
  const heading = [...doc.querySelectorAll('main h3')].find((h) => h.textContent.trim() === 'Updates')
  const panel = heading.parentElement.nextElementSibling
  const list = panel.firstElementChild
  const second = doc.createElement('div')
  second.appendChild(list.lastElementChild)   // move the oldest row into its own block
  panel.appendChild(second)
  assert.strictEqual(parseUpdateRows(readIncidentPage(doc).rows).updates.length, 2)
})

// An update published with no body element: the row must still be a row, and its timestamp must not
// slide into the body slot.
test('a row whose body element is absent is still read', () => {
  const doc = UNTITLED()
  doc.querySelector('.trix-content').remove()
  const { updates, dropped } = parseUpdateRows(readIncidentPage(doc).rows)
  assert.strictEqual(dropped, 0)
  assert.deepEqual(updates[0], { status: 'Resolved', at: 'September 21, 2026 at 10:26 PM UTC', body: '' })
})

// The heading is the anchor for the whole row read; losing it must be LOUD, not a quiet empty page.
// Neither capture carries a second heading, so neither pins the scoping in `main h2` nor the
// heading-text match. A page with a second panel would otherwise anchor the row read to the wrong one.
test('the title comes from main, not from a heading elsewhere on the page', () => {
  const doc = UNTITLED()
  const stray = doc.createElement('h2')
  stray.textContent = 'Not the incident title'
  doc.body.insertBefore(stray, doc.body.firstChild)
  assert.strictEqual(readIncidentPage(doc).title, '')
})

test('the rows come from the Updates panel, not from another panel in main', () => {
  const doc = UNTITLED()
  const main = doc.querySelector('main')
  const other = doc.createElement('div')
  other.innerHTML = '<div><h3>Affected components</h3></div><div><div><div>x</div><div>OCR API</div></div></div>'
  main.insertBefore(other, main.firstChild)
  assert.deepEqual(parseUpdateRows(readIncidentPage(doc).rows).updates.map((u) => u.status),
    ['Resolved', 'Investigating'])
})

test('losing the Updates heading yields no rows, which refuses the incident', () => {
  const doc = UNTITLED()
  for (const h of [...doc.querySelectorAll('main h3')]) h.remove()
  assert.deepEqual(readIncidentPage(doc).rows, [])
})

// A row we cannot read may have been the Resolved one, and nothing here can tell which it was — an
// incident published without its end re-reads identically every cycle and never resolves. So ONE bad
// row voids the incident, and the scrape reports it as a failed read.
test('one unreadable row voids the whole incident, not just that row', () => {
  const { updates, dropped } = parseUpdateRows([
    ...CAPTURED_UNTITLED,
    ['Something', 'that is not an update', 'at all'],
  ])
  assert.strictEqual(dropped, 1)
  assert.deepEqual(updates, [], 'a partly-read incident must not publish the updates it did read')
})

// The axis neither capture varies: a row that renders a different number of cells. Identifying cells
// by position would put the timestamp in the body slot here and leave `at` undefined.
test('a row published with no body keeps its timestamp out of the body slot', () => {
  const { updates, dropped } = parseUpdateRows([['Identified', 'September 4, 2026 at 10:00 PM UTC']])
  assert.strictEqual(dropped, 0)
  assert.deepEqual(updates, [
    { status: 'Identified', at: 'September 4, 2026 at 10:00 PM UTC', body: '' },
  ])
})

test('a body that merely CONTAINS a status word does not become the status', () => {
  const { updates } = parseUpdateRows([
    ['Monitoring', 'Resolved for most users; we are still watching.', 'September 4, 2026 at 11:00 PM UTC'],
  ])
  assert.strictEqual(updates[0].status, 'Monitoring')
  assert.strictEqual(updates[0].body, 'Resolved for most users; we are still watching.')
})

test('a row whose timestamp cell is not a timestamp is dropped rather than published', () => {
  const { updates, dropped } = parseUpdateRows([
    ['Investigating', 'Something is wrong.', 'a few minutes ago'],
    ['Nonsense', 'body', 'September 4, 2026 at 10:00 PM UTC'],
  ])
  assert.deepEqual(updates, [])
  assert.strictEqual(dropped, 2)
})

test('whitespace in a cell is collapsed, and a missing row list is not a crash', () => {
  const { updates } = parseUpdateRows([['Resolved', '  The incident\n  has been   resolved. ',
    'September 4, 2026 at 10:00 PM UTC']])
  assert.strictEqual(updates[0].body, 'The incident has been resolved.')
  assert.deepEqual(parseUpdateRows(undefined), { updates: [], dropped: 0 })
})
