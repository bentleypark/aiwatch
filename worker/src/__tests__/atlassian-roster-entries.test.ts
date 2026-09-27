import { describe, it, expect } from 'vitest'
import { atlassianRosterEntries } from '../parsers/statuspage'

describe('atlassianRosterEntries (#1518 — created_at, not the fixed-width /uptime_showcase timeline)', () => {
  it('reads created_at directly as dataAvailableSince', () => {
    expect(atlassianRosterEntries([{ id: 'AAA', created_at: '2026-06-01T00:00:00Z' }])).toEqual([
      { id: 'AAA', dataAvailableSince: '2026-06-01T00:00:00Z' },
    ])
  })

  it('a component with no created_at at all reports null, not a fabricated age', () => {
    expect(atlassianRosterEntries([{ id: 'AAA' }])).toEqual([{ id: 'AAA', dataAvailableSince: null }])
  })

  it('an unparseable created_at reports null', () => {
    expect(atlassianRosterEntries([{ id: 'AAA', created_at: 'not-a-date' }])).toEqual([{ id: 'AAA', dataAvailableSince: null }])
  })

  it('a non-string created_at (upstream schema drift) reports null rather than throwing', () => {
    expect(atlassianRosterEntries([{ id: 'AAA', created_at: 12345 }])).toEqual([{ id: 'AAA', dataAvailableSince: null }])
  })

  it('every component in the array gets its own entry, independently', () => {
    expect(atlassianRosterEntries([
      { id: 'AAA', created_at: '2026-01-01T00:00:00Z' },
      { id: 'BBB', created_at: '2026-09-01T00:00:00Z' },
    ]).sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 'AAA', dataAvailableSince: '2026-01-01T00:00:00Z' },
      { id: 'BBB', dataAvailableSince: '2026-09-01T00:00:00Z' },
    ])
  })

  it('empty array yields no entries', () => {
    expect(atlassianRosterEntries([])).toEqual([])
  })

  it('a real cursor payload shape: reads created_at exactly, not the fixed showcase window start the id would otherwise get', () => {
    // Regression for the round-2 Critical: the showcase endpoint pads every component to a fixed
    // 90-day window, so a component's real age was NOT decidable from its timeline. created_at is.
    const [entry] = atlassianRosterEntries([{ id: 'xwjpvdf81qh9', created_at: '2026-08-17T15:24:19.328Z' }])
    expect(entry.dataAvailableSince).toBe('2026-08-17T15:24:19.328Z')
  })
})
