// #1292 — the WIRING half. `betterstack-status-history-incidents.test.ts` pins that the parser can
// reconstruct incidents from `status_history`; that says nothing about whether `fetchService` ever
// calls it or acts on the result. The bug lives in the acting: BetterStack stopped publishing monitor
// auto-events to `/feed`, so `parseRssIncidents` legitimately returns `[]` from a healthy 200 and the
// service published "no incidents" over live downtime. A pure-parser test stays green through that
// entire failure (memory `debugging_fix_the_called_path_not_the_tested_twin`).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchService, SERVICES } from '../services'
import { calculateAIWatchScore } from '../score'
import { parseBetterStackDowntimeIncidents, parseBetterStackUptime, parseBetterStackDailyImpact } from '../parsers/betterstack'

const helicone = SERVICES.find((s) => s.id === 'helicone')!

/** The REAL feed shape as of 2026-08-28: HTTP 200, well-formed XML, zero <item>. Not a 404 — that is
 *  the whole point, and why #1199/#1234 cannot reach this case. */
const EMPTY_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Incidents | Helicone Inc</title>
<description>Incidents reported on status page</description>
<link>https://status.helicone.ai/</link></channel></rss>`

/** Real August `status_history` for helicone's two API monitors, captured from the live index.json. */
function indexJson() {
  const hist = (days: Array<[string, number]>) => days.map(([day, sec]) => ({
    day, status: sec > 0 ? 'downtime' : 'operational', downtime_duration: sec, maintenance_duration: 0,
  }))
  return JSON.stringify({
    data: { attributes: { aggregate_state: 'operational', timezone: 'America/Adak' } },
    included: [
      { type: 'status_page_resource', id: '484146', attributes: { public_name: 'helicone.ai', status: 'not_monitored', availability: 1, status_history: hist([['2026-08-14', 0]]) } },
      { type: 'status_page_resource', id: '999', attributes: { public_name: 'Website', status: 'operational', availability: 0.9, status_history: hist([['2026-08-15', 20000]]) } },
      { type: 'status_page_resource', id: '7615061', attributes: { public_name: 'api.hconeai.com', status: 'operational', availability: 0.979, status_history: hist([['2026-08-15', 24952.26], ['2026-08-16', 41756.09]]) } },
      { type: 'status_page_resource', id: '8603734', attributes: { public_name: 'eu.api.helicone.ai', status: 'operational', availability: 0.938, status_history: hist([['2026-08-14', 62263.38], ['2026-08-15', 86400], ['2026-08-16', 41756.03]]) } },
    ],
  })
}

/** Every leg answers 200 — the source is fully reachable; only the feed's CONTENT changed. */
function stubFetch(feed: string) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (url.endsWith('/index.json')) return new Response(indexJson(), { status: 200 })
    if (url.endsWith('/feed')) return new Response(feed, { status: 200 })
    return new Response('<html>ok</html>', { status: 200 })
  }))
}

