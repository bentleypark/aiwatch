import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchService, SERVICES } from '../services'
import { MISTRAL_FEED_KV_KEY, type RootlyFeed } from '../parsers/rootly'

// #1381 — the WIRING half. `parsers/__tests__/rootly.test.ts` pins that the pure functions read the
// payload correctly; that says nothing about whether `fetchService` reaches them. The failure this
// guards is the one that already happened once on this service: the config said one thing, the read
// path did another, and every pure test stayed green while production published nothing.
//
// Drives the real `fetchService` entry point so config → KV read → normalize → flag runs end to end.

const mistral = SERVICES.find((s) => s.id === 'mistral')!

/** The live configured scope, read from the config rather than restated — a fixture supplying a
 *  SUBSET is now `unknown` by design (a configured id absent from the payload is a lost read), so a
 *  hand-listed subset would exercise the failure path while claiming to exercise the happy one. */
const SCOPE = mistral.displayComponentIds!

function feed(over: Partial<RootlyFeed> = {}): RootlyFeed {
  return {
    fetchedAt: new Date().toISOString(),
    components: SCOPE.map((id) => ({ id, name: `Component ${id.slice(0, 4)}`, status: 'Operational' })),
    incidents: [{
      id: '5e5018d9-a0fb-4fdd-a1c5-ff255fd7e7e7',
      title: 'Degraded OCR 4.1 Availability',
      updates: [
        { status: 'Resolved', at: 'September 5, 2026 at 05:48 AM UTC', body: 'The issue has been resolved.' },
        { status: 'Identified', at: 'September 4, 2026 at 10:00 PM UTC', body: 'identified' },
      ],
    }],
    coverage: { listed: 1, fetched: 1 },
    // Charts for the WHOLE scope. Required, not decoration: the read path refuses a feed whose
    // uptime cannot be computed, because serving one publishes a RESCALED — and therefore higher —
    // score than the figure it replaced. A fixture without this would be testing the refusal path
    // while claiming to test the happy one.
    uptime: SCOPE.map((id) => ({ componentId: id, barCount: 91, unreadBars: 0, coverage: { impacted: 0, fetched: 0 }, days: [] })),
    ...over,
  }
}

/** KV double that records reads, so "never looked" is distinguishable from "looked and found nothing". */
function kvWith(value: string | null) {
  const reads: string[] = []
  return {
    reads,
    kv: {
      get: async (k: string) => { reads.push(k); return k === MISTRAL_FEED_KV_KEY ? value : null },
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [] }),
    },
  }
}

