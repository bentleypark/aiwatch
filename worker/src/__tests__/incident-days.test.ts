import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { calculateAIWatchScore } from '../score'
import { computeMonthlyScore, type MonthlyIncidentEntry } from '../monthly-archive'
import { incidentDay, incidentDays } from '../utils'
import type { Incident, ServiceStatus } from '../types'

const LAST = '2026-10-04'

describe('incidentDays (#1487)', () => {
  it('a 3-day outage covers 3 days, not 1', () => {
    expect(incidentDays({ startedAt: '2026-09-14T10:00:00.000Z', resolvedAt: '2026-09-16T08:00:00.000Z' }, LAST))
      .toEqual(['2026-09-14', '2026-09-15', '2026-09-16'])
  })

  it('an incident that crosses midnight by minutes covers both days', () => {
    expect(incidentDays({ startedAt: '2026-09-03T23:42:00.000Z', resolvedAt: '2026-09-04T00:42:00.000Z' }, LAST))
      .toEqual(['2026-09-03', '2026-09-04'])
  })

  it('an incident inside one day covers that day only', () => {
    expect(incidentDays({ startedAt: '2026-09-03T10:00:00.000Z', resolvedAt: '2026-09-03T11:00:00.000Z' }, LAST))
      .toEqual(['2026-09-03'])
  })

  it('the day of resolvedAt counts even when it is exactly midnight, as the calendar paints it', () => {
    expect(incidentDays({ startedAt: '2026-09-15T22:00:00.000Z', resolvedAt: '2026-09-16T00:00:00.000Z' }, LAST))
      .toEqual(['2026-09-15', '2026-09-16'])
  })

  it('an incident with no resolvedAt keeps its start day only, open or not', () => {
    expect(incidentDays({ startedAt: '2026-10-01T10:00:00.000Z', resolvedAt: null }, LAST)).toEqual(['2026-10-01'])
    expect(incidentDays({ startedAt: '2026-10-01T10:00:00.000Z' }, LAST)).toEqual(['2026-10-01'])
  })

  it('later days stop at lastDay', () => {
    expect(incidentDays({ startedAt: '2026-10-03T10:00:00.000Z', resolvedAt: '2026-10-09T10:00:00.000Z' }, LAST))
      .toEqual(['2026-10-03', '2026-10-04'])
  })

  it('keeps the start day when it is already past lastDay', () => {
    expect(incidentDays({ startedAt: '2026-10-05T10:00:00.000Z', resolvedAt: '2026-10-06T10:00:00.000Z' }, LAST)).toEqual(['2026-10-05'])
  })

  it('an inverted range keeps the start day only', () => {
    expect(incidentDays({ startedAt: '2026-09-05T10:00:00.000Z', resolvedAt: '2026-09-02T10:00:00.000Z' }, LAST))
      .toEqual(['2026-09-05'])
  })

  it('an unreadable resolvedAt keeps the start day only, and does not run to lastDay', () => {
    expect(incidentDays({ startedAt: '2026-09-05T10:00:00.000Z', resolvedAt: 'unknown' }, LAST)).toEqual(['2026-09-05'])
  })

  it('a status_history incident covers its stated day only, whatever resolvedAt says', () => {
    expect(incidentDays({ startedAt: '2026-09-05T23:00:00.000Z', resolvedAt: '2026-09-08T00:00:00.000Z', derived: 'status_history', derivedDay: '2026-09-06' }, LAST))
      .toEqual(['2026-09-06'])
  })

  it('a startUnknown incident keeps its one stated day, even if resolvedAt is later', () => {
    expect(incidentDays({ startedAt: '2026-09-10T23:30:00.000Z', resolvedAt: '2026-09-11T01:50:00.000Z', startUnknown: true }, LAST))
      .toEqual(['2026-09-10'])
  })

  it('reads an offset timestamp by its own date, as incidentDay does', () => {
    expect(incidentDays({ startedAt: '2026-10-02T23:30:00.000+08:00', resolvedAt: '2026-10-03T01:00:00.000+08:00' }, LAST))
      .toEqual(['2026-10-02', '2026-10-03'])
  })

  it('always includes incidentDay', () => {
    const samples = [
      { startedAt: '2026-09-14T10:00:00.000Z', resolvedAt: '2026-09-16T08:00:00.000Z' },
      { startedAt: '2026-10-03T06:26:12.555+08:00', resolvedAt: '2026-10-03T06:27:13.038+08:00' },
      { startedAt: '2026-09-05T10:00:00.000Z', resolvedAt: '2026-09-02T10:00:00.000Z' },
      { startedAt: '2026-10-09T10:00:00.000Z' },
      { startedAt: '2026-09-05T23:00:00.000Z', derived: 'status_history' as const, derivedDay: '2026-09-06' },
      { startedAt: 'garbage', resolvedAt: 'also garbage' },
      { startedAt: '', resolvedAt: '2026-09-02T10:00:00.000Z' },
    ]
    for (const s of samples) expect(incidentDays(s, LAST)).toContain(incidentDay(s))
  })
})