/** A feed carrying one down→recovered pair, titled `title`, over the given pubDates. */
function feedNaming(title: string, downAt = 'Fri, 14 Aug 2026 15:42:00 -0000', upAt = 'Sun, 16 Aug 2026 20:35:00 -0000') {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Incidents</title>
<item><title>${title} went down</title><guid>abc123</guid>
<link>https://status.helicone.ai/</link><pubDate>${downAt}</pubDate>
<description>monitor down</description></item>
<item><title>${title} recovered</title><guid>abc123</guid>
<link>https://status.helicone.ai/</link><pubDate>${upAt}</pubDate>
<description>monitor recovered</description></item>
</channel></rss>`
}

/** The fixtures below are dated 2026-08, and the 30-day emission window is computed from the CLOCK —
 *  so on real time this file would start failing around 2026-09-10 and be fully dead by 2026-09-16,
 *  with no code change. Worse, its several `toEqual([])` assertions would go VACUOUSLY green as the
 *  window walked past them. `Date.now` is spied rather than using fake timers so `await` still works. */
const FROZEN = Date.parse('2026-08-29T02:00:00Z')
beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(FROZEN) })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('#1292 — an emptied BetterStack feed must not read as "no incidents"', () => {
  it('synthesizes the downtime status_history records when the feed publishes nothing', async () => {
    stubFetch(EMPTY_FEED)
    const svc = await fetchService(helicone, undefined, undefined, {})

    // The regression proper: pre-fix this array was empty while the page recorded ~53h of downtime.
    expect(svc.incidents.length).toBeGreaterThan(0)
    const days = new Set(svc.incidents.map((i) => i.startedAt.slice(0, 10)))
    expect(days).toContain('2026-08-14')
    expect(svc.incidents.every((i) => i.derived === 'status_history')).toBe(true)
    // Non-null impact and no autoMonitor tag, or score.ts drops them right back out (#261 / #989).
    expect(svc.incidents.every((i) => i.impact != null && !i.autoMonitor)).toBe(true)
  })

  it('passes componentDenylist through to the synthesis, not just to the breakdown', async () => {
    // The marketing surface has real downtime in this fixture, so it would synthesize an incident if
    // `config.componentDenylist` never reached the parser. Nothing else in the fixture would notice.
    stubFetch(EMPTY_FEED)
    const svc = await fetchService(helicone, undefined, undefined, {})
    expect(svc.incidents.map((i) => i.componentNames?.[0])).not.toContain('Website')
    expect(svc.incidents.length, 'the API surfaces must still synthesize').toBeGreaterThan(0)
  })

  it('CONTROL — a resource the feed still covers gets no duplicate synthetic', async () => {
    // The feed names `eu.api.helicone.ai` and covers Aug 14–16, so that resource must gain nothing
    // for those days. This is what leaves a hand-declared incident un-duplicated.
    stubFetch(feedNaming('eu.api.helicone.ai'))
    const svc = await fetchService(helicone, undefined, undefined, {})

    expect(svc.incidents.filter((i) => i.derived === undefined).length,
      'the real feed item must survive').toBeGreaterThan(0)
    const euSynthetic = svc.incidents.filter(
      (i) => i.derived === 'status_history' && i.componentNames?.[0] === 'eu.api.helicone.ai')
    expect(euSynthetic, 'RSS already covers this resource for those days').toEqual([])
  })

  it('a feed item for ONE resource must not suppress a DIFFERENT resource on the same day', async () => {
    // Regression for the day-only suppression key. `api.hconeai.com` was down Aug 15–16 as well, and
    // keying suppression on the date alone let the eu.api feed item swallow it — re-introducing the
    // exact under-report this change exists to end, on the very service that motivated it.
    stubFetch(feedNaming('eu.api.helicone.ai'))
    const svc = await fetchService(helicone, undefined, undefined, {})

    const hcone = svc.incidents.filter((i) => i.componentNames?.[0] === 'api.hconeai.com')
    expect(hcone.length, 'api.hconeai.com downtime must survive an eu.api feed item').toBeGreaterThan(0)
    expect(hcone.every((i) => i.derived === 'status_history')).toBe(true)
  })

  it('a HAND-WRITTEN feed title names no resource, so it claims the whole day', async () => {
    // modal/huggingface declare incidents in prose ("Elevated error rate - AWS CDN"), which names no
    // monitor resource. There is nothing to key on, so such an item suppresses every resource that
    // day rather than risk duplicating a declared incident.
    stubFetch(feedNaming('Elevated error rates across the platform'))
    const svc = await fetchService(helicone, undefined, undefined, {})

    const onCoveredDays = svc.incidents.filter(
      (i) => i.derived === 'status_history' && i.startedAt.slice(0, 10) >= '2026-08-14' && i.startedAt.slice(0, 10) <= '2026-08-16')
    expect(onCoveredDays).toEqual([])
  })

  it('a renamed status_history is already visible — uptime and the calendar null out with it', () => {
    // The shape change that reads exactly like a clean month is NOT counted separately. It does not
    // need to be: `parseBetterStackUptime` and `parseBetterStackDailyImpact` read the same field on
    // the same payload, so the service loses its uptime figure and its calendar at the same moment —
    // both of which are visible on `/api/status`. A per-request KV counter for a condition that is
    // permanent once it starts would be traffic-shaped, which is what this asserts instead of.
    const shapeChanged = {
      data: { attributes: { aggregate_state: 'operational', timezone: 'America/Adak' } },
      included: [
        { type: 'status_page_resource', id: '1', attributes: { public_name: 'api.hconeai.com', status: 'operational', availability: 0.9 } },
        { type: 'status_page_resource', id: '2', attributes: { public_name: 'eu.api.helicone.ai', status: 'operational', availability: 0.9 } },
      ],
    }
    expect(parseBetterStackDowntimeIncidents(shapeChanged, { now: FROZEN })).toEqual([])
    expect(parseBetterStackUptime(shapeChanged), 'uptime goes with it').toBeNull()
    expect(parseBetterStackDailyImpact(shapeChanged), 'the calendar goes with it').toBeNull()
  })

  it('the steady-state gap leaves its durable record as TAGGED incidents, not a counter', async () => {
    // Deliberately not booked: permanent once a feed dies, and this path runs per request, so a
    // counter would be traffic-shaped. The tag is what makes the synthesized days auditable later.
    stubFetch(EMPTY_FEED)
    const store: Record<string, string> = {}
    const kv = {
      get: async (k: string) => store[k] ?? null,
      put: async (k: string, v: string) => { store[k] = v },
      delete: async (k: string) => { delete store[k] },
      list: async () => ({ keys: [], list_complete: true as const }),
    }
    const svc = await fetchService(helicone, undefined, kv as never, {})
    expect(svc.incidents.filter((i) => i.derived === 'status_history').length).toBeGreaterThan(0)
    expect(Object.keys(store), 'the expected gap must not book a counter').toEqual([])
  })

  it('does NOT let one feed item suppress unpublished downtime on adjacent days', async () => {
    // The ±1 UTC padding this replaced discarded 11h of real downtime on the days either side of a
    // 2-hour feed item — this issue's own failure mode, re-created one day out from every item.
    const idx = JSON.stringify({
      data: { attributes: { aggregate_state: 'operational', timezone: 'UTC' } },
      included: [{
        type: 'status_page_resource', id: '7615061',
        attributes: {
          public_name: 'api.hconeai.com', status: 'operational',
          status_history: [['2026-08-10', 20000], ['2026-08-11', 7200], ['2026-08-12', 20000]].map(
            ([day, sec]) => ({ day, status: 'downtime', downtime_duration: sec, maintenance_duration: 0 })),
        },
      }],
    })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(typeof input === 'string' || input instanceof URL ? input : input.url)
      if (url.endsWith('/index.json')) return new Response(idx, { status: 200 })
      // Two items: an older one that sets the feed's reach floor, and one claiming 08-11 only. Without
      // the older item the floor would sit at 08-11 and hide the point being tested.
      if (url.endsWith('/feed')) return new Response(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Incidents</title>
<item><title>api.hconeai.com went down</title><guid>a1</guid><link>https://status.helicone.ai/</link><pubDate>Sun, 09 Aug 2026 10:00:00 -0000</pubDate><description>d</description></item>
<item><title>api.hconeai.com recovered</title><guid>a1</guid><link>https://status.helicone.ai/</link><pubDate>Sun, 09 Aug 2026 11:00:00 -0000</pubDate><description>r</description></item>
<item><title>api.hconeai.com went down</title><guid>b1</guid><link>https://status.helicone.ai/</link><pubDate>Tue, 11 Aug 2026 12:00:00 -0000</pubDate><description>d</description></item>
<item><title>api.hconeai.com recovered</title><guid>b1</guid><link>https://status.helicone.ai/</link><pubDate>Tue, 11 Aug 2026 14:00:00 -0000</pubDate><description>r</description></item>
</channel></rss>`, { status: 200 })
      return new Response('<html>ok</html>', { status: 200 })
    }))
    const svc = await fetchService(helicone, undefined, undefined, {})

    const days = svc.incidents.filter((i) => i.derived === 'status_history')
      .map((i) => i.startedAt.slice(0, 10)).sort()
    expect(days).toEqual(['2026-08-10', '2026-08-12'])
  })

  it('a Pacific page claims by its OWN local day, not the UTC one', async () => {
    // together is Pacific, where local midnight is 07:00Z — so a feed item stamped early on the 11th
    // UTC is the 10th on the page. Keying on the UTC date would leave the 10th unclaimed and emit a
    // duplicate beside the feed item.
    const idx = JSON.stringify({
      data: { attributes: { aggregate_state: 'operational', timezone: 'Pacific Time (US & Canada)' } },
      included: [{
        type: 'status_page_resource', id: '9',
        attributes: {
          public_name: 'api.hconeai.com', status: 'operational',
          status_history: [{ day: '2026-08-10', status: 'downtime', downtime_duration: 20000, maintenance_duration: 0 }],
        },
      }],
    })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(typeof input === 'string' || input instanceof URL ? input : input.url)
      if (url.endsWith('/index.json')) return new Response(idx, { status: 200 })
      // 06:00Z on the 11th is 23:00 on the 10th in Los Angeles.
      if (url.endsWith('/feed')) return new Response(feedNaming('api.hconeai.com', 'Tue, 11 Aug 2026 06:00:00 -0000', 'Tue, 11 Aug 2026 06:30:00 -0000'), { status: 200 })
      return new Response('<html>ok</html>', { status: 200 })
    }))
    const svc = await fetchService(helicone, undefined, undefined, {})
    expect(svc.incidents.filter((i) => i.derived === 'status_history')).toEqual([])
  })

  it('moves the SCORE, not just the incident array', async () => {
    // The whole point: score.ts pays out Incidents 25/25 and Recovery 15/15 on an empty list. Pinning
    // only `impact != null` / `autoMonitor === undefined` pins the FIELDS — it does not prove
    // `isReliabilityIncident` accepts them, nor that `duration` survives `parseDurationMin`. Any
    // future change that re-tags these autoMonitor, nulls impact, or reformats duration would revert
    // the fix with a fully green suite.
    stubFetch(EMPTY_FEED)
    const svc = await fetchService(helicone, undefined, undefined, {})

    const withHistory = calculateAIWatchScore(svc, 30, { kind: 'unsupported' })
    const withoutHistory = calculateAIWatchScore({ ...svc, incidents: [] }, 30, { kind: 'unsupported' })

    expect(withoutHistory.metrics.affectedDays30d).toBe(0)
    expect(withHistory.metrics.affectedDays30d).toBeGreaterThan(0)
    expect(withHistory.breakdown.incidents).toBeLessThan(withoutHistory.breakdown.incidents)
    // Recovery deliberately does NOT move: a synthesized `duration` is a day's downtime, not a time
    // to recover, so it is excluded from the MTTR sample (see the MTTR test below).
    expect(withHistory.metrics.mttrHours).toBeNull()
    expect(withHistory.breakdown.recovery).toBe(withoutHistory.breakdown.recovery)
  })

  it('claims BOTH local days when a short feed item straddles local midnight', async () => {
    // The claim walk steps in half-days and stops short of the end, so an item under 12h that crosses
    // local midnight has its closing day covered only by the explicit end-day claim. Without that the
    // second day reads as unpublished and gets a duplicate synthetic beside the real feed item.
    // Adak is UTC-9, so local midnight is 09:00Z: 06:00Z→12:00Z is Aug 14 21:00 → Aug 15 03:00 local.
    const idx = JSON.stringify({
      data: { attributes: { aggregate_state: 'operational', timezone: 'America/Adak' } },
      included: [{
        type: 'status_page_resource', id: '7615061',
        attributes: {
          public_name: 'api.hconeai.com', status: 'operational',
          status_history: [['2026-08-14', 10800], ['2026-08-15', 10800]].map(([day, sec]) => ({
            day, status: 'downtime', downtime_duration: sec, maintenance_duration: 0,
          })),
        },
      }],
    })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(typeof input === 'string' || input instanceof URL ? input : input.url)
      if (url.endsWith('/index.json')) return new Response(idx, { status: 200 })
      if (url.endsWith('/feed')) return new Response(
        feedNaming('api.hconeai.com', 'Sat, 15 Aug 2026 06:00:00 -0000', 'Sat, 15 Aug 2026 12:00:00 -0000'), { status: 200 })
      return new Response('<html>ok</html>', { status: 200 })
    }))
    const svc = await fetchService(helicone, undefined, undefined, {})
    expect(svc.incidents.filter((i) => i.derived === 'status_history')).toEqual([])
  })

  it('a denylisted resource\'s feed item claims only ITSELF, not the whole day', async () => {
    // Attribution reads every resource name, denylist or not. Building the name list from the
    // denylist-FILTERED components made a "Website went down" item match nothing, fall to the
    // catch-all, and suppress synthesis for every other resource that day — reinstating the
    // service-wide day suppression the (resource, day) key exists to remove.
    stubFetch(feedNaming('Website', 'Sat, 15 Aug 2026 06:00:00 -0000', 'Sat, 15 Aug 2026 12:00:00 -0000'))
    const svc = await fetchService(helicone, undefined, undefined, {})
    const synth = svc.incidents.filter((i) => i.derived === 'status_history')
    expect(synth.length, 'the API surfaces must still synthesize').toBeGreaterThan(0)
    expect(synth.map((i) => i.componentNames?.[0])).not.toContain('Website')
  })

  it('an UNRESOLVED feed item claims through today, not just its start day', async () => {
    // Collapsing an open incident to its start day left day 3 of a running outage unclaimed, so the
    // parser published a closed "— recovered" for a day the provider still calls down.
    // Dates are relative to now: #602 re-reads a feed item untouched for 7 days as resolved, which
    // would make a fixed-date fixture test the resolved path instead of this one.
    const day = (back: number) => new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10)
    const idx = JSON.stringify({
      data: { attributes: { aggregate_state: 'operational', timezone: 'UTC' } },
      included: [{
        type: 'status_page_resource', id: '5',
        attributes: {
          public_name: 'api.hconeai.com', status: 'downtime',
          status_history: [day(3), day(2), day(1)].map((d) => ({
            day: d, status: 'downtime', downtime_duration: 86400, maintenance_duration: 0,
          })),
        },
      }],
    })
    const openFeed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Incidents</title>
<item><title>api.hconeai.com went down</title><guid>open1</guid>
<link>https://status.helicone.ai/</link><pubDate>${new Date(Date.now() - 3 * 86_400_000).toUTCString()}</pubDate>
<description>still down</description></item>
</channel></rss>`
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(typeof input === 'string' || input instanceof URL ? input : input.url)
      if (url.endsWith('/index.json')) return new Response(idx, { status: 200 })
      if (url.endsWith('/feed')) return new Response(openFeed, { status: 200 })
      return new Response('<html>ok</html>', { status: 200 })
    }))
    const svc = await fetchService(helicone, undefined, undefined, {})
    expect(svc.incidents.some((i) => i.status !== 'resolved'), 'the feed item must still be open').toBe(true)
    expect(svc.incidents.filter((i) => i.derived === 'status_history')).toEqual([])
  })

  it('publishes svc.incidents newest-first once synthetics and feed items are mixed', async () => {
    // Before this change the array was pure `parseRssIncidents` output, i.e. feed order, so
    // `incidents[0]` WAS the newest — and two consumers still rely on that: the is-down template's
    // "Last incident" header reads `incidents[0]`, and `/api/v1/status/:id` returns `slice(0, 5)`.
    // Appending synthetics would let an older feed item head the array while the "Recent Incidents"
    // card directly below it, which does sort, showed a newer one.
    stubFetch(feedNaming('api.hconeai.com', 'Wed, 05 Aug 2026 10:00:00 -0000', 'Wed, 05 Aug 2026 11:00:00 -0000'))
    const svc = await fetchService(helicone, undefined, undefined, {})

    const dates = svc.incidents.map((i) => i.startedAt)
    expect(dates.length, 'both sources must be present').toBeGreaterThan(1)
    expect(svc.incidents.some((i) => i.derived === undefined), 'the feed item survives').toBe(true)
    expect([...dates].sort().reverse(), 'already sorted newest-first').toEqual(dates)
    expect(dates[0].slice(0, 10), 'the newest is a synthesized August day').toBe('2026-08-16')
  })

  it('puts an ONGOING incident first, even when a synthesized day starts later', async () => {
    // Two consumers read a RAW PREFIX and need "most relevant first", not "newest start":
    // `api/_is-down/html-template.ts`'s "Last incident" header takes `incidents[0]`, and
    // `/api/v1/status/:id` returns `slice(0, 5)`. A feed item's claim walk credits only the ONE
    // resource its title names, so ANOTHER resource's bucket on a later day survives beside the live
    // incident and outranks it by start time. The header would then name a day-bucket directly under
    // a "Yes — down" answer, while the incident list below it — which sorts ongoing-first — named a
    // different one. Dates are relative: #602 re-reads a 7-day-old feed item as resolved.
    const day = (back: number) => new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10)
    const idx = JSON.stringify({
      data: { attributes: { aggregate_state: 'operational', timezone: 'UTC' } },
      included: [
        { type: 'status_page_resource', id: '5', attributes: { public_name: 'api.hconeai.com', status: 'downtime', status_history: [] } },
        // A DIFFERENT resource, down on a LATER day — unclaimed, so it synthesizes and its anchor
        // sorts above the still-open incident's start.
        { type: 'status_page_resource', id: '6', attributes: { public_name: 'eu.api.helicone.ai', status: 'operational',
          status_history: [{ day: day(1), status: 'downtime', downtime_duration: 7200, maintenance_duration: 0 }] } },
      ],
    })
    const openFeed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Incidents</title>
<item><title>api.hconeai.com went down</title><guid>open1</guid>
<link>https://status.helicone.ai/</link><pubDate>${new Date(Date.now() - 3 * 86_400_000).toUTCString()}</pubDate>
<description>still down</description></item>
</channel></rss>`
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(typeof input === 'string' || input instanceof URL ? input : input.url)
      if (url.endsWith('/index.json')) return new Response(idx, { status: 200 })
      if (url.endsWith('/feed')) return new Response(openFeed, { status: 200 })
      return new Response('<html>ok</html>', { status: 200 })
    }))
    const svc = await fetchService(helicone, undefined, undefined, {})

    const synth = svc.incidents.filter((i) => i.derived === 'status_history')
    expect(synth.length, 'the other resource\'s day must survive the claim walk').toBe(1)
    expect(synth[0].startedAt > svc.incidents.find((i) => i.status !== 'resolved')!.startedAt,
      'and it must START LATER — otherwise this asserts nothing').toBe(true)
    expect(svc.incidents[0].status, 'yet the ongoing incident heads the array').not.toBe('resolved')
    expect(svc.incidents[0].derived, 'and it is the feed item, not the bucket').toBeUndefined()
  })

  it('does not synthesize past the feed\'s own reach', async () => {
    // The claim set can only be built from what `parseRssIncidents` returns, and that caps at 20
    // groups, drops maintenance titles and sub-60s blips, and sees only what `/feed` still serves —
    // none of which is tied to the 30-day synthesis window. For a day older than the oldest surviving
    // feed item, silence proves nothing, and the accumulator may already hold that outage from RSS.
    // Synthesizing there banks it a SECOND time under a `bs-hist:` id that nothing dedups.
    const idx = JSON.stringify({
      data: { attributes: { aggregate_state: 'operational', timezone: 'UTC' } },
      included: [{
        type: 'status_page_resource', id: '7615061',
        attributes: {
          public_name: 'api.hconeai.com', status: 'operational',
          status_history: [['2026-08-05', 24900], ['2026-08-20', 20000]].map(([day, sec]) => ({
            day, status: 'downtime', downtime_duration: sec, maintenance_duration: 0,
          })),
        },
      }],
    })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(typeof input === 'string' || input instanceof URL ? input : input.url)
      if (url.endsWith('/index.json')) return new Response(idx, { status: 200 })
      // The feed reaches back only to the 18th, so 08-05 is beyond what its silence can attest.
      if (url.endsWith('/feed')) return new Response(
        feedNaming('api.hconeai.com', 'Tue, 18 Aug 2026 10:00:00 -0000', 'Tue, 18 Aug 2026 11:00:00 -0000'), { status: 200 })
      return new Response('<html>ok</html>', { status: 200 })
    }))
    const svc = await fetchService(helicone, undefined, undefined, {})

    const synth = svc.incidents.filter((i) => i.derived === 'status_history')
      .map((i) => i.startedAt.slice(0, 10))
    expect(synth, 'only the day inside the feed\'s reach may be synthesized').toEqual(['2026-08-20'])
  })

  it('an EMPTY feed sets no floor — that is the #1292 case', async () => {
    // Nothing can have aged out of a feed with no items, so silence across the whole window is real.
    stubFetch(EMPTY_FEED)
    const svc = await fetchService(helicone, undefined, undefined, {})
    expect(svc.incidents.filter((i) => i.derived === 'status_history').length).toBeGreaterThan(0)
  })

  it('does not let synthesized days drag MTTR — adding downtime must not RAISE Recovery', async () => {
    // A synthesized `duration` is one DAY'S downtime, not a time to recover. Left in the MTTR sample,
    // a few short days push it past computeMttrHours' 3-sample switch to the robust median and pull
    // the median under the service's real incidents: measured on the shipped formulas, one real 8h
    // incident plus four short synthesized days moved Recovery from ~6.5 to ~13.8 — more downtime,
    // better score. They still count toward affectedDays, which is the component that should move.
    stubFetch(EMPTY_FEED)
    const svc = await fetchService(helicone, undefined, undefined, {})
    const real = {
      id: 'rss-real', title: 'API errors', status: 'resolved' as const, impact: 'major' as const,
      startedAt: '2026-08-20T00:00:00.000Z', resolvedAt: '2026-08-20T08:00:00.000Z',
      duration: '8h 0m', timeline: [],
    }
    const withBoth = calculateAIWatchScore({ ...svc, incidents: [real, ...svc.incidents] }, 30, { kind: 'unsupported' })
    const realOnly = calculateAIWatchScore({ ...svc, incidents: [real] }, 30, { kind: 'unsupported' })

    expect(withBoth.metrics.mttrHours, 'MTTR reads the real incident only')
      .toBe(realOnly.metrics.mttrHours)
    expect(withBoth.breakdown.recovery).toBe(realOnly.breakdown.recovery)
    // ...while the synthesized days DO move the component that should move.
    expect(withBoth.metrics.affectedDays30d).toBeGreaterThan(realOnly.metrics.affectedDays30d)
    expect(withBoth.breakdown.incidents).toBeLessThan(realOnly.breakdown.incidents)
  })
})
