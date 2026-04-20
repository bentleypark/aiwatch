import { describe, it, expect } from 'vitest'
import { groupIncidents, GROUP_THRESHOLD, normalizeTitle } from '../incidentGrouping'

// Minimal Incident factory — fields match worker/src/types.ts shape
function makeIncident({ id, title, startedAt, status = 'resolved', impact = null, duration = '5m' }) {
  return { id, title, startedAt, status, impact, duration, timeline: [] }
}

describe('normalizeTitle', () => {
  it('strips trailing " — recovered"', () => {
    expect(normalizeTitle('Nomic Embed Text v1.5 embeddings API — recovered'))
      .toBe('Nomic Embed Text v1.5 embeddings API')
  })

  it('leaves untouched titles alone', () => {
    expect(normalizeTitle('Major Outage Reported')).toBe('Major Outage Reported')
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeTitle('  Service X — recovered  ')).toBe('Service X')
  })

  it('does not strip "recovered" elsewhere in title', () => {
    expect(normalizeTitle('Service recovered after issue'))
      .toBe('Service recovered after issue')
  })
})

describe('groupIncidents — threshold + impact rules', () => {
  // Tests in this block pin timeZone: 'UTC' so day-key extraction is deterministic regardless
  // of where Vitest runs. KST-specific behavior is exercised in the dedicated TZ block below.
  const UTC = { timeZone: 'UTC' }

  it('groups 14 same-day same-title null-impact entries into one group (Fireworks AI Nomic case)', () => {
    const incs = Array.from({ length: 14 }, (_, i) => makeIncident({
      id: `nomic-${i}`,
      title: 'Nomic Embed Text v1.5 embeddings API — recovered',
      // Spread across 17h on same UTC day (2026-04-16)
      startedAt: `2026-04-16T${String(6 + Math.floor(i * 1.2)).padStart(2, '0')}:00:00Z`,
    }))
    const result = groupIncidents(incs, UTC)
    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe('group')
    expect(result[0].count).toBe(14)
    expect(result[0].normalizedTitle).toBe('Nomic Embed Text v1.5 embeddings API')
    expect(result[0].entries).toHaveLength(14)
  })

  it('does NOT group when count is below threshold (2 entries)', () => {
    const incs = [
      makeIncident({ id: 'a', title: 'X — recovered', startedAt: '2026-04-16T10:00:00Z' }),
      makeIncident({ id: 'b', title: 'X — recovered', startedAt: '2026-04-16T15:00:00Z' }),
    ]
    const result = groupIncidents(incs, UTC)
    expect(result).toHaveLength(2)
    expect(result.every(r => r.kind === 'single')).toBe(true)
  })

  it('groups exactly at threshold (3 entries)', () => {
    expect(GROUP_THRESHOLD).toBe(3)
    const incs = Array.from({ length: 3 }, (_, i) => makeIncident({
      id: `x-${i}`,
      title: 'X — recovered',
      startedAt: `2026-04-16T${10 + i}:00:00Z`,
    }))
    const result = groupIncidents(incs, UTC)
    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe('group')
    expect(result[0].count).toBe(3)
  })

  it('never groups entries with non-null impact, even if 3+ match the key', () => {
    const incs = Array.from({ length: 5 }, (_, i) => makeIncident({
      id: `real-${i}`,
      title: 'API Outage — recovered',
      startedAt: `2026-04-16T${10 + i}:00:00Z`,
      impact: 'major',
    }))
    const result = groupIncidents(incs, UTC)
    expect(result).toHaveLength(5)
    expect(result.every(r => r.kind === 'single')).toBe(true)
  })

  it('mixes grouped + individual rows when a service has both flap and real incidents', () => {
    const incs = [
      ...Array.from({ length: 5 }, (_, i) => makeIncident({
        id: `flap-${i}`,
        title: 'Embeddings API — recovered',
        startedAt: `2026-04-16T${10 + i}:00:00Z`,
      })),
      makeIncident({
        id: 'real-1',
        title: 'Major Outage',
        startedAt: '2026-04-16T18:00:00Z',
        impact: 'major',
      }),
    ]
    const result = groupIncidents(incs, UTC)
    expect(result).toHaveLength(2)
    const group = result.find(r => r.kind === 'group')
    const single = result.find(r => r.kind === 'single')
    expect(group.count).toBe(5)
    expect(single.incident.id).toBe('real-1')
  })
})