// The fixtures below carry REAL dates off the live page (Sep 4-5, 2026), and `computeRootlyUptime`
// keeps a trailing 30-day window off `Date.now()`. Left on the wall clock these tests pass today and
// start failing on 2026-10-05, when that day leaves the window: `uptime30d` goes to 100 and the
// incident's `impact` goes back to null — a dated CI break, on a green codebase, that no code change
// would explain. `toFake: ['Date']` freezes only the clock; `fetchWithTimeout`'s real timers still run.
beforeEach(() => vi.useFakeTimers({ now: new Date('2026-09-10T12:00:00Z'), toFake: ['Date'] }))
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('#1381 — fetchService reads the Rootly feed', () => {
  it('the config actually opts in, or none of this runs', () => {
    expect(mistral.rootlyFeed).toBe(true)
    expect(mistral.apiUrl).toBeNull()
  })

  it('serves incidents from a fresh feed, and does NOT mark the source unreadable', async () => {
    const { kv, reads } = kvWith(JSON.stringify({ fetchedAt: new Date().toISOString(), feed: feed() }))
    const svc = await fetchService(mistral, undefined, kv as never, {})
    expect(reads, 'the feed key must actually be read').toContain(MISTRAL_FEED_KV_KEY)
    expect(svc.status).toBe('operational')
    expect(svc.incidents.map((i) => i.title)).toEqual(['Degraded OCR 4.1 Availability'])
    // The two assertions belong together: a successful read that STILL flagged the source is the
    // state that put "AIWatch can't currently read Mistral API's status source" on a public page
    // next to a badge derived from this feed. Serving the incidents is only half of being correct.
    expect(svc.incidentSourceStale, 'a readable feed must not claim the source is unreadable').toBeUndefined()
    expect(svc.sourceUnknown, 'and it is not an unknown reading either').toBeUndefined()
  })

  it('an ABSENT feed publishes `unknown`, not a green pill, and never fetches the challenged page', async () => {
    // Round 5: `base` says `operational`, so a feed-ONLY service with an expired key published a
    // green badge for a service we have no reading of at all — a realistic state against a 3h TTL
    // (see `workflow-dispatch.ts` — #629/#1395). #1233's `unknown` is neither an outage nor an all-clear.
    const fetchSpy = vi.fn(async () => new Response('', { status: 403 }))
    vi.stubGlobal('fetch', fetchSpy)
    const { kv } = kvWith(null)
    const svc = await fetchService(mistral, undefined, kv as never, {})
    expect(svc.status).toBe('unknown')
    expect(svc.sourceUnknown).toBe(true)
    expect(svc.incidents, 'an unknown service carries no incidents (#1233)').toEqual([])
    expect(svc.incidentSourceStale).toBe(true)
    expect(fetchSpy, 'must not reach for the bot-walled status page').not.toHaveBeenCalled()
  })

  it('REFUSES a stored feed that fails the storable check, rather than serving a blank', async () => {
    // A value that got into KV some other way — an older writer, a hand-edited key. It parses as JSON
    // and would otherwise publish "no incidents" over a page full of them.
    const { kv } = kvWith(JSON.stringify({
      fetchedAt: new Date().toISOString(),
      feed: feed({ incidents: [], coverage: { listed: 12, fetched: 0 } }),
    }))
    const svc = await fetchService(mistral, undefined, kv as never, {})
    expect(svc.incidents).toEqual([])
    expect(svc.incidentSourceStale, 'a refused feed leaves the gate shut').toBe(true)
  })

  it('corrupt JSON in KV falls through instead of throwing', async () => {
    const { kv } = kvWith('{not json')
    const svc = await fetchService(mistral, undefined, kv as never, {})
    expect(svc.incidentSourceStale).toBe(true)
  })

  it('an unreadable component status yields `unknown` and KEEPS the gate shut', async () => {
    // #1233 — unknown is neither an outage nor an all-clear, so it must not clear the stale flag
    // even on a fresh feed: a badge we could not derive is not a successful read.
    const { kv } = kvWith(JSON.stringify({
      fetchedAt: new Date().toISOString(),
      feed: feed({
        // One in-scope component whose status word we do not recognize. The rest stay readable, so
        // this pins the unreadable-component path rather than the missing-component one.
        components: feed().components.map((c, i) => (i === 0 ? { ...c, status: 'Elevated Errors' } : c)),
      }),
    }))
    const svc = await fetchService(mistral, undefined, kv as never, {})
    expect(svc.status).toBe('unknown')
    expect(svc.sourceUnknown).toBe(true)
    expect(svc.incidentSourceStale).toBe(true)
  })

  it('a component outside the configured scope does not move the badge', async () => {
    // Console is on the page but deliberately absent from displayComponentIds.
    const { kv } = kvWith(JSON.stringify({
      fetchedAt: new Date().toISOString(),
      feed: feed({
        // Console is on the page but out of `displayComponentIds` — a Major Outage there must move
        // neither the badge nor the card.
        components: [
          ...feed().components,
          { id: '219bff35-e3ad-4684-a5d2-d26dc3826792', name: 'Console', status: 'Major Outage' },
        ],
      }),
    }))
    const svc = await fetchService(mistral, undefined, kv as never, {})
    expect(svc.status).toBe('operational')
    // Asserting the badge alone does not discriminate: `operational` is also what the fall-through
    // path yields, so this passed with the read path deleted. Pin that the components came FROM the
    // feed — only the read path can produce them.
    //
    // And the CARD is scoped by the same ids as the badge, so Console is absent from both. Caught by
    // running it: the first version scoped the badge only, and the live payload put 14 components on
    // a card the config says holds 13.
    expect(svc.components).toHaveLength(SCOPE.length)
    expect(svc.components?.some((c) => c.name === 'Console'), 'Console is out of scope').toBe(false)
  })

  it('a Console incident does not reach the API incident list either', async () => {
    // The badge and the card scope by id; the INCIDENT list has no ids to scope by (Rootly's
    // incident pages publish no affected-component list), so `incidentExclude` is the only lever —
    // and it is a substring match on the TITLE, i.e. on source vocabulary. Instatus appended the
    // component ("… · Le Console") and the entry read `le console`; Rootly publishes the raw title
    // and calls the component `Console`, so that entry stopped matching and the migration quietly
    // put a non-API component's incidents on the API card. This title is the live one, recorded in
    // `normalizeRootlyIncidents`'s docstring.
    const { kv } = kvWith(JSON.stringify({
      fetchedAt: new Date().toISOString(),
      feed: feed({
        incidents: [
          {
            id: 'inc-console', title: 'Console Degraded',
            updates: [
              { status: 'Resolved', at: 'September 5, 2026 at 05:48 AM UTC', body: 'resolved' },
              { status: 'Identified', at: 'September 4, 2026 at 10:00 PM UTC', body: 'identified' },
            ],
          },
          {
            id: 'inc-api', title: 'Chat Completions API Degraded',
            updates: [
              { status: 'Resolved', at: 'September 5, 2026 at 05:48 AM UTC', body: 'resolved' },
              { status: 'Identified', at: 'September 4, 2026 at 10:00 PM UTC', body: 'identified' },
            ],
          },
        ],
        coverage: { listed: 2, fetched: 2 },
      }),
    }))
    const svc = await fetchService(mistral, undefined, kv as never, {})
    // Asserting only "Console is absent" would also pass on an empty list, which is how a broken
    // read path looks — so pin that the API incident came through in the same call.
    expect(svc.incidents.map((i) => i.title)).toEqual(['Chat Completions API Degraded'])
  })
})

