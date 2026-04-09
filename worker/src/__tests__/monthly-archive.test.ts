import { describe, it, expect } from 'vitest'
import {
  computeMonthlyUptime,
  computeMonthlyLatency,
  getMonthDates,
  isInMonthlyArchiveWindow,
  buildMonthlyArchive,
  accumulateMonthlyIncidents,
  parseDurationMin,
} from '../monthly-archive'
import type { ServiceStatus } from '../types'

// ── parseDurationMin ─────────────────────────────────────────────────

describe('parseDurationMin', () => {
  it('parses "2h 30m" to 150', () => {
    expect(parseDurationMin('2h 30m')).toBe(150)
  })

  it('parses hours only "3h" to 180', () => {
    expect(parseDurationMin('3h')).toBe(180)
  })

  it('parses minutes only "45m" to 45', () => {
    expect(parseDurationMin('45m')).toBe(45)
  })

  it('parses "1h" to 60', () => {
    expect(parseDurationMin('1h')).toBe(60)
  })

  it('returns 0 for empty string', () => {
    expect(parseDurationMin('')).toBe(0)
  })

  it('returns 0 for falsy input', () => {
    expect(parseDurationMin(null as unknown as string)).toBe(0)
    expect(parseDurationMin(undefined as unknown as string)).toBe(0)
  })

  it('handles NaN gracefully (non-numeric prefix)', () => {
    // "abch 30m" → parseInt("abc") = NaN → 0, parseInt("30") = 30
    expect(parseDurationMin('abch 30m')).toBe(30)
  })

  it('handles "~2h 30m" (tilde prefix)', () => {
    // "~2h" → parseInt("~2") = NaN → 0 hours, but "30m" → 30
    // Note: this is a known limitation — approximate durations with "~" lose hours
    const result = parseDurationMin('~2h 30m')
    expect(result).toBe(30) // ~prefix makes parseInt fail on hours
  })
})

// ── getMonthDates ────────────────────────────────────────────────────

describe('getMonthDates', () => {
  it('returns all dates for March 2026', () => {
    const dates = getMonthDates(2026, 3)
    expect(dates).toHaveLength(31)
    expect(dates[0]).toBe('2026-03-01')
    expect(dates[30]).toBe('2026-03-31')
  })

  it('returns 28 dates for February (non-leap)', () => {
    expect(getMonthDates(2025, 2)).toHaveLength(28)
  })

  it('returns 29 dates for February (leap year)', () => {
    expect(getMonthDates(2024, 2)).toHaveLength(29)
  })
})

// ── computeMonthlyUptime ─────────────────────────────────────────────

describe('computeMonthlyUptime', () => {
  it('computes uptime% from daily counters', () => {
    const dailyData = {
      '2026-03-01': { claude: { ok: 280, total: 288 }, openai: { ok: 288, total: 288 } },
      '2026-03-02': { claude: { ok: 288, total: 288 }, openai: { ok: 288, total: 288 } },
    }
    const result = computeMonthlyUptime(dailyData)
    expect(result.claude).toBeCloseTo(98.61, 1)
    expect(result.openai).toBe(100)
  })

  it('handles empty data', () => {
    expect(Object.keys(computeMonthlyUptime({}))).toHaveLength(0)
  })

  it('returns 0 for total=0', () => {
    const dailyData = { '2026-03-01': { claude: { ok: 0, total: 0 } } }
    expect(computeMonthlyUptime(dailyData).claude).toBe(0)
  })
})

// ── computeMonthlyLatency ────────────────────────────────────────────

describe('computeMonthlyLatency', () => {
  it('averages probe RTT p75 across days', () => {
    const probeData = {
      '2026-03-01': { claude: { p50: 100, p75: 200, p95: 300, min: 50, max: 400, count: 100, spikes: 0 } },
      '2026-03-02': { claude: { p50: 110, p75: 220, p95: 310, min: 55, max: 410, count: 100, spikes: 1 } },
      '2026-03-03': { claude: { p50: 105, p75: 210, p95: 305, min: 52, max: 405, count: 100, spikes: 0 } },
    }
    expect(computeMonthlyLatency(probeData).claude).toBe(210)
  })

  it('skips days with p75=0', () => {
    const probeData = {
      '2026-03-01': { openai: { p50: 0, p75: 0, p95: 0, min: 0, max: 0, count: 5, spikes: 5 } },
      '2026-03-02': { openai: { p50: 150, p75: 300, p95: 450, min: 100, max: 500, count: 100, spikes: 0 } },
    }
    expect(computeMonthlyLatency(probeData).openai).toBe(300)
  })

  it('skips negative p75', () => {
    const probeData = {
      '2026-03-01': { groq: { p50: 0, p75: -1, p95: 0, min: 0, max: 0, count: 1, spikes: 1 } },
      '2026-03-02': { groq: { p50: 50, p75: 100, p95: 150, min: 30, max: 200, count: 50, spikes: 0 } },
    }
    expect(computeMonthlyLatency(probeData).groq).toBe(100)
  })

  it('handles empty data', () => {
    expect(Object.keys(computeMonthlyLatency({}))).toHaveLength(0)
  })
})