describe('groupIncidents — local timezone day boundary (KST = UTC+9)', () => {
  // All tests in this block pin timeZone: 'Asia/Seoul' so behavior is deterministic
  // regardless of where Vitest runs (CI vs local). Production callers omit timeZone and
  // get the runtime default (browser TZ in the SPA).
  const KST = { timeZone: 'Asia/Seoul' }

  it('splits a UTC-day-spanning batch when entries fall on different KST dates', () => {
    // The exact case from production: BetterStack flap entries straddling 15:00 UTC
    // (= 00:00 KST). User reads these as different days in the UI even though UTC date matches.
    const incs = [
      makeIncident({ id: 'a', title: 'X — recovered', startedAt: '2026-04-16T14:30:00Z' }), // KST 04-16 23:30
      makeIncident({ id: 'b', title: 'X — recovered', startedAt: '2026-04-16T14:55:00Z' }), // KST 04-16 23:55
      makeIncident({ id: 'c', title: 'X — recovered', startedAt: '2026-04-16T16:30:00Z' }), // KST 04-17 01:30
      makeIncident({ id: 'd', title: 'X — recovered', startedAt: '2026-04-16T17:30:00Z' }), // KST 04-17 02:30
      makeIncident({ id: 'e', title: 'X — recovered', startedAt: '2026-04-16T20:00:00Z' }), // KST 04-17 05:00
    ]
    const result = groupIncidents(incs, KST)
    // Two KST dates: 04-16 (2 entries → below threshold) + 04-17 (3 entries → group)
    expect(result.filter(r => r.kind === 'group')).toHaveLength(1)
    const group = result.find(r => r.kind === 'group')
    expect(group.dayKey).toBe('2026-04-17')
    expect(group.count).toBe(3)
    expect(result.filter(r => r.kind === 'single')).toHaveLength(2)
  })

  it('groups entries spanning UTC midnight that share the same KST date', () => {
    // 23:00 UTC and 02:00 next-UTC-day are both KST 04-17 (08:00 and 11:00 KST).
    const incs = [
      makeIncident({ id: 'a', title: 'X — recovered', startedAt: '2026-04-16T23:00:00Z' }), // KST 04-17 08:00
      makeIncident({ id: 'b', title: 'X — recovered', startedAt: '2026-04-17T01:00:00Z' }), // KST 04-17 10:00
      makeIncident({ id: 'c', title: 'X — recovered', startedAt: '2026-04-17T02:00:00Z' }), // KST 04-17 11:00
    ]
    const result = groupIncidents(incs, KST)
    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe('group')
    expect(result[0].dayKey).toBe('2026-04-17')
    expect(result[0].count).toBe(3)
  })

  it('does not group entries on consecutive KST days even if titles match', () => {
    const incs = [
      ...Array.from({ length: 3 }, (_, i) => makeIncident({
        id: `d1-${i}`,
        title: 'X — recovered',
        // KST 04-17 (UTC 04-16 18:00–20:00 = KST 04-17 03:00–05:00)
        startedAt: `2026-04-16T${18 + i}:00:00Z`,
      })),
      ...Array.from({ length: 3 }, (_, i) => makeIncident({
        id: `d2-${i}`,
        title: 'X — recovered',
        // KST 04-18 (UTC 04-17 18:00–20:00 = KST 04-18 03:00–05:00)
        startedAt: `2026-04-17T${18 + i}:00:00Z`,
      })),
    ]
    const result = groupIncidents(incs, KST)
    expect(result).toHaveLength(2)
    expect(result.every(r => r.kind === 'group')).toBe(true)
    expect(result.map(r => r.dayKey).sort()).toEqual(['2026-04-17', '2026-04-18'])
  })

  it('UTC option produces UTC-date grouping when explicitly requested', () => {
    // Sanity check that the timeZone option is actually wired through.
    const incs = [
      makeIncident({ id: 'a', title: 'X — recovered', startedAt: '2026-04-16T14:30:00Z' }),
      makeIncident({ id: 'b', title: 'X — recovered', startedAt: '2026-04-16T20:00:00Z' }),
      makeIncident({ id: 'c', title: 'X — recovered', startedAt: '2026-04-16T23:00:00Z' }),
    ]
    const result = groupIncidents(incs, { timeZone: 'UTC' })
    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe('group')
    expect(result[0].dayKey).toBe('2026-04-16')
  })
})

