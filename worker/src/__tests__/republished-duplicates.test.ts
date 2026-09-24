import { describe, it, expect } from 'vitest'
import { dropRepublishedDuplicates, calculateAIWatchScore } from '../score'
import { aggregateIncidentDurations } from '../monthly-archive'
import type { Incident, ServiceStatus } from '../types'

/** #1502 — a provider that re-publishes one incident on a timer leaves N records closing together.
 *  Cases marked `archived` are rows copied out of `aiwatch-reports/_data/`; the rest are constructed to
 *  exercise one guard each.
 *
 *  The negatives carry the weight. Grouping by repeated title alone matches hundreds of groups across
 *  those months — Anthropic's per-model rows, Together's per-resource rows — and the close-minute half
 *  is the only thing that rejects them. A test pinning the positives alone would pass against a rule
 *  that collapsed all of them.
 *
 *  The last two cases pin the WIRING: the pure function is useless if either call site drops it, and
 *  a dropped call changes only a summed figure nothing else asserts (#966/#940's tested-twin class). */

const inc = (o: Partial<Incident> & Pick<Incident, 'id' | 'startedAt'>): Incident => ({
  title: 'Elevated search request error rate',
  status: 'resolved',
  impact: 'critical',
  duration: null,
  timeline: [],
  ...o,
})

// archived — kimi, 2026-08-03, verbatim from `_data/2026-08.json`: starts an hour apart, closing within ONE
// minute of each other but at five DIFFERENT instants (`:12.383` … `:17.187`). Five records, one outage.
const kimiAug3 = [
  inc({ id: 'z3m6h0jg1023', startedAt: '2026-08-03T20:17:12.981+08:00', resolvedAt: '2026-08-03T23:51:17.187+08:00', duration: '3h 35m' }),
  inc({ id: 'mhlpldr24pbp', startedAt: '2026-08-03T22:17:12.639+08:00', resolvedAt: '2026-08-03T23:51:13.165+08:00', duration: '1h 35m' }),
  inc({ id: '8gg4p8f4p36c', startedAt: '2026-08-03T21:17:13.797+08:00', resolvedAt: '2026-08-03T23:51:12.930+08:00', duration: '2h 34m' }),
  inc({ id: '0yyp39qb795m', startedAt: '2026-08-03T23:17:12.333+08:00', resolvedAt: '2026-08-03T23:51:12.873+08:00', duration: '35m' }),
  inc({ id: 'zzycpn3dj9qv', startedAt: '2026-08-03T19:17:12.202+08:00', resolvedAt: '2026-08-03T23:51:12.383+08:00', duration: '4h 35m' }),
]

