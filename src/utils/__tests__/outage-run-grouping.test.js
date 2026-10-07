// #1623 — consecutive Better Stack day rows the worker proved to be ONE outage render as one group row,
// headed by the worker's measure of the whole run.
import { describe, it, expect } from 'vitest'
import { groupIncidents } from '../incidentGrouping'
import { groupRangeText, groupBadgeText, hidesEntryStatus } from '../groupLabels'
import { sumGroupDuration } from '../incidentSort'
import { filterIncidentList } from '../incidentFilter'
import { groupIncidents as edgeGroupIncidents } from '../../../api/_is-down/incident-grouping'

const RUN = { id: 'bs-run:7615061:2026-10-02', startDay: '2026-10-02', endDay: '2026-10-05', days: 4, downSec: 178_169, ongoing: true }
const row = (day, extra) => ({
  id: `bs-hist:7615061:${day}`, title: 'api.hconeai.com — downtime', status: 'resolved', impact: 'minor',
  timeline: [], derived: 'status_history', derivedDay: day, outageRun: RUN,
  startedAt: `${day}T21:00:00.000Z`, resolvedAt: `${day}T22:30:00.000Z`, duration: '1h 30m', ...extra,
})
const helicone = [
  row('2026-10-05', { title: 'api.hconeai.com — down', status: 'investigating', resolvedAt: null, duration: null, startedAt: '2026-10-05T09:00:00.000Z' }),
  row('2026-10-04', { continuing: true, resolvedAt: '2026-10-05T21:00:00.000Z', duration: '24h 0m' }),
  row('2026-10-03', { continuing: true, resolvedAt: '2026-10-04T21:00:00.000Z', duration: '24h 0m' }),
  row('2026-10-02', { continuing: true }),
]
const DONE = { ...RUN, endDay: '2026-10-04', days: 3, ongoing: false }
const finished = helicone.slice(1).map((e) => ({ ...e, continuing: undefined, outageRun: DONE }))
const t = (k) => ({ 'incidents.group.days': '{n} days', 'incidents.group.flaps': '× {n} flaps', 'incidents.duration.ongoing': 'Ongoing' })[k] ?? k

describe.each([['SPA', groupIncidents], ['Edge', edgeGroupIncidents]])('%s groupIncidents', (_n, group) => {
  it('folds a running multi-day outage into one group, newest day first', () => {
    const rows = group(helicone)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: 'group', run: true, startDay: '2026-10-02', endDay: '2026-10-05', ongoing: true, count: 4, downSec: 178_169,
      normalizedTitle: 'api.hconeai.com — down', uniformStatus: true, statusCounts: { ongoing: 4 },
    })
    expect(rows[0].entries.map((e) => e.derivedDay)).toEqual(['2026-10-05', '2026-10-04', '2026-10-03', '2026-10-02'])
  })

  it('heads a run from the worker\'s whole-run measure even when only some of its days reached the list', () => {
    // A 7-day list, the feed floor or the downtime floor can drop the early days; the header must not
    // restate the first surviving day as the outage's start.
    const [g] = group(helicone.slice(0, 2))
    expect(g).toMatchObject({ kind: 'group', startDay: '2026-10-02', count: 4 })
    expect(g.entries).toHaveLength(2)
  })

  it('keeps a finished one grouped and resolved', () => {
    expect(group(finished)[0]).toMatchObject({ kind: 'group', run: true, ongoing: false, statusCounts: { resolved: 3 } })
  })

  it('leaves a day row without a run on its own', () => {
    const { outageRun: _r, ...lone } = helicone[3]
    expect(group([lone])).toEqual([{ kind: 'single', incident: lone }])
  })
})

describe('the Incidents page after its period cut', () => {
  it('still heads a run from its true first day', () => {
    const kept = filterIncidentList(helicone, { serviceFilter: 'all', statusFilter: 'all', cutoff: Date.parse('2026-10-04T00:00:00Z') })
    expect(kept.length).toBeLessThan(helicone.length)
    expect(groupIncidents(kept)[0]).toMatchObject({ startDay: '2026-10-02', count: 4 })
  })
})

describe('group labels and totals', () => {
  it('state a run in days, ending "Ongoing" while it runs', () => {
    const [g] = groupIncidents(helicone)
    expect(groupBadgeText(g, t)).toBe('4 days')
    expect(groupRangeText(g, 'en', t)).toBe('Oct 2 → Ongoing')
    expect(groupRangeText(groupIncidents(finished)[0], 'en', t)).toBe('Oct 2 → Oct 4')
  })

  it('total the run from the worker, plus "ongoing" while it runs', () => {
    expect(sumGroupDuration(groupIncidents(helicone)[0])).toEqual({ totalMs: 178_169_000, hasOngoing: true, resolvedCount: 1, unknownCount: 0 })
  })

  it('CONTROL — a flap group keeps its count and timed range', () => {
    const g = { kind: 'group', count: 3, rangeStart: '2026-10-02T01:00:00Z', rangeEnd: '2026-10-02T02:00:00Z' }
    expect(groupBadgeText(g, t)).toBe('× 3 flaps')
    expect(groupRangeText(g, 'en', t)).toMatch(/:/)
  })
})

describe('hidesEntryStatus', () => {
  it('hides a past day inside a run, never today\'s ongoing row, never a flap group entry', () => {
    const [g] = groupIncidents(helicone)
    expect(g.entries.map((e) => hidesEntryStatus(g, e))).toEqual([false, true, true, true])
    expect(hidesEntryStatus({ kind: 'group' }, helicone[1])).toBe(false)
  })
})
