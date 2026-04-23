import { describe, it, expect } from 'vitest'
import {
  groupIncidents,
  normalizeTitle,
  GROUP_THRESHOLD,
  type GroupingIncident,
  type GroupRow,
  type SingleRow,
} from '../incident-grouping'

function mkInc(overrides: Partial<GroupingIncident> = {}): GroupingIncident {
  return {
    id: overrides.id ?? 'x',
    title: overrides.title ?? 'Untitled',
    startedAt: overrides.startedAt ?? '2026-04-20T10:00:00Z',
    status: overrides.status ?? 'resolved',
    impact: overrides.impact ?? null,
    duration: overrides.duration ?? null,
    resolvedAt: overrides.resolvedAt ?? null,
  }
}

describe('normalizeTitle', () => {
  it('strips trailing " — recovered"', () => {
    expect(normalizeTitle('Nomic Embed v1.5 — recovered')).toBe('Nomic Embed v1.5')
  })
  it('handles null and undefined safely', () => {
    expect(normalizeTitle(null)).toBe('')
    expect(normalizeTitle(undefined)).toBe('')
  })
  it('leaves non-suffix text intact', () => {
    expect(normalizeTitle('Opus 4.6 elevated errors')).toBe('Opus 4.6 elevated errors')
  })
})

describe('groupIncidents — empty + below threshold', () => {
  it('returns empty for empty input', () => {
    expect(groupIncidents([])).toEqual([])
  })
  it('emits every entry as a single row when no bucket reaches the threshold', () => {
    const incs = [
      mkInc({ id: 'a', title: 'Alpha', startedAt: '2026-04-20T10:00:00Z' }),
      mkInc({ id: 'b', title: 'Beta', startedAt: '2026-04-20T11:00:00Z' }),
    ]
    const rows = groupIncidents(incs)
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.kind === 'single')).toBe(true)
  })
})

describe('groupIncidents — threshold = 3', () => {
  it('three same-day normalized-title entries collapse to one group row', () => {
    const day = '2026-04-20T'
    const incs = [
      mkInc({ id: '1', title: 'Nomic Embed', startedAt: day + '10:00:00Z' }),
      mkInc({ id: '2', title: 'Nomic Embed', startedAt: day + '11:00:00Z' }),
      mkInc({ id: '3', title: 'Nomic Embed — recovered', startedAt: day + '12:00:00Z' }),
    ]
    const rows = groupIncidents(incs)
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('group')
    const g = rows[0] as GroupRow
    expect(g.count).toBe(3)
    expect(g.normalizedTitle).toBe('Nomic Embed')
    expect(g.rangeStart).toBe(day + '10:00:00Z')
    expect(g.rangeEnd).toBe(day + '12:00:00Z')
  })

  it('exactly 2 dupes stay as singles (strict ≥3 threshold)', () => {
    expect(GROUP_THRESHOLD).toBe(3)
    const incs = [
      mkInc({ id: '1', title: 'Alpha', startedAt: '2026-04-20T10:00:00Z' }),
      mkInc({ id: '2', title: 'Alpha', startedAt: '2026-04-20T11:00:00Z' }),
    ]
    const rows = groupIncidents(incs)
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.kind === 'single')).toBe(true)
  })

  it('entries with impact != null never group (human-tagged real incidents)', () => {
    const incs = [
      mkInc({ id: '1', title: 'Major outage', impact: 'major', startedAt: '2026-04-20T10:00:00Z' }),
      mkInc({ id: '2', title: 'Major outage', impact: 'major', startedAt: '2026-04-20T11:00:00Z' }),
      mkInc({ id: '3', title: 'Major outage', impact: 'major', startedAt: '2026-04-20T12:00:00Z' }),
    ]
    const rows = groupIncidents(incs)
    expect(rows).toHaveLength(3)
    expect(rows.every((r) => r.kind === 'single')).toBe(true)
  })
})