describe('dropRepublishedDuplicates', () => {
  it('keeps the earliest record of an hourly re-publication, which already spans the outage', () => {
    const out = dropRepublishedDuplicates(kimiAug3)
    expect(out.map((i) => i.id)).toEqual(['zzycpn3dj9qv']) // the 19:17 record, last in the archive's order
    expect(out[0].duration).toBe('4h 35m') // the outage, not the 12h 54m the five records sum to
  })

  it('matches siblings whose close differs by SECONDS — archived kimi rows, 2026-07-12', () => {
    const out = dropRepublishedDuplicates([
      inc({ id: '4tzvxt4w8gyz', title: 'Agentic 模型错误报警', startedAt: '2026-07-12T11:29:16.309+08:00', resolvedAt: '2026-07-12T13:05:26.758+08:00' }),
      inc({ id: 'gqm6fbzrx2w4', title: 'Agentic 模型错误报警', startedAt: '2026-07-12T06:29:15.546+08:00', resolvedAt: '2026-07-12T13:05:25.103+08:00' }),
    ])
    expect(out.map((i) => i.id)).toEqual(['gqm6fbzrx2w4'])
  })

  it('keeps every record when nothing repeats, and returns the same array reference', () => {
    const one = [inc({ id: 'a', startedAt: '2026-08-13T02:41:00+08:00', resolvedAt: '2026-08-13T04:39:00+08:00' })]
    expect(dropRepublishedDuplicates(one)).toBe(one)
  })

  it('does NOT drop per-model rows that merely repeat a title — archived claude rows, 2026-06-17', () => {
    const perModel = [
      inc({ id: 'zw75lhl39skc', title: 'Elevated errors for Claude Opus 4.8', startedAt: '2026-06-17T05:08:19.998Z', resolvedAt: '2026-06-17T06:37:45.424Z' }),
      inc({ id: 'k8563n9wd0r8', title: 'Elevated errors for Claude Opus 4.8', startedAt: '2026-06-17T08:24:34.955Z', resolvedAt: '2026-06-17T10:03:12.447Z' }),
      inc({ id: 's107yx224p9r', title: 'Elevated errors for Claude Opus 4.8', startedAt: '2026-06-17T15:34:18.385Z', resolvedAt: '2026-06-17T16:28:10.294Z' }),
    ]
    expect(dropRepublishedDuplicates(perModel)).toBe(perModel)
  })

  it('does NOT drop two incidents that close in the same HOUR — archived mistral pair, 2026-05-06', () => {
    // 12m45s end to end: an hour-wide key reports one 13m incident where the provider published a 3m
    // and a 2m. The minute is the boundary.
    const sameHour = [
      inc({ id: 'cdcb6ccb', title: 'Completion API Degraded · Chat Completions', startedAt: '2026-05-06T08:08:58Z', resolvedAt: '2026-05-06T08:11:41Z' }),
      inc({ id: '61bf005c', title: 'Completion API Degraded · Chat Completions', startedAt: '2026-05-06T08:20:29Z', resolvedAt: '2026-05-06T08:21:43Z' }),
    ]
    expect(dropRepublishedDuplicates(sameHour)).toBe(sameHour)
  })

  it('does NOT drop rows that share a close minute under different titles', () => {
    const sameClose = [
      inc({ id: 'a', title: 'Inkling — down', startedAt: '2026-08-20T01:00:00Z', resolvedAt: '2026-08-20T03:00:00Z' }),
      inc({ id: 'b', title: 'Kimi K3 — down', startedAt: '2026-08-20T02:00:00Z', resolvedAt: '2026-08-20T03:00:30Z' }),
    ]
    expect(dropRepublishedDuplicates(sameClose)).toBe(sameClose)
  })

  it('does NOT drop an unresolved row, which has no close to share', () => {
    const open = [
      inc({ id: 'a', status: 'investigating', startedAt: '2026-08-03T19:17:00+08:00', resolvedAt: null }),
      inc({ id: 'b', status: 'investigating', startedAt: '2026-08-03T20:17:00+08:00', resolvedAt: null }),
    ]
    expect(dropRepublishedDuplicates(open)).toBe(open)
  })

  it('does NOT drop rows whose timestamps AIWatch synthesized (#1292, #1480)', () => {
    const synthesized = [
      inc({ id: 'a', derived: 'status_history', derivedDay: '2026-08-15', startedAt: '2026-08-15T12:00:00Z', resolvedAt: '2026-08-15T12:00:00Z' }),
      inc({ id: 'b', derived: 'status_history', derivedDay: '2026-08-15', startedAt: '2026-08-15T12:00:00Z', resolvedAt: '2026-08-15T12:00:00Z' }),
    ]
    expect(dropRepublishedDuplicates(synthesized)).toBe(synthesized)

    const noStart = [
      inc({ id: 'a', startUnknown: true, startedAt: '2026-08-15T12:00:00Z', resolvedAt: '2026-08-15T12:00:00Z' }),
      inc({ id: 'b', startUnknown: true, startedAt: '2026-08-15T12:00:00Z', resolvedAt: '2026-08-15T12:00:00Z' }),
    ]
    expect(dropRepublishedDuplicates(noStart)).toBe(noStart)
  })

  it('drops per group, keeps ungrouped rows, and preserves order', () => {
    const mixed = [
      ...kimiAug3,
      inc({ id: 'solo', title: '二维码登录异常', startedAt: '2026-08-07T09:00:00+08:00', resolvedAt: '2026-08-07T09:30:00+08:00' }),
      inc({ id: 'x', title: '开放平台 API 服务异常', startedAt: '2026-08-21T01:00:00+08:00', resolvedAt: '2026-08-21T01:20:00+08:00' }),
      inc({ id: 'y', title: '开放平台 API 服务异常', startedAt: '2026-08-21T00:00:00+08:00', resolvedAt: '2026-08-21T01:20:00+08:00' }),
    ]
    expect(dropRepublishedDuplicates(mixed).map((i) => i.id)).toEqual(['zzycpn3dj9qv', 'solo', 'y'])
  })
})

