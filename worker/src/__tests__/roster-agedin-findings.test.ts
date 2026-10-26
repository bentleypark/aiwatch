import { describe, it, expect } from 'vitest'
import { rosterAgedInFindings } from '../roster-audit'

const DAY = 86_400_000
const NOW = Date.parse('2026-09-27T00:00:00Z')
const ago = (days: number) => new Date(NOW - days * DAY).toISOString()

describe('rosterAgedInFindings (#1518 — the single fixedScope-gated (b) call every cron branch makes)', () => {
  it('fixedScope=true reports nothing for an entry with no group information (the incident.io shape), even when aged in', () => {
    const entries = [{ id: 'A', dataAvailableSince: ago(90) }]
    expect(rosterAgedInFindings(entries, [], [], true, NOW)).toEqual([])
  })

  it('#1741 fixedScope=true still reports an aged-in top-level entry (groupId null)', () => {
    const entries = [{ id: 'TOP', dataAvailableSince: ago(90), groupId: null }]
    expect(rosterAgedInFindings(entries, [], [], true, NOW)).toEqual(['TOP'])
  })

  it('#1741 fixedScope=true does not report an aged-in group member', () => {
    const entries = [{ id: 'MODEL', dataAvailableSince: ago(90), groupId: 'GROUP' }]
    expect(rosterAgedInFindings(entries, [], [], true, NOW)).toEqual([])
  })

  it('#1741 fixedScope=true honours scope and exclude for top-level entries', () => {
    const entries = [
      { id: 'IN_SCOPE', dataAvailableSince: ago(90), groupId: null },
      { id: 'EXCLUDED', dataAvailableSince: ago(90), groupId: null },
      { id: 'AGED', dataAvailableSince: ago(90), groupId: null },
    ]
    expect(rosterAgedInFindings(entries, ['IN_SCOPE'], ['EXCLUDED'], true, NOW)).toEqual(['AGED'])
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
