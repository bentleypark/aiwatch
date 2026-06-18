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

// NOTE (#663): cell keys are impact-aligned — 'minor' (yellow) / 'major' (orange) / 'critical' (red).
// The 4th arg is the live wire `service.status` (operational|degraded|down) — NOT a cell key.
describe('buildCalendarFromIncidents — Phase 3 ongoing forward-fill (#662)', () => {
  it('RSS / no-dailyImpact: spans an ongoing incident startedAt→today (degraded service)', () => {
    vi.setSystemTime(new Date('2026-06-15T09:00:00Z'))
    const incidents = [{ status: 'investigating', impact: 'major', startedAt: iso(2) }]
    const cal = buildCalendarFromIncidents(incidents, undefined, 14, 'degraded')
    expect(cal[13]).toBe('major') // today
    expect(cal[12]).toBe('major') // today-1
    expect(cal[11]).toBe('major') // today-2 (start)
    expect(cal[10]).toBe('operational') // today-3 (before start)
  })

  it('RSS / null impact (Bedrock-shaped) spans as minor (yellow)', () => {
    vi.setSystemTime(new Date('2026-06-15T09:00:00Z'))
    const incidents = [{ status: 'investigating', impact: null, startedAt: iso(2) }]
    const cal = buildCalendarFromIncidents(incidents, undefined, 14, 'degraded')
    expect(cal[13]).toBe('minor')
    expect(cal[11]).toBe('minor')
    expect(cal[10]).toBe('operational')
  })

  it('dailyImpact (statuspage): fills ONLY today for an ongoing incident, defers past days to official', () => {
    vi.setSystemTime(new Date('2026-06-15T09:00:00Z'))
    // Official record: one finalized past-day bucket; the ongoing incident itself started 2 days ago.
    const dailyImpact = { '2026-06-10': 'major' } // impact value → 'major' cell at its index
    const incidents = [{ status: 'investigating', impact: 'critical', startedAt: iso(2) }]
    const cal = buildCalendarFromIncidents(incidents, dailyImpact, 30, 'down')
    expect(cal[29]).toBe('critical') // today — live ongoing status
    expect(cal[28]).toBe('operational') // today-1 (intermediate) NOT overridden
    expect(cal[27]).toBe('operational') // today-2 (start day) NOT overridden — deferred to official
    expect(cal[24]).toBe('major') // 2026-06-10 official bucket preserved
  })

  it('dailyImpact: Phase 3 does not escalate a finalized past bucket (worst-of touches today only)', () => {
    vi.setSystemTime(new Date('2026-06-15T09:00:00Z'))
    const dailyImpact = { '2026-06-13': 'major' } // major, finalized
    const incidents = [{ status: 'investigating', impact: 'critical', startedAt: iso(2) }] // critical
    const cal = buildCalendarFromIncidents(incidents, dailyImpact, 30, 'down')
    expect(cal[27]).toBe('major') // 06-13 stays the official 'major', NOT upgraded to 'critical'
    expect(cal[29]).toBe('critical') // today reflects the live critical
  })

  it('OPERATIONAL service with an open minor incident is NOT painted (claude-shaped, no noise)', () => {
    vi.setSystemTime(new Date('2026-06-15T09:00:00Z'))
    const dailyImpact = { '2026-06-10': 'major' }
    const incidents = [{ status: 'investigating', impact: 'minor', startedAt: iso(1) }]
    const cal = buildCalendarFromIncidents(incidents, dailyImpact, 30, 'operational')
    expect(cal[29]).toBe('operational') // today NOT filled — service is operational
    expect(cal[24]).toBe('major') // official past bucket still shown
  })

  it('RSS: clamps a pre-window ongoing incident to the window start (fills every cell)', () => {
    vi.setSystemTime(new Date('2026-06-15T09:00:00Z'))
    const incidents = [{ status: 'investigating', impact: 'major', startedAt: iso(40) }] // before the 14d window
    const cal = buildCalendarFromIncidents(incidents, undefined, 14, 'down')
    expect(cal[0]).toBe('major') // oldest cell filled (clamped to windowStart, no out-of-bounds)
    expect(cal[13]).toBe('major') // today
  })

  it('RSS: multiple overlapping ongoing incidents merge worst-of', () => {
    vi.setSystemTime(new Date('2026-06-15T09:00:00Z'))
    const incidents = [
      { status: 'investigating', impact: 'minor', startedAt: iso(4) }, // older, yellow
      { status: 'investigating', impact: 'critical', startedAt: iso(1) }, // newer, red
    ]
    const cal = buildCalendarFromIncidents(incidents, undefined, 14, 'down')
    expect(cal[9]).toBe('minor') // today-4: only the minor incident
    expect(cal[12]).toBe('critical') // today-1: critical overlaps → worst-of red
    expect(cal[13]).toBe('critical') // today
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
    expect(cal[10]).toBe('major') // start day (today-3), painted by Phase 2
    expect(cal[11]).toBe('operational') // not spanned forward
    expect(cal[13]).toBe('operational') // today untouched (resolved)
  })

  it('an unknown (non-null) impact falls back to minor (#663 documented contract)', () => {
    vi.setSystemTime(new Date('2026-06-15T09:00:00Z'))
    const incidents = [{ status: 'investigating', impact: 'something_else', startedAt: iso(1) }]
    const cal = buildCalendarFromIncidents(incidents, undefined, 14, 'down')
    expect(cal[13]).toBe('minor') // unknown → minor (yellow)
  })

  it('a dailyImpact minor bucket lands as a minor cell (Phase 1 via impactToCellStatus)', () => {
    vi.setSystemTime(new Date('2026-06-15T09:00:00Z'))
    const cal = buildCalendarFromIncidents([], { '2026-06-12': 'minor' }, 30, 'operational')
    expect(cal[26]).toBe('minor') // 2026-06-12 = today-3 → index 26 (30-day window)
  })
})

