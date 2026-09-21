import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchService, SERVICES } from '../services'

// #1089 — the WIRING half. `instatus.test.ts` pins that the parser distinguishes an unreadable payload
// from a genuinely empty one; that says nothing about whether `fetchService` acts on the distinction.
// The bug lived in the acting, not the parsing: the badge is `hasOngoing ? 'degraded' : httpStatus`, so
// a failed parse collapsing to `[]` published a green badge — a false RECOVERY — while the incident was
// still open upstream. A pure-parser test would stay green through that entire failure.
//
// Drives the real `fetchService` entry point (the `auto-monitor-tag.test.ts` harness pattern) so the
// call chain parse → flag → derive is exercised, not a hand-assembled imitation of it.

// #1381 → #1390 — the fixture service is FAL. This suite has now been re-pointed twice for the same
// reason: Mistral migrated to Rootly, then Perplexity to incident.io, and a test that keeps driving a
// service which has left Instatus stops exercising the wiring it exists to guard while still passing.
// fal is the last service on Instatus, so the next such migration ends this suite rather than moving it.
// The payload flavour is incidental — `parseInstatusUptime` dispatches on the `__NUXT_DATA__` /
// `__next_f` marker in the BYTES, not on the service — and what is under test is what fetchService does
// with the parse RESULT. fal shares the `statusComponent: 'API'` the fixtures below name.
const instatusSvc = SERVICES.find((s) => s.id === 'fal')!

/** A structurally VALID Nuxt payload carrying one ONGOING incident. */
function healthyNuxtHtml() {
  const arr: unknown[] = [
    'Audio API Degraded', 'INVESTIGATING', '2026-07-17T07:55:56.406Z', 0, 'MEDIUM', '4288f6a2', [], [],
    { id: 5, name: 0, lastUpdateStatus: 1, created_at: 2, duration: 3, severity: 4, services: 6, incidentUpdates: 7 },
    [8],
    { incidents: 9 },
    { 'incidents-by-date-2026': 10 },
  ]
  return `<script id="__NUXT_DATA__" type="application/json">${JSON.stringify(arr)}</script>`
}

/**
 * Both fetches return HTTP 200 — that is the crux. The page is *reachable*, so `httpStatus` is
 * `operational`; only the incident payload is unreadable. A guard keyed on the HTTP status would miss
 * this entirely, which is exactly how the bug survived: #761 fixed a *throwing* scrape URL, and this
 * case never throws.
 */
function stubFetch(scrapeBody: string) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(scrapeBody, { status: 200 })))
}

afterEach(() => vi.unstubAllGlobals())

describe('#1089 — an unreadable Instatus payload must not publish a recovery', () => {
  it('does NOT return operational when the incident payload is unreadable', async () => {
    // The regression test proper. Pre-fix this returned `status: 'operational'` with no marker, and the
    // plugin monitor turned that into "✅ Mistral API has recovered".
    stubFetch('<html><body>we redesigned the status page</body></html>')
    const svc = await fetchService(instatusSvc, undefined, undefined, {})
    expect(svc.sourceUnknown, 'an unreadable source must be flagged, not silently trusted').toBe(true)
  })

  // #1233 — these cases assert the FLAG. Past the three-strike threshold the leg also publishes a
  // VERDICT, and nothing pinned which one: mutating this return to `degraded` was green across the whole
  // suite, because every test here observes the pre-threshold `operational` state. The tracking blob is
  // seeded with two prior failures so this call is the crossing.
  it('past the threshold it publishes `unknown`, not a fabricated `degraded`', async () => {
    stubFetch('<html><body>we redesigned the status page</body></html>')
    // Keyed by SERVICE ID, not by the binding above — the tracking blob is looked up by `config.id`.
    const store = { [instatusSvc.id]: { failCount: 2, failCountAt: new Date().toISOString() } }
    const svc = await fetchService(instatusSvc, undefined, undefined, store)
    expect({ status: svc.status, sourceUnknown: svc.sourceUnknown })
      .toEqual({ status: 'unknown', sourceUnknown: true })
    // #1233 invariant — an unreadable source carries NO incident. Several modules omit an `unknown`
    // branch because of this (the X drafts, the feed's fallback line, the region/calendar fallbacks).
    expect(svc.incidents).toEqual([])
  })

  it('control: below the threshold it still publishes operational — the ramp is unchanged', async () => {
    stubFetch('<html><body>we redesigned the status page</body></html>')
    const svc = await fetchService(instatusSvc, undefined, undefined, {})
    expect(svc.status).toBe('operational')
    expect(svc.sourceUnknown).toBe(true)
  })

  it('flags sourceUnknown even though the page returned HTTP 200', async () => {
    // Guards against "just check res.ok" — the page is fine, our read of it is not.
    stubFetch('<script id="__NUXT_DATA__" type="application/json">{oops</script>')
    const svc = await fetchService(instatusSvc, undefined, undefined, {})
    expect(svc.sourceUnknown).toBe(true)
  })

  it('leaves sourceUnknown unset on a healthy payload, and still reports the ongoing incident', async () => {
    // The false-positive direction. If this ever flips, every poll would claim an unreadable
    // source and the badge would be permanently caveated — worse than the bug being fixed.
    stubFetch(healthyNuxtHtml())
    const svc = await fetchService(instatusSvc, undefined, undefined, {})
    expect(svc.sourceUnknown).toBeUndefined()
    expect(svc.incidents.some((i) => i.status !== 'resolved'), 'the ongoing incident should survive').toBe(true)
  })

  it('a genuinely empty page is NOT flagged — quiet is not the same as unreadable', async () => {
    // The distinction the whole change rests on, asserted at the wiring level rather than the parser.
    const arr: unknown[] = ['x', 'y', 'z', 0, 'MEDIUM', 'id', [], [], {}, [], { incidents: 9 }, { 'incidents-by-date-2026': 10 }]
    stubFetch(`<script id="__NUXT_DATA__" type="application/json">${JSON.stringify(arr)}</script>`)
    const svc = await fetchService(instatusSvc, undefined, undefined, {})
    expect(svc.sourceUnknown).toBeUndefined()
  })
})

