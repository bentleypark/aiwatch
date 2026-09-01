// #1295 — a `status_history`-derived day-total must not be banked onto a day the accumulator already
// holds a FEED-published row for, from the same resource.
//
// The live claim-walk cannot prevent this. It asks what the feed says NOW, and BetterStack removes its
// monitor items retroactively — so a day we banked from RSS in early August reads as unspoken-for weeks
// later and gets synthesized on top of the rows already there. Both are `resolved`, so
// `prunePhantomIncidents` never touches either.
//
// Fixtures are real rows read off `incidents:monthly:2026-08`.
import { describe, it, expect } from 'vitest'
import { accumulateMonthlyIncidents, derivedDayAlreadyBankedFromFeed } from '../monthly-archive'
import type { MonthlyIncidents, MonthlyIncidentEntry } from '../monthly-archive'
import type { Incident, ServiceStatus } from '../types'

// status.together.ai reports `timezone: "Pacific Time (US & Canada)"` -> America/Los_Angeles, so its
// local day 2026-08-04 runs 07:00Z -> 07:00Z and the anchor (`zonedDayStartMs + 12h`) is 19:00Z. An
// earlier revision of this file used 12:00Z and called the page UTC — which is the ONE timezone where
// `anchor +/- 12h` cannot differ from the local day, so every boundary case below asserted nothing.
const ANCHOR = '2026-08-04T19:00:00.000Z'
const RESOURCE = 'Google Gemma 4 31B IT'

const synthesized = (resource = RESOURCE, startedAt = ANCHOR, day = '2026-08-04'): Incident => ({
  id: `bs-hist:r-1:${day}`,
  title: `${resource} — recovered`,
  status: 'resolved',
  impact: 'minor',
  componentNames: [resource],
  startedAt,
  resolvedAt: new Date(Date.parse(startedAt) + 39 * 60_000).toISOString(),
  duration: '39m',
  timeline: [],
  derived: 'status_history',
  derivedDay: day,
})

const feedRow = (title: string, startedAt: string): MonthlyIncidentEntry => {
  // `startedAt` is deliberately unparseable in one case, so derive `resolvedAt` only when it parses —
  // an entry with a broken timestamp is exactly the shape being asserted on.
  const at = Date.parse(startedAt)
  return {
    id: `#rss-${title}-${startedAt}`,
    title,
    startedAt,
    resolvedAt: Number.isNaN(at) ? null : new Date(at + 10 * 60_000).toISOString(),
    durationMin: 10,
    finalStatus: 'resolved',
    impact: 'minor',
  }
}

const svc = (incidents: Incident[]): ServiceStatus => ({
  id: 'together', name: 'Together AI', status: 'operational', incidents,
} as ServiceStatus)

const existingWith = (entries: MonthlyIncidentEntry[]): MonthlyIncidents => ({
  lastUpdated: '2026-08-30T00:00:00.000Z',
  services: {
    together: {
      count: entries.length,
      totalMinutes: entries.reduce((n, e) => n + e.durationMin, 0),
      longestMinutes: Math.max(0, ...entries.map((e) => e.durationMin)),
      dates: [...new Set(entries.map((e) => e.startedAt.slice(0, 10)))],
      incidentIds: entries.map((e) => e.id),
      durations: Object.fromEntries(entries.map((e) => [e.id, e.durationMin])),
      incidents: entries,
    },
  },
})

