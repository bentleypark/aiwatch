import { describe, it, expect } from 'vitest'
import {
  STATUS_PRIORITY,
  STATUS_ORDER,
  getResolvedTime,
  getLatestActivity,
  compareIncidents,
  compareGroupedRows,
  dominantGroupStatus,
  formatDurationMs,
  sumGroupDuration,
} from '../incidentSort'
import { groupIncidents } from '../incidentGrouping'

function makeIncident({
  id = 'inc',
  title,
  status = 'ongoing',
  startedAt = '2026-04-28T00:00:00Z',
  resolvedAt,
  impact = null,
  timeline = [],
}) {
  // title defaults to id so groupIncidents doesn't accidentally merge
  // distinct fixtures via empty-title same-day collisions.
  return { id, title: title ?? id, status, startedAt, resolvedAt, impact, timeline }
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

describe('compareGroupedRows', () => {
  // Helper: build a real `groupIncidents` output from a list of incidents,
  // then sort it the way ServiceDetails.jsx / Incidents.jsx do at render time.
  // Tests the *page-level composition*, not just the comparator in isolation —
  // a regression like #383 (page calls groupIncidents but forgets the sort)
  // would still pass an isolated comparator unit test.
  const UTC = { timeZone: 'UTC' }

  it('puts an investigating incident above newer resolved rows (ServiceDetails.jsx #383 regression)', () => {
    // Real-world shape: ChatGPT detail page on 2026-05-05 had one investigating
    // entry from Apr 30 06:59 buried under May 5 / May 1 resolved entries,
    // because groupIncidents re-sorted purely by date.
    const incidents = [
      makeIncident({ id: 'r-may5', status: 'resolved',      startedAt: '2026-05-05T00:29:00Z', resolvedAt: '2026-05-05T02:10:00Z' }),
      makeIncident({ id: 'r-may1', status: 'resolved',      startedAt: '2026-05-01T12:55:00Z', resolvedAt: '2026-05-01T13:03:00Z' }),
      makeIncident({ id: 'inv',    status: 'investigating', startedAt: '2026-04-30T06:59:00Z' }),
      makeIncident({ id: 'r-apr30',status: 'resolved',      startedAt: '2026-04-30T06:01:00Z', resolvedAt: '2026-04-30T07:24:00Z' }),
    ]
    const sortedIds = groupIncidents(incidents, UTC)
      .slice()
      .sort(compareGroupedRows)
      .map((row) => row.kind === 'single' ? row.incident.id : `group:${row.normalizedTitle}`)
    expect(sortedIds[0]).toBe('inv')
  })

  it('keeps newest-first ordering within the same status tier (stable sort)', () => {
    const incidents = [
      makeIncident({ id: 'r-old', status: 'resolved', startedAt: '2026-04-29T10:00:00Z', resolvedAt: '2026-04-29T10:10:00Z' }),
      makeIncident({ id: 'r-new', status: 'resolved', startedAt: '2026-05-05T10:00:00Z', resolvedAt: '2026-05-05T10:10:00Z' }),
    ]
    const sortedIds = groupIncidents(incidents, UTC)
      .slice()
      .sort(compareGroupedRows)
      .map((row) => row.incident.id)
    expect(sortedIds).toEqual(['r-new', 'r-old'])
  })

  it('puts a mostly-resolved flap group BELOW a single investigating row (Mistral-flap parity)', () => {
    // Together/Fireworks/Mistral flap into 2+ same-day same-title resolved rows.
    // Even when the flap group's rangeEnd is more recent, an unrelated
    // investigating incident must outrank it.
    const incidents = [
      makeIncident({ id: 'flap-1', title: 'Embedding API — recovered', status: 'resolved', startedAt: '2026-05-05T08:00:00Z', resolvedAt: '2026-05-05T08:05:00Z' }),
      makeIncident({ id: 'flap-2', title: 'Embedding API — recovered', status: 'resolved', startedAt: '2026-05-05T09:00:00Z', resolvedAt: '2026-05-05T09:05:00Z' }),
      makeIncident({ id: 'flap-3', title: 'Embedding API — recovered', status: 'resolved', startedAt: '2026-05-05T10:00:00Z', resolvedAt: '2026-05-05T10:05:00Z' }),
      makeIncident({ id: 'inv',    title: 'API outage',                status: 'investigating', startedAt: '2026-05-04T12:00:00Z' }),
    ]
    const rows = groupIncidents(incidents, UTC).slice().sort(compareGroupedRows)
    expect(rows[0].kind).toBe('single')
    expect(rows[0].incident.id).toBe('inv')
    expect(rows[1].kind).toBe('group')
    expect(rows[1].count).toBe(3)
  })

  it('orders monitoring above resolved across mixed singles and groups', () => {
    const incidents = [
      makeIncident({ id: 'r-1', status: 'resolved', startedAt: '2026-05-05T11:00:00Z', resolvedAt: '2026-05-05T11:05:00Z' }),
      makeIncident({ id: 'mon', status: 'monitoring', startedAt: '2026-05-05T08:00:00Z' }),
      makeIncident({ id: 'r-2', status: 'resolved', startedAt: '2026-05-05T12:00:00Z', resolvedAt: '2026-05-05T12:05:00Z' }),
    ]
    const ids = groupIncidents(incidents, UTC).slice().sort(compareGroupedRows).map((r) => r.incident.id)
    expect(ids[0]).toBe('mon')
  })

  it('treats unknown row status as resolved tier (defensive)', () => {
    const a = { kind: 'single', incident: { id: 'a', status: 'weird', startedAt: '2026-05-05T00:00:00Z' } }
    const b = { kind: 'single', incident: { id: 'b', status: 'monitoring', startedAt: '2026-05-04T00:00:00Z' } }
    expect(compareGroupedRows(b, a)).toBeLessThan(0)
  })
})

describe('STATUS_ORDER', () => {
  it('puts ongoing first, then raw worker statuses in priority order', () => {
    // STATUS_ORDER must include BOTH the normalized 'ongoing' alias used by
    // Incidents.jsx (which collapses investigating/identified→ongoing before
    // grouping) AND the raw worker statuses used by ServiceDetails.jsx (which
    // does not pre-normalize). Putting 'ongoing' first lets the normalized
    // path resolve correctly, while the raw-status path still falls through
    // to investigating/identified when 'ongoing' is absent from statusCounts.
    expect(STATUS_ORDER).toEqual(['ongoing', 'investigating', 'identified', 'monitoring', 'resolved'])
  })
})

describe('dominantGroupStatus', () => {
  it('returns the only key when group is uniform', () => {
    const group = { uniformStatus: true, statusCounts: { investigating: 4 } }
    expect(dominantGroupStatus(group)).toBe('investigating')
  })

  it('picks ongoing for the normalized Incidents.jsx shape (regression for #355)', () => {
    // Incidents.jsx normalizes inc.status → 'ongoing' | 'monitoring' | 'resolved'
    // before grouping, so production statusCounts keys for that page are exactly
    // {ongoing, monitoring, resolved}. Pre-fix: a STATUS_ORDER without 'ongoing'
    // dropped this case to the resolved tier with a green badge.
    const group = {
      uniformStatus: false,
      statusCounts: { ongoing: 2, resolved: 5 },
    }
    expect(dominantGroupStatus(group)).toBe('ongoing')
  })

  it('picks investigating for the raw-status ServiceDetails.jsx shape', () => {
    // ServiceDetails.jsx does NOT normalize before grouping, so its statusCounts
    // keys are raw worker statuses (investigating/identified/monitoring/resolved).
    // 'ongoing' is absent — find() must fall through to 'investigating'.
    const group = {
      uniformStatus: false,
      statusCounts: { investigating: 2, monitoring: 1, resolved: 5 },
    }
    expect(dominantGroupStatus(group)).toBe('investigating')
  })

  it('picks identified over monitoring + resolved', () => {
    const group = {
      uniformStatus: false,
      statusCounts: { identified: 1, monitoring: 3, resolved: 10 },
    }
    expect(dominantGroupStatus(group)).toBe('identified')
  })

  it('picks investigating over identified (priority order matches STATUS_ORDER)', () => {
    const group = {
      uniformStatus: false,
      statusCounts: { investigating: 1, identified: 1 },
    }
    expect(dominantGroupStatus(group)).toBe('investigating')
  })

  it('falls back to resolved when group has only resolved entries', () => {
    const group = {
      uniformStatus: false,
      statusCounts: { resolved: 5 },
    }
    expect(dominantGroupStatus(group)).toBe('resolved')
  })

  it('falls back to resolved on empty statusCounts (defensive)', () => {
    const group = { uniformStatus: false, statusCounts: {} }
    expect(dominantGroupStatus(group)).toBe('resolved')
  })

  it('integrates with STATUS_PRIORITY so a mostly-investigating group sorts above mostly-resolved', () => {
    const investigatingGroup = {
      uniformStatus: false,
      statusCounts: { investigating: 1, resolved: 8 },
    }
    const resolvedGroup = {
      uniformStatus: false,
      statusCounts: { monitoring: 1, resolved: 8 },
    }
    expect(STATUS_PRIORITY[dominantGroupStatus(investigatingGroup)])
      .toBeLessThan(STATUS_PRIORITY[dominantGroupStatus(resolvedGroup)])
  })

  it('integrates with STATUS_PRIORITY for the normalized Incidents.jsx shape (#355 regression)', () => {
    // The actual production case for Incidents.jsx — a flap group with normalized
    // 'ongoing' + 'resolved' entries must sort above a resolved-only group.
    const ongoingGroup = {
      uniformStatus: false,
      statusCounts: { ongoing: 2, resolved: 5 },
    }
    const resolvedGroup = {
      uniformStatus: false,
      statusCounts: { resolved: 8 },
    }
    expect(STATUS_PRIORITY[dominantGroupStatus(ongoingGroup)])
      .toBeLessThan(STATUS_PRIORITY[dominantGroupStatus(resolvedGroup)])
  })
})

describe('formatDurationMs', () => {
  it('renders sub-minute durations as 1m (round up, mirrors worker formatDuration)', () => {
    expect(formatDurationMs(0)).toBe('1m')
    expect(formatDurationMs(30_000)).toBe('1m')
  })

  it('renders minutes-only durations without hour prefix', () => {
    expect(formatDurationMs(31 * 60_000)).toBe('31m')
    expect(formatDurationMs(59 * 60_000)).toBe('59m')
  })

  it('renders hours-and-minutes for durations >= 1h', () => {
    expect(formatDurationMs(60 * 60_000)).toBe('1h 0m')
    expect(formatDurationMs(125 * 60_000)).toBe('2h 5m')
  })

  it('rounds partial minutes up (Math.ceil) to match worker', () => {
    // 30s30ms → 1m, 60s30ms → 2m, etc. — same rounding as worker formatDuration
    expect(formatDurationMs(30_500)).toBe('1m')
    expect(formatDurationMs(60_500)).toBe('2m')
  })

  it('matches worker formatDuration output bit-for-bit (cross-language parity lock-in)', async () => {
    // formatDurationMs and worker/src/utils.ts:formatDuration are sibling impls
    // that MUST produce identical output for the same elapsed ms — group totals
    // on the dashboard otherwise drift from per-incident `duration` strings the
    // worker emits. This test imports the worker function and asserts equality
    // across boundary inputs (sub-minute, minute boundaries, hour rollover,
    // partial-minute round-up). Catches silent drift if either side migrates
    // rounding (Math.ceil → Math.round, etc.) without updating the other.
    const { formatDuration } = await import('../../../worker/src/utils')
    const fixtures = [0, 1, 30_000, 60_000, 60_001, 60_500, 90_000, 120_000, 30 * 60_000, 59 * 60_000, 60 * 60_000, 125 * 60_000, 180 * 60_000]
    for (const ms of fixtures) {
      const epoch0 = new Date(0)
      const later = new Date(ms)
      expect(formatDurationMs(ms)).toBe(formatDuration(epoch0, later))
    }
  })
})

describe('sumGroupDuration', () => {
  const start = (iso) => new Date(iso).toISOString()

  it('sums durations across all resolved entries', () => {
    const group = {
      entries: [
        { startedAt: start('2026-04-30T01:00:00Z'), resolvedAt: start('2026-04-30T01:10:00Z') },
        { startedAt: start('2026-04-30T02:00:00Z'), resolvedAt: start('2026-04-30T02:30:00Z') },
        { startedAt: start('2026-04-30T03:00:00Z'), resolvedAt: start('2026-04-30T03:05:00Z') },
      ],
    }
    const result = sumGroupDuration(group)
    expect(result.totalMs).toBe(45 * 60_000)
    expect(result.hasOngoing).toBe(false)
    expect(result.resolvedCount).toBe(3)
    expect(formatDurationMs(result.totalMs)).toBe('45m')
  })

  it('flags hasOngoing when an entry is missing resolvedAt', () => {
    const group = {
      entries: [
        { startedAt: start('2026-04-30T01:00:00Z'), resolvedAt: start('2026-04-30T01:10:00Z') },
        { startedAt: start('2026-04-30T02:00:00Z') }, // ongoing
      ],
    }
    const result = sumGroupDuration(group)
    expect(result.totalMs).toBe(10 * 60_000)
    expect(result.hasOngoing).toBe(true)
    expect(result.resolvedCount).toBe(1)
  })

  it('returns zero totalMs and hasOngoing=false for empty entries (defensive)', () => {
    const result = sumGroupDuration({ entries: [] })
    expect(result.totalMs).toBe(0)
    expect(result.hasOngoing).toBe(false)
    expect(result.resolvedCount).toBe(0)
  })

  it('treats missing entries field as empty (defensive)', () => {
    const result = sumGroupDuration({})
    expect(result.totalMs).toBe(0)
    expect(result.resolvedCount).toBe(0)
  })

  it('skips entries with end <= start (treats as ongoing)', () => {
    // Malformed payload: resolvedAt earlier than startedAt — must not produce
    // negative ms or crash. Treated as ongoing so the sum stays a lower bound.
    const group = {
      entries: [
        { startedAt: start('2026-04-30T01:00:00Z'), resolvedAt: start('2026-04-30T00:50:00Z') },
        { startedAt: start('2026-04-30T02:00:00Z'), resolvedAt: start('2026-04-30T02:15:00Z') },
      ],
    }
    const result = sumGroupDuration(group)
    expect(result.totalMs).toBe(15 * 60_000)
    expect(result.hasOngoing).toBe(true)
    expect(result.resolvedCount).toBe(1)
  })

  it('skips entries with invalid timestamps (treats as ongoing)', () => {
    const group = {
      entries: [
        { startedAt: 'not-a-date', resolvedAt: start('2026-04-30T01:10:00Z') },
        { startedAt: start('2026-04-30T02:00:00Z'), resolvedAt: start('2026-04-30T02:05:00Z') },
      ],
    }
    const result = sumGroupDuration(group)
    expect(result.totalMs).toBe(5 * 60_000)
    expect(result.hasOngoing).toBe(true)
    expect(result.resolvedCount).toBe(1)
  })
})
