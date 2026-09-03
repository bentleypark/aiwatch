import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchService, SERVICES } from '../services'
import { normalizeCachedService } from '../status-verdict'
import { AISTUDIO_ENDPOINT } from '../parsers/aistudio'
import type { ServiceConfig, ServiceStatus } from '../types'
import type { KVLike, TrackingStateBlob } from '../utils'

// #1234 — the WIRING half of the disclosure guard on the generic path's two fetch legs.
//
// #1089 (Instatus) and #1123 (OnlineOrNot) gave their arms a "we could not read this source" verdict;
// #1212 gave the Azure-RSS and AWS-Health arms the same. The RSS / gcloud / BetterStack legs of the
// GENERIC path never got it: a non-ok scrape skipped the `else if (scrapeRes?.ok)` arm entirely, so
// `incidents` stayed `[]`, `hasOngoing` was false, `derivedStatus` fell through to the MAIN page's
// HTTP code, and — because nothing incremented `parseErrors` — `resetFetchFailure` cleared the streak
// every cycle. Plain green badge, no flag, no counter, forever.
//
// These tests drive the REAL `fetchService`, not a pure helper: the defect lived entirely in the
// wiring (which arm is entered, which accounting branch runs), so a pure-fn test would have stayed
// green through all of it — the `debugging_fix_the_called_path_not_the_tested_twin` shape.
//
// The subjects are the three leg shapes, one service each: `xai` (RSS only), `gemini` (gcloud), and
// `together` / `helicone` (RSS + BetterStack). Every one of them has no `apiUrl`, which is what puts
// them on this path rather than the Statuspage one.

const xai = SERVICES.find((s) => s.id === 'xai')!
const gemini = SERVICES.find((s) => s.id === 'gemini')!
const together = SERVICES.find((s) => s.id === 'together')!

function mockKV(store: Record<string, string> = {}): KVNamespace {
  return {
    get: async (k: string) => store[k] ?? null,
    put: async (k: string, v: string) => { store[k] = v },
    delete: async (k: string) => { delete store[k] },
    list: async () => ({ keys: [], list_complete: true, cursor: undefined }),
  } as unknown as KVLike as unknown as KVNamespace
}

const keysStartingWith = (store: Record<string, string>, prefix: string) =>
  Object.keys(store).filter((k) => k.startsWith(prefix))

const reasonsFor = (store: Record<string, string>, svcId: string) => {
  const booked = keysStartingWith(store, 'instatus-parse-fail:')
  if (booked.length === 0) return null
  return JSON.parse(store[booked[0]]).counts[svcId] ?? null
}

/** Route by URL so ONE leg can fail while the others answer normally — the whole premise here is that
 *  the main-page fetch and the incident-source fetch are independent, and the bug was reading the
 *  former's HTTP code as a verdict about the latter. A single blanket stub cannot express that. */
function routedFetch(routes: Array<[(url: string) => boolean, () => Response | Promise<Response>]>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(typeof input === 'string' || input instanceof URL ? input : input.url)
    for (const [match, respond] of routes) if (match(url)) return await respond()
    return new Response('<html>ok</html>', { status: 200 })
  })
}

const isXaiFeed = (u: string) => u.endsWith('/feed.xml')
const isGcloud = (u: string) => u.includes('status.cloud.google.com/incidents.json')
const isTogetherFeed = (u: string) => u.endsWith('status.together.ai/feed')
const isIndexJson = (u: string) => u.endsWith('/index.json')
// The aistudio RPC lives on `alkalimakersuite-pa.clients6.google.com`, NOT on `aistudio.google.com`
// (which is gemini's `statusUrl`). Matching the endpoint constant rather than a hand-written host is
// what keeps this from silently routing to the catch-all and failing for the wrong reason.
const isAistudio = (u: string) => u === AISTUDIO_ENDPOINT

