import { describe, it, expect } from 'vitest'
import { weightedDowntimeSeconds, startOfTodayUTC } from '../uptime-interval'

// #1006 — the shared interval accumulator. These pin the two rules a code review found the parsers
// drifting on: OPEN incidents clamp to now, and OVERLAPPING intervals merge (worst-weight-wins),
// never sum.
const H = 3_600_000 // one hour in ms
const NOW = Date.parse('2026-07-15T00:00:00Z')
const WINDOW_START = NOW - 30 * 86_400_000

describe('weightedDowntimeSeconds', () => {
  it('is 0 for no intervals (a clean window)', () => {
    expect(weightedDowntimeSeconds([], WINDOW_START, NOW)).toBe(0)
  })

  it('charges a closed full outage at weight 1.0', () => {
    const start = NOW - 5 * 86_400_000
    const s = weightedDowntimeSeconds([{ start, end: start + 2 * H, weight: 1 }], WINDOW_START, NOW)
    expect(s).toBe((2 * H) / 1000) // 7200s
  })

  it('charges a degraded window at its 0.3 weight', () => {
    const start = NOW - 5 * 86_400_000
    const s = weightedDowntimeSeconds([{ start, end: start + 10 * H, weight: 0.3 }], WINDOW_START, NOW)
    expect(s).toBeCloseTo((10 * H * 0.3) / 1000, 5)
  })

  it('clamps an OPEN incident (null end) to now — downtime accrues during a live outage', () => {
    const start = NOW - 4 * H // started 4h ago, still open
    const s = weightedDowntimeSeconds([{ start, end: null, weight: 1 }], WINDOW_START, NOW)
    expect(s).toBe((4 * H) / 1000) // 14400s, NOT dropped
  })

  it('clamps an unparseable (NaN) end to now, same as null', () => {
    const start = NOW - 4 * H
    const s = weightedDowntimeSeconds([{ start, end: NaN, weight: 1 }], WINDOW_START, NOW)
    expect(s).toBe((4 * H) / 1000)
  })

  it('drops an interval whose START is unparseable (can not place it)', () => {
    expect(weightedDowntimeSeconds([{ start: NaN, end: NOW, weight: 1 }], WINDOW_START, NOW)).toBe(0)
  })

  it('MERGES overlapping intervals — a full outage inside a degraded window counts each instant ONCE at the worst weight', () => {
    const base = NOW - 6 * 86_400_000
    // degraded 10:00–20:00 (10h @0.3), full 12:00–13:00 (1h @1.0) nested inside it.
    const s = weightedDowntimeSeconds(
      [
        { start: base, end: base + 10 * H, weight: 0.3 },
        { start: base + 2 * H, end: base + 3 * H, weight: 1 },
      ],
      WINDOW_START,
      NOW,
    )
    // Summing would give 10h*0.3 + 1h*1.0 = 4.0h. Correct merge: 9h@0.3 + 1h@1.0 = 2.7 + 1.0 = 3.7h.
    expect(s).toBeCloseTo((3.7 * H) / 1000, 5)
  })

  it('does not double-count two IDENTICAL overlapping intervals', () => {
    const start = NOW - 3 * 86_400_000
    const one = weightedDowntimeSeconds([{ start, end: start + 5 * H, weight: 1 }], WINDOW_START, NOW)
    const dup = weightedDowntimeSeconds(
      [
        { start, end: start + 5 * H, weight: 1 },
        { start, end: start + 5 * H, weight: 1 },
      ],
      WINDOW_START,
      NOW,
    )
    expect(dup).toBe(one)
  })

  it('clips an interval straddling the window start to the in-window portion only', () => {
    // starts 2 days before the window opens, ends 1 day inside it → only the 1 in-window day counts.
    const s = weightedDowntimeSeconds(
      [{ start: WINDOW_START - 2 * 86_400_000, end: WINDOW_START + 86_400_000, weight: 1 }],
      WINDOW_START,
      NOW,
    )
    expect(s).toBe(86_400) // one day of seconds
  })

  it('ignores an interval entirely outside the window', () => {
    const old = WINDOW_START - 5 * 86_400_000
    expect(weightedDowntimeSeconds([{ start: old, end: old + 2 * H, weight: 1 }], WINDOW_START, NOW)).toBe(0)
  })

  it('skips zero/negative-weight intervals (announced maintenance)', () => {
    const start = NOW - 5 * 86_400_000
    expect(weightedDowntimeSeconds([{ start, end: start + 2 * H, weight: 0 }], WINDOW_START, NOW)).toBe(0)
  })
})

describe('startOfTodayUTC (#1017)', () => {
  it('returns midnight UTC of the given instant', () => {
    expect(new Date(startOfTodayUTC(Date.parse('2026-07-25T14:30:00Z'))).toISOString()).toBe('2026-07-25T00:00:00.000Z')
  })

  it('is idempotent on an instant already at midnight', () => {
    const midnight = Date.parse('2026-07-25T00:00:00Z')
    expect(startOfTodayUTC(midnight)).toBe(midnight)
  })

  it('does not roll to the next/previous day across a month boundary', () => {
    // Regression guard: an earlier draft built this via Date.UTC(...parts) with the month passed
    // 1-based instead of Date.UTC's 0-based index, silently landing on the WRONG month.
    expect(new Date(startOfTodayUTC(Date.parse('2026-08-01T05:00:00Z'))).toISOString()).toBe('2026-08-01T00:00:00.000Z')
    expect(new Date(startOfTodayUTC(Date.parse('2026-01-31T23:59:59Z'))).toISOString()).toBe('2026-01-31T00:00:00.000Z')
  })

  it('a full-day interval ending at nowMs contributes its whole duration to "today"', () => {
    const now = Date.parse('2026-07-25T18:00:00Z') // 18h into the UTC day
    const todayStart = startOfTodayUTC(now)
    // Outage spans yesterday evening through now — only the portion inside today counts.
    const start = now - 30 * 3_600_000 // 30h before now (started yesterday)
    expect(weightedDowntimeSeconds([{ start, end: now, weight: 1 }], todayStart, now)).toBe(18 * 3600) // 18h of today
  })
})