// ── isInMonthlyArchiveWindow ─────────────────────────────────────────

describe('isInMonthlyArchiveWindow', () => {
  it('returns true on 1st at UTC 00:00', () => {
    expect(isInMonthlyArchiveWindow(1, 0, 0)).toEqual({ inWindow: true, isCatchUp: false })
  })

  it('returns true on 1st at UTC 00:14', () => {
    expect(isInMonthlyArchiveWindow(1, 0, 14)).toEqual({ inWindow: true, isCatchUp: false })
  })

  it('returns false on 1st at UTC 00:15', () => {
    expect(isInMonthlyArchiveWindow(1, 0, 15)).toEqual({ inWindow: false, isCatchUp: false })
  })

  it('returns catch-up on 1st at UTC 01:00', () => {
    expect(isInMonthlyArchiveWindow(1, 1, 0)).toEqual({ inWindow: true, isCatchUp: true })
  })

  it('returns false on 2nd', () => {
    expect(isInMonthlyArchiveWindow(2, 0, 0)).toEqual({ inWindow: false, isCatchUp: false })
  })

  it('returns false on 1st at UTC 02:00', () => {
    expect(isInMonthlyArchiveWindow(1, 2, 0)).toEqual({ inWindow: false, isCatchUp: false })
  })
})

// ── accumulateMonthlyIncidents ───────────────────────────────────────