/** A readable xAI feed listing nothing — the ordinary state, and the false-positive control. */
const QUIET_XAI_FEED = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel><title>xAI Status</title><lastBuildDate>Mon, 01 Sep 2026 00:00:00 Z</lastBuildDate></channel></rss>`

/** aistudio's proto envelope carrying no incidents — keeps gemini's SECOND source healthy so a
 *  `parseErrors` bump from it cannot be mistaken for the gcloud leg's booking. */
const EMPTY_AISTUDIO = JSON.stringify([[[]]])

/** A trailing 30-day `status_history`, the field the uptime figure and the 30-day calendar are BOTH
 *  computed from — an index.json without it parses to a null uptime and no calendar, so omitting it
 *  would make the carry-over test below assert nothing (`feedback_faithful_fixtures`). */
function hist(downtimeOnLastDay = 0) {
  const days = []
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10)
    const sec = i === 0 ? downtimeOnLastDay : 0
    days.push({ day: d, status: sec > 0 ? 'downtime' : 'operational', downtime_duration: sec, maintenance_duration: 0 })
  }
  return days
}

/** BetterStack `index.json` whose aggregate state is a real, provider-declared outage: `downtime`
 *  with a majority of resources down is what `parseBetterStackStatus` maps to `'down'`. The current
 *  day's history carries the downtime that state implies, so the roll-up and the daily record agree. */
const INDEX_JSON_DOWN = JSON.stringify({
  data: { attributes: { aggregate_state: 'downtime', timezone: 'America/Adak' } },
  included: [
    { type: 'status_page_resource', id: '1', attributes: { public_name: 'API', status: 'downtime', availability: 0.81, status_history: hist(7200) } },
    { type: 'status_page_resource', id: '2', attributes: { public_name: 'Inference', status: 'downtime', availability: 0.79, status_history: hist(7200) } },
  ],
})

/** The same page, all-clear. */
const INDEX_JSON_OK = JSON.stringify({
  data: { attributes: { aggregate_state: 'operational', timezone: 'America/Adak' } },
  included: [
    { type: 'status_page_resource', id: '1', attributes: { public_name: 'API', status: 'operational', availability: 0.999, status_history: hist() } },
    { type: 'status_page_resource', id: '2', attributes: { public_name: 'Inference', status: 'operational', availability: 0.998, status_history: hist() } },
  ],
})

/** All-clear roll-up, but with one 30-minute outage inside the trailing window. The 30-day calendar
 *  is derived from downtime days, so a PERFECTLY clean history yields no calendar at all — a fixture
 *  with none would make the carry-over assertion below vacuous rather than strict. */
const INDEX_JSON_WITH_A_BAD_DAY = JSON.stringify({
  data: { attributes: { aggregate_state: 'operational', timezone: 'America/Adak' } },
  included: [
    { type: 'status_page_resource', id: '1', attributes: { public_name: 'API', status: 'operational', availability: 0.999, status_history: hist(1800) } },
    { type: 'status_page_resource', id: '2', attributes: { public_name: 'Inference', status: 'operational', availability: 0.998, status_history: hist(1800) } },
  ],
})

/** Aggregate `degraded` with every resource non-operational — above `BETTERSTACK_DEGRADE_THRESHOLD`,
 *  so `parseBetterStackStatus` returns `'degraded'` rather than collapsing it to operational. */
const INDEX_JSON_DEGRADED = JSON.stringify({
  data: { attributes: { aggregate_state: 'degraded', timezone: 'America/Adak' } },
  included: [
    { type: 'status_page_resource', id: '1', attributes: { public_name: 'API', status: 'degraded', availability: 0.91, status_history: hist(1800) } },
    { type: 'status_page_resource', id: '2', attributes: { public_name: 'Inference', status: 'degraded', availability: 0.92, status_history: hist(1800) } },
  ],
})

const EMPTY_FEED = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel><title>Incidents</title></channel></rss>`

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('#1234 — the RSS leg (xai)', () => {
  it('a 503 scrape does NOT clear the failure streak and is disclosed', async () => {
    // The regression proper. Clearing the streak is the load-bearing half: it is what stops the
    // counter ever reaching 3, so the badge could stay green through an unbounded run of bad reads.
    const store: Record<string, string> = {}
    const trackingStore: TrackingStateBlob = {}
    vi.stubGlobal('fetch', routedFetch([[isXaiFeed, () => new Response('upstream error', { status: 503 })]]))

    const svc = await fetchService(xai, undefined, mockKV(store), trackingStore)

    expect(trackingStore.xai?.failCount, 'an unreadable incident source is a failed read, not a success').toBe(1)
    expect(svc.sourceUnknown, 'and it is disclosed as OUR read failing, not a verdict about xAI').toBe(true)
    expect(svc.incidents, 'nothing was readable, so nothing may be published').toEqual([])
    expect(svc.status, 'strike 1 of the ramp still publishes the badge — flagged, not fabricated').toBe('operational')
  })

  it('the third consecutive bad read crosses into unknown', async () => {
    // `withUnreadFeedFlag`'s contract: `sourceUnknown` on the FIRST failed read, `status: 'unknown'`
    // only once `trackFetchFailure` says `shouldDegrade`. Both halves are pinned, here and above.
    const store: Record<string, string> = {}
    const trackingStore: TrackingStateBlob = { xai: { failCount: 2, failCountAt: new Date().toISOString() } }
    vi.stubGlobal('fetch', routedFetch([[isXaiFeed, () => new Response('nope', { status: 503 })]]))

    const svc = await fetchService(xai, undefined, mockKV(store), trackingStore)

    expect(svc.status).toBe('unknown')
    expect(svc.sourceUnknown).toBe(true)
    expect(svc.incidentSourceStale, 'the choke point drops it out of the rankings (#1268)').toBe(true)
  })

  it('books the reason durably, so the rate outlives the 48h fetch-fail window', async () => {
    const store: Record<string, string> = {}
    vi.stubGlobal('fetch', routedFetch([[isXaiFeed, () => new Response('nope', { status: 404 })]]))

    await fetchService(xai, undefined, mockKV(store), {})

    expect(reasonsFor(store, 'xai'), 'booked on the FIRST bad read, not only at the threshold')
      .toEqual({ 'rss-unreadable': 1 })
  })

  it('a THROWN scrape fetch is the same verdict as a non-ok one', async () => {
    // Deliberate: the Instatus arm this mirrors tests `scrapeRes?.ok`, which is false for both a null
    // (the fetch's own `.catch`) and a non-ok response — they are the same epistemic state, "we could
    // not read the source". A throw already bumped `parseErrors`; what it never got was the
    // disclosure, so the badge went green on the worst failure mode of the three.
    const store: Record<string, string> = {}
    const trackingStore: TrackingStateBlob = {}
    vi.stubGlobal('fetch', routedFetch([[isXaiFeed, () => { throw new Error('ECONNRESET') }]]))

    const svc = await fetchService(xai, undefined, mockKV(store), trackingStore)

    expect(svc.sourceUnknown).toBe(true)
    expect(reasonsFor(store, 'xai')).toEqual({ 'rss-unreadable': 1 })
    expect(trackingStore.xai?.failCount).toBe(1)
  })

  it('a readable feed is NOT flagged — the false-positive direction', async () => {
    // If this flips, xai carries a "we cannot read this source" caveat every ordinary day and never
    // clears its streak: a worse failure than the one being fixed, and invisible in the same way.
    const store: Record<string, string> = {}
    const trackingStore: TrackingStateBlob = { xai: { failCount: 2, failCountAt: new Date().toISOString() } }
    vi.stubGlobal('fetch', routedFetch([[isXaiFeed, () => new Response(QUIET_XAI_FEED, { status: 200 })]]))

    const svc = await fetchService(xai, undefined, mockKV(store), trackingStore)

    expect(svc.status).toBe('operational')
    expect(svc.sourceUnknown).toBeUndefined()
    expect(trackingStore.xai, 'a readable source clears the streak').toBeUndefined()
    expect(keysStartingWith(store, 'instatus-parse-fail:'), 'nothing unreadable happened').toEqual([])
  })
})