describe('#1089 review — the scrape FETCH failures, not just the parse', () => {
  // Review round 1 (Critical): the first cut only covered "scrape returned 200, payload unreadable".
  // A 404 or a thrown fetch skipped the parse block entirely, left `incidents` empty with no marker,
  // and fell through to `httpStatus` exactly as before. The 404 case IS #761's URL-drift scenario —
  // the likeliest real trigger — so the fix would have missed the most probable cause in production.

  // These two used to discriminate the scrape fetch by URL (`includes('/activity/')`), which worked
  // while this suite ran against Mistral: its `instatusUrl` was `…/activity/page/1` and its
  // `statusUrl` was the root. #1381 moved Mistral off Instatus, and BOTH remaining Instatus services
  // set `instatusUrl` equal to `statusUrl` — so that predicate matches nothing, every fetch returns
  // the healthy branch, and both tests silently degenerate into the parse-failure case above.
  //
  // The scrape is therefore identified by ORDER: `fetchService` issues the two inside one
  // `Promise.all` whose array literal puts `statusUrl` first and the scrape second. `expectTwoSameUrl`
  // asserts that premise on every run, so if the shape changes these fail loudly instead of going
  // hollow again — which is the actual defect being fixed here.
  // Call 1 returns a HEALTHY payload, not filler. An unparseable root response flags `sourceUnknown`
  // by itself, so filler would make these pass with the scrape succeeding — verified: with the
  // failure disarmed they stayed green, which is the same hollowness this block set out to fix.
  function stubScrapeFailure(fail: () => Response | never) {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url))
      if (calls.length === 2) return fail()
      return new Response(healthyNuxtHtml(), { status: 200 })
    }))
    return calls
  }

  function expectTwoSameUrl(calls: string[]) {
    expect(calls, 'the scrape must be a SECOND fetch, or "call 2" identifies nothing').toHaveLength(2)
    expect(calls[0], 'root and scrape URLs are equal here — order is the only discriminator').toBe(calls[1])
  }

  it('a 404 scrape does not read as "no incidents"', async () => {
    const calls = stubScrapeFailure(() => new Response('nope', { status: 404 }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const trackingStore = {}
    const svc = await fetchService(instatusSvc, undefined, undefined, trackingStore)
    expectTwoSameUrl(calls)
    expect(svc.sourceUnknown, 'a 404 scrape must flag the source, not publish operational').toBe(true)
    expect(trackingStore).toEqual({ fal: { failCount: 1, failCountAt: expect.any(String), sourceReadFailure: { source: 'instatus-scrape', phase: 'http', httpStatus: 404 } } })
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'status_source_read_failure', serviceId: 'fal', source: 'instatus-scrape', phase: 'http', httpStatus: 404, latencyMs: expect.any(Number) }))
  })

  it('a throwing scrape does not read as "no incidents"', async () => {
    const calls = stubScrapeFailure(() => { throw new Error('ECONNRESET') })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const trackingStore = {}
    const svc = await fetchService(instatusSvc, undefined, undefined, trackingStore)
    expectTwoSameUrl(calls)
    expect(svc.sourceUnknown).toBe(true)
    expect(trackingStore).toEqual({ fal: { failCount: 1, failCountAt: expect.any(String), sourceReadFailure: { source: 'instatus-scrape', phase: 'transport', errorKind: 'network' } } })
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'status_source_read_failure', serviceId: 'fal', source: 'instatus-scrape', phase: 'transport', errorKind: 'network', latencyMs: expect.any(Number) }))
  })

  it('clears a prior scrape HTTP cause when the later unreadable payload has no bounded fetch cause', async () => {
    const responses = [
      new Response(healthyNuxtHtml(), { status: 200 }),
      new Response('unavailable', { status: 503 }),
      new Response('<html><body>redesigned</body></html>', { status: 200 }),
      new Response('<html><body>redesigned</body></html>', { status: 200 }),
    ]
    vi.stubGlobal('fetch', vi.fn(async () => responses.shift()!))
    const trackingStore = {}

    await fetchService(instatusSvc, undefined, undefined, trackingStore)
    expect(trackingStore).toEqual({ fal: { failCount: 1, failCountAt: expect.any(String), sourceReadFailure: { source: 'instatus-scrape', phase: 'http', httpStatus: 503 } } })

    await fetchService(instatusSvc, undefined, undefined, trackingStore)
    expect(trackingStore).toEqual({ fal: { failCount: 2, failCountAt: expect.any(String) } })
  })

  it('carries the measured latency through the guard', async () => {
    // Review round 1 (Important 3): the early return dropped `latency` — all three Instatus services
    // are category:'api', so this was real data loss on every parse failure.
    stubFetch('<html><body>redesigned</body></html>')
    const svc = await fetchService(instatusSvc, undefined, undefined, {})
    expect(svc.sourceUnknown).toBe(true)
    expect(svc.latency, 'latency is measured independently of the scrape').not.toBeNull()
  })

  it('carries the uptime provenance with the uptime figure', async () => {
    // Review round 1 (Important 4): `uptime30d` shipped with no `uptimeSource`, which ServiceDetails,
    // the Uptime page and monthly-archive all read as "unavailable".
    //
    // The main-page fetch is INDEPENDENT of the scrape, so it must carry a real uptime payload here or
    // the assertion is vacuous — an earlier version of this test guarded on `if (uptime != null)` with
    // a fixture that had none, so it asserted nothing at all while reading as coverage.
    const NOW = Date.now(), DAY = 86_400_000
    const arr: unknown[] = ['API', 99.599, 'ignored']
    const dayIdx: number[] = []
    for (let i = 0; i < 90; i++) {
      arr.push([]); const evList = arr.length - 1
      arr.push({ date: new Date(NOW - i * DAY).toISOString(), events: evList })
      dayIdx.push(arr.length - 1)
    }
    arr.push(dayIdx); const daysList = arr.length - 1
    arr.push({ id: 0, name: 0, uptime: 1, days: daysList })
    const mainPage = `<script id="__NUXT_DATA__" type="application/json">${JSON.stringify(arr)}</script>`

    // This test used a 404-on-`/activity/` stub to stage "main page parses, scrape does not". That
    // predicate has been dead since the suite moved off Mistral, and staging it by call order does
    // not help either: `mainPage` is a components/uptime payload, so the scrape half fails to parse
    // whichever response it gets, and the 404 arm changed nothing. Removed rather than restaged —
    // whether a FAILED scrape fetch flags the source is the `#1089` block's question, asserted there
    // with a mutation behind it. What is left here is this test's own claim: a parse failure must not
    // cost the uptime figure or its provenance.
    stubFetch(mainPage)
    const svc = await fetchService(instatusSvc, undefined, undefined, {})
    expect(svc.sourceUnknown).toBe(true)
    expect(svc.uptime30d, 'fixture must actually yield an uptime, else this test is vacuous').not.toBeNull()
    expect(svc.uptimeSource, 'uptime must travel with its provenance').toBe('official')
  })
})
