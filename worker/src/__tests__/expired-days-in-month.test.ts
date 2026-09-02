import { describe, it, expect } from 'vitest'
import { expiredDaysInMonth, MONTH_NOT_ENDED, archiveContentCensus, censusRegressions } from '../monthly-archive'

// #1260 — `buildMonthlyArchive` reads every day of uptime from `history:{date}`, which expires, and
// writes the result over the TTL-less `archive:monthly`. This is the predicate the rebuild endpoint
// refuses on, so its boundary is the difference between a guard and a destructive write.

const RETENTION = 90
const at = (iso: string) => Date.parse(`${iso}T12:00:00Z`)

describe('expiredDaysInMonth', () => {
  it('returns 0 for a month entirely inside the window', () => {
    // 2026-07 is 20-51 days old on 2026-08-20.
    expect(expiredDaysInMonth('2026-07', RETENTION, at('2026-08-20'))).toBe(0)
  })

  it('returns every day for a month entirely past the window', () => {
    // 2026-01 is >200 days old; January has 31 days.
    expect(expiredDaysInMonth('2026-01', RETENTION, at('2026-08-20'))).toBe(31)
  })

  it('counts only the expired prefix of a straddling month', () => {
    // On 2026-08-20, 2026-05-22 is exactly 90 days old and therefore the last expired day, so
    // 2026-05-01..22 are gone and 05-23 onward survive.
    expect(expiredDaysInMonth('2026-05', RETENTION, at('2026-08-20'))).toBe(22)
  })

  it('is exact at the boundary day', () => {
    // A day exactly `retentionDays` old counts as expired — deliberately one day early, because the
    // caller is guarding a write that cannot be undone.
    expect(expiredDaysInMonth('2026-05', RETENTION, at('2026-08-19'))).toBe(21)
    expect(expiredDaysInMonth('2026-05', RETENTION, at('2026-08-21'))).toBe(23)
  })

  it('handles February in a leap year and a 30-day month', () => {
    expect(expiredDaysInMonth('2024-02', RETENTION, at('2026-08-20'))).toBe(29)
    expect(expiredDaysInMonth('2026-04', RETENTION, at('2026-08-20'))).toBe(30)
  })

  it('rejects a month that has not happened, rather than calling it safe', () => {
    // 0 means "full rebuild, proceed" — a typo'd future month must not read as that.
    expect(expiredDaysInMonth('2026-12', RETENTION, at('2026-08-20'))).toBeLessThan(0)
  })

  it('returns a negative for a month it cannot parse, never the safe-looking 0', () => {
    // 0 is the value that means "full rebuild, proceed" — a parse failure must not report it.
    expect(expiredDaysInMonth('0000-01', RETENTION, at('2026-08-20'))).toBeLessThan(0)
  })

  // #1274 — the CURRENT month used to return 0, indistinguishable from a legitimate full rebuild of
  // a completed recent month. Rebuilding it freezes a PARTIAL archive, and the month-end cron writes
  // the previous month only when nothing is stored, so it never replaces it. No `:prev:` backup
  // exists to fall back on either — a first-ever write has no prior bytes to copy.
  it('rejects the current month, which used to read as a full rebuild', () => {
    expect(expiredDaysInMonth('2026-08', RETENTION, at('2026-08-24'))).toBe(MONTH_NOT_ENDED)
    // Including its first and last days, so the answer does not depend on where in the month we are.
    expect(expiredDaysInMonth('2026-08', RETENTION, at('2026-08-01'))).toBe(MONTH_NOT_ENDED)
    expect(expiredDaysInMonth('2026-08', RETENTION, at('2026-08-31'))).toBe(MONTH_NOT_ENDED)
  })

  it('accepts the month that just ended, on its first day', () => {
    // The boundary the guard must not overshoot: rebuilding the month that just closed is the
    // documented operator action, and the month-end cron itself runs on the 1st.
    expect(expiredDaysInMonth('2026-07', RETENTION, at('2026-08-01'))).toBe(0)
  })

  it('tells "not ended" apart from "not a real month", because the operator hears different words', () => {
    // Both refuse, but only one of them means "you mistyped it".
    expect(expiredDaysInMonth('2026-13', RETENTION, at('2026-08-24'))).toBe(-1)
    expect(expiredDaysInMonth('2026-08', RETENTION, at('2026-08-24'))).not.toBe(-1)
    // Still one refusal to a caller that only tests the sign.
    expect(MONTH_NOT_ENDED).toBeLessThan(0)
  })
})