describe('#1234 — the gcloud leg (gemini)', () => {
  it('an unreadable incidents.json is disclosed and keeps the streak', async () => {
    // gemini's aistudio leg answers normally here on purpose: it has its own `parseErrors` path, so
    // leaving it broken would let this assertion pass for the wrong reason.
    const store: Record<string, string> = {}
    const trackingStore: TrackingStateBlob = {}
    vi.stubGlobal('fetch', routedFetch([
      [isGcloud, () => new Response('gateway timeout', { status: 504 })],
      [isAistudio, () => new Response(EMPTY_AISTUDIO, { status: 200 })],
    ]))

    const svc = await fetchService(gemini, undefined, mockKV(store), trackingStore)

    expect(svc.sourceUnknown).toBe(true)
    expect(reasonsFor(store, 'gemini')).toEqual({ 'gcloud-unreadable': 1 })
    expect(trackingStore.gemini?.failCount).toBe(1)
  })

  it('the third consecutive bad read crosses into unknown', async () => {
    // Not a duplicate of the xai case: `legShouldDegrade` is computed ONCE for both legs, so a
    // change that made the escalation leg-specific would leave the RSS test green while gcloud and
    // BetterStack silently never escalated. Verified by mutation — gating the assignment on
    // `legFailure === 'rss-unreadable'` survives the suite without this test and its sibling below.
    const store: Record<string, string> = {}
    const trackingStore: TrackingStateBlob = { gemini: { failCount: 2, failCountAt: new Date().toISOString() } }
    vi.stubGlobal('fetch', routedFetch([
      [isGcloud, () => new Response('gateway timeout', { status: 504 })],
      [isAistudio, () => new Response(EMPTY_AISTUDIO, { status: 200 })],
    ]))

    const svc = await fetchService(gemini, undefined, mockKV(store), trackingStore)

    expect(svc.status).toBe('unknown')
    expect(svc.incidentSourceStale, 'and it leaves the rankings, like any unreadable source').toBe(true)
  })

  it('a readable incidents.json is NOT flagged', async () => {
    const store: Record<string, string> = {}
    const trackingStore: TrackingStateBlob = { gemini: { failCount: 2, failCountAt: new Date().toISOString() } }
    vi.stubGlobal('fetch', routedFetch([
      [isGcloud, () => new Response(JSON.stringify([]), { status: 200 })],
      [isAistudio, () => new Response(EMPTY_AISTUDIO, { status: 200 })],
    ]))

    const svc = await fetchService(gemini, undefined, mockKV(store), trackingStore)

    expect(svc.sourceUnknown).toBeUndefined()
    expect(trackingStore.gemini).toBeUndefined()
    expect(keysStartingWith(store, 'instatus-parse-fail:')).toEqual([])
  })
})

