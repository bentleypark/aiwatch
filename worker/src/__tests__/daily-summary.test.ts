import { describe, it, expect } from 'vitest'
import { buildDailySummary, computeLatencyAvg, isInSummaryWindow } from '../daily-summary'
import type { ServiceStatus } from '../types'

function makeSvc(overrides: Partial<ServiceStatus> = {}): ServiceStatus {
  return {
    id: 'test',
    name: 'Test Service',
    status: 'operational',
    url: 'https://example.com',
    statusUrl: 'https://status.example.com',
    incidents: [],
    latency: null,
    uptime30d: null,
    statusPageType: 'statuspage',
    components: [],
    ...overrides,
  } as ServiceStatus
}

describe('buildDailySummary', () => {
  it('shows basic service overview', () => {
    const result = buildDailySummary({
      services: [makeSvc({ id: 'a', name: 'Svc A' }), makeSvc({ id: 'b', name: 'Svc B' })],
      aiUsage: null,
      latencySnapshots: [],
      incidentCountToday: { newCount: 0, resolvedCount: 0 },
      redditCount: 0,
    })
    expect(result).toContain('2 monitored')
    expect(result).toContain('2 operational')
  })

  it('shows degraded and down counts', () => {
    const result = buildDailySummary({
      services: [
        makeSvc({ id: 'a', name: 'A', status: 'operational' }),
        makeSvc({ id: 'b', name: 'B', status: 'degraded' }),
        makeSvc({ id: 'c', name: 'C', status: 'down', incidents: [{ id: 'inc1', title: 'Down', status: 'investigating', startedAt: new Date(Date.now() - 3600000).toISOString(), impact: 'major', updates: [] }] }),
      ],
      aiUsage: null,
      latencySnapshots: [],
      incidentCountToday: { newCount: 0, resolvedCount: 0 },
      redditCount: 0,
    })
    expect(result).toContain('1 degraded')
    expect(result).toContain('1 down')
    expect(result).toContain('🔴 C')
    expect(result).toContain('🟡 B')
  })

  it('shows active issues with duration', () => {
    const result = buildDailySummary({
      services: [
        makeSvc({
          id: 'x', name: 'X Service', status: 'down',
          incidents: [{ id: 'i1', title: 'API Error', status: 'investigating', startedAt: new Date(Date.now() - 7200000).toISOString(), impact: 'major', updates: [] }],
        }),
      ],
      aiUsage: null,
      latencySnapshots: [],
      incidentCountToday: { newCount: 0, resolvedCount: 0 },
      redditCount: 0,
    })
    expect(result).toContain('X Service (investigating, 2h)')
  })

  it('shows AI usage section', () => {
    const result = buildDailySummary({
      services: [makeSvc()],
      aiUsage: { calls: 5, success: 4, failed: 1 },
      latencySnapshots: [],
      incidentCountToday: { newCount: 0, resolvedCount: 0 },
      redditCount: 0,
    })
    expect(result).toContain('AI Analysis Usage')
    expect(result).toContain('5 calls (4 success, 1 failed)')
    expect(result).toContain('$0.030')
  })

  it('omits AI usage section when no calls', () => {
    const result = buildDailySummary({
      services: [makeSvc()],
      aiUsage: { calls: 0, success: 0, failed: 0 },
      latencySnapshots: [],
      incidentCountToday: { newCount: 0, resolvedCount: 0 },
      redditCount: 0,
    })
    expect(result).not.toContain('AI Analysis')
  })

  it('shows uptime best/worst', () => {
    const result = buildDailySummary({
      services: [
        makeSvc({ id: 'a', name: 'Alpha', uptime30d: 100.0 }),
        makeSvc({ id: 'b', name: 'Beta', uptime30d: 99.50 }),
        makeSvc({ id: 'c', name: 'Gamma', uptime30d: 97.28 }),
      ],
      aiUsage: null,
      latencySnapshots: [],
      incidentCountToday: { newCount: 0, resolvedCount: 0 },
      redditCount: 0,
    })
    expect(result).toContain('Uptime (30d)')
    expect(result).toContain('Alpha 100.00%')
    expect(result).toContain('Gamma 97.28%')
  })

  it('shows latency best/worst', () => {
    const result = buildDailySummary({
      services: [
        makeSvc({ id: 'fast', name: 'FastSvc' }),
        makeSvc({ id: 'mid', name: 'MidSvc' }),
        makeSvc({ id: 'slow', name: 'SlowSvc' }),
      ],
      aiUsage: null,
      latencySnapshots: [
        { t: '2026-03-26T00:00:00Z', data: { fast: 50, mid: 300, slow: 800 } },
        { t: '2026-03-26T00:30:00Z', data: { fast: 60, mid: 350, slow: 900 } },
      ],
      incidentCountToday: { newCount: 0, resolvedCount: 0 },
      redditCount: 0,
    })
    expect(result).toContain('Latency (24h avg)')
    expect(result).toContain('FastSvc 55ms')
    expect(result).toContain('SlowSvc 850ms')
  })

  it('handles invalid startedAt without NaN', () => {
    const result = buildDailySummary({
      services: [makeSvc({
        id: 'x', name: 'X', status: 'down',
        incidents: [{ id: 'i1', title: 'Bad', status: 'investigating', startedAt: 'not-a-date', impact: 'major', updates: [] }],
      })],
      aiUsage: null,
      latencySnapshots: [],
      incidentCountToday: { newCount: 0, resolvedCount: 0 },
      redditCount: 0,
    })
    expect(result).not.toContain('NaN')
    expect(result).toContain('X (investigating)')
  })

  it('skips uptime section when fewer than 3 services have data', () => {
    const result = buildDailySummary({
      services: [
        makeSvc({ id: 'a', name: 'Alpha', uptime30d: 100.0 }),
        makeSvc({ id: 'b', name: 'Beta', uptime30d: 99.0 }),
      ],
      aiUsage: null,
      latencySnapshots: [],
      incidentCountToday: { newCount: 0, resolvedCount: 0 },
      redditCount: 0,
    })
    expect(result).not.toContain('Uptime (30d)')
  })

  it('skips latency section when fewer than 3 services have data', () => {
    const result = buildDailySummary({
      services: [makeSvc({ id: 'a', name: 'A' }), makeSvc({ id: 'b', name: 'B' })],
      aiUsage: null,
      latencySnapshots: [{ t: '1', data: { a: 100, b: 200 } }],
      incidentCountToday: { newCount: 0, resolvedCount: 0 },
      redditCount: 0,
    })
    expect(result).not.toContain('Latency (24h avg)')
  })

  it('shows daily alert counts from KV when available', () => {
    const result = buildDailySummary({
      services: [makeSvc()],
      aiUsage: null,
      latencySnapshots: [],
      incidentCountToday: { newCount: 0, resolvedCount: 0 },
      alertCounts: { incidents: 3, resolved: 2, down: 1, degraded: 0, recovered: 1 },
      redditCount: 0,
    })
    expect(result).toContain('Alerts Sent Today')
    expect(result).toContain('7')  // total
    expect(result).toContain('3 incidents')
    expect(result).toContain('2 resolved')
    expect(result).toContain('1 down')
    expect(result).toContain('1 recovered')
    expect(result).not.toContain('degraded')  // 0 should be omitted
  })

  it('shows webhook counts when available', () => {
    const result = buildDailySummary({
      services: [makeSvc()],
      aiUsage: null,
      latencySnapshots: [],
      incidentCountToday: { newCount: 0, resolvedCount: 0 },
      webhookCounts: { discord: 5, slack: 2 },
      redditCount: 0,
    })
    expect(result).toContain('Active Webhooks')
    expect(result).toContain('5 Discord')
    expect(result).toContain('2 Slack')
  })

  it('shows Active Webhooks: 0 when no registrations', () => {
    const result = buildDailySummary({
      services: [makeSvc()],
      aiUsage: null,
      latencySnapshots: [],
      incidentCountToday: { newCount: 0, resolvedCount: 0 },
      webhookCounts: { discord: 0, slack: 0 },
      redditCount: 0,
    })
    expect(result).toContain('Active Webhooks')
    expect(result).toContain('0')
  })

  it('shows delivery counts when available', () => {
    const result = buildDailySummary({
      services: [makeSvc()],
      aiUsage: null,
      latencySnapshots: [],
      incidentCountToday: { newCount: 0, resolvedCount: 0 },
      deliveryCounts: { discord: 10, slack: 3, failed: 1 },
      redditCount: 0,
    })
    expect(result).toContain('User Webhook Delivery')
    expect(result).toContain('10 Discord')
    expect(result).toContain('3 Slack')
    expect(result).toContain('1 failed')
  })

  it('omits delivery section when all counts are zero', () => {
    const result = buildDailySummary({
      services: [makeSvc()],
      aiUsage: null,
      latencySnapshots: [],
      incidentCountToday: { newCount: 0, resolvedCount: 0 },
      deliveryCounts: { discord: 0, slack: 0, failed: 0 },
      redditCount: 0,
    })
    expect(result).not.toContain('User Webhook Delivery')
  })

  it('falls back to incidentCountToday when alertCounts is null', () => {
    const result = buildDailySummary({
      services: [makeSvc()],
      aiUsage: null,
      latencySnapshots: [],
      incidentCountToday: { newCount: 3, resolvedCount: 2 },
      redditCount: 5,
    })
    expect(result).toContain('3 new')
    expect(result).toContain('2 resolved')
    expect(result).toContain('Alerts Sent')
    expect(result).toContain('5 posts detected')
  })
})

