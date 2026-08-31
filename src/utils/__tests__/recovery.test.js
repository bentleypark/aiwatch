import { describe, it, expect } from 'vitest'
import { parseDurationToMin, formatRecoveryMin, computeRecoveryStats } from '../recovery'

const NOW = Date.parse('2026-06-03T09:00:00Z')
const ago = (days, h = 0) => new Date(NOW - days * 86_400_000 - h * 3_600_000).toISOString()
const inc = (duration, startedAt, status = 'resolved') => ({ status, duration, startedAt })

describe('parseDurationToMin', () => {
  it('parses h+m, m-only, and h-only-ish forms', () => {
    expect(parseDurationToMin('29h 34m')).toBe(29 * 60 + 34)
    expect(parseDurationToMin('43m')).toBe(43)
    expect(parseDurationToMin('1h 20m')).toBe(80)
  })
  it('parses the "Xh 0m" form the worker emits for whole-hour durations', () => {
    // worker/src/utils.ts formatDuration always appends a minutes token (never bare "3h"),
    // so "3h 0m" is a real producer output — pin the producer↔consumer contract.
    expect(parseDurationToMin('3h 0m')).toBe(180)
  })
  it('returns 0 for empty / unparseable', () => {
    expect(parseDurationToMin('')).toBe(0)
    expect(parseDurationToMin(null)).toBe(0)
    expect(parseDurationToMin('soon')).toBe(0)
  })
})

describe('formatRecoveryMin', () => {
  it('formats minutes vs hours', () => {
    expect(formatRecoveryMin(34)).toBe('34m')
    expect(formatRecoveryMin(1774)).toBe('29h 34m')
    expect(formatRecoveryMin(80)).toBe('1h 20m')
  })
})

describe('computeRecoveryStats (#557 — median + worst, not mean)', () => {
  it('the Mistral case: median is the typical blip, max surfaces the 29h outage', () => {
    // 7-day set: one 29h34m outage + six 4–7m blips (the live 2026-06-03 data).
    const incidents = [
      inc('29h 34m', ago(2)), inc('43m', ago(2, 6)),
      inc('4m', ago(5)), inc('5m', ago(5, 12)), inc('6m', ago(6, 1)),
      inc('7m', ago(6, 2)), inc('5m', ago(6, 3)),
    ]
    const r = computeRecoveryStats(incidents, NOW, 7)
    // sorted mins: [4,5,5,6,7,43,1774] → median = index 3 = 6; max = 1774
    expect(r).toEqual({ medianMin: 6, maxMin: 1774, count: 7 })
    expect(formatRecoveryMin(r.medianMin)).toBe('6m')      // typical (was the misleading "4h 23m" mean)
    expect(formatRecoveryMin(r.maxMin)).toBe('29h 34m')    // worst, now surfaced
  })

  it('uses the lower-middle element for even counts (matches score.ts median convention)', () => {
    const r = computeRecoveryStats([inc('2m', ago(1)), inc('10m', ago(1, 1)), inc('20m', ago(1, 2)), inc('40m', ago(1, 3))], NOW, 7)
    // sorted [2,10,20,40], length 4 → index Math.floor(4/2)=2 → 20
    expect(r.medianMin).toBe(20)
    expect(r.maxMin).toBe(40)
  })

  it('single incident → median equals max (caller hides the redundant "worst")', () => {
    const r = computeRecoveryStats([inc('43m', ago(1))], NOW, 7)
    expect(r).toEqual({ medianMin: 43, maxMin: 43, count: 1 })
  })

  it('excludes incidents outside the 7-day window', () => {
    const r = computeRecoveryStats([inc('5m', ago(1)), inc('99h 0m', ago(9))], NOW, 7)
    expect(r).toEqual({ medianMin: 5, maxMin: 5, count: 1 }) // the 9-day-old outage dropped
  })

  it('ignores non-resolved, 0m, and missing-duration incidents', () => {
    const incidents = [
      inc('5m', ago(1)),
      inc('30m', ago(1, 1), 'investigating'), // not resolved
      inc('0m', ago(1, 2)),                    // 0m
      { status: 'resolved', startedAt: ago(1, 3) }, // no duration
    ]
    const r = computeRecoveryStats(incidents, NOW, 7)
    expect(r).toEqual({ medianMin: 5, maxMin: 5, count: 1 })
  })

  it('window edge is inclusive on the lower bound (>= cutoff)', () => {
    const atEdge = new Date(NOW - 7 * 86_400_000).toISOString()       // exactly 7d ago → included
    const justOlder = new Date(NOW - 7 * 86_400_000 - 1).toISOString() // 1ms older → excluded
    expect(computeRecoveryStats([inc('5m', atEdge)], NOW, 7)).toEqual({ medianMin: 5, maxMin: 5, count: 1 })
    expect(computeRecoveryStats([inc('5m', justOlder)], NOW, 7)).toBeNull()
  })

  it('returns null when nothing qualifies', () => {
    expect(computeRecoveryStats([], NOW, 7)).toBeNull()
    expect(computeRecoveryStats(undefined, NOW, 7)).toBeNull()
    expect(computeRecoveryStats([inc('10m', ago(20))], NOW, 7)).toBeNull() // all out of window
  })
})

describe('#1292 — a status_history-derived duration is not a recovery time', () => {
  // Its source is a per-day downtime-seconds bucket: no start, no end, no recovery event. Publishing
  // it here made this card read "17h 18m" while the Score Breakdown below it showed Recovery 15/15
  // and the ranking column showed "—" — three surfaces, three answers, one field. `score.ts`
  // `carriesRecoveryTime` asks the same question for the Score and the is-down page.
  const NOW = Date.parse('2026-08-29T00:00:00Z')
  const day = (back) => new Date(NOW - back * 86_400_000).toISOString()
  const derived = { id: 'bs-hist:1:d', status: 'resolved', duration: '17h 18m', startedAt: day(2), derived: 'status_history' }
  const real = { id: 'rss-1', status: 'resolved', duration: '30m', startedAt: day(3) }

  it('is excluded from the card entirely', () => {
    expect(computeRecoveryStats([derived], NOW)).toBeNull()
  })

  it('does not drag the median when a real incident is present', () => {
    const withBoth = computeRecoveryStats([real, derived], NOW)
    const realOnly = computeRecoveryStats([real], NOW)
    expect(withBoth).toEqual(realOnly)
    expect(withBoth.count, 'the derived one is not counted').toBe(1)
  })

  it('CONTROL — an ordinary resolved incident still counts', () => {
    expect(computeRecoveryStats([real], NOW).medianMin).toBe(30)
  })
})