describe('archiveContentCensus (#1260)', () => {
  // `null` means "I could not read this", which the caller treats as unreadable. A 0/0 census for a
  // value that is not an archive would make anything at all look like an improvement over it.
  it('returns null for anything that is not a plausible archive object', () => {
    expect(archiveContentCensus(null)).toBeNull()
    expect(archiveContentCensus([])).toBeNull()
    expect(archiveContentCensus('hello')).toBeNull()
    expect(archiveContentCensus(42)).toBeNull()
    expect(archiveContentCensus({})).toBeNull()
    expect(archiveContentCensus({ services: [] })).toBeNull()
  })

  it('collects section KEYS generically, and leaves the regenerable narrative out', () => {
    const base = { period: '2026-07', generatedAt: 'x', daysCollected: 3, services: {} }
    expect(archiveContentCensus(base)!.sectionKeys).toEqual([])
    expect(archiveContentCensus({ ...base, security: { totalAlerts: 1 } })!.sectionKeys).toEqual(['security'])
    // `narrative` regenerates on every rebuild and is null after any AI blip — guarding it would
    // refuse rebuilds that lose nothing.
    expect(archiveContentCensus({ ...base, security: {}, degradation: {}, narrative: {} })!.sectionKeys)
      .toEqual(['degradation', 'security'])
    expect(archiveContentCensus({ ...base, security: null, degradation: null })!.sectionKeys).toEqual([])
  })

  it('returns null when a required scalar is the wrong type, rather than reading it as zero', () => {
    expect(archiveContentCensus({ daysCollected: '30', services: { a: {} } })).toBeNull()
  })

  it('counts per-service measurements separately from the roster', () => {
    const c = archiveContentCensus({
      period: 'p', generatedAt: 'g', daysCollected: 0,
      services: {
        a: { uptime: 99, score: 90, avgLatencyMs: 100 },
        b: { uptime: null, score: null, avgLatencyMs: null },
      },
    })!
    expect(c.services).toBe(2)
    expect(c.servicesWithUptime).toBe(1)
    expect(c.servicesWithScore).toBe(1)
    expect(c.servicesWithLatency).toBe(1)
  })
})

describe('censusRegressions (#1260)', () => {
  const census = (o: Record<string, unknown> = {}) => ({
    daysCollected: 0, services: 0, servicesWithUptime: 0, servicesWithScore: 0,
    servicesWithLatency: 0, sectionKeys: [] as string[], incidentIds: [] as string[], ...o,
  }) as Parameters<typeof censusRegressions>[0]

  it('reports every numeric entry that shrank', () => {
    expect(censusRegressions(census({ services: 2 }), census({ services: 1 })))
      .toContain('services')
  })

  it('names a section that vanished even when another appeared', () => {
    // A count would net to zero here and pass — the loss has to be identified, not tallied.
    const prior = census({ sectionKeys: ['degradation'] })
    const next = census({ sectionKeys: ['security'] })
    expect(censusRegressions(prior, next)).toContain('sections:degradation')
  })

  it('does not report an incident the caller can account for', () => {
    const prior = census({ incidentIds: ['inc-1', 'inc-2'] })
    const next = census({ incidentIds: ['inc-2'] })
    expect(censusRegressions(prior, next, new Set(['inc-1']))).toEqual([])
    expect(censusRegressions(prior, next)).toContain('incidents')
  })

  it('reports nothing when the rebuild holds at least as much', () => {
    expect(censusRegressions(census({ services: 1 }), census({ services: 2, sectionKeys: ['security'] }))).toEqual([])
  })
})