describe('#1295 — derivedDayAlreadyBankedFromFeed', () => {
  it('reports the real production collision', () => {
    // 2026-08-04, Google Gemma 4 31B IT: 10 RSS rows already banked, then one synthesized day-total.
    const banked = Array.from({ length: 10 }, (_, i) =>
      feedRow(`${RESOURCE} — ${i % 2 ? 'recovered' : 'down'}`, `2026-08-04T${String(8 + i).padStart(2, '0')}:11:00.000Z`))
    expect(derivedDayAlreadyBankedFromFeed(banked, synthesized())).toBe(true)
  })

  it('does not suppress when the banked row is a DIFFERENT resource that day', () => {
    // The day is shared but the outage is not — suppressing here would under-count, which is the
    // direction of the #1292 bug this synthesis exists to fix.
    const banked = [feedRow('Qwen3.5 9B — down', '2026-08-04T13:00:00.000Z')]
    expect(derivedDayAlreadyBankedFromFeed(banked, synthesized())).toBe(false)
  })

  it('matches a feed row that OPENS before the local day and ends inside it', () => {
    // The live case the start-instant test missed: together's `Inkling Small — down` ran
    // 06:14:36Z → 07:26:37Z against a local day opening at 07:00Z, so it began 45 min outside the
    // window and ended 26 min inside — and the day-total was banked on top of it.
    const straddling = feedRow(`${RESOURCE} — down`, '2026-08-04T06:14:36.000Z')
    straddling.resolvedAt = '2026-08-04T07:26:37.000Z'
    expect(derivedDayAlreadyBankedFromFeed([straddling], synthesized())).toBe(true)
  })

  it('matches a feed row in the LAST hour of the local day', () => {
    // The upper edge. Without this, deleting the `from >= dayEnd` half of the window test leaves both
    // suites green — verified by mutation — while it decides a real deletion on production data.
    const late = feedRow(`${RESOURCE} — down`, '2026-08-05T06:30:00.000Z')
    late.resolvedAt = '2026-08-05T06:50:00.000Z'
    expect(derivedDayAlreadyBankedFromFeed([late], synthesized())).toBe(true)
    // ...and the instant the NEXT local day opens is outside it.
    const next = feedRow(`${RESOURCE} — down`, '2026-08-05T07:00:00.000Z')
    next.resolvedAt = '2026-08-05T07:10:00.000Z'
    expect(derivedDayAlreadyBankedFromFeed([next], synthesized())).toBe(false)
  })

  it('does not suppress when the same resource was banked on the ADJACENT day', () => {
    // The window is anchor ± 12h. A row before that belongs to the previous local day; matching it
    // would re-create the +/-1 day over-claim #1292 removed from the claim-walk.
    // 06:00Z is still 2026-08-03 in Pacific — the previous local day, one hour before this one opens.
    const banked = [feedRow(`${RESOURCE} — down`, '2026-08-04T06:00:00.000Z')]
    expect(derivedDayAlreadyBankedFromFeed(banked, synthesized())).toBe(false)
    // ...and the boundary itself is inclusive at the start of the local day (07:00Z).
    expect(derivedDayAlreadyBankedFromFeed(
      [feedRow(`${RESOURCE} — down`, '2026-08-04T07:00:00.000Z')], synthesized())).toBe(true)
  })

  it('does not let a LONGER resource name suppress the shorter one it contains', () => {
    // SUFFIX nesting: one resource name ends with another. `services.ts`'s claim-walk matches
    // longest-first for this reason — it credits the feed item to the longer resource ONLY, so the
    // shorter one's day stays unclaimed and IS synthesized. A containment match here would then delete
    // it, re-creating #1292's under-report.
    const banked = [feedRow('eu.api.helicone.ai — down', '2026-08-04T13:00:00.000Z')]
    const shorter = synthesized('helicone.ai')
    expect(derivedDayAlreadyBankedFromFeed(banked, shorter)).toBe(false)
    // ...while the resource the feed actually named is still matched.
    expect(derivedDayAlreadyBankedFromFeed(banked, synthesized('eu.api.helicone.ai'))).toBe(true)
  })

  it('does not let a PREFIX-nested resource name suppress the shorter one', () => {
    // PREFIX nesting: one resource name STARTS with another. This is what the ` — ` separator exists
    // for — without it `'Inkling Small — down'.startsWith('Inkling')` is true and the shorter
    // resource's own downtime day would be deleted. The suffix case above cannot catch this, because
    // `startsWith` alone already rejects it.
    const banked = [feedRow('Inkling Small — down', '2026-08-04T13:00:00.000Z')]
    expect(derivedDayAlreadyBankedFromFeed(banked, synthesized('Inkling'))).toBe(false)
    expect(derivedDayAlreadyBankedFromFeed(banked, synthesized('Inkling Small'))).toBe(true)
  })

  it('collapses an UNRESOLVED banked row to its start instant', () => {
    // The branch the interval fix added. `until = to` (NaN) makes every window comparison false, so an
    // unresolved row of the same resource would match every derived day in the month.
    const open = feedRow(`${RESOURCE} — down`, '2026-08-04T13:00:00.000Z')
    open.resolvedAt = null
    expect(derivedDayAlreadyBankedFromFeed([open], synthesized())).toBe(true)
    const elsewhere = feedRow(`${RESOURCE} — down`, '2026-08-01T13:00:00.000Z')
    elsewhere.resolvedAt = null
    expect(derivedDayAlreadyBankedFromFeed([elsewhere], synthesized())).toBe(false)
  })

  it('keeps the row when the DERIVED anchor itself is unparseable', () => {
    const banked = [feedRow(`${RESOURCE} — down`, '2026-08-04T13:00:00.000Z')]
    expect(derivedDayAlreadyBankedFromFeed(banked, { ...synthesized(), startedAt: 'not-a-date' })).toBe(false)
  })

  it('treats another SYNTHESIZED row as no evidence at all', () => {
    const banked: MonthlyIncidentEntry[] = [{
      ...feedRow(`${RESOURCE} — recovered`, ANCHOR), derived: 'status_history', derivedDay: '2026-08-04',
    }]
    expect(derivedDayAlreadyBankedFromFeed(banked, synthesized())).toBe(false)
  })

  it('keeps the row when the input cannot decide', () => {
    // Undecidable is not evidence of coverage: a missing resource name (nothing to match) or an
    // unparseable stored timestamp must leave the incident to be banked, not silently dropped.
    const banked = [feedRow(`${RESOURCE} — down`, '2026-08-04T13:00:00.000Z')]
    expect(derivedDayAlreadyBankedFromFeed(banked, { ...synthesized(), componentNames: [] })).toBe(false)
    expect(derivedDayAlreadyBankedFromFeed(
      [feedRow(`${RESOURCE} — down`, 'not-a-date')], synthesized())).toBe(false)
  })
})

