import { describe, it, expect } from 'vitest'
import { buildDailySummary, computeLatencyAvg, isInSummaryWindow, formatDegradationSection, formatV1TrafficSection } from '../daily-summary'
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
      aiUsage: { calls: 5, success: 4, failed: 1, gemma: 3, sonnet: 1 },
      latencySnapshots: [],
      incidentCountToday: { newCount: 0, resolvedCount: 0 },
      redditCount: 0,
    })
    expect(result).toContain('AI Analysis Usage')
    expect(result).toContain('5 calls (4 success, 1 failed)')
    expect(result).toContain('Gemma: 3, Sonnet: 1')
    expect(result).toContain('$0.006')
    expect(result).toContain('Sonnet only')
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
    expect(result).toContain('📈 **Uptime**')
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

  it('excludes estimate-only services from uptime best/worst', () => {
    const result = buildDailySummary({
      services: [
        makeSvc({ id: 'bedrock', name: 'Amazon Bedrock', uptime30d: 100.0, uptimeSource: 'estimate' as const, incidents: [] }),
        makeSvc({ id: 'azureopenai', name: 'Azure OpenAI', uptime30d: 100.0, uptimeSource: 'estimate' as const, incidents: [] }),
        makeSvc({ id: 'openai', name: 'OpenAI API', uptime30d: 99.99 }),
        makeSvc({ id: 'claude', name: 'Claude API', uptime30d: 99.50 }),
        makeSvc({ id: 'elevenlabs', name: 'ElevenLabs', uptime30d: 97.54 }),
      ],
      aiUsage: null,
      latencySnapshots: [],
      incidentCountToday: { newCount: 0, resolvedCount: 0 },
      redditCount: 0,
    })
    expect(result).toContain('📈 **Uptime**')
    expect(result).not.toContain('Amazon Bedrock')
    expect(result).not.toContain('Azure OpenAI')
    expect(result).toContain('OpenAI API 99.99%')
    expect(result).toContain('ElevenLabs 97.54%')
  })

  it('includes estimate services with incidents in uptime best/worst', () => {
    const result = buildDailySummary({
      services: [
        makeSvc({ id: 'bedrock', name: 'Amazon Bedrock', uptime30d: 99.80, uptimeSource: 'estimate' as const, incidents: [{ id: 'i1', title: 'Outage', status: 'resolved', startedAt: '2026-04-01T00:00:00Z', impact: 'major', updates: [] }] }),
        makeSvc({ id: 'openai', name: 'OpenAI API', uptime30d: 99.99 }),
        makeSvc({ id: 'claude', name: 'Claude API', uptime30d: 99.50 }),
      ],
      aiUsage: null,
      latencySnapshots: [],
      incidentCountToday: { newCount: 0, resolvedCount: 0 },
      redditCount: 0,
    })
    expect(result).toContain('Amazon Bedrock')
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
    expect(result).not.toContain('📈 **Uptime**')
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

  it('shows Discord webhook counts when available (Slack moved to /feed, #467)', () => {
    const result = buildDailySummary({
      services: [makeSvc()],
      aiUsage: null,
      latencySnapshots: [],
      incidentCountToday: { newCount: 0, resolvedCount: 0 },
      webhookCounts: { discord: 5 },
      redditCount: 0,
    })
    expect(result).toContain('Active Discord Webhooks')
    expect(result).toContain('5')
    expect(result).not.toContain('Slack')
  })

  it('shows Active Discord Webhooks: 0 when no registrations', () => {
    const result = buildDailySummary({
      services: [makeSvc()],
      aiUsage: null,
      latencySnapshots: [],
      incidentCountToday: { newCount: 0, resolvedCount: 0 },
      webhookCounts: { discord: 0 },
      redditCount: 0,
    })
    expect(result).toContain('Active Discord Webhooks')
    expect(result).toContain('0')
  })

  it('shows Discord delivery counts when available', () => {
    const result = buildDailySummary({
      services: [makeSvc()],
      aiUsage: null,
      latencySnapshots: [],
      incidentCountToday: { newCount: 0, resolvedCount: 0 },
      deliveryCounts: { discord: 10, failed: 1 },
      redditCount: 0,
    })
    expect(result).toContain('User Webhook Delivery')
    expect(result).toContain('10 Discord')
    expect(result).toContain('1 failed')
    expect(result).not.toContain('Slack')
  })

  it('omits delivery section when all counts are zero', () => {
    const result = buildDailySummary({
      services: [makeSvc()],
      aiUsage: null,
      latencySnapshots: [],
      incidentCountToday: { newCount: 0, resolvedCount: 0 },
      deliveryCounts: { discord: 0, failed: 0 },
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

  it('appends Detection Lead section when entries present', () => {
    const result = buildDailySummary({
      services: [makeSvc({ id: 'together', name: 'Together AI' })],
      aiUsage: null,
      latencySnapshots: [],
      incidentCountToday: { newCount: 1, resolvedCount: 0 },
      redditCount: 0,
      detectionLeadEntries: [
        { svcId: 'together', incId: 'i1', leadMs: 7 * 60_000, detectedAt: '2026-04-18T11:53:00Z', officialAt: '2026-04-18T12:00:00Z' },
      ],
    })
    expect(result).toContain('Early RTT detections (last 24h)')
    expect(result).toContain('Together AI: 7m before official update')
  })

  it('omits Detection Lead section when entries empty', () => {
    const result = buildDailySummary({
      services: [makeSvc({ id: 'a' })],
      aiUsage: null,
      latencySnapshots: [],
      incidentCountToday: { newCount: 0, resolvedCount: 0 },
      redditCount: 0,
      detectionLeadEntries: [],
    })
    expect(result).not.toContain('Detection Lead')
  })
})

describe('buildDailySummary — Status Page Fetch Failures section (#500)', () => {
  const BASE = {
    services: [
      makeSvc({ id: 'deepseek', name: 'DeepSeek API' }),
      makeSvc({ id: 'claude', name: 'Claude API' }),
    ],
    aiUsage: null,
    latencySnapshots: [],
    incidentCountToday: { newCount: 0, resolvedCount: 0 },
    redditCount: 0,
  }

  it('omits section when no fetch failures today', () => {
    const result = buildDailySummary({ ...BASE })
    expect(result).not.toContain('Status Page Fetch Failures')
  })

  it('shows section with threshold-hit count when failures present', () => {
    const result = buildDailySummary({
      ...BASE,
      fetchFailureCounts: { deepseek: 5 },
    })
    expect(result).toContain('Status Page Fetch Failures Today')
    expect(result).toContain('DeepSeek API: 5× threshold hit')
    expect(result).toContain('5 real')
  })

  it('labels all as false positives when suppressed count equals total', () => {
    const result = buildDailySummary({
      ...BASE,
      fetchFailureCounts: { deepseek: 3 },
      crossValidSuppressed: { deepseek: 3 },
    })
    expect(result).toContain('all false positives — probe healthy')
  })

  it('shows partial suppression breakdown', () => {
    const result = buildDailySummary({
      ...BASE,
      fetchFailureCounts: { deepseek: 5 },
      crossValidSuppressed: { deepseek: 2 },
    })
    expect(result).toContain('3 real, 2 probe-suppressed')
  })

  it('sorts services by failure count descending', () => {
    const result = buildDailySummary({
      ...BASE,
      fetchFailureCounts: { claude: 1, deepseek: 8 },
    })
    // Extract only the fetch failures section to avoid matching 'Claude API' in earlier sections
    const sectionStart = result.indexOf('Status Page Fetch Failures Today')
    expect(sectionStart).toBeGreaterThan(-1)
    const section = result.slice(sectionStart)
    expect(section.indexOf('DeepSeek API')).toBeLessThan(section.indexOf('Claude API'))
  })

  it('clamps real to 0 when suppressed exceeds total (data race guard)', () => {
    const result = buildDailySummary({
      ...BASE,
      fetchFailureCounts: { deepseek: 2 },
      crossValidSuppressed: { deepseek: 5 },
    })
    expect(result).not.toMatch(/-\d+ real/)
    expect(result).toContain('Status Page Fetch Failures Today')
  })

  it('omits section when crossValidSuppressed has entries but fetchFailureCounts is empty', () => {
    const result = buildDailySummary({
      ...BASE,
      crossValidSuppressed: { deepseek: 3 },
    })
    expect(result).not.toContain('Status Page Fetch Failures')
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

describe('formatDegradationSection (#464)', () => {
  const svcs = [
    makeSvc({ id: 'deepseek', name: 'DeepSeek API' }),
    makeSvc({ id: 'mistral', name: 'Mistral API' }),
  ]

  it('returns empty string when no degradations recorded', () => {
    expect(formatDegradationSection(undefined, undefined, svcs)).toBe('')
    expect(formatDegradationSection({}, {}, svcs)).toBe('')
  })

  it('renders total + not-on-status-page headline and per-service breakdown', () => {
    const out = formatDegradationSection({ deepseek: 4, mistral: 1 }, { deepseek: 3 }, svcs)
    expect(out).toContain('RTT Degradations (~48h)')
    expect(out).toContain('5 total')                      // 4 + 1
    expect(out).toContain('3 not on official status pages') // deepseek nostatus only
    expect(out).toContain('DeepSeek API: 4 RTT spikes (3 not on official status page)')
    expect(out).toContain('Mistral API: 1 RTT spike (all reflected on status page)')
  })

  it('sorts services by spike count descending', () => {
    const out = formatDegradationSection({ mistral: 2, deepseek: 9 }, {}, svcs)
    expect(out.indexOf('DeepSeek API')).toBeLessThan(out.indexOf('Mistral API'))
  })

  it('falls back to svcId when name missing', () => {
    const out = formatDegradationSection({ unknownsvc: 2 }, {}, svcs)
    expect(out).toContain('unknownsvc: 2 RTT spikes')
  })

  it('headline shows 0 not-on-status when all degradations are reflected on status pages', () => {
    const out = formatDegradationSection({ deepseek: 3 }, {}, svcs)
    expect(out).toContain('3 total · 0 not on official status pages')
    expect(out).toContain('DeepSeek API: 3 RTT spikes (all reflected on status page)')
  })

  it('per-service loop iterates degradationCounts only — a nostatus-only entry is not attributed per-service', () => {
    // Production always writes degBase before the nostatus key, so this mismatch shouldn't occur;
    // this pins the formatter's behavior if it ever does (headline counts it, no orphan per-service line).
    const out = formatDegradationSection({ deepseek: 2 }, { mistral: 1 }, svcs)
    expect(out).toContain('2 total · 1 not on official status pages')
    expect(out).toContain('DeepSeek API: 2 RTT spikes')
    expect(out).not.toContain('Mistral API:')  // mistral only in nostatus → no per-service line
  })
})

describe('formatV1TrafficSection (#518)', () => {
  it('returns empty string when traffic data is unavailable (SQL API not configured)', () => {
    expect(formatV1TrafficSection(null)).toBe('')
    expect(formatV1TrafficSection(undefined)).toBe('')
  })

  it('renders last-24h total with the all-vs-per-service split and cumulative since-date', () => {
    const out = formatV1TrafficSection({
      today: { all: 120, service: 30, total: 150 },
      cumulative: 4200,
      since: '2026-06-01',
    })
    expect(out).toContain('Public API (/api/v1)')
    expect(out).toContain('Last 24h: 150 (all-services 120 · per-service ~30)')
    expect(out).toContain('Cumulative: ~4200 (since 2026-06-01)')
  })

  it('renders a zero-traffic day without breaking (0 total)', () => {
    const out = formatV1TrafficSection({
      today: { all: 0, service: 0, total: 0 },
      cumulative: 4200,
      since: '2026-06-01',
    })
    expect(out).toContain('Last 24h: 0 (all-services 0 · per-service ~0)')
    expect(out).toContain('Cumulative: ~4200')
  })

  it('is included by buildDailySummary when v1Traffic is present', () => {
    const out = buildDailySummary({
      services: [makeSvc({ id: 'claude', name: 'Claude' })],
      aiUsage: null,
      latencySnapshots: [],
      incidentCountToday: { newCount: 0, resolvedCount: 0 },
      redditCount: 0,
      v1Traffic: { today: { all: 5, service: 2, total: 7 }, cumulative: 7, since: '2026-06-01' },
    })
    expect(out).toContain('Public API (/api/v1)')
    expect(out).toContain('Last 24h: 7')
  })
})
