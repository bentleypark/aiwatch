import { describe, it, expect } from 'vitest'
import {
  STATUS_PRIORITY,
  getResolvedTime,
  getLatestActivity,
  compareIncidents,
} from '../incidentSort'

function makeIncident({
  id = 'inc',
  status = 'ongoing',
  startedAt = '2026-04-28T00:00:00Z',
  resolvedAt,
  timeline = [],
}) {
  return { id, status, startedAt, resolvedAt, timeline }
}

describe('STATUS_PRIORITY', () => {
  it('ranks ongoing < monitoring < resolved', () => {
    expect(STATUS_PRIORITY.ongoing).toBeLessThan(STATUS_PRIORITY.monitoring)
    expect(STATUS_PRIORITY.monitoring).toBeLessThan(STATUS_PRIORITY.resolved)
  })

  it('treats raw upstream statuses (investigating/identified) as ongoing tier', () => {
    // worker/src/types.ts emits 4 raw statuses — investigating/identified must NOT
    // fall through to the resolved tier (regression check for the bug found in #354
    // round-2 verification).
    expect(STATUS_PRIORITY.investigating).toBe(STATUS_PRIORITY.ongoing)
    expect(STATUS_PRIORITY.identified).toBe(STATUS_PRIORITY.ongoing)
    expect(STATUS_PRIORITY.investigating).toBeLessThan(STATUS_PRIORITY.monitoring)
    expect(STATUS_PRIORITY.identified).toBeLessThan(STATUS_PRIORITY.monitoring)
  })
})

describe('getResolvedTime', () => {
  it('prefers resolvedAt field when present', () => {
    const inc = makeIncident({
      status: 'resolved',
      resolvedAt: '2026-04-28T03:00:00Z',
      timeline: [{ stage: 'resolved', at: '2026-04-28T02:00:00Z' }],
    })
    expect(getResolvedTime(inc)).toBe('2026-04-28T03:00:00Z')
  })

  it('falls back to last resolved timeline entry', () => {
    const inc = makeIncident({
      status: 'resolved',
      timeline: [
        { stage: 'investigating', at: '2026-04-28T00:00:00Z' },
        { stage: 'resolved',      at: '2026-04-28T02:00:00Z' },
      ],
    })
    expect(getResolvedTime(inc)).toBe('2026-04-28T02:00:00Z')
  })

  it('returns null when no resolution evidence exists', () => {
    const inc = makeIncident({
      status: 'ongoing',
      timeline: [{ stage: 'investigating', at: '2026-04-28T00:00:00Z' }],
    })
    expect(getResolvedTime(inc)).toBeNull()
  })

  it('handles missing timeline field', () => {
    const inc = { status: 'ongoing', startedAt: '2026-04-28T00:00:00Z' }
    expect(getResolvedTime(inc)).toBeNull()
  })

  it('picks the LAST resolved entry when multiple exist (re-opened incident)', () => {
    const inc = makeIncident({
      status: 'resolved',
      timeline: [
        { stage: 'resolved',      at: '2026-04-28T01:00:00Z' },
        { stage: 'investigating', at: '2026-04-28T01:30:00Z' },
        { stage: 'resolved',      at: '2026-04-28T02:00:00Z' },
      ],
    })
    expect(getResolvedTime(inc)).toBe('2026-04-28T02:00:00Z')
  })
})

describe('getLatestActivity', () => {
  it('uses resolved time for resolved incidents', () => {
    const inc = makeIncident({
      status: 'resolved',
      startedAt: '2026-04-28T00:00:00Z',
      resolvedAt: '2026-04-28T02:00:00Z',
    })
    expect(getLatestActivity(inc)).toBe(new Date('2026-04-28T02:00:00Z').getTime())
  })

  it('uses last timeline entry for active incidents', () => {
    const inc = makeIncident({
      status: 'ongoing',
      startedAt: '2026-04-28T00:00:00Z',
      timeline: [
        { stage: 'investigating', at: '2026-04-28T00:00:00Z' },
        { stage: 'identified',    at: '2026-04-28T01:30:00Z' },
      ],
    })
    expect(getLatestActivity(inc)).toBe(new Date('2026-04-28T01:30:00Z').getTime())
  })

  it('falls back to startedAt when timeline is empty', () => {
    const inc = makeIncident({ status: 'ongoing', startedAt: '2026-04-28T00:00:00Z' })
    expect(getLatestActivity(inc)).toBe(new Date('2026-04-28T00:00:00Z').getTime())
  })

  it('falls back to startedAt for resolved incidents without resolution evidence', () => {
    const inc = makeIncident({
      status: 'resolved',
      startedAt: '2026-04-28T00:00:00Z',
      // no resolvedAt, no resolved-stage timeline entry — degenerate but possible
    })
    expect(getLatestActivity(inc)).toBe(new Date('2026-04-28T00:00:00Z').getTime())
  })
})

