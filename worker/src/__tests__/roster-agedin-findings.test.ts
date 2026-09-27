import { describe, it, expect } from 'vitest'
import { rosterAgedInFindings } from '../roster-audit'

const DAY = 86_400_000
const NOW = Date.parse('2026-09-27T00:00:00Z')
const ago = (days: number) => new Date(NOW - days * DAY).toISOString()

describe('rosterAgedInFindings (#1518 — the single fixedScope-gated (b) call every cron branch makes)', () => {
  it('fixedScope=true suppresses (b) entirely, even with a real aged-in candidate present', () => {
    const entries = [{ id: 'A', dataAvailableSince: ago(90) }]
    expect(rosterAgedInFindings(entries, [], [], true, NOW)).toEqual([])
  })

  it('fixedScope=false runs the real (b) check and reports it', () => {
    const entries = [{ id: 'A', dataAvailableSince: ago(90) }]
    expect(rosterAgedInFindings(entries, [], [], false, NOW)).toEqual(['A'])
  })

  it('fixedScope does not affect scope/exclude behavior when false — same result as calling auditAgedInOutOfScope directly', () => {
    const entries = [
      { id: 'IN_SCOPE', dataAvailableSince: ago(90) },
      { id: 'EXCLUDED', dataAvailableSince: ago(90) },
      { id: 'AGED', dataAvailableSince: ago(90) },
    ]
    expect(rosterAgedInFindings(entries, ['IN_SCOPE'], ['EXCLUDED'], false, NOW)).toEqual(['AGED'])
  })
})