describe('#1234 — the BetterStack index.json leg (together)', () => {
  it('an unreadable index.json is disclosed instead of silently becoming the main page HTTP code', async () => {
    // `derivedStatus = betterStackStat ?? httpStatus`. A null `betterStackStat` substitutes the
    // marketing page's code for the provider's own aggregate state. The substitution stays — there is
    // nothing better to publish — but `sourceUnknown` makes it no longer silent, which is the whole
    // of checklist item 3.
    const store: Record<string, string> = {}
    const trackingStore: TrackingStateBlob = {}
    vi.stubGlobal('fetch', routedFetch([
      [isIndexJson, () => new Response('bad gateway', { status: 502 })],
      [isTogetherFeed, () => new Response(EMPTY_FEED, { status: 200 })],
    ]))

    const svc = await fetchService(together, undefined, mockKV(store), trackingStore)

    expect(svc.sourceUnknown).toBe(true)
    expect(reasonsFor(store, 'together')).toEqual({ 'betterstack-unreadable': 1 })
    expect(trackingStore.together?.failCount).toBe(1)
  })

  it('the third consecutive bad read crosses into unknown', async () => {
    // The BetterStack half of the same mutation gap — see the gcloud case above.
    const store: Record<string, string> = {}
    const trackingStore: TrackingStateBlob = { together: { failCount: 2, failCountAt: new Date().toISOString() } }
    vi.stubGlobal('fetch', routedFetch([
      [isIndexJson, () => new Response('bad gateway', { status: 502 })],
      [isTogetherFeed, () => new Response(EMPTY_FEED, { status: 200 })],
    ]))

    const svc = await fetchService(together, undefined, mockKV(store), trackingStore)

    expect(svc.status).toBe('unknown')
    expect(svc.incidentSourceStale).toBe(true)
  })

  it('a THROWN index.json fetch is the same verdict as a non-ok one', async () => {
    // The twin of the scrape leg's throw case above, and the reason its guard is keyed on
    // `config.betterStackUrl` rather than on `betterStackRes` being non-null: a thrown fetch resolves
    // to null through its own `.catch`, so keying on the response would book nothing. Without this
    // test that key choice is unguarded — reverting it leaves the whole file green while the
    // disclosure AND the durable counter both vanish.
    const store: Record<string, string> = {}
    const trackingStore: TrackingStateBlob = {}
    vi.stubGlobal('fetch', routedFetch([
      [isIndexJson, () => { throw new Error('ECONNRESET') }],
      [isTogetherFeed, () => new Response(EMPTY_FEED, { status: 200 })],
    ]))

    const svc = await fetchService(together, undefined, mockKV(store), trackingStore)

    expect(svc.sourceUnknown).toBe(true)
    expect(reasonsFor(store, 'together')).toEqual({ 'betterstack-unreadable': 1 })
    expect(trackingStore.together?.failCount).toBe(1)
  })

  it('both legs readable → no flag, and the streak clears', async () => {
    const store: Record<string, string> = {}
    const trackingStore: TrackingStateBlob = { together: { failCount: 2, failCountAt: new Date().toISOString() } }
    vi.stubGlobal('fetch', routedFetch([
      [isIndexJson, () => new Response(INDEX_JSON_OK, { status: 200 })],
      [isTogetherFeed, () => new Response(EMPTY_FEED, { status: 200 })],
    ]))

    const svc = await fetchService(together, undefined, mockKV(store), trackingStore)

    expect(svc.status).toBe('operational')
    expect(svc.sourceUnknown).toBeUndefined()
    expect(trackingStore.together).toBeUndefined()
    expect(keysStartingWith(store, 'instatus-parse-fail:')).toEqual([])
  })
})

