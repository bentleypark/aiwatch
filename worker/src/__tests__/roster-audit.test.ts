import { describe, it, expect } from 'vitest'
import { auditAgedInOutOfScope, nextRosterFindingSeen, formatRosterAuditAlert, ROSTER_AUDIT_WINDOW_DAYS, type RosterAuditEntry } from '../roster-audit'

const DAY = 86_400_000
const NOW = Date.parse('2026-09-27T00:00:00Z')
const ago = (days: number) => new Date(NOW - days * DAY).toISOString()

describe('auditAgedInOutOfScope (#1518b — a component that crossed 30 days and was never added to scope)', () => {
  it('reports an old, unscoped, unexcluded id', () => {
    const entries: RosterAuditEntry[] = [{ id: 'A', dataAvailableSince: ago(40) }]
    expect(auditAgedInOutOfScope(entries, [], [], NOW)).toEqual(['A'])
  })

  it('does NOT report an id still under the window — the #1266 case this check must not also catch', () => {
    const entries: RosterAuditEntry[] = [{ id: 'A', dataAvailableSince: ago(10) }]
    expect(auditAgedInOutOfScope(entries, [], [], NOW)).toEqual([])
  })

  it('at the exact boundary (== windowDays) DOES report', () => {
    const entries: RosterAuditEntry[] = [{ id: 'A', dataAvailableSince: ago(ROSTER_AUDIT_WINDOW_DAYS) }]
    expect(auditAgedInOutOfScope(entries, [], [], NOW)).toEqual(['A'])
  })

  it('does NOT report an id that IS in scope, however old', () => {
    const entries: RosterAuditEntry[] = [{ id: 'A', dataAvailableSince: ago(400) }]
    expect(auditAgedInOutOfScope(entries, ['A'], [], NOW)).toEqual([])
  })

  it('does NOT report an id on the exclusion list, however old', () => {
    const entries: RosterAuditEntry[] = [{ id: 'A', dataAvailableSince: ago(400) }]
    expect(auditAgedInOutOfScope(entries, [], ['A'], NOW)).toEqual([])
  })

  it('does NOT report an id with no usable data_available_since (null) — under-proven is not proven-30-plus', () => {
    const entries: RosterAuditEntry[] = [{ id: 'A', dataAvailableSince: null }]
    expect(auditAgedInOutOfScope(entries, [], [], NOW)).toEqual([])
  })

  it('a removed id (absent from entries) never appears — the existing alerts own that case', () => {
    expect(auditAgedInOutOfScope([], ['CONFIGURED-BUT-GONE'], [], NOW)).toEqual([])
  })

  it('reports several qualifying ids, skipping scoped/excluded/young/unproven ones in the same page', () => {
    const entries: RosterAuditEntry[] = [
      { id: 'IN_SCOPE', dataAvailableSince: ago(400) },
      { id: 'EXCLUDED', dataAvailableSince: ago(400) },
      { id: 'YOUNG', dataAvailableSince: ago(5) },
      { id: 'UNPROVEN', dataAvailableSince: null },
      { id: 'AGED_1', dataAvailableSince: ago(40) },
      { id: 'AGED_2', dataAvailableSince: ago(90) },
    ]
    expect(auditAgedInOutOfScope(entries, ['IN_SCOPE'], ['EXCLUDED'], NOW).sort()).toEqual(['AGED_1', 'AGED_2'])
  })
})

describe('nextRosterFindingSeen (#1518 — dedup so a stable finding does not re-alert every daily run)', () => {
  it('bootstraps: every current id is new when there is no prior seen set', () => {
    expect(nextRosterFindingSeen(null, ['A', 'B'])).toEqual({ toAlert: ['A', 'B'], nextSeen: ['A', 'B'] })
  })

  it('does not re-alert an id already in the prior seen set', () => {
    expect(nextRosterFindingSeen(['A'], ['A'])).toEqual({ toAlert: [], nextSeen: ['A'] })
  })

  it('alerts only the NEW id when one is added alongside an already-seen one', () => {
    expect(nextRosterFindingSeen(['A'], ['A', 'B'])).toEqual({ toAlert: ['B'], nextSeen: ['A', 'B'] })
  })

  it('SHRINKS when a finding clears — unlike #992\'s diffPageComponents, nextSeen tracks the CURRENT set', () => {
    expect(nextRosterFindingSeen(['A', 'B'], ['A'])).toEqual({ toAlert: [], nextSeen: ['A'] })
  })

  it('a cleared id re-alerts if the finding recurs later (nextSeen no longer remembers it)', () => {
    const cleared = nextRosterFindingSeen(['A', 'B'], ['A'])
    expect(nextRosterFindingSeen(cleared.nextSeen, ['A', 'B'])).toEqual({ toAlert: ['B'], nextSeen: ['A', 'B'] })
  })

  it('currentIds empty clears the whole seen set', () => {
    expect(nextRosterFindingSeen(['A', 'B'], [])).toEqual({ toAlert: [], nextSeen: [] })
  })
})

describe('formatRosterAuditAlert (#1518 — the operator Discord body)', () => {
  it('renders a name+id line for a known id, from the names map', () => {
    const body = formatRosterAuditAlert(['Fireworks AI'], ['id-1'], new Map([['id-1', 'Nemotron 3 Ultra']]))
    expect(body).toContain('`Nemotron 3 Ultra` (`id-1`)')
  })

  it('falls back to the bare id when the names map has no entry — never an empty alert', () => {
    const body = formatRosterAuditAlert(['Fireworks AI'], ['id-1'], new Map())
    expect(body).toContain('`id-1` (`id-1`)')
  })

  it('falls back to "(no AIWatch service)" when serviceNames is empty', () => {
    const body = formatRosterAuditAlert([], ['id-1'], new Map())
    expect(body).toContain('(no AIWatch service)')
  })

  it('joins multiple service names with a comma', () => {
    const body = formatRosterAuditAlert(['OpenAI API', 'ChatGPT', 'Codex'], ['id-1'], new Map())
    expect(body).toContain('OpenAI API, ChatGPT, Codex')
  })
})