describe('isInSummaryWindow', () => {
  it('returns inWindow=true in normal window (UTC 09:00-09:04)', () => {
    expect(isInSummaryWindow(9, 0)).toEqual({ inWindow: true, isCatchUp: false })
    expect(isInSummaryWindow(9, 4)).toEqual({ inWindow: true, isCatchUp: false })
  })

  it('returns inWindow=true with isCatchUp in catch-up window (UTC 10:00-10:04)', () => {
    expect(isInSummaryWindow(10, 0)).toEqual({ inWindow: true, isCatchUp: true })
    expect(isInSummaryWindow(10, 4)).toEqual({ inWindow: true, isCatchUp: true })
  })

  it('returns inWindow=false outside both windows', () => {
    expect(isInSummaryWindow(8, 59)).toEqual({ inWindow: false, isCatchUp: false })
    expect(isInSummaryWindow(9, 5)).toEqual({ inWindow: false, isCatchUp: false })
    expect(isInSummaryWindow(10, 5)).toEqual({ inWindow: false, isCatchUp: false })
    expect(isInSummaryWindow(11, 0)).toEqual({ inWindow: false, isCatchUp: false })
    expect(isInSummaryWindow(0, 0)).toEqual({ inWindow: false, isCatchUp: false })
    expect(isInSummaryWindow(23, 59)).toEqual({ inWindow: false, isCatchUp: false })
  })
})

describe('computeLatencyAvg', () => {
  it('computes average across snapshots', () => {
    const avg = computeLatencyAvg([
      { t: '1', data: { a: 100, b: 200 } },
      { t: '2', data: { a: 200, b: 400 } },
    ])
    expect(avg.a).toBe(150)
    expect(avg.b).toBe(300)
  })

  it('handles empty snapshots', () => {
    const avg = computeLatencyAvg([])
    expect(Object.keys(avg)).toHaveLength(0)
  })

  it('handles services appearing in some snapshots', () => {
    const avg = computeLatencyAvg([
      { t: '1', data: { a: 100 } },
      { t: '2', data: { a: 200, b: 400 } },
    ])
    expect(avg.a).toBe(150)
    expect(avg.b).toBe(400)
  })
})
