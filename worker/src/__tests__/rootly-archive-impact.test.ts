import { describe, it, expect } from 'vitest'
import { computeMonthlyScore, type MonthlyIncidentEntry } from '../monthly-archive'
import { rootlyScoringImpact } from '../parsers/rootly'
import { SERVICES } from '../services'
import rows from './fixtures/mistral-archive-2026-09-incidents.json'

// #1557 — the 2026-09 backfill path. `incidents:monthly:2026-09` is no longer accumulated after 10-01,
// so its Mistral rows keep whatever impact they were stored with. The archive build applies the same
// default the live path does. Fixture: mistral's `incidentList` from `archive:monthly:2026-09`.

const WINDOW = { startISO: '2026-09-01T00:00:00.000Z', endISO: '2026-10-01T00:00:00.000Z' }
const mistral = SERVICES.find((s) => s.id === 'mistral')!
const entries = rows as MonthlyIncidentEntry[]

describe('computeMonthlyScore — Rootly rows with no stored impact (#1557)', () => {
  it('counts them for a Rootly service, so the monthly Score is lower than if they were informational', () => {
    const nullRows = entries.filter((e) => e.impact == null)
    const rootly = computeMonthlyScore('mistral', nullRows, 99.45, new Map(), WINDOW, mistral)
    const asInformational = computeMonthlyScore('mistral', nullRows, 99.45, new Map(), WINDOW, { ...mistral, rootlyFeed: undefined })
    expect(rootly.score).not.toBeNull()
    expect(rootly.score!).toBeLessThan(asInformational.score!)
  })

  it('leaves a non-Rootly service\'s null-impact rows informational', () => {
    const informational = entries.map((e) => ({ ...e, impact: null }))
    const other = SERVICES.find((s) => s.id === 'claude')!
    const r = computeMonthlyScore('claude', informational, 99.45, new Map(), WINDOW, other)
    const none = computeMonthlyScore('claude', [], 99.45, new Map(), WINDOW, other)
    expect(r.score).toBe(none.score)
  })

  it('still keeps an advisory-titled row out', () => {
    const advisory: MonthlyIncidentEntry = {
      id: 'adv', title: 'Usage limits depleting faster than expected', startedAt: '2026-09-15T00:00:00.000Z',
      resolvedAt: '2026-09-15T05:00:00.000Z', durationMin: 300, finalStatus: 'resolved', impact: null,
    }
    const r = computeMonthlyScore('mistral', [advisory], 99.45, new Map(), WINDOW, mistral)
    const none = computeMonthlyScore('mistral', [], 99.45, new Map(), WINDOW, mistral)
    expect(r.score).toBe(none.score)
  })
})

describe('rootlyScoringImpact (#1557)', () => {
  it('scores an unattributed incident minor', () => {
    expect(rootlyScoringImpact({ impact: null, title: 'Elevated error rate on some of our services' })).toBe('minor')
  })

  it('keeps the severity the chart gave', () => {
    expect(rootlyScoringImpact({ impact: 'major', title: 'Availability drop for Mistral OCR 4' })).toBe('major')
    expect(rootlyScoringImpact({ impact: 'minor', title: 'Batch API Degraded' })).toBe('minor')
  })

  it('leaves an advisory title informational', () => {
    expect(rootlyScoringImpact({ impact: null, title: 'Usage limits depleting faster than expected' })).toBeNull()
  })
})