describe('accumulateMonthlyIncidents', () => {
  const makeService = (id: string, incidents: Array<{ id: string; startedAt: string; status: string; duration: string | null }>): ServiceStatus => ({
    id, name: id, provider: '', category: 'api', status: 'operational',
    latency: null, uptime30d: null, lastChecked: '', incidents: incidents.map(i => ({
      id: i.id, title: `Incident ${i.id}`, status: i.status as any, impact: null,
      startedAt: i.startedAt, duration: i.duration, timeline: [],
    })),
  })

  it('accumulates incidents from services', () => {
    const services = [
      makeService('claude', [
        { id: 'inc-1', startedAt: '2026-04-01T10:00:00Z', status: 'resolved', duration: '2h 30m' },
        { id: 'inc-2', startedAt: '2026-04-05T14:00:00Z', status: 'resolved', duration: '1h' },
      ]),
      makeService('openai', [
        { id: 'inc-3', startedAt: '2026-04-02T08:00:00Z', status: 'resolved', duration: '45m' },
      ]),
    ]

    const result = accumulateMonthlyIncidents(null, services, '2026-04')
    expect(result.services.claude.count).toBe(2)
    expect(result.services.claude.totalMinutes).toBe(210) // 150+60
    expect(result.services.claude.longestMinutes).toBe(150)
    expect(result.services.claude.dates).toEqual(['2026-04-01', '2026-04-05'])
    expect(result.services.claude.incidentIds).toEqual(['inc-1', 'inc-2'])
    expect(result.services.openai.count).toBe(1)
    expect(result.services.openai.totalMinutes).toBe(45)
  })

  it('deduplicates incidents by ID', () => {
    const services = [
      makeService('claude', [
        { id: 'inc-1', startedAt: '2026-04-01T10:00:00Z', status: 'resolved', duration: '2h' },
      ]),
    ]

    const first = accumulateMonthlyIncidents(null, services, '2026-04')
    expect(first.services.claude.count).toBe(1)

    // Run again with same incident — should not double-count
    const second = accumulateMonthlyIncidents(first, services, '2026-04')
    expect(second.services.claude.count).toBe(1)
    expect(second.services.claude.incidentIds).toEqual(['inc-1'])
  })

  it('adds new incidents to existing accumulation', () => {
    const first = accumulateMonthlyIncidents(null, [
      makeService('claude', [
        { id: 'inc-1', startedAt: '2026-04-01T10:00:00Z', status: 'resolved', duration: '1h' },
      ]),
    ], '2026-04')

    const second = accumulateMonthlyIncidents(first, [
      makeService('claude', [
        { id: 'inc-1', startedAt: '2026-04-01T10:00:00Z', status: 'resolved', duration: '1h' },
        { id: 'inc-2', startedAt: '2026-04-03T10:00:00Z', status: 'resolved', duration: '30m' },
      ]),
    ], '2026-04')

    expect(second.services.claude.count).toBe(2)
    expect(second.services.claude.totalMinutes).toBe(90) // 60+30
  })

  it('filters incidents to target month only', () => {
    const services = [
      makeService('claude', [
        { id: 'inc-1', startedAt: '2026-03-31T23:00:00Z', status: 'resolved', duration: '1h' },
        { id: 'inc-2', startedAt: '2026-04-01T00:00:00Z', status: 'resolved', duration: '2h' },
      ]),
    ]

    const result = accumulateMonthlyIncidents(null, services, '2026-04')
    expect(result.services.claude.count).toBe(1)
    expect(result.services.claude.incidentIds).toEqual(['inc-2'])
  })

  it('handles services with no incidents', () => {
    const services = [makeService('claude', [])]
    const result = accumulateMonthlyIncidents(null, services, '2026-04')
    expect(result.services.claude).toBeUndefined()
  })

  it('updates totalMinutes + longestMinutes when unresolved incident later resolves', () => {
    // First accumulation: unresolved incident (duration 0)
    const first = accumulateMonthlyIncidents(null, [
      makeService('claude', [
        { id: 'inc-1', startedAt: '2026-04-01T10:00:00Z', status: 'investigating', duration: null },
      ]),
    ], '2026-04')
    expect(first.services.claude.longestMinutes).toBe(0)
    expect(first.services.claude.totalMinutes).toBe(0)

    // Second accumulation: now resolved with duration — delta should be added
    const second = accumulateMonthlyIncidents(first, [
      makeService('claude', [
        { id: 'inc-1', startedAt: '2026-04-01T10:00:00Z', status: 'resolved', duration: '3h' },
      ]),
    ], '2026-04')
    expect(second.services.claude.longestMinutes).toBe(180)
    expect(second.services.claude.totalMinutes).toBe(180) // delta: 180-0 = 180
    expect(second.services.claude.count).toBe(1) // count unchanged
  })

  it('does not double-count duration on repeated resolved accumulation', () => {
    const services = [
      makeService('claude', [
        { id: 'inc-1', startedAt: '2026-04-01T10:00:00Z', status: 'resolved', duration: '2h' },
      ]),
    ]
    const first = accumulateMonthlyIncidents(null, services, '2026-04')
    expect(first.services.claude.totalMinutes).toBe(120)

    // Same resolved incident accumulated again — should not add duration
    const second = accumulateMonthlyIncidents(first, services, '2026-04')
    expect(second.services.claude.totalMinutes).toBe(120) // unchanged
  })
})

// ── buildMonthlyArchive ──────────────────────────────────────────────