describe('#1295 — accumulateMonthlyIncidents does not double-bank', () => {
  it('skips the synthesized day-total when the feed row is already banked', () => {
    const banked = [feedRow(`${RESOURCE} — down`, '2026-08-04T13:00:00.000Z')]
    const out = accumulateMonthlyIncidents(existingWith(banked), [svc([synthesized()])], '2026-08', null)
    const data = out.services.together
    expect(data.incidents?.map((e) => e.id)).toEqual(banked.map((e) => e.id))
    expect(data.count, 'the outage was counted twice').toBe(1)
    expect(data.totalMinutes, 'the day total was added on top of the feed rows').toBe(10)
  })

  it('still banks a synthesized day the feed never covered', () => {
    // The whole point of #1292: a day with no feed row must still produce an incident.
    const banked = [feedRow(`${RESOURCE} — down`, '2026-08-01T03:00:00.000Z')]
    const out = accumulateMonthlyIncidents(existingWith(banked), [svc([synthesized()])], '2026-08', null)
    expect(out.services.together.count).toBe(2)
    expect(out.services.together.incidents?.some((e) => e.derived === 'status_history')).toBe(true)
  })

  it('still banks a synthesized day for a resource the feed did not name', () => {
    const banked = [feedRow('Qwen3.5 9B — down', '2026-08-04T13:00:00.000Z')]
    const out = accumulateMonthlyIncidents(existingWith(banked), [svc([synthesized()])], '2026-08', null)
    expect(out.services.together.count).toBe(2)
  })

  it('leaves a NON-derived incident alone whatever is already banked', () => {
    // The guard must not widen: an RSS row arriving for a day that already has one is the
    // pre-existing id-dedup path's business, not this one's.
    const banked = [feedRow(`${RESOURCE} — down`, '2026-08-04T13:00:00.000Z')]
    const rss: Incident = {
      id: '#rss-new', title: `${RESOURCE} — recovered`, status: 'resolved', impact: 'minor',
      componentNames: [RESOURCE], startedAt: '2026-08-04T15:00:00.000Z',
      resolvedAt: '2026-08-04T15:20:00.000Z', duration: '20m', timeline: [],
    }
    const out = accumulateMonthlyIncidents(existingWith(banked), [svc([rss])], '2026-08', null)
    expect(out.services.together.count).toBe(2)
  })
})
