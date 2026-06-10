import { describe, it, expect } from 'vitest'
import {
  computeMonthlyUptime,
  computeMonthlyLatency,
  computeMonthlyLatencyStats,
  getMonthDates,
  isInMonthlyArchiveWindow,
  buildMonthlyArchive,
  accumulateMonthlyIncidents,
  parseDurationMin,
  summarizeSecurityAlerts,
  extractOsvVulnId,
  enrichTopFindingsWithTimelines,
  buildArchiveReadyEmbed,
  archiveNotifiedKey,
  REPORTS_WORKFLOW_URL,
  MAX_INCIDENTS_PER_SERVICE_IN_ARCHIVE,
  summarizeDetectionLead,
  canPresentLeadAverage,
  degradationMonthlyKey,
  addDegradationToMonthly,
  normalizeDegradationMonthly,
  summarizeDegradation,
} from '../monthly-archive'
import { MIN_LEAD_SAMPLE_SIZE } from '../detection-lead-log'
import type { ServiceStatus } from '../types'
import type { MonthlySecurityEntry, MonthlySecuritySummary } from '../monthly-archive'
import type { DetectionLeadEntry } from '../detection-lead-log'
import type { OsvTimeline } from '../security-monitor'

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

describe('computeMonthlyLatencyStats (#17 — p95 + spikes)', () => {
  it('averages valid daily p95 and sums spikes', () => {
    const probeData = {
      '2026-03-01': { claude: { p50: 100, p75: 200, p95: 300, min: 50, max: 400, count: 100, spikes: 2 } },
      '2026-03-02': { claude: { p50: 110, p75: 220, p95: 320, min: 55, max: 410, count: 100, spikes: 3 } },
    }
    expect(computeMonthlyLatencyStats(probeData).claude).toEqual({ p95: 310, spikes: 5 })
  })

  it('p95 is null when no day has a valid (>0) p95, but spikes still accumulate', () => {
    // A probe-failure-only day stores p95=0 — must not render a misleading "0 ms".
    const probeData = {
      '2026-03-01': { openai: { p50: 0, p75: 0, p95: 0, min: 0, max: 0, count: 5, spikes: 5 } },
      '2026-03-02': { openai: { p50: 0, p75: 0, p95: 0, min: 0, max: 0, count: 3, spikes: 3 } },
    }
    expect(computeMonthlyLatencyStats(probeData).openai).toEqual({ p95: null, spikes: 8 })
  })

  it('excludes p95=0 days from the average but keeps valid ones', () => {
    const probeData = {
      '2026-03-01': { groq: { p50: 0, p75: 0, p95: 0, min: 0, max: 0, count: 5, spikes: 1 } },
      '2026-03-02': { groq: { p50: 50, p75: 100, p95: 150, min: 30, max: 200, count: 50, spikes: 0 } },
    }
    expect(computeMonthlyLatencyStats(probeData).groq).toEqual({ p95: 150, spikes: 1 })
  })

  it('spikes total is 0 (not null) when service has valid p95 but no spikes', () => {
    const probeData = {
      '2026-03-01': { cohere: { p50: 80, p75: 160, p95: 240, min: 40, max: 300, count: 100, spikes: 0 } },
    }
    expect(computeMonthlyLatencyStats(probeData).cohere).toEqual({ p95: 240, spikes: 0 })
  })

  it('handles empty data', () => {
    expect(Object.keys(computeMonthlyLatencyStats({}))).toHaveLength(0)
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

  // ── incident detail accumulation (#375) ─────────────────────────────

  it('captures per-incident detail (title, timestamps, status) on new entries', () => {
    const services = [
      makeService('claude', [
        { id: 'inc-1', startedAt: '2026-04-01T10:00:00Z', status: 'resolved', duration: '2h' },
        { id: 'inc-2', startedAt: '2026-04-05T14:00:00Z', status: 'investigating', duration: null },
      ]),
    ]
    // Ensure makeService sets resolvedAt on resolved incidents (verify shape).
    services[0].incidents[0].resolvedAt = '2026-04-01T12:00:00Z'

    const result = accumulateMonthlyIncidents(null, services, '2026-04')
    const detail = result.services.claude.incidents
    expect(detail).toBeDefined()
    expect(detail!.length).toBe(2)
    expect(detail![0]).toEqual({
      id: 'inc-1', title: 'Incident inc-1',
      startedAt: '2026-04-01T10:00:00Z', resolvedAt: '2026-04-01T12:00:00Z',
      durationMin: 120, finalStatus: 'resolved',
    })
    expect(detail![1].finalStatus).toBe('investigating')
    expect(detail![1].durationMin).toBe(0)
    expect(detail![1].resolvedAt).toBeNull()
  })

  it('updates detail entry when incident status progresses on a later run', () => {
    // First pass: incident is investigating, no duration.
    const first = accumulateMonthlyIncidents(null, [
      makeService('claude', [
        { id: 'inc-1', startedAt: '2026-04-01T10:00:00Z', status: 'investigating', duration: null },
      ]),
    ], '2026-04')
    expect(first.services.claude.incidents![0].finalStatus).toBe('investigating')

    // Second pass: now resolved with a duration + resolvedAt.
    const resolvedSvc = makeService('claude', [
      { id: 'inc-1', startedAt: '2026-04-01T10:00:00Z', status: 'resolved', duration: '90m' },
    ])
    resolvedSvc.incidents[0].resolvedAt = '2026-04-01T11:30:00Z'
    const second = accumulateMonthlyIncidents(first, [resolvedSvc], '2026-04')
    const updated = second.services.claude.incidents![0]
    expect(updated.finalStatus).toBe('resolved')
    expect(updated.durationMin).toBe(90)
    expect(updated.resolvedAt).toBe('2026-04-01T11:30:00Z')
  })

  it('caps detail at MAX_INCIDENTS_PER_SERVICE_IN_ARCHIVE — drops oldest, keeps aggregates', () => {
    const overflow = MAX_INCIDENTS_PER_SERVICE_IN_ARCHIVE + 50
    const baseMs = Date.parse('2026-04-01T00:00:00Z')
    const incs = Array.from({ length: overflow }, (_, i) => ({
      id: `inc-${String(i).padStart(4, '0')}`,
      // Monotonic +1min per index so "oldest" is unambiguously the lowest index.
      startedAt: new Date(baseMs + i * 60_000).toISOString(),
      status: 'resolved',
      duration: '5m',
    }))
    // Shuffle so the cap implementation actually exercises the sort step (otherwise the
    // input is already chronologically ordered and sort is a no-op for stable algorithms).
    // Deterministic Fisher-Yates with a fixed seed via simple LCG so the test stays reproducible.
    let rng = 0x12345
    const next = () => (rng = (rng * 1664525 + 1013904223) >>> 0)
    for (let i = incs.length - 1; i > 0; i--) {
      const j = next() % (i + 1)
      ;[incs[i], incs[j]] = [incs[j], incs[i]]
    }
    const result = accumulateMonthlyIncidents(null, [makeService('mistral', incs)], '2026-04')
    const data = result.services.mistral
    // Aggregate counts include every incident (the cap binds detail only).
    expect(data.count).toBe(overflow)
    expect(data.totalMinutes).toBe(overflow * 5)
    expect(data.incidentIds.length).toBe(overflow) // dedup state untruncated
    // Detail array hits the cap.
    expect(data.incidents!.length).toBe(MAX_INCIDENTS_PER_SERVICE_IN_ARCHIVE)
    // Oldest 50 dropped — first surviving entry is index 50.
    expect(data.incidents![0].id).toBe('inc-0050')
    expect(data.incidents![data.incidents!.length - 1].id).toBe(`inc-${String(overflow - 1).padStart(4, '0')}`)
  })

  it('backward-compat: existing data without `incidents` field still accumulates correctly', () => {
    // Simulate an older accumulator value that lacks the new `incidents` field.
    const legacy = {
      lastUpdated: '2026-04-01T00:00:00Z',
      services: {
        claude: { count: 1, totalMinutes: 60, longestMinutes: 60, dates: ['2026-04-01'], incidentIds: ['old-1'], durations: { 'old-1': 60 } },
      },
    }
    const services = [
      makeService('claude', [
        { id: 'new-1', startedAt: '2026-04-02T10:00:00Z', status: 'resolved', duration: '30m' },
      ]),
    ]
    const result = accumulateMonthlyIncidents(legacy, services, '2026-04')
    expect(result.services.claude.count).toBe(2)
    expect(result.services.claude.incidents).toBeDefined()
    // Legacy entry has no detail; only the new incident is in the detail array.
    expect(result.services.claude.incidents!.length).toBe(1)
    expect(result.services.claude.incidents![0].id).toBe('new-1')
  })
})

// ── summarizeSecurityAlerts (#290) ───────────────────────────────────

describe('summarizeSecurityAlerts', () => {
  it('counts by source, severity, service; preserves all fields on top findings', () => {
    const entries: MonthlySecurityEntry[] = [
      { title: 'A', url: 'u1', source: 'osv',        severity: 'critical', service: 'OpenAI',             detectedAt: '2026-03-01T00:00:00Z' },
      { title: 'B', url: 'u2', source: 'osv',        severity: 'high',     service: 'OpenAI',             detectedAt: '2026-03-02T00:00:00Z' },
      { title: 'C', url: 'u3', source: 'osv',        severity: 'medium',   service: 'Anthropic (Claude)', detectedAt: '2026-03-03T00:00:00Z' },
      { title: 'D', url: 'u4', source: 'hackernews',                                                      detectedAt: '2026-03-04T00:00:00Z' },
    ]
    const s = summarizeSecurityAlerts(entries)
    expect(s.totalAlerts).toBe(4)
    expect(s.bySource).toEqual({ osv: 3, hackernews: 1 })
    expect(s.bySeverity).toEqual({ critical: 1, high: 1, medium: 1, low: 0 })
    expect(s.byService).toEqual({ OpenAI: 2, 'Anthropic (Claude)': 1 })
    // Regression guard: a refactor that narrows the projection to {title, url, severity}
    // would quietly break the report template that renders service + detectedAt.
    expect(s.topFindings[0]).toEqual(entries[0])
  })

  it('sorts topFindings by severity desc with recent-first tie-break', () => {
    const entries: MonthlySecurityEntry[] = [
      { title: 'old-critical', url: 'u1', source: 'osv', severity: 'critical', detectedAt: '2026-03-01T00:00:00Z' },
      { title: 'new-critical', url: 'u2', source: 'osv', severity: 'critical', detectedAt: '2026-03-30T00:00:00Z' },
      { title: 'high',         url: 'u3', source: 'osv', severity: 'high',     detectedAt: '2026-03-15T00:00:00Z' },
      { title: 'medium',       url: 'u4', source: 'osv', severity: 'medium',   detectedAt: '2026-03-20T00:00:00Z' },
    ]
    const s = summarizeSecurityAlerts(entries)
    expect(s.topFindings.map(f => f.title)).toEqual(['new-critical', 'old-critical', 'high', 'medium'])
  })

  it('ranks missing/unknown severity below low', () => {
    const entries: MonthlySecurityEntry[] = [
      { title: 'no-sev',  url: 'u1', source: 'hackernews', detectedAt: '2026-03-10T00:00:00Z' },
      { title: 'low',     url: 'u2', source: 'osv', severity: 'low',            detectedAt: '2026-03-11T00:00:00Z' },
      { title: 'weird',   url: 'u3', source: 'osv', severity: 'SUPERCRITICAL',  detectedAt: '2026-03-12T00:00:00Z' },
    ]
    const s = summarizeSecurityAlerts(entries)
    // low outranks both no-severity and the unrecognized label
    expect(s.topFindings[0].title).toBe('low')
    // bySeverity should only count recognized buckets
    expect(s.bySeverity).toEqual({ critical: 0, high: 0, medium: 0, low: 1 })
  })

  it('caps topFindings at 10', () => {
    const entries: MonthlySecurityEntry[] = Array.from({ length: 15 }, (_, i) => ({
      title: `entry-${i}`,
      url: `u${i}`,
      source: 'osv' as const,
      severity: 'medium',
      detectedAt: `2026-03-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    }))
    const s = summarizeSecurityAlerts(entries)
    expect(s.totalAlerts).toBe(15)
    expect(s.topFindings).toHaveLength(10)
  })

  it('is case-insensitive on severity normalization', () => {
    const entries: MonthlySecurityEntry[] = [
      { title: 'A', url: 'u1', source: 'osv', severity: 'CRITICAL', detectedAt: '2026-03-01T00:00:00Z' },
      { title: 'B', url: 'u2', source: 'osv', severity: 'High',     detectedAt: '2026-03-02T00:00:00Z' },
    ]
    const s = summarizeSecurityAlerts(entries)
    expect(s.bySeverity).toEqual({ critical: 1, high: 1, medium: 0, low: 0 })
  })

  it('returns zero-filled summary with empty topFindings for empty input', () => {
    const s = summarizeSecurityAlerts([])
    expect(s.totalAlerts).toBe(0)
    expect(s.bySource).toEqual({ osv: 0, hackernews: 0 })
    expect(s.bySeverity).toEqual({ critical: 0, high: 0, medium: 0, low: 0 })
    expect(s.byService).toEqual({})
    expect(s.topFindings).toEqual([])
  })
})

// ── OSV vuln id extraction + archive timeline enrichment (#291) ──────

describe('extractOsvVulnId', () => {
  it('picks GHSA ids out of osv.dev URLs', () => {
    expect(extractOsvVulnId('https://osv.dev/vulnerability/GHSA-abc-def-ghi')).toBe('GHSA-abc-def-ghi')
  })

  it('picks GHSA ids out of github.com advisory URLs', () => {
    expect(extractOsvVulnId('https://github.com/advisories/GHSA-69w3-r845-3855')).toBe('GHSA-69w3-r845-3855')
  })

  it('picks CVE ids out of URLs', () => {
    expect(extractOsvVulnId('https://nvd.nist.gov/vuln/detail/CVE-2026-12345')).toBe('CVE-2026-12345')
  })

  it('is case-insensitive on the GHSA/CVE prefix', () => {
    // Some downstream tooling lowercases path segments; the regex uses /i to tolerate that.
    expect(extractOsvVulnId('https://osv.dev/vulnerability/ghsa-aaa-bbb-ccc')).toBe('ghsa-aaa-bbb-ccc')
    expect(extractOsvVulnId('https://example.com/cve-2026-12345')).toBe('cve-2026-12345')
  })

  it('returns null for URLs without a recognizable id', () => {
    expect(extractOsvVulnId('https://example.com/advisory/random')).toBeNull()
    expect(extractOsvVulnId(undefined)).toBeNull()
    expect(extractOsvVulnId('')).toBeNull()
  })
})

describe('enrichTopFindingsWithTimelines', () => {
  const baseSummary: MonthlySecuritySummary = {
    totalAlerts: 3,
    bySource: { osv: 2, hackernews: 1 },
    bySeverity: { critical: 0, high: 1, medium: 1, low: 0 },
    byService: {},
    topFindings: [
      { title: 'OSV A', url: 'https://osv.dev/vulnerability/GHSA-aaa-bbb-ccc', source: 'osv',        severity: 'high',   detectedAt: '2026-03-01T00:00:00Z' },
      { title: 'OSV B', url: 'https://osv.dev/vulnerability/GHSA-xxx-yyy-zzz', source: 'osv',        severity: 'medium', detectedAt: '2026-03-02T00:00:00Z' },
      { title: 'HN C',  url: 'https://news.ycombinator.com/item?id=1',         source: 'hackernews',                     detectedAt: '2026-03-03T00:00:00Z' },
    ],
  }
  const timelineA: OsvTimeline = {
    vulnId: 'GHSA-aaa-bbb-ccc',
    createdAt: '2026-03-01T00:00:00Z',
    lastSeen: '2026-03-15T00:00:00Z',
    entries: [
      { stage: 'detected',     at: '2026-03-01T00:00:00Z', severity: 'medium' },
      { stage: 'severity_changed', at: '2026-03-10T00:00:00Z', severity: 'high' },
      { stage: 'fix_released', at: '2026-03-15T00:00:00Z', fixedVersion: '1.2.3' },
    ],
  }

  it('attaches timeline entries to OSV findings when the KV key exists', async () => {
    const kv = {
      get: async (key: string) => key === 'security:timeline:osv:GHSA-aaa-bbb-ccc' ? JSON.stringify(timelineA) : null,
    } as unknown as KVNamespace
    const enriched = await enrichTopFindingsWithTimelines(kv, baseSummary)
    expect(enriched.topFindings[0].timeline).toHaveLength(3)
    expect(enriched.topFindings[0].timeline![2].stage).toBe('fix_released')
    // Findings without a KV entry pass through unchanged
    expect(enriched.topFindings[1].timeline).toBeUndefined()
    // HN findings never get enriched
    expect(enriched.topFindings[2].timeline).toBeUndefined()
  })

  it('skips enrichment on missing / malformed / empty timeline', async () => {
    const kv = {
      get: async (key: string) => {
        if (key === 'security:timeline:osv:GHSA-aaa-bbb-ccc') return '{not valid json'
        if (key === 'security:timeline:osv:GHSA-xxx-yyy-zzz') return JSON.stringify({ ...timelineA, entries: [] })
        return null
      },
    } as unknown as KVNamespace
    const enriched = await enrichTopFindingsWithTimelines(kv, baseSummary)
    expect(enriched.topFindings[0].timeline).toBeUndefined()  // malformed
    expect(enriched.topFindings[1].timeline).toBeUndefined()  // empty entries array
  })

  it('tolerates KV get rejection per finding (one failure does not poison the batch)', async () => {
    const kv = {
      get: async (key: string) => {
        if (key === 'security:timeline:osv:GHSA-aaa-bbb-ccc') throw new Error('KV read failed')
        if (key === 'security:timeline:osv:GHSA-xxx-yyy-zzz') return JSON.stringify({ ...timelineA, vulnId: 'GHSA-xxx-yyy-zzz' })
        return null
      },
    } as unknown as KVNamespace
    const enriched = await enrichTopFindingsWithTimelines(kv, baseSummary)
    expect(enriched.topFindings[0].timeline).toBeUndefined()
    expect(enriched.topFindings[1].timeline).toHaveLength(3)
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
    expect(archive.services.claude.totalDowntimeMin).toBe(300)
    expect(archive.services.claude.longestIncidentMin).toBe(120)
    expect(archive.services.claude.avgLatencyMs).toBe(210)
    expect(archive.services.openai.incidents).toBe(1)
    expect(archive.services.openai.avgResolutionMin).toBe(45)
    expect(archive.services.openai.totalDowntimeMin).toBe(45)
    expect(archive.services.openai.longestIncidentMin).toBe(45)
    expect(archive.services.openai.avgLatencyMs).toBeNull()
  })

  it('#586 hybrid: threads officialUptime (status-page) separately from the daily-counter uptime', async () => {
    // claude's daily counters give ~98.61% (AIWatch-measured) — see test above. The status-page
    // officialUptime (from services:latest's uptime30d) is passed through scoreData and must NOT
    // overwrite or equal the daily-counter uptime; estimate services (null uptime30d) → null.
    const scoreData = [
      { id: 'claude', aiwatchScore: 85, scoreGrade: 'excellent' as const, officialUptime: 99.83 },
      { id: 'openai', aiwatchScore: 92, scoreGrade: 'excellent' as const, officialUptime: null },
    ]
    const archive = await buildMonthlyArchive(mockKV, 2026, 3, scoreData)
    expect(archive.services.claude.officialUptime).toBe(99.83)        // status-page value, for display
    expect(archive.services.claude.uptime).toBeCloseTo(98.61, 0)      // daily-counter value, for the Score — unchanged
    expect(archive.services.claude.officialUptime).not.toBe(archive.services.claude.uptime)
    expect(archive.services.openai.officialUptime).toBeNull()         // no published metric → null
  })

  it('officialUptime defaults to null when scoreData omits it (forward/back compat)', async () => {
    const archive = await buildMonthlyArchive(mockKV, 2026, 3, [
      { id: 'claude', aiwatchScore: 85, scoreGrade: 'excellent' as const },
    ])
    expect(archive.services.claude.officialUptime).toBeNull()
  })

  it('emits null totalDowntimeMin + longestIncidentMin for services with no incidents', async () => {
    const noIncKV = {
      get: async (key: string) => {
        const store: Record<string, string> = {
          'history:2026-03-01': JSON.stringify({ cohere: { ok: 288, total: 288 } }),
        }
        return store[key] ?? null
      },
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    } as unknown as KVNamespace

    const archive = await buildMonthlyArchive(noIncKV, 2026, 3)
    expect(archive.services.cohere.incidents).toBe(0)
    expect(archive.services.cohere.totalDowntimeMin).toBeNull()
    expect(archive.services.cohere.longestIncidentMin).toBeNull()
  })

  it('handles no score data (uptime + incidents only)', async () => {
    const archive = await buildMonthlyArchive(mockKV, 2026, 3)
    expect(archive.services.claude.score).toBeNull()
    expect(archive.services.claude.grade).toBeNull()
    expect(archive.services.claude.incidents).toBe(5)
  })

  // ── #426: AI retrospective narrative bake-in ──
  it('omits narrative entirely when no narrativeOpts are passed', async () => {
    const archive = await buildMonthlyArchive(mockKV, 2026, 3)
    expect(archive.narrative).toBeUndefined()
  })

  it('omits narrative when narrativeOpts has neither an AI binding nor an API key', async () => {
    const archive = await buildMonthlyArchive(mockKV, 2026, 3, undefined, { serviceNames: {} })
    expect(archive.narrative).toBeUndefined()
  })

  it('attaches an AI-generated narrative draft when an AI binding produces a usable response', async () => {
    const draftJson = JSON.stringify({
      notableIncidents: [{ service: 'Claude API', title: 'Elevated errors', narrative: 'Errors spiked for ~1h.' }],
      observations: ['Treat Claude as primary; recovery was fast.'],
    })
    const ai = { run: async () => ({ response: draftJson }) }
    const archive = await buildMonthlyArchive(mockKV, 2026, 3, undefined, {
      ai,
      serviceNames: { claude: 'Claude API' },
    })
    expect(archive.narrative).not.toBeNull()
    expect(archive.narrative?.model).toBe('gemma')
    expect(archive.narrative?.notableIncidents).toHaveLength(1)
    expect(archive.narrative?.observations).toHaveLength(1)
  })

  it('sets narrative to null (archive still builds) when AI generation fails', async () => {
    // AI binding throws, no API key → generateMonthlyNarrative returns null.
    const ai = { run: async () => { throw new Error('Workers AI down') } }
    const archive = await buildMonthlyArchive(mockKV, 2026, 3, undefined, { ai, serviceNames: {} })
    // The deterministic archive must be intact regardless of the AI failure.
    expect(archive.services.claude.incidents).toBe(5)
    expect(archive.narrative).toBeNull()
  })

  // ── #375: snapshot per-incident detail into the permanent archive ──
  it('snapshots per-service incidentList from accumulated data (#375)', async () => {
    const detailKV = {
      get: async (key: string) => {
        const store: Record<string, string> = {
          'incidents:monthly:2026-03': JSON.stringify({
            lastUpdated: '2026-03-31T09:00:00Z',
            services: {
              claude: {
                count: 2, totalMinutes: 90, longestMinutes: 60,
                dates: ['2026-03-01', '2026-03-15'], incidentIds: ['a', 'b'],
                durations: { a: 60, b: 30 },
                incidents: [
                  { id: 'a', title: 'Claude API down', startedAt: '2026-03-01T10:00:00Z', resolvedAt: '2026-03-01T11:00:00Z', durationMin: 60, finalStatus: 'resolved' },
                  { id: 'b', title: 'Claude latency spike', startedAt: '2026-03-15T14:00:00Z', resolvedAt: '2026-03-15T14:30:00Z', durationMin: 30, finalStatus: 'resolved' },
                ],
              },
            },
          }),
        }
        return store[key] ?? null
      },
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    } as unknown as KVNamespace

    const archive = await buildMonthlyArchive(detailKV, 2026, 3)
    expect(archive.services.claude.incidentList).toBeDefined()
    expect(archive.services.claude.incidentList!.length).toBe(2)
    expect(archive.services.claude.incidentList![0].id).toBe('a')
    expect(archive.services.claude.incidentList![0].title).toBe('Claude API down')
    expect(archive.services.claude.incidentList![1].finalStatus).toBe('resolved')
  })

  it('omits incidentList when accumulated data is from a pre-#375 KV entry (no `incidents` field)', async () => {
    const legacyKV = {
      get: async (key: string) => {
        const store: Record<string, string> = {
          'incidents:monthly:2026-03': JSON.stringify({
            lastUpdated: '2026-03-31T09:00:00Z',
            services: {
              claude: { count: 1, totalMinutes: 60, longestMinutes: 60, dates: ['2026-03-01'], incidentIds: ['a'], durations: { a: 60 } },
            },
          }),
        }
        return store[key] ?? null
      },
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    } as unknown as KVNamespace

    const archive = await buildMonthlyArchive(legacyKV, 2026, 3)
    expect(archive.services.claude.incidents).toBe(1)
    expect(archive.services.claude.incidentList).toBeUndefined()
  })

  it('clones incidentList — archive mutation does not affect accumulator data', async () => {
    const sharedDetail = [
      { id: 'a', title: 'incident', startedAt: '2026-03-01T10:00:00Z', resolvedAt: '2026-03-01T11:00:00Z', durationMin: 60, finalStatus: 'resolved' as const },
    ]
    const accumKV = {
      get: async (key: string) => {
        if (key === 'incidents:monthly:2026-03') {
          return JSON.stringify({
            lastUpdated: '2026-03-31T09:00:00Z',
            services: { claude: { count: 1, totalMinutes: 60, longestMinutes: 60, dates: [], incidentIds: ['a'], durations: { a: 60 }, incidents: sharedDetail } },
          })
        }
        return null
      },
      put: async () => {}, delete: async () => {}, list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    } as unknown as KVNamespace
    const archive = await buildMonthlyArchive(accumKV, 2026, 3)
    // Mutate the archive copy and verify the source array is untouched.
    archive.services.claude.incidentList![0].title = 'mutated'
    expect(sharedDetail[0].title).toBe('incident')
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

  it('snapshots security summary from security:monthly:{period} (#290)', async () => {
    const secEntries: MonthlySecurityEntry[] = [
      { title: 'RCE in openai', url: 'u1', source: 'osv', severity: 'critical', service: 'OpenAI', detectedAt: '2026-03-10T00:00:00Z' },
      { title: 'HN breach story', url: 'u2', source: 'hackernews', detectedAt: '2026-03-15T00:00:00Z' },
      { title: 'Path traversal', url: 'u3', source: 'osv', severity: 'high', service: 'Anthropic (Claude)', detectedAt: '2026-03-20T00:00:00Z' },
    ]
    const kvWithSecurity = {
      get: async (key: string) => {
        if (key === `security:monthly:2026-03`) return JSON.stringify(secEntries)
        return null
      },
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    } as unknown as KVNamespace

    const archive = await buildMonthlyArchive(kvWithSecurity, 2026, 3)
    expect(archive.security).not.toBeNull()
    expect(archive.security?.totalAlerts).toBe(3)
    expect(archive.security?.bySource).toEqual({ osv: 2, hackernews: 1 })
    expect(archive.security?.topFindings[0].title).toBe('RCE in openai') // critical first
  })

  it('leaves archive.security = null when security:monthly key is missing', async () => {
    // Months predating this feature (and months with zero detections) must not crash.
    const archive = await buildMonthlyArchive(mockKV, 2026, 3)
    expect(archive.security).toBeNull()
  })

  it('leaves archive.security = null on malformed security:monthly JSON', async () => {
    const corruptSecurityKV = {
      get: async (key: string) => {
        if (key === 'security:monthly:2026-03') return '{not valid json'
        return null
      },
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    } as unknown as KVNamespace

    const archive = await buildMonthlyArchive(corruptSecurityKV, 2026, 3)
    expect(archive.security).toBeNull()
  })

  it('archive.security enriches OSV top findings with per-alert timelines (#291)', async () => {
    const secEntries: MonthlySecurityEntry[] = [
      { title: 'OSV with timeline', url: 'https://osv.dev/vulnerability/GHSA-aaa-bbb-ccc', source: 'osv', severity: 'high', detectedAt: '2026-03-10T00:00:00Z' },
      { title: 'HN no timeline',    url: 'https://news.ycombinator.com/item?id=99',          source: 'hackernews',             detectedAt: '2026-03-11T00:00:00Z' },
    ]
    const timeline: OsvTimeline = {
      vulnId: 'GHSA-aaa-bbb-ccc',
      createdAt: '2026-03-10T00:00:00Z',
      lastSeen: '2026-03-20T00:00:00Z',
      entries: [
        { stage: 'detected',     at: '2026-03-10T00:00:00Z', severity: 'medium' },
        { stage: 'fix_released', at: '2026-03-20T00:00:00Z', fixedVersion: '2.0.0' },
      ],
    }
    const kv = {
      get: async (key: string) => {
        if (key === 'security:monthly:2026-03') return JSON.stringify(secEntries)
        if (key === 'security:timeline:osv:GHSA-aaa-bbb-ccc') return JSON.stringify(timeline)
        return null
      },
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    } as unknown as KVNamespace

    const archive = await buildMonthlyArchive(kv, 2026, 3)
    expect(archive.security).not.toBeNull()
    const osvFinding = archive.security!.topFindings.find(f => f.source === 'osv')
    const hnFinding = archive.security!.topFindings.find(f => f.source === 'hackernews')
    expect(osvFinding?.timeline).toHaveLength(2)
    expect(osvFinding?.timeline?.[1].stage).toBe('fix_released')
    expect(hnFinding?.timeline).toBeUndefined()
  })

  it('leaves archive.security = null when the security:monthly KV get rejects', async () => {
    // Pairs with the `.catch(() => null)` guard on the security read — if a future refactor
    // drops the catch, this test fails before the archive rejection propagates to the cron.
    const rejectingKV = {
      get: async (key: string) => {
        if (key === 'security:monthly:2026-03') throw new Error('KV read rejected')
        return null
      },
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    } as unknown as KVNamespace

    const archive = await buildMonthlyArchive(rejectingKV, 2026, 3)
    expect(archive.security).toBeNull()
  })

  it('leaves archive.security = null on empty security:monthly array', async () => {
    // A month with the key present but no detections shouldn't produce a zero-valued summary —
    // null is the signal "no security data for this month" for downstream rendering.
    const emptyArrayKV = {
      get: async (key: string) => {
        if (key === 'security:monthly:2026-03') return '[]'
        return null
      },
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    } as unknown as KVNamespace

    const archive = await buildMonthlyArchive(emptyArrayKV, 2026, 3)
    expect(archive.security).toBeNull()
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

// ── Phase 2: Archive-ready notification (aiwatch-reports#4) ──────────

describe('archiveNotifiedKey', () => {
  it('returns the stable archive:notified:{period} form', () => {
    expect(archiveNotifiedKey('2026-04')).toBe('archive:notified:2026-04')
  })
})

describe('buildArchiveReadyEmbed', () => {
  it('renders a full English month label for a valid YYYY-MM', () => {
    const embed = buildArchiveReadyEmbed('2026-04', 31, 30)
    expect(embed.title).toBe('📦 Monthly Archive Ready — 2026-04')
    expect(embed.color).toBe(0x9B59B6)
    expect(embed.description).toContain('**April 2026** archive')
    expect(embed.description).toContain('Services: 31')
    expect(embed.description).toContain('Days collected: 30')
  })

  it('links to the generate-report.yml workflow_dispatch page', () => {
    const embed = buildArchiveReadyEmbed('2026-04', 31, 30)
    expect(embed.description).toContain(REPORTS_WORKFLOW_URL)
    expect(REPORTS_WORKFLOW_URL).toBe(
      'https://github.com/bentleypark/aiwatch-reports/actions/workflows/generate-report.yml',
    )
  })

  it('spells out the month input the operator must enter', () => {
    const embed = buildArchiveReadyEmbed('2026-04', 31, 30)
    expect(embed.description).toMatch(/enter month `2026-04`/)
  })

  it('formats December correctly (month = 12 edge)', () => {
    const embed = buildArchiveReadyEmbed('2026-12', 31, 31)
    expect(embed.description).toContain('**December 2026** archive')
  })

  it('formats January correctly (single-digit month with zero padding)', () => {
    const embed = buildArchiveReadyEmbed('2027-01', 31, 31)
    expect(embed.description).toContain('**January 2027** archive')
  })

  it('renders a usable embed when the archive has zero services or days', () => {
    const embed = buildArchiveReadyEmbed('2026-04', 0, 0)
    expect(embed.title).toBe('📦 Monthly Archive Ready — 2026-04')
    expect(embed.description).toContain('**April 2026** archive')
    expect(embed.description).toContain('Services: 0')
    expect(embed.description).toContain('Days collected: 0')
    expect(embed.description).not.toContain('Invalid Date')
  })

  it('falls back to the raw period when the format is malformed', () => {
    const embed = buildArchiveReadyEmbed('not-a-month', 0, 0)
    expect(embed.title).toBe('📦 Monthly Archive Ready — not-a-month')
    expect(embed.description).toContain('**not-a-month** archive')
    expect(embed.description).not.toContain('Invalid Date')
  })

  it('falls back to the raw period when the month component is out of range', () => {
    const embed = buildArchiveReadyEmbed('2026-13', 0, 0)
    expect(embed.description).toContain('**2026-13** archive')
    expect(embed.description).not.toContain('Invalid Date')
  })

  it('always embeds the archive KV key path for traceability', () => {
    const embed = buildArchiveReadyEmbed('2026-04', 31, 30)
    expect(embed.description).toContain('`archive:monthly:2026-04`')
  })
})

// ── Phase 3: Detection-lead monthly summary (#369) ────────────────────

function makeDetEntry(overrides: Partial<DetectionLeadEntry> = {}): DetectionLeadEntry {
  // Helper that produces leadMs values consistent with detectedAt / officialAt so the
  // entries pass isValidEntry checks. Default lead is 5 minutes; callers override leadMs
  // and detectedAt together when they want a specific lead value.
  const detectedAt = overrides.detectedAt ?? '2026-04-15T10:00:00.000Z'
  const leadMs = overrides.leadMs ?? 5 * 60_000
  const officialAt = overrides.officialAt ?? new Date(new Date(detectedAt).getTime() + leadMs).toISOString()
  return {
    svcId: 'claude',
    incId: 'inc-1',
    leadMs,
    detectedAt,
    officialAt,
    ...overrides,
  }
}

describe('summarizeDetectionLead', () => {
  it('returns null on empty input — caller decides whether to surface field', () => {
    expect(summarizeDetectionLead([])).toBeNull()
  })

  it('summarizes a single entry — count 1, all averages equal that entry', () => {
    const entry = makeDetEntry({ svcId: 'gemini', incId: 'g1', leadMs: 8 * 60_000, detectedAt: '2026-04-10T10:00:00.000Z' })
    const summary = summarizeDetectionLead([entry])!
    expect(summary.count).toBe(1)
    expect(summary.avgLeadMs).toBe(8 * 60_000)
    expect(summary.medianLeadMs).toBe(8 * 60_000)
    expect(summary.maxLeadMs).toBe(8 * 60_000)
    expect(summary.byService).toEqual({ gemini: 1 })
    expect(summary.topExamples).toHaveLength(1)
    expect(summary.topExamples[0]).toEqual({ svcId: 'gemini', incId: 'g1', leadMs: 8 * 60_000, detectedAt: '2026-04-10T10:00:00.000Z' })
  })

  it('computes median for an odd count — middle value', () => {
    const entries = [3, 5, 7].map((m, i) => makeDetEntry({ incId: `i${i}`, leadMs: m * 60_000 }))
    expect(summarizeDetectionLead(entries)!.medianLeadMs).toBe(5 * 60_000)
  })

  it('computes median for an even count — average of two middle values', () => {
    const entries = [2, 4, 6, 8].map((m, i) => makeDetEntry({ incId: `i${i}`, leadMs: m * 60_000 }))
    // (4 + 6) / 2 = 5 minutes
    expect(summarizeDetectionLead(entries)!.medianLeadMs).toBe(5 * 60_000)
  })

  it('aggregates byService correctly for mixed providers', () => {
    const entries = [
      makeDetEntry({ svcId: 'claude',  incId: 'c1', leadMs: 5 * 60_000 }),
      makeDetEntry({ svcId: 'claude',  incId: 'c2', leadMs: 7 * 60_000 }),
      makeDetEntry({ svcId: 'openai',  incId: 'o1', leadMs: 3 * 60_000 }),
      makeDetEntry({ svcId: 'gemini',  incId: 'g1', leadMs: 12 * 60_000 }),
    ]
    const summary = summarizeDetectionLead(entries)!
    expect(summary.byService).toEqual({ claude: 2, openai: 1, gemini: 1 })
  })

  it('caps topExamples at 5 even when more entries are present', () => {
    const entries = Array.from({ length: 8 }, (_, i) =>
      makeDetEntry({ incId: `i${i}`, leadMs: (10 - i) * 60_000 }), // 10m, 9m, 8m, ... 3m
    )
    const summary = summarizeDetectionLead(entries)!
    expect(summary.count).toBe(8)
    expect(summary.topExamples).toHaveLength(5)
    // Sorted by leadMs desc — largest first
    expect(summary.topExamples.map(e => e.leadMs)).toEqual([10, 9, 8, 7, 6].map(m => m * 60_000))
  })

  it('topExamples ties break on detectedAt desc — most recent wins', () => {
    // Two entries with identical leadMs but different detectedAt — the recent one should sort first
    const earlier = makeDetEntry({ incId: 'early', leadMs: 5 * 60_000, detectedAt: '2026-04-05T10:00:00.000Z' })
    const later   = makeDetEntry({ incId: 'late',  leadMs: 5 * 60_000, detectedAt: '2026-04-25T10:00:00.000Z' })
    const summary = summarizeDetectionLead([earlier, later])!
    // First topExample is the later one
    expect(summary.topExamples[0].incId).toBe('late')
    expect(summary.topExamples[1].incId).toBe('early')
  })

  it('does not mutate the input array (defensive)', () => {
    const entries = [
      makeDetEntry({ incId: 'a', leadMs: 7 * 60_000 }),
      makeDetEntry({ incId: 'b', leadMs: 3 * 60_000 }),
    ]
    const before = entries.map(e => e.incId)
    summarizeDetectionLead(entries)
    expect(entries.map(e => e.incId)).toEqual(before)
  })

  it('avgLeadMs is rounded to whole milliseconds (no NaN / no Infinity even for odd division)', () => {
    // Three entries with non-integer-divisible sum: (1m + 2m + 4m) / 3 → not integer ms
    const entries = [1, 2, 4].map((m, i) => makeDetEntry({ incId: `i${i}`, leadMs: m * 60_000 }))
    const summary = summarizeDetectionLead(entries)!
    expect(Number.isFinite(summary.avgLeadMs)).toBe(true)
    expect(Number.isInteger(summary.avgLeadMs)).toBe(true)
    // (60_000 + 120_000 + 240_000) / 3 = 140_000 — happens to round cleanly here
    expect(summary.avgLeadMs).toBe(140_000)
  })
})

describe('canPresentLeadAverage (#464)', () => {
  it('returns false for null/undefined summary', () => {
    expect(canPresentLeadAverage(null)).toBe(false)
    expect(canPresentLeadAverage(undefined)).toBe(false)
  })

  it('returns false below MIN_LEAD_SAMPLE_SIZE (thin sample — no marketing claim)', () => {
    const entries = Array.from({ length: MIN_LEAD_SAMPLE_SIZE - 1 }, (_, i) =>
      makeDetEntry({ incId: `i${i}`, leadMs: 5 * 60_000 }))
    expect(canPresentLeadAverage(summarizeDetectionLead(entries))).toBe(false)
  })

  it('returns true at MIN_LEAD_SAMPLE_SIZE (enough genuine events to present)', () => {
    const entries = Array.from({ length: MIN_LEAD_SAMPLE_SIZE }, (_, i) =>
      makeDetEntry({ incId: `i${i}`, leadMs: 5 * 60_000 }))
    expect(canPresentLeadAverage(summarizeDetectionLead(entries))).toBe(true)
  })
})

describe('degradation monthly accumulator (#511)', () => {
  it('degradationMonthlyKey is YYYY-MM in UTC', () => {
    expect(degradationMonthlyKey(new Date('2026-06-01T12:00:00Z'))).toBe('probe-degradation:monthly:2026-06')
    expect(degradationMonthlyKey(new Date('2026-01-31T23:59:00Z'))).toBe('probe-degradation:monthly:2026-01')
  })

  describe('addDegradationToMonthly (pure fold)', () => {
    it('starts fresh from null and increments byService only when on-status', () => {
      const out = addDegradationToMonthly(null, 'deepseek', false)
      expect(out).toEqual({ byService: { deepseek: 1 }, noStatusByService: {} })
    })

    it('increments both byService and noStatusByService when not on status page', () => {
      const out = addDegradationToMonthly(null, 'deepseek', true)
      expect(out).toEqual({ byService: { deepseek: 1 }, noStatusByService: { deepseek: 1 } })
    })

    it('accumulates across calls without mutating the input', () => {
      const prev = { byService: { deepseek: 2 }, noStatusByService: { deepseek: 1 } }
      const out = addDegradationToMonthly(prev, 'deepseek', true)
      expect(out).toEqual({ byService: { deepseek: 3 }, noStatusByService: { deepseek: 2 } })
      expect(prev).toEqual({ byService: { deepseek: 2 }, noStatusByService: { deepseek: 1 } }) // unmutated
    })

    it('tracks multiple services independently', () => {
      let acc = addDegradationToMonthly(null, 'deepseek', true)
      acc = addDegradationToMonthly(acc, 'mistral', false)
      expect(acc).toEqual({ byService: { deepseek: 1, mistral: 1 }, noStatusByService: { deepseek: 1 } })
    })
  })

  describe('normalizeDegradationMonthly', () => {
    it('returns empty shape for null/garbage', () => {
      expect(normalizeDegradationMonthly(null)).toEqual({ byService: {}, noStatusByService: {} })
      expect(normalizeDegradationMonthly('nope')).toEqual({ byService: {}, noStatusByService: {} })
    })

    it('keeps only finite non-negative integer counts', () => {
      const out = normalizeDegradationMonthly({
        byService: { deepseek: 3, bad: -1, nan: NaN, frac: 2.7 },
        noStatusByService: { deepseek: 2 },
      })
      expect(out).toEqual({ byService: { deepseek: 3, frac: 2 }, noStatusByService: { deepseek: 2 } })
    })

    it('drops Infinity, negative fractions, and non-number values (Number.isFinite + v>=0 guard, pre-floor)', () => {
      const out = normalizeDegradationMonthly({
        byService: { inf: Infinity, negfrac: -2.7, str: '3', nul: null, obj: {}, ok: 4 },
        noStatusByService: {},
      })
      // Infinity dropped (Number.isFinite), -2.7 dropped (v>=0 runs before Math.floor),
      // '3'/null/{} dropped (typeof !== number); only ok:4 survives.
      expect(out).toEqual({ byService: { ok: 4 }, noStatusByService: {} })
    })
  })

  describe('summarizeDegradation', () => {
    it('returns null for null input or all-zero totals', () => {
      expect(summarizeDegradation(null)).toBeNull()
      expect(summarizeDegradation({ byService: {}, noStatusByService: {} })).toBeNull()
    })

    it('computes total + noStatusTotal across services', () => {
      const out = summarizeDegradation({
        byService: { deepseek: 4, mistral: 1 },
        noStatusByService: { deepseek: 3 },
      })
      expect(out).toEqual({
        total: 5,
        noStatusTotal: 3,
        byService: { deepseek: 4, mistral: 1 },
        noStatusByService: { deepseek: 3 },
      })
    })

    it('returns null when byService is empty even if noStatusByService has counts (corrupt-KV invariant)', () => {
      // total is driven by byService (every nostatus increment also bumps byService in normal flow).
      // A hand-edited/corrupt accumulator with byService empty but noStatus populated → null (garbage
      // in → null out). Pins the byService-drives-total invariant.
      expect(summarizeDegradation({ byService: {}, noStatusByService: { deepseek: 3 } })).toBeNull()
    })
  })
})

describe('buildMonthlyArchive — detectionLead integration (#369)', () => {
  function mkKv(initial: Record<string, string>) {
    return {
      get: async (key: string) => initial[key] ?? null,
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    } as unknown as KVNamespace
  }

  const baseEntry = (overrides: Partial<DetectionLeadEntry> = {}): DetectionLeadEntry => ({
    svcId: 'claude', incId: 'c1', leadMs: 5 * 60_000,
    detectedAt: '2026-04-15T10:00:00.000Z',
    officialAt: '2026-04-15T10:05:00.000Z',
    ...overrides,
  })

  it('attaches detectionLead summary when monthly accumulator has entries', async () => {
    const period = '2026-04'
    const kv = mkKv({
      [`detection:lead:monthly:${period}`]: JSON.stringify([
        baseEntry({ incId: 'c1', leadMs: 5 * 60_000 }),
        baseEntry({ incId: 'c2', svcId: 'openai', leadMs: 9 * 60_000, detectedAt: '2026-04-20T10:00:00.000Z', officialAt: '2026-04-20T10:09:00.000Z' }),
      ]),
    })
    const archive = await buildMonthlyArchive(kv, 2026, 4)
    expect(archive.detectionLead).not.toBeNull()
    expect(archive.detectionLead!.count).toBe(2)
    expect(archive.detectionLead!.maxLeadMs).toBe(9 * 60_000)
    expect(archive.detectionLead!.byService).toEqual({ claude: 1, openai: 1 })
  })

  it('attaches null when accumulator is missing', async () => {
    const kv = mkKv({}) // no detection:lead:monthly key
    const archive = await buildMonthlyArchive(kv, 2026, 4)
    expect(archive.detectionLead).toBeNull()
  })

  it('attaches null when accumulator JSON is malformed (no archive crash)', async () => {
    const kv = mkKv({
      'detection:lead:monthly:2026-04': '{not valid json',
    })
    const archive = await buildMonthlyArchive(kv, 2026, 4)
    expect(archive.detectionLead).toBeNull()
  })

  it('attaches null when accumulator is non-array (no archive crash)', async () => {
    const kv = mkKv({
      'detection:lead:monthly:2026-04': '{"not": "an array"}',
    })
    const archive = await buildMonthlyArchive(kv, 2026, 4)
    expect(archive.detectionLead).toBeNull()
  })

  it('filters out malformed entries before summarizing — partial corruption survives', async () => {
    // Mix: 1 valid, 2 invalid (missing svcId; leadMs negative). Summary should reflect only the valid one.
    // Note: isValidEntry enforces (officialAt - detectedAt) ≈ leadMs within 1s, so timestamps must
    // match the lead — "good" uses 6m apart to match leadMs: 6 * 60_000.
    const kv = mkKv({
      'detection:lead:monthly:2026-04': JSON.stringify([
        baseEntry({ incId: 'good', leadMs: 6 * 60_000, officialAt: '2026-04-15T10:06:00.000Z' }),
        { svcId: '', incId: 'bad-empty-svc', leadMs: 5 * 60_000, detectedAt: '2026-04-15T10:00:00.000Z', officialAt: '2026-04-15T10:05:00.000Z' },
        { svcId: 'claude', incId: 'bad-neg', leadMs: -100, detectedAt: '2026-04-15T10:00:00.000Z', officialAt: '2026-04-15T10:05:00.000Z' },
      ]),
    })
    const archive = await buildMonthlyArchive(kv, 2026, 4)
    expect(archive.detectionLead).not.toBeNull()
    expect(archive.detectionLead!.count).toBe(1)
    expect(archive.detectionLead!.topExamples[0].incId).toBe('good')
  })

  it('reads the previous-month accumulator key based on the archive period (not "now")', async () => {
    // Archive is being built for 2026-04 — must read detection:lead:monthly:2026-04, not :2026-05
    const kv = mkKv({
      'detection:lead:monthly:2026-04': JSON.stringify([baseEntry({ incId: 'apr', leadMs: 7 * 60_000, officialAt: '2026-04-15T10:07:00.000Z' })]),
      'detection:lead:monthly:2026-05': JSON.stringify([baseEntry({ incId: 'may', leadMs: 11 * 60_000, detectedAt: '2026-05-15T10:00:00.000Z', officialAt: '2026-05-15T10:11:00.000Z' })]),
    })
    const archive = await buildMonthlyArchive(kv, 2026, 4)
    expect(archive.detectionLead!.count).toBe(1)
    expect(archive.detectionLead!.topExamples[0].incId).toBe('apr')
  })
})

describe('buildMonthlyArchive — degradation integration (#511)', () => {
  function mkKv(initial: Record<string, string>) {
    return {
      get: async (key: string) => initial[key] ?? null,
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    } as unknown as KVNamespace
  }

  it('attaches degradation summary when monthly accumulator has counts', async () => {
    const kv = mkKv({
      'probe-degradation:monthly:2026-04': JSON.stringify({
        byService: { deepseek: 4, mistral: 1 },
        noStatusByService: { deepseek: 3 },
      }),
    })
    const archive = await buildMonthlyArchive(kv, 2026, 4)
    expect(archive.degradation).not.toBeNull()
    expect(archive.degradation!.total).toBe(5)
    expect(archive.degradation!.noStatusTotal).toBe(3)
    expect(archive.degradation!.byService).toEqual({ deepseek: 4, mistral: 1 })
  })

  it('attaches null when accumulator is missing', async () => {
    const archive = await buildMonthlyArchive(mkKv({}), 2026, 4)
    expect(archive.degradation).toBeNull()
  })

  it('attaches null when accumulator JSON is malformed (no archive crash)', async () => {
    const archive = await buildMonthlyArchive(mkKv({ 'probe-degradation:monthly:2026-04': '{bad json' }), 2026, 4)
    expect(archive.degradation).toBeNull()
  })

  it('attaches null when accumulator has all-zero totals', async () => {
    const kv = mkKv({ 'probe-degradation:monthly:2026-04': JSON.stringify({ byService: {}, noStatusByService: {} }) })
    const archive = await buildMonthlyArchive(kv, 2026, 4)
    expect(archive.degradation).toBeNull()
  })
})