describe('compareIncidents', () => {
  it('puts ongoing before monitoring', () => {
    const ongoing    = makeIncident({ id: 'a', status: 'ongoing',    startedAt: '2026-04-28T00:00:00Z' })
    const monitoring = makeIncident({ id: 'b', status: 'monitoring', startedAt: '2026-04-28T05:00:00Z' })
    expect(compareIncidents(ongoing, monitoring)).toBeLessThan(0)
    expect(compareIncidents(monitoring, ongoing)).toBeGreaterThan(0)
  })

  it('puts raw investigating/identified before monitoring', () => {
    // Real worker payload uses investigating/identified — they must outrank
    // monitoring even when monitoring started more recently.
    const investigating = makeIncident({ id: 'a', status: 'investigating', startedAt: '2026-04-28T00:00:00Z' })
    const identified    = makeIncident({ id: 'b', status: 'identified',    startedAt: '2026-04-28T01:00:00Z' })
    const monitoring    = makeIncident({ id: 'c', status: 'monitoring',    startedAt: '2026-04-28T05:00:00Z' })
    expect(compareIncidents(investigating, monitoring)).toBeLessThan(0)
    expect(compareIncidents(identified, monitoring)).toBeLessThan(0)
  })

  it('puts monitoring before resolved', () => {
    const monitoring = makeIncident({ id: 'a', status: 'monitoring', startedAt: '2026-04-28T00:00:00Z' })
    const resolved   = makeIncident({ id: 'b', status: 'resolved',   startedAt: '2026-04-28T05:00:00Z', resolvedAt: '2026-04-28T06:00:00Z' })
    expect(compareIncidents(monitoring, resolved)).toBeLessThan(0)
  })

  it('puts ongoing before resolved even when resolved is more recent', () => {
    // The bug Overview had — recent monitoring/resolved should NOT outrank an older ongoing.
    const ongoing  = makeIncident({ id: 'a', status: 'ongoing',  startedAt: '2026-04-28T00:00:00Z' })
    const resolved = makeIncident({ id: 'b', status: 'resolved', startedAt: '2026-04-28T05:00:00Z', resolvedAt: '2026-04-28T06:00:00Z' })
    expect(compareIncidents(ongoing, resolved)).toBeLessThan(0)
  })

  it('within same tier, sorts by latest activity desc', () => {
    const newer = makeIncident({ id: 'a', status: 'ongoing', startedAt: '2026-04-28T05:00:00Z' })
    const older = makeIncident({ id: 'b', status: 'ongoing', startedAt: '2026-04-28T00:00:00Z' })
    expect(compareIncidents(newer, older)).toBeLessThan(0)
  })

  it('within same tier, timeline last update beats startedAt', () => {
    const oldStartFreshUpdate = makeIncident({
      id: 'a',
      status: 'ongoing',
      startedAt: '2026-04-28T00:00:00Z',
      timeline: [{ stage: 'identified', at: '2026-04-28T05:00:00Z' }],
    })
    const newerStart = makeIncident({
      id: 'b',
      status: 'ongoing',
      startedAt: '2026-04-28T03:00:00Z',
    })
    // oldStartFreshUpdate's last activity is later (05:00) than newerStart's (03:00)
    expect(compareIncidents(oldStartFreshUpdate, newerStart)).toBeLessThan(0)
  })

  it('unknown status defaults to resolved tier so malformed entries do not outrank ongoing', () => {
    const ongoing = makeIncident({ id: 'a', status: 'ongoing', startedAt: '2026-04-28T00:00:00Z' })
    const weird   = makeIncident({ id: 'b', status: 'weird-future-status', startedAt: '2026-04-28T05:00:00Z' })
    expect(compareIncidents(ongoing, weird)).toBeLessThan(0)
  })

  it('Array.sort yields the documented overall order', () => {
    // Mix of raw worker statuses (investigating/identified) + monitoring + resolved
    // mirrors the actual API response shape from /api/status.
    const incidents = [
      makeIncident({ id: '1-resolved-old',     status: 'resolved',      startedAt: '2026-04-27T00:00:00Z', resolvedAt: '2026-04-27T01:00:00Z' }),
      makeIncident({ id: '2-monitoring-new',   status: 'monitoring',    startedAt: '2026-04-28T05:00:00Z' }),
      makeIncident({ id: '3-investigating-old',status: 'investigating', startedAt: '2026-04-28T01:00:00Z' }),
      makeIncident({ id: '4-identified-new',   status: 'identified',    startedAt: '2026-04-28T03:00:00Z' }),
      makeIncident({ id: '5-resolved-recent',  status: 'resolved',      startedAt: '2026-04-28T04:00:00Z', resolvedAt: '2026-04-28T05:30:00Z' }),
    ]
    const sorted = [...incidents].sort(compareIncidents).map((i) => i.id)
    expect(sorted).toEqual([
      '4-identified-new',     // active tier, latest activity
      '3-investigating-old',  // active tier, older
      '2-monitoring-new',     // monitoring tier
      '5-resolved-recent',    // resolved tier, latest resolved
      '1-resolved-old',       // resolved tier, older
    ])
  })
})