describe('the two call sites that sum per-incident durations', () => {
  // The same five-record shape as `MonthlyIncidentEntry` rows. Closes are uniform here, so this case
  // proves the wiring only — the minute-truncation of the key is pinned by the pure-function cases above.
  const entries = [
    { id: 'a', title: 'Elevated search request error rate', startedAt: '2026-08-03T19:17:00+08:00', resolvedAt: '2026-08-03T23:51:17+08:00', durationMin: 275, finalStatus: 'resolved' as const, impact: 'critical' as const },
    { id: 'b', title: 'Elevated search request error rate', startedAt: '2026-08-03T20:17:00+08:00', resolvedAt: '2026-08-03T23:51:17+08:00', durationMin: 215, finalStatus: 'resolved' as const, impact: 'critical' as const },
    { id: 'c', title: 'Elevated search request error rate', startedAt: '2026-08-03T21:17:00+08:00', resolvedAt: '2026-08-03T23:51:17+08:00', durationMin: 154, finalStatus: 'resolved' as const, impact: 'critical' as const },
    { id: 'd', title: 'Elevated search request error rate', startedAt: '2026-08-03T22:17:00+08:00', resolvedAt: '2026-08-03T23:51:17+08:00', durationMin: 95, finalStatus: 'resolved' as const, impact: 'critical' as const },
    { id: 'e', title: 'Elevated search request error rate', startedAt: '2026-08-03T23:17:00+08:00', resolvedAt: '2026-08-03T23:51:17+08:00', durationMin: 35, finalStatus: 'resolved' as const, impact: 'critical' as const },
  ]

  it('the archive publishes the outage once, not the sum of its republications', () => {
    const r = aggregateIncidentDurations(entries, entries.length, 0, 0)
    expect(r.totalMin).toBe(275) // not 275+215+154+95+35 = 774
    expect(r.longestMin).toBe(275)
    expect(r.countedCount).toBe(1) // the avg-resolution divisor: one incident, not five
  })

  it('the Score samples the outage once for Recovery', () => {
    const svc = (incidents: Incident[]): ServiceStatus =>
      ({ id: 'kimi', name: 'Kimi', status: 'operational', uptime30d: 100, incidents, lastChecked: '2026-08-31T00:00:00Z' }) as unknown as ServiceStatus
    const window = { startISO: '2026-08-01T00:00:00Z', endISO: '2026-08-31T23:59:59Z' }
    const probe = { kind: 'unavailable' } as const
    const earliest = kimiAug3.find((i) => i.id === 'zzycpn3dj9qv')!  // the 19:17 record the dedup keeps
    const five = calculateAIWatchScore(svc(kimiAug3), 30, probe, window)
    const one = calculateAIWatchScore(svc([earliest]), 30, probe, window)
    // Five records of one outage must score exactly as the one outage does.
    expect(five.breakdown.recovery).toBe(one.breakdown.recovery)
    expect(five.score).toBe(one.score)
  })
})