describe('Score counts every covered day (#1487)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-04T12:00:00.000Z'))
  })
  afterEach(() => vi.useRealTimers())

  const svc = (incidents: Incident[]): ServiceStatus => ({
    id: 'test', name: 'Test', provider: 'Test', category: 'api',
    status: 'operational', latency: null, uptime30d: 100, lastChecked: '2026-10-04T12:00:00.000Z', incidents,
  })
  const inc = (id: string, startedAt: string, resolvedAt: string | null, impact: Incident['impact'] = 'major', status: Incident['status'] = 'resolved'): Incident => ({
    id, title: id, status, impact, startedAt, resolvedAt, duration: null, timeline: [],
  })
  const score = (incidents: Incident[], window?: { startISO: string; endISO: string }) =>
    calculateAIWatchScore(svc(incidents), 30, { kind: 'unsupported' }, window)

  it('a 3-day provider-published outage reads 3 affected days, like three single-day incidents', () => {
    const spanning = score([inc('a', '2026-09-14T10:00:00.000Z', '2026-09-16T08:00:00.000Z')])
    const separate = score([
      inc('a', '2026-09-14T10:00:00.000Z', '2026-09-14T11:00:00.000Z'),
      inc('b', '2026-09-15T10:00:00.000Z', '2026-09-15T11:00:00.000Z'),
      inc('c', '2026-09-16T10:00:00.000Z', '2026-09-16T11:00:00.000Z'),
    ])
    expect(spanning.metrics.affectedDays30d).toBe(3)
    expect(separate.metrics.affectedDays30d).toBe(3)
    expect(spanning.breakdown.incidents).toBe(separate.breakdown.incidents)
    expect(spanning.breakdown.incidents).toBeCloseTo(25 * Math.exp(-3 / 10), 1)
  })

  it('weights each covered day: a 3-day minor incident is 0.9 weighted days', () => {
    const r = score([inc('a', '2026-09-14T10:00:00.000Z', '2026-09-16T08:00:00.000Z', 'minor')])
    expect(r.metrics.affectedDays30d).toBe(3)
    expect(r.breakdown.incidents).toBeCloseTo(25 * Math.exp(-0.9 / 10), 1)
  })

  it('a day takes the worst impact of the incidents covering it', () => {
    const r = score([
      inc('long', '2026-09-14T10:00:00.000Z', '2026-09-16T08:00:00.000Z', 'minor'),
      inc('short', '2026-09-15T10:00:00.000Z', '2026-09-15T11:00:00.000Z', 'major'),
    ])
    expect(r.metrics.affectedDays30d).toBe(3)
    expect(r.breakdown.incidents).toBeCloseTo(25 * Math.exp(-(0.3 + 1 + 0.3) / 10), 1)
  })

  it('an open incident counts its start day only, however long it has been open', () => {
    const r = score([inc('open', '2026-09-10T10:00:00.000Z', null, 'major', 'investigating')])
    expect(r.metrics.affectedDays30d).toBe(1)
    expect(r.breakdown.incidents).toBeCloseTo(25 * Math.exp(-1 / 10), 1)
  })

  it('an incident is counted whole in the month it started in, and in no other', () => {
    const september = { startISO: '2026-09-01T00:00:00.000Z', endISO: '2026-10-01T00:00:00.000Z' }
    const october = { startISO: '2026-10-01T00:00:00.000Z', endISO: '2026-11-01T00:00:00.000Z' }
    const crossing = [inc('a', '2026-09-30T10:00:00.000Z', '2026-10-02T08:00:00.000Z')]
    expect(score(crossing, september).metrics.affectedDays30d).toBe(3)
    expect(score(crossing, october).metrics.affectedDays30d).toBe(0)
  })

  it('an archived row frozen unresolved is one day, not every day to the month end', () => {
    const october = { startISO: '2026-10-01T00:00:00.000Z', endISO: '2026-11-01T00:00:00.000Z' }
    const r = score([inc('frozen', '2026-10-01T10:00:00.000Z', null, 'minor', 'investigating')], october)
    expect(r.metrics.affectedDays30d).toBe(1)
    expect(r.breakdown.incidents).toBeCloseTo(25 * Math.exp(-0.3 / 10), 1)
  })

  it('a resolvedAt in the future counts through today only', () => {
    const r = score([inc('future', '2026-10-01T10:00:00.000Z', '2026-12-31T10:00:00.000Z')])
    expect(r.metrics.affectedDays30d).toBe(4)
  })

  it('a startUnknown row whose resolvedAt an override moved later is still one day', () => {
    const september = { startISO: '2026-09-01T00:00:00.000Z', endISO: '2026-10-01T00:00:00.000Z' }
    const r = score([{ ...inc('u', '2026-09-10T23:30:00.000Z', '2026-09-11T01:50:00.000Z'), startUnknown: true }], september)
    expect(r.metrics.affectedDays30d).toBe(1)
  })

  it('null-impact incidents still add no days', () => {
    const r = score([inc('info', '2026-09-14T10:00:00.000Z', '2026-09-16T08:00:00.000Z', null)])
    expect(r.metrics.affectedDays30d).toBe(0)
  })

  it('a zero-length record stays one day', () => {
    const r = score([{ ...inc('z', '2026-09-14T10:00:00.000Z', '2026-09-14T10:00:00.000Z'), startUnknown: true, zeroLengthRecord: true }])
    expect(r.metrics.affectedDays30d).toBe(1)
  })
})