describe('#1381 — fetchService computes uptime and severity from the chart', () => {
  /** A feed carrying the uptime chart, which is where the only severity this source states lives. */
  const AGENTS_INCIDENT = {
    id: 'inc-1', title: 'Agents API Degraded',
    updates: [
      { status: 'Resolved', at: 'September 5, 2026 at 11:00 AM UTC', body: 'done' },
      { status: 'Identified', at: 'September 5, 2026 at 10:00 AM UTC', body: 'looking' },
    ],
  }

  function withUptime(days: Array<{ date: string; label: string; segments: Array<{ cls: string; width: number }> }>,
                      coverage = { impacted: days.length, fetched: days.length },
                      incidents: RootlyFeed['incidents'] = [AGENTS_INCIDENT]) {
    return {
      fetchedAt: new Date().toISOString(),
      feed: feed({
        incidents,
        coverage: { listed: incidents.length, fetched: incidents.length },
        // Charts for the WHOLE scope: a configured component with no chart withholds the figure, so
        // a one-component fixture would assert the withheld path while claiming to assert the figure.
        // Only the first carries impacted days; the rest are clean.
        uptime: SCOPE.map((id, i) => (i === 0
          ? { componentId: id, barCount: 91, unreadBars: 0, coverage, days }
          : { componentId: id, barCount: 91, unreadBars: 0, coverage: { impacted: 0, fetched: 0 }, days: [] })),
      }),
    }
  }

  it('publishes a COMPUTED uptime and gives the incident its day severity', async () => {
    const { kv } = kvWith(JSON.stringify(withUptime([{
      date: 'Sep 5, 2026', label: 'Agents API Degraded',
      segments: [{ cls: 'bg-gray-700', width: 30 }, { cls: 'bg-green-400', width: 70 }],
    }])))
    const svc = await fetchService(mistral, undefined, kv as never, {})
    expect(svc.uptime30d).toBeCloseTo(99.7, 1)
    expect(svc.uptimeSource).toBe('official')
    // THE point of reading the chart: without this the incident stays `impact: null`, and
    // score.ts's `isReliabilityIncident` gates affected-days AND the MTTR sample on impact,
    // so a month of real incidents would score as clean.
    expect(svc.incidents[0].impact).toBe('minor')
  })

  it('carries a MAJOR day through as major', async () => {
    const { kv } = kvWith(JSON.stringify(withUptime([{
      date: 'Sep 5, 2026', label: 'Agents API Degraded',
      segments: [{ cls: 'bg-red-500', width: 20 }, { cls: 'bg-green-400', width: 80 }],
    }])))
    const svc = await fetchService(mistral, undefined, kv as never, {})
    expect(svc.incidents[0].impact).toBe('major')
  })

  it('publishes the two derived fields the calendar and the archive read', async () => {
    // Both are single spreads on the returned object, both survived deletion with the whole suite
    // green when review checked, and both are asserted in comments to be load-bearing:
    //   - `todayWeightedOutageSec` is what `readArchivedWeightedOutageSec` finds later; without it
    //     the counter for this service is null from here on, disabling the mechanism whose stated
    //     purpose is letting a calendar survive a status-page migration — on the one service that
    //     just migrated.
    //   - `dailyImpact` is the per-day severity the uptime calendar renders; absent, every day of a
    //     month with real outages renders clean.
    const { kv } = kvWith(JSON.stringify(withUptime([{
      date: 'Sep 5, 2026', label: 'Agents API Degraded',
      segments: [{ cls: 'bg-red-500', width: 50 }, { cls: 'bg-green-400', width: 50 }],
    }])))
    const svc = await fetchService(mistral, undefined, kv as never, {})
    expect(svc.dailyImpact).toEqual({ '2026-09-05': 'major' })
    // The frozen clock is 2026-09-10, so Sep 5 is not today and today carries no outage — the field
    // is present and zero, which is the reading the archive needs. `undefined` would be the bug.
    expect(svc.todayWeightedOutageSec).toBe(0)
  })

  it('counts TODAY\'s outage seconds when the impacted day is today', async () => {
    const { kv } = kvWith(JSON.stringify(withUptime([{
      date: 'Sep 10, 2026', label: 'Agents API Degraded',
      segments: [{ cls: 'bg-red-500', width: 50 }, { cls: 'bg-green-400', width: 50 }],
    }])))
    const svc = await fetchService(mistral, undefined, kv as never, {})
    // Half the bar at MAJOR_WEIGHT 1.0 over a 86400s day. Asserted as a number rather than
    // `toBeDefined` — a field that is present but always 0 would satisfy the weaker assertion.
    expect(svc.todayWeightedOutageSec).toBeCloseTo(43200, 0)
  })

  it('an EXCLUDED incident still gets its severity from the chart when it is ours', async () => {
    // Attribution runs on the FILTERED list. That order is what stops `incidentExclude`d incidents
    // (Console, whose component is outside `displayComponentIds`, so its chart days never enter
    // `up.days`) from counting as lost reads forever. The risk of the order is the opposite one —
    // that filtering first drops an incident before it can be given its impact — so pin that an
    // incident which SURVIVES the filter still receives the severity its component-day carries.
    const { kv } = kvWith(JSON.stringify(withUptime([{
      date: 'Sep 5, 2026', label: 'Agents API Degraded',
      segments: [{ cls: 'bg-red-500', width: 40 }, { cls: 'bg-green-400', width: 60 }],
    }])))
    const svc = await fetchService(mistral, undefined, kv as never, {})
    expect(svc.incidents.map((i) => i.title)).toEqual(['Agents API Degraded'])
    expect(svc.incidents[0].impact).toBe('major')
  })

  it('does NOT count an EXCLUDED incident as a lost read — the filter runs before attribution', async () => {
    // The production ORDER, which is the half of round 9's fix a test can actually pin. `unattributed`
    // lives only inside a console.warn, so the warn IS the observation point: asserting on
    // `svc.incidents` cannot tell the two orders apart, because both publish the same list. That is
    // why reverting the order left the whole suite green when review checked it.
    //
    // Console is `incidentExclude`d AND outside `displayComponentIds`, so its chart days never enter
    // `up.days`. Attributed before filtering, it is a permanent phantom "lost read" that pins this
    // diagnostic on for every run and destroys its value as a degradation signal.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { kv } = kvWith(JSON.stringify(withUptime(
      [{
        date: 'Sep 5, 2026', label: 'Agents API Degraded',
        segments: [{ cls: 'bg-gray-700', width: 30 }, { cls: 'bg-green-400', width: 70 }],
      }],
      undefined,
      [
        {
          id: 'inc-console', title: 'Console Degraded',
          updates: [
            { status: 'Resolved', at: 'September 6, 2026 at 05:48 AM UTC', body: 'resolved' },
            { status: 'Identified', at: 'September 6, 2026 at 01:00 AM UTC', body: 'identified' },
          ],
        },
        AGENTS_INCIDENT,
      ],
    )))
    const svc = await fetchService(mistral, undefined, kv as never, {})
    // The Console incident IS in the feed and IS inside the window — it is dropped by the filter, not
    // by round 9's cutoff guard, so this asserts the ORDER rather than re-asserting the cutoff.
    expect(svc.incidents.map((i) => i.title)).toEqual(['Agents API Degraded'])
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('rootly read:'))
    expect(lines.join('\n')).not.toContain('unattributedIncidents=1')
    // Every counter shares one warn, so a fully readable feed must leave it silent entirely.
    expect(lines, 'a clean read must not print the degradation diagnostic').toEqual([])
    warn.mockRestore()
  })

  it('a tooltip-short feed in KV is IGNORED, so the previous figure keeps serving', async () => {
    // The end-to-end half of the ingest refusal. The push is rejected at `/api/internal/mistral-feed`
    // so a short scrape never reaches KV — but the read path re-runs the same gate, which is what
    // makes a value that got in another way (an older writer, a hand-edited key) behave identically.
    //
    // Publishing it instead would RAISE the score: `score.ts` drops the 40-point Uptime component
    // and rescales the other three, which #1186 records as imputing uptime at 0.667x(I+R+P). On this
    // service a measured 96.36% scores 55 and a withheld one scores 74.
    const { kv } = kvWith(JSON.stringify(withUptime(
      [{ date: 'Sep 5, 2026', label: 'Agents API Degraded', segments: [{ cls: 'bg-gray-700', width: 30 }] }],
      { impacted: 2, fetched: 1 },   // one tooltip lost
    )))
    const svc = await fetchService(mistral, undefined, kv as never, {})
    // Not served at all: the caller treats an unusable feed as no feed, which is `unknown` — never a
    // green pill, and never a rescaled score.
    expect(svc.status).toBe('unknown')
    expect(svc.sourceUnknown).toBe(true)
    expect(svc.uptime30d ?? null).toBeNull()
    expect(svc.incidents).toEqual([])
  })

  it('a feed with NO uptime section is not served either — same reason, different shape', async () => {
    // The shape a feed written before the chart was captured has. It cannot produce a figure, so it
    // reaches the score exactly as a tooltip-short one does. Both are refused rather than served
    // with `uptime30d: null`, which is what earlier rounds of this file asserted: serving them is
    // what routes the service into the #713 rescale and RAISES its published score.
    const { kv } = kvWith(JSON.stringify({
      fetchedAt: new Date().toISOString(), feed: feed({ uptime: undefined }),
    }))
    const svc = await fetchService(mistral, undefined, kv as never, {})
    expect(svc.status).toBe('unknown')
    expect(svc.uptime30d ?? null).toBeNull()
    expect(svc.incidents).toEqual([])
  })
})

