// #1292 — synthesized incidents must not arm `prunePhantomIncidents` against the feed.
//
// The prune deletes DURABLE accumulator rows and publishes a public ⚪ withdrawal notice for what it
// deletes, so it protects itself two ways, both of which appending synthetics would defeat:
//   1. `!live?.length` — for a service whose feed died the live list was EMPTY, so pruning was
//      structurally off. Synthetics make it non-empty, switching pruning ON for exactly the services
//      #1292 is about.
//   2. `oldestLiveStart` is a watermark for how far back the FEED reaches. Synthetics come from a
//      different source with its own 30-day reach, so they would claim visibility the feed never had,
//      and an entry that merely fell off the feed window would read as confidently absent.
// `withdrawalHold` does not save it either: its incident-running clause needs a non-resolved live
// incident, and every synthesized incident is resolved by construction.
import { describe, it, expect } from 'vitest'
import { prunePhantomIncidents, PHANTOM_PRUNE_AFTER_MISSED_RUNS } from '../monthly-archive'
import type { ServiceStatus } from '../types'
import type { MonthlyIncidents } from '../monthly-archive'

const OLD_ENTRY = {
  id: 'real-1',
  title: 'api.hconeai.com — down',
  startedAt: '2026-08-20T00:00:00.000Z',
  finalStatus: 'investigating',
  impact: 'minor',
}

/** Ids still stored for helicone — the service key disappears once its last entry is pruned. */
function idsIn(data: unknown): string[] {
  const svc = (data as { services?: Record<string, { incidents?: Array<{ id: string }> }> })
    .services?.helicone
  return (svc?.incidents ?? []).map((e) => e.id)
}

/** A faithful `MonthlyIncidents` — every aggregate the prune rewrites is present and consistent with
 *  the single entry, so the fixture is a state the accumulator could actually produce. */
function archive() {
  return {
    lastUpdated: '2026-08-20T00:10:00.000Z',
    services: {
      helicone: {
        count: 1, totalMinutes: 60, longestMinutes: 60,
        dates: ['2026-08-20'], incidentIds: [OLD_ENTRY.id],
        durations: { [OLD_ENTRY.id]: 60 },
        incidents: [{ ...OLD_ENTRY }],
      },
    },
  } as unknown as MonthlyIncidents
}

/** A service whose ONLY live incidents are synthesized — the post-#1292 shape for a dead feed. */
function syntheticOnly(): ServiceStatus[] {
  return [{
    id: 'helicone', name: 'Helicone', provider: 'Helicone', category: 'api', status: 'operational',
    incidents: [{
      // Reaches 15 days FURTHER BACK than the accumulator entry — that reach is what makes the
      // watermark claim the feed can see the entry, when the feed in fact published nothing at all.
      id: 'bs-hist:7615061:2026-08-07', title: 'api.hconeai.com — recovered', status: 'resolved',
      impact: 'minor', startedAt: '2026-08-05T09:00:00.000Z', resolvedAt: '2026-08-07T20:35:00.000Z',
      duration: '52h 54m', timeline: [], derived: 'status_history',
    }],
  } as unknown as ServiceStatus]
}

describe('#1292 — synthesized incidents must not arm the phantom prune', () => {
  it('does not prune a real accumulator row when the only live incidents are synthesized', () => {
    let data: MonthlyIncidents = archive()
    // Well past the threshold: if synthetics counted as evidence, the row would be gone by now.
    for (let i = 0; i < PHANTOM_PRUNE_AFTER_MISSED_RUNS + 2; i++) {
      data = prunePhantomIncidents(data, syntheticOnly(), [])
    }
    expect(idsIn(data), 'a synthesized incident is not evidence the feed still publishes').toContain('real-1')
  })

  it('still prunes when a REAL live incident vouches for the feed', () => {
    // The control: the guard must not have been widened into "never prune a BetterStack service".
    const live = syntheticOnly()
    ;(live[0].incidents as unknown as Array<Record<string, unknown>>).push({
      id: 'rss-99', title: 'api.hconeai.com — recovered', status: 'resolved', impact: 'minor',
      startedAt: '2026-08-01T00:00:00.000Z', resolvedAt: '2026-08-01T01:00:00.000Z',
      duration: '1h 0m', timeline: [],
    })
    let data: MonthlyIncidents = archive()
    for (let i = 0; i < PHANTOM_PRUNE_AFTER_MISSED_RUNS; i++) {
      data = prunePhantomIncidents(data, live, [])
    }
    // A service whose last entry is pruned drops out of the archive entirely, so read defensively.
    expect(idsIn(data), 'a real feed incident older than the entry still arms the prune').not.toContain('real-1')
  })
})
