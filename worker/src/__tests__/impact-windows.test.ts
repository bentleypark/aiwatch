import { describe, it, expect } from 'vitest'
import { mergeImpactWindows, calculateAIWatchScore } from '../score'
import { aggregateIncidentDurations } from '../monthly-archive'
import type { Incident, ServiceStatus } from '../types'

/** #1505 — downtime is the union of impact intervals. Cases marked `archived` are rows copied out of
 *  `aiwatch-reports/_data/`; the rest are constructed to exercise one boundary each.
 *
 *  The negatives carry the weight: records that do not overlap must stay separate windows, or the
 *  union would quietly turn a month of per-model incidents into one long one. */

const iv = (start: string, end: string) => ({ startMs: Date.parse(start), minutes: (Date.parse(end) - Date.parse(start)) / 60_000 })

describe('mergeImpactWindows', () => {
  it('collapses an hourly re-publication into the one outage it describes — archived kimi, 2026-08-03', () => {
    // Five records, starts an hour apart, all closing at 23:51 within one minute.
    const w = mergeImpactWindows([
      iv('2026-08-03T20:17:12.981+08:00', '2026-08-03T23:51:17.187+08:00'),
      iv('2026-08-03T22:17:12.639+08:00', '2026-08-03T23:51:13.165+08:00'),
      iv('2026-08-03T21:17:13.797+08:00', '2026-08-03T23:51:12.930+08:00'),
      iv('2026-08-03T23:17:12.333+08:00', '2026-08-03T23:51:12.873+08:00'),
      iv('2026-08-03T19:17:12.202+08:00', '2026-08-03T23:51:12.383+08:00'),
    ])
    expect(w).toEqual([274]) // 19:17:12 → 23:51:17, not the 12h 51m the five records sum to
  })

  it('keeps per-model rows that repeat a title but never overlap — archived claude, 2026-06-17', () => {
    expect(mergeImpactWindows([
      iv('2026-06-17T05:08:19.998Z', '2026-06-17T06:37:45.424Z'),
      iv('2026-06-17T08:24:34.955Z', '2026-06-17T10:03:12.447Z'),
      iv('2026-06-17T15:34:18.385Z', '2026-06-17T16:28:10.294Z'),
    ])).toEqual([89, 99, 54])
  })

  it('keeps two incidents minutes apart as two windows — archived mistral pair, 2026-05-06', () => {
    expect(mergeImpactWindows([
      iv('2026-05-06T08:08:58Z', '2026-05-06T08:11:41Z'),
      iv('2026-05-06T08:20:29Z', '2026-05-06T08:21:43Z'),
    ])).toEqual([3, 1])
  })

  it('merges overlapping records whatever their titles — the service-level union', () => {
    expect(mergeImpactWindows([
      { startMs: Date.parse('2026-08-20T01:00:00Z'), minutes: 120 },
      { startMs: Date.parse('2026-08-20T02:00:00Z'), minutes: 61 },
    ])).toEqual([121])
  })

  it('merges a record that starts exactly where the previous one ends', () => {
    expect(mergeImpactWindows([
      { startMs: Date.parse('2026-09-26T00:00:00Z'), minutes: 10 },
      { startMs: Date.parse('2026-09-26T00:10:00Z'), minutes: 5 },
    ])).toEqual([15])
  })

  it('does not depend on input order', () => {
    const a = { startMs: Date.parse('2026-09-01T00:00:00Z'), minutes: 30 }
    const b = { startMs: Date.parse('2026-09-01T00:20:00Z'), minutes: 30 }
    const c = { startMs: Date.parse('2026-09-02T00:00:00Z'), minutes: 5 }
    expect(mergeImpactWindows([c, b, a]).sort()).toEqual(mergeImpactWindows([a, b, c]).sort())
    expect(mergeImpactWindows([c, b, a]).sort()).toEqual([5, 50])
  })

  it('keeps a record with an unparseable start as its own window', () => {
    expect(mergeImpactWindows([
      { startMs: Date.parse('2026-06-01'), minutes: 30 },
      { startMs: Date.parse('not a date'), minutes: 20 },
    ]).sort()).toEqual([20, 30])
  })

  it('returns nothing for no records', () => {
    expect(mergeImpactWindows([])).toEqual([])
  })
})