describe('#1234 — the disclosure is scoped to the FALSE GREEN, and books regardless', () => {
  // Round 2 rewrite. Three defects came out of one invention: this path originally passed
  // `derivedStatus` straight through beside `sourceUnknown`, which (a) emitted `degraded` +
  // `sourceUnknown` — the pair `normalizeCachedService` decodes as a pre-#1233 payload and rewrites,
  // so cached surfaces and `/api/status` disagreed within a cycle; then, once that was suppressed,
  // (b) converted a live corroborated outage into `unknown` at strike 1 and (c) erased a readable
  // provider `down` from strike 3.
  //
  // The invention was the problem: every sibling arm (Instatus #1089, OnlineOrNot #1123, AWS/Azure
  // #1212, the 5xx/throw returns) publishes `shouldDegrade ? 'unknown' : 'operational'`, and a fifth
  // behaviour had to be right about interactions none of them face. So the wire disclosure is scoped
  // to the case #1234 actually measured — a verdict that would otherwise be a FALSE GREEN, which is
  // what all four services in the issue's table published. A `degraded`/`down` verdict is left exactly
  // as it is today: it is not a false all-clear, and this issue never measured it.
  //
  // The BOOKING is not scoped. `recordParseFailure` and `trackFetchFailure` run on every unreadable
  // leg whatever the verdict, so the durable counter — the thing checklist item 4 asked for — still
  // answers "how often does this happen" on every path.

  it('a live corroborated outage survives an unreadable leg', async () => {
    // gemini reads TWO incident sources. A 504 on `incidents.json` must not turn an aistudio incident
    // that we read perfectly into "we cannot read this service".
    const store: Record<string, string> = {}
    const aistudioLive = JSON.stringify([[[
      ['live-now', 'Gemini API elevated errors', 1, [[1, 't', ['1776466800'], 'Detected']], 1, [1]],
    ]]])
    vi.stubGlobal('fetch', routedFetch([
      [isGcloud, () => new Response('gateway timeout', { status: 504 })],
      [isAistudio, () => new Response(aistudioLive, { status: 200 })],
    ]))

    const svc = await fetchService(gemini, undefined, mockKV(store), {})

    expect(svc.status, 'the outage we CAN see is still the answer').toBe('degraded')
    expect(svc.incidents.length, 'and the incident is still published').toBeGreaterThan(0)
    expect(svc.sourceUnknown, 'no false-green to disclose — the badge already says something is wrong').toBeUndefined()
    expect(reasonsFor(store, 'gemini'), 'but the unreadable leg is still BOOKED').toEqual({ 'gcloud-unreadable': 1 })
  })

  it('a readable provider DEGRADED verdict survives a dead scrape leg', async () => {
    const store: Record<string, string> = {}
    vi.stubGlobal('fetch', routedFetch([
      [isTogetherFeed, () => new Response('nope', { status: 503 })],
      [isIndexJson, () => new Response(INDEX_JSON_DEGRADED, { status: 200 })],
    ]))

    const svc = await fetchService(together, undefined, mockKV(store), {})

    expect(svc.status).toBe('degraded')
    expect(svc.sourceUnknown).toBeUndefined()
    expect(reasonsFor(store, 'together')).toEqual({ 'rss-unreadable': 1 })
  })

  it('a readable provider DOWN verdict survives, even past the three-strike ramp', async () => {
    // The ramp must not be able to erase a verdict read from a source that never failed. Seeded at
    // the crossing, which is where the earlier shape replaced `down` with `unknown`.
    const store: Record<string, string> = {}
    const trackingStore: TrackingStateBlob = { together: { failCount: 2, failCountAt: new Date().toISOString() } }
    vi.stubGlobal('fetch', routedFetch([
      [isTogetherFeed, () => new Response('nope', { status: 503 })],
      [isIndexJson, () => new Response(INDEX_JSON_DOWN, { status: 200 })],
    ]))

    const svc = await fetchService(together, undefined, mockKV(store), trackingStore)

    expect(svc.status).toBe('down')
    expect(svc.sourceUnknown).toBeUndefined()
  })

  it('a whole status host that is 5xx keeps its degraded verdict and books the leg', async () => {
    // The feed and the main page share a host, so they fail together and `httpStatus` is `degraded`.
    // That is what this published before the issue and what it publishes after — the change here is
    // the booking, not the badge.
    const store: Record<string, string> = {}
    const trackingStore: TrackingStateBlob = {}
    vi.stubGlobal('fetch', routedFetch([[() => true, () => new Response('upstream error', { status: 503 })]]))

    const svc = await fetchService(xai, undefined, mockKV(store), trackingStore)

    expect(svc.status).toBe('degraded')
    expect(svc.sourceUnknown).toBeUndefined()
    expect(reasonsFor(store, 'xai')).toEqual({ 'rss-unreadable': 1 })
    expect(trackingStore.xai?.failCount, 'and the streak still climbs').toBe(1)
  })

  it('no verdict this path publishes is the retired `degraded` + `sourceUnknown` pair', async () => {
    // `normalizeCachedService` rewrites that pair on every CACHED read, resting on "a payload written
    // by the current worker already carries `unknown`". Asserted as the invariant across the four
    // verdict shapes above rather than as a status spelling, since the spelling is what kept moving.
    const cases: Array<[string, Array<[(u: string) => boolean, () => Response]>, typeof xai]> = [
      ['host 5xx', [[() => true, () => new Response('x', { status: 503 })]], xai],
      ['feed dead, provider degraded', [[isTogetherFeed, () => new Response('x', { status: 503 })], [isIndexJson, () => new Response(INDEX_JSON_DEGRADED, { status: 200 })]], together],
      ['feed dead, provider down', [[isTogetherFeed, () => new Response('x', { status: 503 })], [isIndexJson, () => new Response(INDEX_JSON_DOWN, { status: 200 })]], together],
      ['index.json dead, feed quiet', [[isIndexJson, () => new Response('x', { status: 502 })], [isTogetherFeed, () => new Response(EMPTY_FEED, { status: 200 })]], together],
    ]
    for (const [label, routes, cfg] of cases) {
      vi.stubGlobal('fetch', routedFetch(routes))
      const svc = await fetchService(cfg, undefined, mockKV({}), {})
      expect(normalizeCachedService(svc), `${label}: cached surfaces must decode to what /api/status served`).toBe(svc)
    }
  })
})