describe('buildCalendarFromIncidents — Phase 2 resolved multi-day span for no-dailyImpact (#691)', () => {
  it('spans a RESOLVED multi-day incident startedAt→resolvedAt (Bedrock-shaped, service now operational)', () => {
    vi.setSystemTime(new Date('2026-06-18T09:00:00Z'))
    // 3-day outage that resolved: started today-5, resolved today-3. Service recovered → operational.
    const incidents = [{ status: 'resolved', impact: 'major', startedAt: iso(5), resolvedAt: iso(3) }]
    const cal = buildCalendarFromIncidents(incidents, undefined, 14, 'operational')
    expect(cal[8]).toBe('major') // today-5 (start)
    expect(cal[9]).toBe('major') // today-4 (middle — previously left green)
    expect(cal[10]).toBe('major') // today-3 (resolved day)
    expect(cal[7]).toBe('operational') // today-6 (before start)
    expect(cal[11]).toBe('operational') // today-2 (after resolve)
    expect(cal[13]).toBe('operational') // today
  })

  it('clamps a RESOLVED incident that started before the window to the window start', () => {
    vi.setSystemTime(new Date('2026-06-18T09:00:00Z'))
    const incidents = [{ status: 'resolved', impact: 'critical', startedAt: iso(20), resolvedAt: iso(2) }]
    const cal = buildCalendarFromIncidents(incidents, undefined, 14, 'operational')
    expect(cal[0]).toBe('critical') // oldest cell (clamped start, no out-of-bounds)
    expect(cal[11]).toBe('critical') // today-2 (resolved day)
    expect(cal[12]).toBe('operational') // today-1 (after resolve)
  })

  it('dailyImpact service: a RESOLVED incident still paints ONLY its start day (official record owns the span)', () => {
    vi.setSystemTime(new Date('2026-06-18T09:00:00Z'))
    const dailyImpact = { '2026-06-13': 'minor' } // official record present
    const incidents = [{ status: 'resolved', impact: 'major', startedAt: iso(5), resolvedAt: iso(3) }]
    const cal = buildCalendarFromIncidents(incidents, dailyImpact, 14, 'operational')
    expect(cal[8]).toBe('major') // today-5 start day supplemented
    expect(cal[9]).toBe('operational') // middle NOT spanned — deferred to the official daily record
    expect(cal[10]).toBe('operational') // resolved day NOT spanned
  })

  it('no-dailyImpact: an ONGOING incident is unaffected by the Phase 2 span (still start-day only here)', () => {
    vi.setSystemTime(new Date('2026-06-18T09:00:00Z'))
    // ongoing (no resolvedAt) on an operational service → Phase 3 gate is off, so only the start day paints
    const incidents = [{ status: 'investigating', impact: 'major', startedAt: iso(2) }]
    const cal = buildCalendarFromIncidents(incidents, undefined, 14, 'operational')
    expect(cal[11]).toBe('major') // start day
    expect(cal[12]).toBe('operational') // not spanned (Phase 3 gated on non-operational)
    expect(cal[13]).toBe('operational') // today
  })

  it('guards a malformed resolvedAt — falls back to painting the start day only', () => {
    vi.setSystemTime(new Date('2026-06-18T09:00:00Z'))
    const incidents = [{ status: 'resolved', impact: 'major', startedAt: iso(4), resolvedAt: 'not-a-date' }]
    const cal = buildCalendarFromIncidents(incidents, undefined, 14, 'operational')
    expect(cal[9]).toBe('major') // start day (today-4)
    expect(cal[10]).toBe('operational') // no span from a bad resolvedAt
  })

  it('clamps a FUTURE resolvedAt to today (never paints beyond the window)', () => {
    vi.setSystemTime(new Date('2026-06-18T09:00:00Z'))
    // resolvedAt 2 days in the FUTURE (clock skew / bad feed) → span must cap at today
    const incidents = [{ status: 'resolved', impact: 'major', startedAt: iso(2), resolvedAt: iso(-2) }]
    const cal = buildCalendarFromIncidents(incidents, undefined, 14, 'operational')
    expect(cal[11]).toBe('major') // start day (today-2)
    expect(cal[13]).toBe('major') // today — clamped end
    expect(() => buildCalendarFromIncidents(incidents, undefined, 14, 'operational')).not.toThrow()
  })

  it('paints the start day only for an INVERTED range (resolvedAt < startedAt), never nothing', () => {
    vi.setSystemTime(new Date('2026-06-18T09:00:00Z'))
    const incidents = [{ status: 'resolved', impact: 'critical', startedAt: iso(3), resolvedAt: iso(5) }]
    const cal = buildCalendarFromIncidents(incidents, undefined, 14, 'operational')
    expect(cal[10]).toBe('critical') // start day (today-3) still painted
    expect(cal[8]).toBe('operational') // does NOT paint backwards toward the inverted "end"
  })

  it('single-day RESOLVED span (startedAt === resolvedAt) paints exactly one cell', () => {
    vi.setSystemTime(new Date('2026-06-18T09:00:00Z'))
    const incidents = [{ status: 'resolved', impact: 'major', startedAt: iso(3), resolvedAt: iso(3) }]
    const cal = buildCalendarFromIncidents(incidents, undefined, 14, 'operational')
    expect(cal[9]).toBe('operational') // day before
    expect(cal[10]).toBe('major') // the single span day (loop runs exactly once)
    expect(cal[11]).toBe('operational') // day after
  })

  it('null-impact RESOLVED multi-day span paints minor (Bedrock-shaped null impact)', () => {
    vi.setSystemTime(new Date('2026-06-18T09:00:00Z'))
    const incidents = [{ status: 'resolved', impact: null, startedAt: iso(4), resolvedAt: iso(2) }]
    const cal = buildCalendarFromIncidents(incidents, undefined, 14, 'operational')
    expect(cal[9]).toBe('minor') // start
    expect(cal[10]).toBe('minor') // middle
    expect(cal[11]).toBe('minor') // resolved day
  })

  it('overlapping RESOLVED spans merge worst-of (minor span ∪ critical span)', () => {
    vi.setSystemTime(new Date('2026-06-18T09:00:00Z'))
    const incidents = [
      { status: 'resolved', impact: 'minor', startedAt: iso(6), resolvedAt: iso(2) }, // 5-day minor
      { status: 'resolved', impact: 'critical', startedAt: iso(4), resolvedAt: iso(3) }, // 2-day critical (overlaps)
    ]
    const cal = buildCalendarFromIncidents(incidents, undefined, 14, 'operational')
    expect(cal[7]).toBe('minor') // today-6: minor only
    expect(cal[9]).toBe('critical') // today-4: overlap → worst-of red
    expect(cal[10]).toBe('critical') // today-3: overlap → red
    expect(cal[11]).toBe('minor') // today-2: minor tail only
  })

  it('composes Phase 2 resolved span + Phase 3 ongoing fill on the same no-dailyImpact service', () => {
    vi.setSystemTime(new Date('2026-06-18T09:00:00Z'))
    // A past resolved multi-day outage AND a currently-ongoing one, service live status = down.
    const incidents = [
      { status: 'resolved', impact: 'major', startedAt: iso(8), resolvedAt: iso(6) }, // past, spanned by Phase 2
      { status: 'investigating', impact: 'critical', startedAt: iso(1) }, // ongoing, filled by Phase 3
    ]
    const cal = buildCalendarFromIncidents(incidents, undefined, 14, 'down')
    expect(cal[5]).toBe('major') // today-8 (resolved start)
    expect(cal[6]).toBe('major') // today-7 (resolved middle — Phase 2 span)
    expect(cal[7]).toBe('major') // today-6 (resolved end)
    expect(cal[8]).toBe('operational') // today-5 (gap between the two incidents)
    expect(cal[12]).toBe('critical') // today-1 (ongoing start — Phase 3)
    expect(cal[13]).toBe('critical') // today (ongoing → forward-filled)
  })
})

describe('calendar cell keys ↔ cal.status.* i18n coverage (#663 decoupling pin)', () => {
  it('every calendar cell key has a cal.status.* label in both en and ko', async () => {
    const { default: en } = await import('../../locales/en')
    const { default: ko } = await import('../../locales/ko')
    for (const key of ['operational', 'minor', 'major', 'critical']) {
      expect(en[`cal.status.${key}`], `en missing cal.status.${key}`).toBeTruthy()
      expect(ko[`cal.status.${key}`], `ko missing cal.status.${key}`).toBeTruthy()
    }
  })
})