describe('the two call sites that sum per-incident durations', () => {
  const row = (id: string, startedAt: string, durationMin: number, finalStatus: 'resolved' | 'monitoring' = 'resolved') =>
    ({ id, title: `t-${id}`, startedAt, resolvedAt: finalStatus === 'resolved' ? startedAt : null, durationMin, finalStatus, impact: 'minor' as const })

  it('the archive publishes overlapping records as one window', () => {
    const r = aggregateIncidentDurations([
      row('a', '2026-08-03T19:17:00+08:00', 275),
      row('b', '2026-08-03T20:17:00+08:00', 215),
      row('c', '2026-08-03T21:17:00+08:00', 154),
      row('d', '2026-08-10T00:00:00Z', 30),
    ], 4, 0, 0)
    expect(r.totalMin).toBe(305) // 275 + 30, not 674
    expect(r.countedTotalMin).toBe(305)
    expect(r.longestMin).toBe(275)
    expect(r.countedCount).toBe(2) // the avg-resolution divisor: two windows, not four records
    expect(r.mergedRecords).toBe(2)
  })

  it('counts an open record\'s overlap with a resolved one once in the total, and keeps it out of the counted figures', () => {
    const r = aggregateIncidentDurations([
      row('done', '2026-08-10T00:00:00Z', 60),
      row('open', '2026-08-10T00:30:00Z', 60, 'monitoring'),
    ], 2, 0, 0)
    expect(r.totalMin).toBe(90)
    expect(r.countedTotalMin).toBe(60)
    expect(r.countedCount).toBe(1)
    expect(r.excludedUnresolved).toBe(1)
  })

  it('the Score samples overlapping records once for Recovery', () => {
    const inc = (o: Partial<Incident> & Pick<Incident, 'id' | 'startedAt'>): Incident => ({
      title: 'Elevated search request error rate', status: 'resolved', impact: 'critical', duration: null, timeline: [], ...o,
    })
    // archived — kimi, 2026-08-03
    const five = [
      inc({ id: 'z3m6h0jg1023', startedAt: '2026-08-03T20:17:12.981+08:00', resolvedAt: '2026-08-03T23:51:17.187+08:00', duration: '3h 35m' }),
      inc({ id: 'mhlpldr24pbp', startedAt: '2026-08-03T22:17:12.639+08:00', resolvedAt: '2026-08-03T23:51:13.165+08:00', duration: '1h 35m' }),
      inc({ id: '8gg4p8f4p36c', startedAt: '2026-08-03T21:17:13.797+08:00', resolvedAt: '2026-08-03T23:51:12.930+08:00', duration: '2h 34m' }),
      inc({ id: '0yyp39qb795m', startedAt: '2026-08-03T23:17:12.333+08:00', resolvedAt: '2026-08-03T23:51:12.873+08:00', duration: '35m' }),
      inc({ id: 'zzycpn3dj9qv', startedAt: '2026-08-03T19:17:12.202+08:00', resolvedAt: '2026-08-03T23:51:12.383+08:00', duration: '4h 35m' }),
    ]
    const svc = (incidents: Incident[]): ServiceStatus =>
      ({ id: 'kimi', name: 'Kimi', status: 'operational', uptime30d: 100, incidents, lastChecked: '2026-08-31T00:00:00Z' }) as unknown as ServiceStatus
    const window = { startISO: '2026-08-01T00:00:00Z', endISO: '2026-08-31T23:59:59Z' }
    const probe = { kind: 'unavailable' } as const
    const earliest = five.find((i) => i.id === 'zzycpn3dj9qv')!
    expect(calculateAIWatchScore(svc(five), 30, probe, window).breakdown.recovery)
      .toBe(calculateAIWatchScore(svc([earliest]), 30, probe, window).breakdown.recovery)
  })
})