describe('buildMonthlyArchive', () => {
  const mockKV = {
    get: async (key: string) => {
      const store: Record<string, string> = {
        'history:2026-03-01': JSON.stringify({ claude: { ok: 280, total: 288 }, openai: { ok: 288, total: 288 } }),
        'history:2026-03-02': JSON.stringify({ claude: { ok: 288, total: 288 }, openai: { ok: 285, total: 288 } }),
        'probe:daily:2026-03-01': JSON.stringify({ claude: { p50: 100, p75: 200, p95: 300, min: 50, max: 400, count: 100, spikes: 0 } }),
        'probe:daily:2026-03-02': JSON.stringify({ claude: { p50: 110, p75: 220, p95: 310, min: 55, max: 410, count: 100, spikes: 1 } }),
        'incidents:monthly:2026-03': JSON.stringify({
          lastUpdated: '2026-03-31T09:00:00Z',
          services: {
            claude: { count: 5, totalMinutes: 300, longestMinutes: 120, dates: ['2026-03-01', '2026-03-10', '2026-03-15'], incidentIds: ['a', 'b', 'c', 'd', 'e'], durations: { a: 120, b: 60, c: 45, d: 30, e: 45 } },
            openai: { count: 1, totalMinutes: 45, longestMinutes: 45, dates: ['2026-03-20'], incidentIds: ['f'], durations: { f: 45 } },
          },
        }),
      }
      return store[key] ?? null
    },
    put: async () => {},
    delete: async () => {},
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
  } as unknown as KVNamespace

  it('builds archive with uptime + latency + accumulated incidents', async () => {
    const scoreData = [
      { id: 'claude', aiwatchScore: 85, scoreGrade: 'excellent' as const },
      { id: 'openai', aiwatchScore: 92, scoreGrade: 'excellent' as const },
    ]

    const archive = await buildMonthlyArchive(mockKV, 2026, 3, scoreData)
    expect(archive.period).toBe('2026-03')
    expect(archive.daysCollected).toBe(2)
    expect(archive.services.claude.uptime).toBeCloseTo(98.61, 0)
    expect(archive.services.claude.score).toBe(85)
    expect(archive.services.claude.grade).toBe('excellent')
    expect(archive.services.claude.incidents).toBe(5) // from accumulated data
    expect(archive.services.claude.avgResolutionMin).toBe(60) // 300/5
    expect(archive.services.claude.avgLatencyMs).toBe(210)
    expect(archive.services.openai.incidents).toBe(1)
    expect(archive.services.openai.avgResolutionMin).toBe(45)
    expect(archive.services.openai.avgLatencyMs).toBeNull()
  })

  it('handles no score data (uptime + incidents only)', async () => {
    const archive = await buildMonthlyArchive(mockKV, 2026, 3)
    expect(archive.services.claude.score).toBeNull()
    expect(archive.services.claude.grade).toBeNull()
    expect(archive.services.claude.incidents).toBe(5)
  })

  it('handles empty KV (no data)', async () => {
    const emptyKV = {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    } as unknown as KVNamespace

    const archive = await buildMonthlyArchive(emptyKV, 2026, 3)
    expect(archive.period).toBe('2026-03')
    expect(archive.daysCollected).toBe(0)
    expect(Object.keys(archive.services)).toHaveLength(0)
  })

  it('handles corrupt KV JSON gracefully', async () => {
    const corruptKV = {
      get: async (key: string) => {
        if (key === 'history:2026-03-01') return 'NOT_JSON'
        if (key === 'history:2026-03-02') return JSON.stringify({ claude: { ok: 288, total: 288 } })
        return null
      },
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    } as unknown as KVNamespace

    const archive = await buildMonthlyArchive(corruptKV, 2026, 3)
    expect(archive.daysCollected).toBe(1) // only day 2 parsed
    expect(archive.services.claude.uptime).toBe(100)
  })

  it('handles December → January boundary', async () => {
    const decKV = {
      get: async (key: string) => {
        if (key === 'history:2026-12-01') return JSON.stringify({ claude: { ok: 288, total: 288 } })
        if (key === 'incidents:monthly:2026-12') return JSON.stringify({
          lastUpdated: '2026-12-31T09:00:00Z',
          services: { claude: { count: 2, totalMinutes: 60, longestMinutes: 40, dates: ['2026-12-15'], incidentIds: ['x', 'y'], durations: { x: 40, y: 20 } } },
        })
        return null
      },
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    } as unknown as KVNamespace

    const archive = await buildMonthlyArchive(decKV, 2026, 12, [
      { id: 'claude', aiwatchScore: 90, scoreGrade: 'excellent' as const },
    ])
    expect(archive.period).toBe('2026-12')
    expect(archive.services.claude.incidents).toBe(2)
    expect(archive.services.claude.uptime).toBe(100)
  })

  it('sets avgResolutionMin to null when totalMinutes is 0', async () => {
    const kvWithUnresolved = {
      get: async (key: string) => {
        if (key === 'incidents:monthly:2026-04') return JSON.stringify({
          lastUpdated: '2026-04-09T09:00:00Z',
          services: { claude: { count: 2, totalMinutes: 0, longestMinutes: 0, dates: ['2026-04-01'], incidentIds: ['a', 'b'], durations: { a: 0, b: 0 } } },
        })
        return null
      },
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    } as unknown as KVNamespace

    const archive = await buildMonthlyArchive(kvWithUnresolved, 2026, 4)
    expect(archive.services.claude.incidents).toBe(2)
    expect(archive.services.claude.avgResolutionMin).toBeNull()
  })
})