describe('#1234 — when BOTH legs fail in one cycle', () => {
  it('attributes the SCRAPE leg, and still tracks exactly one failure', async () => {
    // The coalesce is `scrapeLegFailure ?? betterStackLegFailure`: scrape-first because the scrape is
    // the incident source, the thing whose absence makes an empty list read as health. Pinned because
    // the order is otherwise unobservable — reversing it survives every other test in this file.
    // The count matters too: two failed legs are one unreadable CYCLE, not two strikes, or a service
    // with both legs configured would cross the three-strike ramp at a different rate than one leg.
    const store: Record<string, string> = {}
    const trackingStore: TrackingStateBlob = {}
    vi.stubGlobal('fetch', routedFetch([
      [isTogetherFeed, () => new Response('nope', { status: 503 })],
      [isIndexJson, () => new Response('bad gateway', { status: 502 })],
    ]))

    const svc = await fetchService(together, undefined, mockKV(store), trackingStore)

    expect(reasonsFor(store, 'together')).toEqual({ 'rss-unreadable': 1 })
    expect(trackingStore.together?.failCount, 'one cycle, one strike').toBe(1)
    expect(svc.sourceUnknown).toBe(true)
  })
})

describe('#1234 — a failed leg must not discard what the OTHER leg read', () => {
  // This is why the fix flags on the normal return instead of taking the Instatus guard's early
  // return. The two legs are independent fetches: an early return would answer a dead RSS feed by
  // throwing away a perfectly readable uptime figure, component list and 30-day calendar — turning
  // one unreadable list into wholesale data loss, which is the failure the Instatus guard's own
  // comment goes out of its way to avoid.
  it('a dead RSS feed keeps the BetterStack uptime, components and calendar', async () => {
    const store: Record<string, string> = {}
    vi.stubGlobal('fetch', routedFetch([
      [isTogetherFeed, () => new Response('nope', { status: 503 })],
      [isIndexJson, () => new Response(INDEX_JSON_WITH_A_BAD_DAY, { status: 200 })],
    ]))

    const svc = await fetchService(together, undefined, mockKV(store), {})

    expect(svc.sourceUnknown, 'still disclosed').toBe(true)
    expect(svc.uptime30d, 'the surviving leg measured this — dropping it is not a safer answer').not.toBeNull()
    expect(svc.components?.length ?? 0).toBeGreaterThan(0)
    expect(svc.calendarDays, 'the 30-day calendar the surviving leg supplies').toBe(30)
  })

})