describe('groupIncidents — group metadata', () => {
  const UTC = { timeZone: 'UTC' }

  it('preserves status distribution when statuses differ within a group', () => {
    const incs = [
      makeIncident({ id: '1', title: 'X — recovered', startedAt: '2026-04-16T10:00:00Z', status: 'resolved' }),
      makeIncident({ id: '2', title: 'X — recovered', startedAt: '2026-04-16T11:00:00Z', status: 'resolved' }),
      makeIncident({ id: '3', title: 'X — recovered', startedAt: '2026-04-16T12:00:00Z', status: 'monitoring' }),
    ]
    const result = groupIncidents(incs, UTC)
    expect(result[0].kind).toBe('group')
    expect(result[0].statusCounts).toEqual({ resolved: 2, monitoring: 1 })
    expect(result[0].uniformStatus).toBe(false)
  })

  it('marks uniformStatus when all entries share the same status', () => {
    const incs = Array.from({ length: 4 }, (_, i) => makeIncident({
      id: `x-${i}`,
      title: 'X — recovered',
      startedAt: `2026-04-16T${10 + i}:00:00Z`,
      status: 'resolved',
    }))
    const result = groupIncidents(incs, UTC)
    expect(result[0].uniformStatus).toBe(true)
    expect(result[0].statusCounts).toEqual({ resolved: 4 })
  })

  it('exposes time range: earliest startedAt and latest startedAt', () => {
    // Spread within a single UTC hour range so KST also keeps them on one local day
    // regardless of the system TZ that runs this assertion.
    const incs = [
      makeIncident({ id: 'a', title: 'X — recovered', startedAt: '2026-04-16T11:00:00Z' }),
      makeIncident({ id: 'b', title: 'X — recovered', startedAt: '2026-04-16T09:00:00Z' }),
      makeIncident({ id: 'c', title: 'X — recovered', startedAt: '2026-04-16T10:00:00Z' }),
    ]
    const result = groupIncidents(incs, UTC)
    expect(result[0].rangeStart).toBe('2026-04-16T09:00:00Z')
    expect(result[0].rangeEnd).toBe('2026-04-16T11:00:00Z')
  })

  it('preserves entries in original (input) order within the group', () => {
    const incs = [
      makeIncident({ id: 'a', title: 'X — recovered', startedAt: '2026-04-16T11:00:00Z' }),
      makeIncident({ id: 'b', title: 'X — recovered', startedAt: '2026-04-16T09:00:00Z' }),
      makeIncident({ id: 'c', title: 'X — recovered', startedAt: '2026-04-16T10:00:00Z' }),
    ]
    const result = groupIncidents(incs, UTC)
    expect(result[0].entries.map(e => e.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('groupIncidents — ordering of mixed output', () => {
  const UTC = { timeZone: 'UTC' }

  it('places groups and singles in newest-first order by representative startedAt', () => {
    const incs = [
      // Group on 04-16
      ...Array.from({ length: 3 }, (_, i) => makeIncident({
        id: `g1-${i}`,
        title: 'X — recovered',
        startedAt: `2026-04-16T${10 + i}:00:00Z`,
      })),
      // Single on 04-18 (newer)
      makeIncident({ id: 's1', title: 'Real Outage', startedAt: '2026-04-18T08:00:00Z', impact: 'major' }),
      // Single on 04-15 (older)
      makeIncident({ id: 's2', title: 'Real Outage', startedAt: '2026-04-15T08:00:00Z', impact: 'major' }),
    ]
    const result = groupIncidents(incs, UTC)
    // Newest first by representative time (rangeEnd for groups, startedAt for singles)
    const reps = result.map(r => r.kind === 'group' ? r.rangeEnd : r.incident.startedAt)
    const sorted = [...reps].sort().reverse()
    expect(reps).toEqual(sorted)
  })
})

describe('groupIncidents — edge cases', () => {
  const UTC = { timeZone: 'UTC' }

  it('returns empty array for empty input', () => {
    expect(groupIncidents([], UTC)).toEqual([])
  })

  it('returns single rows when all incidents have unique titles', () => {
    const incs = [
      makeIncident({ id: 'a', title: 'A — recovered', startedAt: '2026-04-16T10:00:00Z' }),
      makeIncident({ id: 'b', title: 'B — recovered', startedAt: '2026-04-16T11:00:00Z' }),
      makeIncident({ id: 'c', title: 'C — recovered', startedAt: '2026-04-16T12:00:00Z' }),
    ]
    const result = groupIncidents(incs, UTC)
    expect(result).toHaveLength(3)
    expect(result.every(r => r.kind === 'single')).toBe(true)
  })

  it('treats undefined impact as null (defensive)', () => {
    const incs = Array.from({ length: 3 }, (_, i) => {
      const inc = makeIncident({ id: `x-${i}`, title: 'X — recovered', startedAt: `2026-04-16T${10 + i}:00:00Z` })
      delete inc.impact
      return inc
    })
    const result = groupIncidents(incs, UTC)
    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe('group')
  })
})
