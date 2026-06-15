import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildCalendarFromIncidents } from '../calendar'

// Anchor incident dates to LOCAL noon so day-key math is stable regardless of the test runner's
// timezone (the calendar buckets by local date; noon never crosses a date boundary on a ±14h offset).
const atLocalNoon = (daysAgo) => {
  const d = new Date()
  d.setHours(12, 0, 0, 0)
  d.setDate(d.getDate() - daysAgo)
  return d
}
const iso = (daysAgo) => atLocalNoon(daysAgo).toISOString()

afterEach(() => vi.useRealTimers())

describe('buildCalendarFromIncidents — Phase 3 ongoing forward-fill (#662)', () => {
  it('RSS / no-dailyImpact: spans an ongoing incident startedAt→today (degraded service)', () => {
    vi.setSystemTime(new Date('2026-06-15T09:00:00Z'))
    const incidents = [{ status: 'investigating', impact: 'major', startedAt: iso(2) }]
    const cal = buildCalendarFromIncidents(incidents, undefined, 14, 'degraded')
    expect(cal[13]).toBe('degraded') // today
    expect(cal[12]).toBe('degraded') // today-1
    expect(cal[11]).toBe('degraded') // today-2 (start)
    expect(cal[10]).toBe('operational') // today-3 (before start)
  })

  it('RSS / null impact (Bedrock-shaped) spans as degraded_perf', () => {
    vi.setSystemTime(new Date('2026-06-15T09:00:00Z'))
    const incidents = [{ status: 'investigating', impact: null, startedAt: iso(2) }]
    const cal = buildCalendarFromIncidents(incidents, undefined, 14, 'degraded')
    expect(cal[13]).toBe('degraded_perf')
    expect(cal[11]).toBe('degraded_perf')
    expect(cal[10]).toBe('operational')
  })

  it('dailyImpact (statuspage): fills ONLY today for an ongoing incident, defers past days to official', () => {
    vi.setSystemTime(new Date('2026-06-15T09:00:00Z'))
    // Official record: one finalized past-day bucket; the ongoing incident itself started 2 days ago.
    const dailyImpact = { '2026-06-10': 'major' } // → degraded at its index
    const incidents = [{ status: 'investigating', impact: 'critical', startedAt: iso(2) }]
    const cal = buildCalendarFromIncidents(incidents, dailyImpact, 30, 'down')
    expect(cal[29]).toBe('down') // today — live ongoing status
    expect(cal[28]).toBe('operational') // today-1 (intermediate) NOT overridden
    expect(cal[27]).toBe('operational') // today-2 (start day) NOT overridden — deferred to official
    expect(cal[24]).toBe('degraded') // 2026-06-10 official bucket preserved
  })

  it('dailyImpact: Phase 3 does not escalate a finalized past bucket (worst-of touches today only)', () => {
    vi.setSystemTime(new Date('2026-06-15T09:00:00Z'))
    const dailyImpact = { '2026-06-13': 'major' } // degraded, finalized
    const incidents = [{ status: 'investigating', impact: 'critical', startedAt: iso(2) }] // critical=down
    const cal = buildCalendarFromIncidents(incidents, dailyImpact, 30, 'down')
    expect(cal[27]).toBe('degraded') // 06-13 stays the official 'degraded', NOT upgraded to 'down'
    expect(cal[29]).toBe('down') // today reflects the live critical
  })

  it('OPERATIONAL service with an open minor incident is NOT painted (claude-shaped, no noise)', () => {
    vi.setSystemTime(new Date('2026-06-15T09:00:00Z'))
    const dailyImpact = { '2026-06-10': 'major' }
    const incidents = [{ status: 'investigating', impact: 'minor', startedAt: iso(1) }]
    const cal = buildCalendarFromIncidents(incidents, dailyImpact, 30, 'operational')
    expect(cal[29]).toBe('operational') // today NOT filled — service is operational
    expect(cal[24]).toBe('degraded') // official past bucket still shown
  })

  it('RSS: clamps a pre-window ongoing incident to the window start (fills every cell)', () => {
    vi.setSystemTime(new Date('2026-06-15T09:00:00Z'))
    const incidents = [{ status: 'investigating', impact: 'major', startedAt: iso(40) }] // before the 14d window
    const cal = buildCalendarFromIncidents(incidents, undefined, 14, 'down')
    expect(cal[0]).toBe('degraded') // oldest cell filled (clamped to windowStart, no out-of-bounds)
    expect(cal[13]).toBe('degraded') // today
  })

  it('RSS: multiple overlapping ongoing incidents merge worst-of', () => {
    vi.setSystemTime(new Date('2026-06-15T09:00:00Z'))
    const incidents = [
      { status: 'investigating', impact: 'minor', startedAt: iso(4) }, // older, yellow
      { status: 'investigating', impact: 'critical', startedAt: iso(1) }, // newer, red
    ]
    const cal = buildCalendarFromIncidents(incidents, undefined, 14, 'down')
    expect(cal[9]).toBe('degraded_perf') // today-4: only the minor incident
    expect(cal[12]).toBe('down') // today-1: critical overlaps → worst-of red
    expect(cal[13]).toBe('down') // today
  })

  it('skips a malformed startedAt without throwing', () => {
    vi.setSystemTime(new Date('2026-06-15T09:00:00Z'))
    const incidents = [{ status: 'investigating', impact: 'major', startedAt: 'not-a-date' }]
    const cal = buildCalendarFromIncidents(incidents, undefined, 14, 'down')
    expect(cal.every((s) => s === 'operational')).toBe(true)
  })

  it('does not forward-fill a RESOLVED incident (only its start day)', () => {
    vi.setSystemTime(new Date('2026-06-15T09:00:00Z'))
    const incidents = [{ status: 'resolved', impact: 'major', startedAt: iso(3), resolvedAt: iso(3) }]
    const cal = buildCalendarFromIncidents(incidents, undefined, 14, 'operational')
    expect(cal[10]).toBe('degraded') // start day (today-3), painted by Phase 2
    expect(cal[11]).toBe('operational') // not spanned forward
    expect(cal[13]).toBe('operational') // today untouched (resolved)
  })
})