describe('#1234 — a MISSING scrape configuration is not a failed read', () => {
  it('a BetterStack-only service books nothing from the bare else arm', async () => {
    // The arm this fix extends is also the genuine "no parser matched" arm: it is reached both when a
    // configured scrape came back unreadable AND when no scrape was configured at all. Booking the
    // second case would flag such a service on every poll, forever, for doing nothing wrong.
    //
    // Driven from a SYNTHETIC config on purpose. No service on the roster has this shape today —
    // `bedrock` / `azureopenai` / `deepseekapp` are the only scrape-less ones and each takes a
    // different arm entirely (AWS Health, Azure RSS, Flashduty), so none of them reaches this branch.
    // Using one of them here would assert against a code path this change never touches. The shape is
    // reachable the moment a BetterStack-only service is added, which is what makes it worth pinning.
    const betterStackOnly: ServiceConfig = { ...together, id: 'bs-only-fixture', rssFeedUrl: undefined }

    const store: Record<string, string> = {}
    const trackingStore: TrackingStateBlob = {}
    vi.stubGlobal('fetch', routedFetch([[isIndexJson, () => new Response(INDEX_JSON_OK, { status: 200 })]]))

    const svc = await fetchService(betterStackOnly, undefined, mockKV(store), trackingStore)

    expect(svc.sourceUnknown, 'nothing was unreadable — there was simply nothing to scrape').toBeUndefined()
    expect(keysStartingWith(store, 'instatus-parse-fail:')).toEqual([])
    expect(trackingStore['bs-only-fixture'], 'a healthy cycle clears rather than tracks').toBeUndefined()
  })
})