describe('#1381 round-1 regressions — the invariants the first draft broke', () => {
  it('an `unknown` badge carries NO incidents (#1233)', async () => {
    // `unknown-not-an-outage.test.ts` asserts this for the whole roster, and several modules omit an
    // `unknown` branch BECAUSE of it. The first draft published `unknown` alongside a populated
    // incident list; that test did not catch it because its KV mock has no `mistral:feed` key, so
    // mistral took the base path and never reached this leg.
    const { kv } = kvWith(JSON.stringify({
      fetchedAt: new Date().toISOString(),
      feed: feed({
        components: feed().components.map((c, i) => (i === 0 ? { ...c, status: 'Elevated Errors' } : c)),
      }),
    }))
    const svc = await fetchService(mistral, undefined, kv as never, {})
    expect(svc.status).toBe('unknown')
    expect(svc.incidents, 'an unreadable source never carries an incident').toEqual([])
  })

  it('honours `incidentExclude` like every other branch', async () => {
    // The config declares Le Chat / Le Console / documentation / website out of scope for this
    // API-surface card. The first draft never called `filterIncidents` on this path, so a page-wide
    // "Le Chat Degraded" landed on the Mistral API card while the COMPONENT scope went out of its
    // way to keep Console off the same card.
    const { kv } = kvWith(JSON.stringify({
      fetchedAt: new Date().toISOString(),
      feed: feed({
        incidents: [
          {
            id: 'inc-lechat', title: 'Le Chat Degraded',
            updates: [{ status: 'Resolved', at: 'September 5, 2026 at 05:48 AM UTC', body: 'done' }],
          },
          {
            id: 'inc-api', title: 'Agents API Degraded',
            updates: [{ status: 'Resolved', at: 'September 5, 2026 at 05:48 AM UTC', body: 'done' }],
          },
        ],
        coverage: { listed: 2, fetched: 2 },
      }),
    }))
    const svc = await fetchService(mistral, undefined, kv as never, {})
    const titles = svc.incidents.map((i) => i.title)
    expect(titles, 'excluded titles must not reach the API card').not.toContain('Le Chat Degraded')
    expect(titles).toContain('Agents API Degraded')
  })

  it('a configured component MISSING from the payload is a lost read, not a smaller scope', async () => {
    // How the migration went unnoticed: the ids rotated, scope resolved to fewer components, and the
    // badge kept reading green off whatever remained.
    const { kv } = kvWith(JSON.stringify({
      fetchedAt: new Date().toISOString(),
      feed: feed({ components: feed().components.slice(0, 2) }),
    }))
    const svc = await fetchService(mistral, undefined, kv as never, {})
    expect(svc.status).toBe('unknown')
    expect(svc.incidentSourceStale, 'a partial roster must not clear the gate').toBe(true)
  })
})
