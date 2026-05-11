import { describe, it, expect } from 'vitest'
import {
  STATUS_PRIORITY,
  STATUS_ORDER,
  getResolvedTime,
  getLatestActivity,
  getContextualTime,
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

describe('getContextualTime', () => {
  // Identity translator so assertions can compare against the i18n key.
  const t = (key) => key

  it('resolved with resolvedAt → resolved label, resolvedAt date', () => {
    const inc = makeIncident({
      status: 'resolved',
      startedAt: '2026-05-08T23:12:00Z',
      resolvedAt: '2026-05-09T00:17:00Z',
    })
    expect(getContextualTime(inc, t)).toEqual({
      label: 'incidents.time.resolved',
      date: '2026-05-09T00:17:00Z',
    })
  })

  it('resolved without resolvedAt but with resolved timeline entry → that entry', () => {
    const inc = makeIncident({
      status: 'resolved',
      startedAt: '2026-05-08T23:12:00Z',
      timeline: [
        { stage: 'investigating', at: '2026-05-08T23:12:00Z' },
        { stage: 'resolved', at: '2026-05-09T00:17:00Z' },
      ],
    })
    expect(getContextualTime(inc, t)).toEqual({
      label: 'incidents.time.resolved',
      date: '2026-05-09T00:17:00Z',
    })
  })

  it('monitoring with last timeline entry → updated label, last.at', () => {
    const inc = makeIncident({
      status: 'monitoring',
      startedAt: '2026-05-08T23:12:00Z',
      timeline: [
        { stage: 'investigating', at: '2026-05-08T23:12:00Z' },
        { stage: 'monitoring', at: '2026-05-09T00:05:00Z' },
      ],
    })
    expect(getContextualTime(inc, t)).toEqual({
      label: 'incidents.time.updated',
      date: '2026-05-09T00:05:00Z',
    })
  })

  it('monitoring without timeline → falls back to started/startedAt', () => {
    const inc = makeIncident({
      status: 'monitoring',
      startedAt: '2026-05-08T23:12:00Z',
      timeline: [],
    })
    expect(getContextualTime(inc, t)).toEqual({
      label: 'incidents.time.started',
      date: '2026-05-08T23:12:00Z',
    })
  })

  it('ongoing with last timeline post-dating startedAt → updated label, last.at', () => {
    const inc = makeIncident({
      status: 'ongoing',
      startedAt: '2026-05-08T23:12:00Z',
      timeline: [
        { stage: 'investigating', at: '2026-05-08T23:12:00Z' },
        { stage: 'identified', at: '2026-05-08T23:30:00Z' },
      ],
    })
    expect(getContextualTime(inc, t)).toEqual({
      label: 'incidents.time.updated',
      date: '2026-05-08T23:30:00Z',
    })
  })

  it('ongoing with timeline equal to startedAt → falls back to started (initial post is not an "update")', () => {
    const inc = makeIncident({
      status: 'ongoing',
      startedAt: '2026-05-08T23:12:00Z',
      timeline: [{ stage: 'investigating', at: '2026-05-08T23:12:00Z' }],
    })
    expect(getContextualTime(inc, t)).toEqual({
      label: 'incidents.time.started',
      date: '2026-05-08T23:12:00Z',
    })
  })

  it('unknown status → started label, startedAt (defensive fallback for malformed payload)', () => {
    const inc = makeIncident({
      status: 'mystery_status',
      startedAt: '2026-05-08T23:12:00Z',
      timeline: [{ stage: 'whatever', at: '2026-05-08T23:30:00Z' }],
    })
    // Status not in the active-status set AND not 'monitoring'/'resolved' → falls through.
    // Even if a timeline entry post-dates startedAt, an unrecognized status doesn't unlock
    // the 'updated' branch.
    expect(getContextualTime(inc, t)).toEqual({
      label: 'incidents.time.started',
      date: '2026-05-08T23:12:00Z',
    })
  })

  it('matrix: getContextualTime.date equals getLatestActivity timestamp across non-fallback inputs (#406)', () => {
    // Property-shaped test: for every (status × timeline) combination where the helper
    // does NOT deliberately fall back to startedAt, the date axis MUST equal the sort axis.
    // The remaining "deliberate fallback" cases are excluded with a comment so a future
    // change that narrows the fallback (and starts producing alignment) trips the next
    // round of test maintenance instead of silently re-aligning.
    const startedAt = '2026-05-08T12:00:00Z'
    const lastUpdate = '2026-05-08T13:00:00Z'
    const resolvedAt = '2026-05-09T18:00:00Z'
    const cases = [
      // status, timeline, resolvedAt, note
      { status: 'resolved', timeline: [], resolvedAt, note: 'resolved + resolvedAt' },
      { status: 'resolved', timeline: [{ stage: 'investigating', at: startedAt }, { stage: 'resolved', at: resolvedAt }], resolvedAt: undefined, note: 'resolved without resolvedAt, timeline carries resolved entry' },
      { status: 'monitoring', timeline: [{ stage: 'investigating', at: startedAt }, { stage: 'monitoring', at: lastUpdate }], resolvedAt: undefined, note: 'monitoring + timeline' },
      { status: 'monitoring', timeline: [], resolvedAt: undefined, note: 'monitoring without timeline (both fall back to startedAt)' },
      { status: 'ongoing', timeline: [{ stage: 'investigating', at: startedAt }, { stage: 'identified', at: lastUpdate }], resolvedAt: undefined, note: 'ongoing + timeline post-dating startedAt' },
      { status: 'ongoing', timeline: [{ stage: 'investigating', at: startedAt }], resolvedAt: undefined, note: 'ongoing + timeline === startedAt (both yield startedAt)' },
      // Raw worker statuses — Overview.jsx consumes these without pre-normalizing, so the
      // axis-equality contract MUST hold for them too (round 2 review gap, #406).
      { status: 'investigating', timeline: [{ stage: 'investigating', at: startedAt }, { stage: 'investigating', at: lastUpdate }], resolvedAt: undefined, note: 'investigating + timeline post-dating startedAt' },
      { status: 'investigating', timeline: [{ stage: 'investigating', at: startedAt }], resolvedAt: undefined, note: 'investigating + timeline === startedAt' },
      { status: 'identified', timeline: [{ stage: 'investigating', at: startedAt }, { stage: 'identified', at: lastUpdate }], resolvedAt: undefined, note: 'identified + timeline post-dating startedAt' },
      { status: 'identified', timeline: [], resolvedAt: undefined, note: 'identified without timeline' },
    ]
    for (const c of cases) {
      const inc = makeIncident({ status: c.status, startedAt, resolvedAt: c.resolvedAt, timeline: c.timeline })
      const ctxMs = new Date(getContextualTime(inc, t).date).getTime()
      expect(ctxMs, `axis mismatch for case "${c.note}"`).toBe(getLatestActivity(inc))
    }
    // Deliberate divergence (NOT asserted, documented for future maintainers):
    // - resolved without resolvedAt AND no resolved-stage timeline entry: ctx falls back to
    //   startedAt + 'started' label; getLatestActivity uses the last timeline entry (which
    //   may be later than startedAt). The malformed-payload posture is conservative.
  })

  it('aligns with getLatestActivity sort axis — resolved incident sorted by resolvedAt is also displayed by resolvedAt (#406)', () => {
    // The whole motivation for promoting this helper. Two incidents that cross a
    // calendar boundary: File Operations resolved later but started earlier.
    // getLatestActivity ranks by resolvedAt → File Operations newer than Sonnet 4.6;
    // getContextualTime now reports the same axis so the displayed date label
    // matches the sort order instead of contradicting it.
    const fileOps = makeIncident({
      id: 'file-ops',
      status: 'resolved',
      startedAt: '2026-05-08T23:12:00Z',
      resolvedAt: '2026-05-09T00:17:00Z',
    })
    const sonnet46 = makeIncident({
      id: 'sonnet-4-6',
      status: 'resolved',
      startedAt: '2026-05-09T00:03:00Z',
      resolvedAt: '2026-05-09T00:11:00Z',
    })
    expect(getLatestActivity(fileOps)).toBeGreaterThan(getLatestActivity(sonnet46))
    expect(getContextualTime(fileOps, t).date).toBe(fileOps.resolvedAt)
    expect(getContextualTime(sonnet46, t).date).toBe(sonnet46.resolvedAt)
    // Both rendered dates fall on the same calendar day (2026-05-09) — the visible
    // out-of-order surface from issue #406 disappears once the display follows the
    // sort axis.
    expect(getContextualTime(fileOps, t).date.slice(0, 10)).toBe('2026-05-09')
    expect(getContextualTime(sonnet46, t).date.slice(0, 10)).toBe('2026-05-09')
  })
})