describe('the monthly archive Score reads the same days (#1487)', () => {
  const september = { startISO: '2026-09-01T00:00:00.000Z', endISO: '2026-10-01T00:00:00.000Z' }
  const entry = (over: Partial<MonthlyIncidentEntry>): MonthlyIncidentEntry => ({
    id: 'e', title: 'e', startedAt: '2026-09-14T10:00:00.000Z', resolvedAt: '2026-09-14T11:00:00.000Z',
    durationMin: 60, finalStatus: 'resolved', impact: 'major', ...over,
  })
  const monthly = (e: MonthlyIncidentEntry) => computeMonthlyScore('perplexity', [e], 99.9, new Map(), september, undefined).score!

  it('an archived row resolved days later scores below one resolved the same day, at equal duration', () => {
    const spanning = monthly(entry({ resolvedAt: '2026-09-16T08:00:00.000Z', durationMin: 60 }))
    const oneDay = monthly(entry({ resolvedAt: '2026-09-14T11:00:00.000Z', durationMin: 60 }))
    expect(spanning).toBeLessThan(oneDay)
  })

  it('a startUnknown row whose resolvedAt an override moved later scores as one day', () => {
    const base = entry({ startedAt: '2026-09-10T23:30:00.000Z', resolvedAt: '2026-09-10T23:30:00.000Z', durationMin: 0, startUnknown: true })
    const moved = { ...base, resolvedAt: '2026-09-11T01:50:00.000Z', durationMin: 140 }
    expect(monthly(moved)).toBe(monthly(base))
  })
})