describe('groupIncidents — day boundary', () => {
  it('UTC default: 23:00Z and 01:00Z next day are on different days → no grouping', () => {
    const incs = [
      mkInc({ id: '1', title: 'X', startedAt: '2026-04-20T23:00:00Z' }),
      mkInc({ id: '2', title: 'X', startedAt: '2026-04-20T23:30:00Z' }),
      mkInc({ id: '3', title: 'X', startedAt: '2026-04-21T01:00:00Z' }),
    ]
    const rows = groupIncidents(incs) // default UTC
    expect(rows.every((r) => r.kind === 'single')).toBe(true)
    expect(rows).toHaveLength(3)
  })

  it('SSR determinism: same timezone override produces same groups across calls', () => {
    const incs = [
      mkInc({ id: '1', title: 'X', startedAt: '2026-04-20T15:00:00Z' }),
      mkInc({ id: '2', title: 'X', startedAt: '2026-04-20T16:00:00Z' }),
      mkInc({ id: '3', title: 'X', startedAt: '2026-04-20T17:00:00Z' }),
    ]
    const r1 = groupIncidents(incs, { timeZone: 'UTC' })
    const r2 = groupIncidents(incs, { timeZone: 'UTC' })
    expect(r1).toEqual(r2)
    expect(r1).toHaveLength(1)
  })

  it('honors explicit timeZone override (KST ≡ UTC+9)', () => {
    // 14:00 UTC → 23:00 KST same day; 15:30 UTC → 00:30 KST next day
    const incs = [
      mkInc({ id: '1', title: 'X', startedAt: '2026-04-20T14:00:00Z' }),
      mkInc({ id: '2', title: 'X', startedAt: '2026-04-20T14:30:00Z' }),
      mkInc({ id: '3', title: 'X', startedAt: '2026-04-20T15:30:00Z' }), // 00:30 KST Apr 21
    ]
    const rows = groupIncidents(incs, { timeZone: 'Asia/Seoul' })
    // First 2 on Apr 20 KST, third on Apr 21 KST → none reaches 3 in one bucket
    expect(rows.every((r) => r.kind === 'single')).toBe(true)
  })
})

describe('groupIncidents — sort order', () => {
  it('emits newest-first by representative time (rangeEnd for groups, startedAt for singles)', () => {
    const rows = groupIncidents([
      mkInc({ id: 'old-single', title: 'Alpha', startedAt: '2026-04-10T10:00:00Z' }),
      mkInc({ id: 'g1', title: 'Group', startedAt: '2026-04-20T10:00:00Z' }),
      mkInc({ id: 'g2', title: 'Group', startedAt: '2026-04-20T11:00:00Z' }),
      mkInc({ id: 'g3', title: 'Group', startedAt: '2026-04-20T12:00:00Z' }),
      mkInc({ id: 'recent-single', title: 'Zeta', startedAt: '2026-04-22T10:00:00Z' }),
    ])
    // newest → oldest: recent-single, group (rangeEnd=Apr20 12:00), old-single
    expect(rows).toHaveLength(3)
    expect(rows[0].kind).toBe('single')
    expect((rows[0] as SingleRow).incident.id).toBe('recent-single')
    expect(rows[1].kind).toBe('group')
    expect((rows[1] as GroupRow).count).toBe(3)
    expect(rows[2].kind).toBe('single')
    expect((rows[2] as SingleRow).incident.id).toBe('old-single')
  })
})

describe('groupIncidents — statusCounts + uniformStatus', () => {
  it('records per-status counts and flags mixed status groups', () => {
    const rows = groupIncidents([
      mkInc({ id: '1', title: 'X', status: 'resolved', startedAt: '2026-04-20T10:00:00Z' }),
      mkInc({ id: '2', title: 'X', status: 'resolved', startedAt: '2026-04-20T11:00:00Z' }),
      mkInc({ id: '3', title: 'X', status: 'investigating', startedAt: '2026-04-20T12:00:00Z' }),
    ])
    const g = rows[0] as GroupRow
    expect(g.statusCounts).toEqual({ resolved: 2, investigating: 1 })
    expect(g.uniformStatus).toBe(false)
  })

  it('uniformStatus=true when all entries share status', () => {
    const rows = groupIncidents([
      mkInc({ id: '1', title: 'X', status: 'resolved', startedAt: '2026-04-20T10:00:00Z' }),
      mkInc({ id: '2', title: 'X', status: 'resolved', startedAt: '2026-04-20T11:00:00Z' }),
      mkInc({ id: '3', title: 'X', status: 'resolved', startedAt: '2026-04-20T12:00:00Z' }),
    ])
    const g = rows[0] as GroupRow
    expect(g.uniformStatus).toBe(true)
  })
})
