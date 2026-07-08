import { describe, it, expect } from 'vitest'
import { buildDailySummary, computeLatencyAvg, isInSummaryWindow, formatDegradationSection, formatV1TrafficSection, classifyDegradation, formatSubscriberDelta, formatFeedTrafficSection, formatExtActivitySection, formatStatuslineTrafficSection, formatStatuslineDeltaSuffix, formatPluginTrafficSection, formatPushLine, formatAccuracyLine, formatReferralLine, formatAudienceLine } from '../daily-summary'
import type { ServiceStatus } from '../types'
import type { AccuracyStats } from '../incident-history'
import type { AudienceCounts } from '../outage-audience'

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
        makeSvc({ id: 'c', name: 'C', status: 'down', incidents: [{ id: 'inc1', title: 'Down', status: 'investigating', startedAt: new Date(Date.now() - 3600000).toISOString(), impact: 'major', duration: null, timeline: [] }] }),
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
          incidents: [{ id: 'i1', title: 'API Error', status: 'investigating', startedAt: new Date(Date.now() - 7200000).toISOString(), impact: 'major', duration: null, timeline: [] }],
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
        incidents: [{ id: 'i1', title: 'Bad', status: 'investigating', startedAt: 'not-a-date', impact: 'major', duration: null, timeline: [] }],
      })],
      aiUsage: null,
      latencySnapshots: [],
      incidentCountToday: { newCount: 0, resolvedCount: 0 },
      redditCount: 0,
    })
    expect(result).not.toContain('NaN')
    expect(result).toContain('X (investigating)')
  })

  it('#713: excludes services with no official uptime (Bedrock/Azure are uptime: null)', () => {
    const result = buildDailySummary({
      services: [
        // #713 — no-official-uptime services carry uptime30d null (no estimate) → excluded from the
        // official-uptime best/worst list by the null check alone.
        makeSvc({ id: 'bedrock', name: 'Amazon Bedrock', uptime30d: null, incidents: [] }),
        makeSvc({ id: 'azureopenai', name: 'Azure OpenAI', uptime30d: null, incidents: [] }),
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

  // #679 — the "detection lead" (faster-than-official) section was removed (structurally null).
  it('no longer emits any Detection Lead section', () => {
    const result = buildDailySummary({
      services: [makeSvc({ id: 'together', name: 'Together AI' })],
      aiUsage: null,
      latencySnapshots: [],
      incidentCountToday: { newCount: 1, resolvedCount: 0 },
      redditCount: 0,
    })
    expect(result).not.toContain('Detection Lead')
    expect(result).not.toContain('before official update')
  })
})

// #679 — classifyDegradation moved here from the (deleted) detection-lead-log module; it is the
// KEPT RTT-degradation classifier (separate from the removed lead metric).
describe('classifyDegradation (#464/#511)', () => {
  it('operational service → degradation_nostatus (not on the status page — the differentiator)', () => {
    expect(classifyDegradation(true)).toBe('degradation_nostatus')
  })
  it('non-operational service → degradation (already reflected on the status page)', () => {
    expect(classifyDegradation(false)).toBe('degradation')
  })
  it('pins the exact outcome literals — index.ts derives isNoStatus via `=== "degradation_nostatus"`', () => {
    expect(new Set([classifyDegradation(true), classifyDegradation(false)]))
      .toEqual(new Set(['degradation_nostatus', 'degradation']))
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

describe('formatSubscriberDelta (#548)', () => {
  it('renders a positive delta with a + sign', () => {
    expect(formatSubscriberDelta(3)).toBe(' (+3 today)')
  })
  it('renders a negative delta (churn) with a Unicode minus', () => {
    expect(formatSubscriberDelta(-2)).toBe(' (−2 today)')
  })
  it('returns empty for null (no baseline) or 0 (no change) so the line stays clean', () => {
    expect(formatSubscriberDelta(null)).toBe('')
    expect(formatSubscriberDelta(undefined)).toBe('')
    expect(formatSubscriberDelta(0)).toBe('')
  })
})

describe('formatFeedTrafficSection (#548)', () => {
  it('renders the 24h total with the all-vs-per-service split', () => {
    const out = formatFeedTrafficSection({ all: 120, service: 45, total: 165 })
    expect(out).toContain('Feed Polls')
    expect(out).toContain('Last 24h: 165')
    expect(out).toContain('all-feed 120')
    expect(out).toContain('~45') // per-service marked approximate
  })
  it('returns empty string when feed traffic is unavailable (SQL API not configured)', () => {
    expect(formatFeedTrafficSection(null)).toBe('')
    expect(formatFeedTrafficSection(undefined)).toBe('')
  })
  // #748 — "new feed items" suffix (alert-worthy events, distinct from poll noise)
  it('appends "· N new items" + labels polls when newItems is present', () => {
    const out = formatFeedTrafficSection({ all: 64, service: 7, total: 71, newItems: 2 })
    expect(out).toContain('Last 24h: 71 polls (all-feed 64 · per-service ~7) · 2 new items')
  })
  it('uses the singular "item" for a count of 1', () => {
    expect(formatFeedTrafficSection({ all: 1, service: 0, total: 1, newItems: 1 })).toContain('· 1 new item')
    expect(formatFeedTrafficSection({ all: 1, service: 0, total: 1, newItems: 1 })).not.toContain('1 new items')
  })
  it('shows "· 0 new items" on a quiet day (count present but zero)', () => {
    expect(formatFeedTrafficSection({ all: 30, service: 0, total: 30, newItems: 0 })).toContain('· 0 new items')
  })
  it('omits the suffix entirely when newItems is absent (KV read failed)', () => {
    const out = formatFeedTrafficSection({ all: 30, service: 0, total: 30 })
    expect(out).toContain('Last 24h: 30 polls')
    expect(out).not.toContain('new item')
  })
})

describe('buildDailySummary — #548 webhook delta + feed section', () => {
  const base = {
    services: [], aiUsage: null, latencySnapshots: [],
    incidentCountToday: { newCount: 0, resolvedCount: 0 }, redditCount: 0,
  } as Parameters<typeof buildDailySummary>[0]

  it('appends the new-today delta to the Active Discord Webhooks line', () => {
    const out = buildDailySummary({ ...base, webhookCounts: { discord: 12, newToday: 3 } })
    expect(out).toContain('🔗 **Active Discord Webhooks**: 12 (+3 today)')
  })
  it('omits the delta when there is no baseline', () => {
    const out = buildDailySummary({ ...base, webhookCounts: { discord: 12, newToday: null } })
    expect(out).toContain('🔗 **Active Discord Webhooks**: 12')
    expect(out).not.toContain('today)')
  })
  it('renders the feed-poll section when feedTraffic is present', () => {
    const out = buildDailySummary({ ...base, feedTraffic: { all: 10, service: 5, total: 15 } })
    expect(out).toContain('📡 **Feed Polls (RSS/Slack)**')
    expect(out).toContain('Last 24h: 15')
  })
  it('renders the statusline-poll section when statuslineTraffic is present (#918)', () => {
    const out = buildDailySummary({ ...base, statuslineTraffic: { byPreset: { branded: 88, scoped: 12 }, serverRenderTotal: 100, legacyProxy: 0, total: 100 } })
    expect(out).toContain('📟 **Statusline Polls (Claude Code)**')
    expect(out).toContain('Server-render (#918): ~100')
  })
})

describe('formatPluginTrafficSection (#920)', () => {
  it('renders monitor polls + /aiwatch briefings', () => {
    const out = formatPluginTrafficSection({ monitor: 1440, brief: 12 })
    expect(out).toContain('🧩 **Plugin (Claude Code)**')
    expect(out).toContain('~1440 monitor polls')
    expect(out).toContain('~12 /aiwatch briefings')
  })
  it('omits a zero-count part', () => {
    const out = formatPluginTrafficSection({ monitor: 60, brief: 0 })
    expect(out).toContain('~60 monitor polls')
    expect(out).not.toContain('briefings')
  })
  it('is empty when null/undefined or both are 0', () => {
    expect(formatPluginTrafficSection(null)).toBe('')
    expect(formatPluginTrafficSection(undefined)).toBe('')
    expect(formatPluginTrafficSection({ monitor: 0, brief: 0 })).toBe('')
  })
})

describe('formatStatuslineTrafficSection (#918; #944 cohort-split + delta)', () => {
  it('splits server-render vs legacy proxy on separate lines; server-render carries the breakdown', () => {
    const out = formatStatuslineTrafficSection({
      byPreset: { degraded_only: 91, branded: 2693, full_list: 2 }, serverRenderTotal: 2786, legacyProxy: 9888, total: 12674,
    })
    expect(out).toContain('📟 **Statusline Polls (Claude Code)**')
    expect(out).toContain('Server-render (#918): ~2786')
    expect(out).toContain('branded 2693 · degraded_only 91 · full_list 2') // count-desc, proxy absent
    expect(out).toContain('Legacy/untagged (apex proxy): ~9888')
    expect(out).not.toContain('migrating')                  // neutral label, no trend claim (#944)
    expect(out).not.toContain('proxy 9888')                 // proxy never shown as a preset
  })
  it('appends a day-over-day ▲/▼ delta per cohort when a baseline exists', () => {
    const out = formatStatuslineTrafficSection({
      byPreset: { branded: 2693 }, serverRenderTotal: 2786, legacyProxy: 9888, total: 12674,
      delta: { serverRender: 312, legacyProxy: -540 },
    })
    expect(out).toContain('Server-render (#918): ~2786 (▲+312 vs yesterday)')
    expect(out).toContain('Legacy/untagged (apex proxy): ~9888 (▼-540 vs yesterday)')
  })
  it('omits the delta suffix when the cohort delta is null (first day / corrupt snapshot)', () => {
    const out = formatStatuslineTrafficSection({
      byPreset: { branded: 5 }, serverRenderTotal: 5, legacyProxy: 0, total: 5,
      delta: { serverRender: null, legacyProxy: null },
    })
    expect(out).toContain('Server-render (#918): ~5')
    expect(out).not.toContain('vs yesterday')
  })
  it('omits the legacy line entirely when there is no proxy traffic', () => {
    const out = formatStatuslineTrafficSection({ byPreset: { branded: 5, clickable: 0 }, serverRenderTotal: 5, legacyProxy: 0, total: 5 })
    expect(out).toContain('branded 5')
    expect(out).not.toContain('clickable')
    expect(out).not.toContain('apex proxy')
  })
  it('is empty when null/undefined or grand total is 0 (section skipped until adoption)', () => {
    expect(formatStatuslineTrafficSection(null)).toBe('')
    expect(formatStatuslineTrafficSection(undefined)).toBe('')
    expect(formatStatuslineTrafficSection({ byPreset: {}, serverRenderTotal: 0, legacyProxy: 0, total: 0 })).toBe('')
  })
})

describe('formatStatuslineDeltaSuffix (#944)', () => {
  it('▲ for positive, ▼ for negative (sign carried), ±0 for zero, empty for null', () => {
    expect(formatStatuslineDeltaSuffix(312)).toBe(' (▲+312 vs yesterday)')
    expect(formatStatuslineDeltaSuffix(-540)).toBe(' (▼-540 vs yesterday)')
    expect(formatStatuslineDeltaSuffix(0)).toBe(' (±0 vs yesterday)')
    expect(formatStatuslineDeltaSuffix(null)).toBe('')
    expect(formatStatuslineDeltaSuffix(undefined)).toBe('')
  })
})

describe('formatReferralLine (#842 — outbound referral evidence)', () => {
  const svcs = [makeSvc({ id: 'gemini', name: 'Gemini API' }), makeSvc({ id: 'openai', name: 'OpenAI API' })]
  it('renders total + top-3 destination breakdown (by name, count-desc)', () => {
    const line = formatReferralLine({ total: 5, byService: { gemini: 3, openai: 2 } }, svcs)
    expect(line).toBe('\n🔗 **Outbound Referrals**: 5 (Gemini API 3 · OpenAI API 2)')
  })
  it('falls back to the id when the service name is unknown', () => {
    expect(formatReferralLine({ total: 1, byService: { zzz: 1 } }, svcs)).toContain('zzz 1')
  })
  it('is empty until ≥1 click (null / 0 total)', () => {
    expect(formatReferralLine(null, svcs)).toBe('')
    expect(formatReferralLine(undefined, svcs)).toBe('')
    expect(formatReferralLine({ total: 0, byService: {} }, svcs)).toBe('')
  })
})

describe('formatPushLine (#815 — Tier-1 push observability)', () => {
  const minimal = { services: [makeSvc()], aiUsage: null, latencySnapshots: [], incidentCountToday: { newCount: 0, resolvedCount: 0 }, redditCount: 0 }
  it('renders the count line when pushes were delivered', () => {
    expect(formatPushLine(3)).toBe('\n📱 **Tier-1 Pushes Sent**: 3')
  })
  it('is empty on quiet days (0 / null / undefined) so the summary stays clean', () => {
    expect(formatPushLine(0)).toBe('')
    expect(formatPushLine(null)).toBe('')
    expect(formatPushLine(undefined)).toBe('')
  })
  it('appears in the full daily summary only when pushCount > 0', () => {
    expect(buildDailySummary({ ...minimal, pushCount: 2 })).toContain('📱 **Tier-1 Pushes Sent**: 2')
    expect(buildDailySummary({ ...minimal, pushCount: 0 })).not.toContain('Tier-1 Pushes Sent')
  })
})

describe('formatAccuracyLine (#827 Feature 1 — prediction accuracy)', () => {
  const minimal = { services: [makeSvc()], aiUsage: null, latencySnapshots: [], incidentCountToday: { newCount: 0, resolvedCount: 0 }, redditCount: 0 }
  const stats = (over: Partial<AccuracyStats> = {}): AccuracyStats => ({
    total: 4, accurate: 2, underPredicted: 1, overPredicted: 1, hitRate: 0.5, medianAbsErrorHours: 0.5, ...over,
  })

  it('renders a labeled block: header (count), on-target %, typical miss, bias', () => {
    const out = formatAccuracyLine(stats())
    expect(out).toContain('🎯 **AI Recovery Prediction Accuracy** (4 forecasts scored)')
    expect(out).toContain('On-target: 50% — actual recovery landed within the predicted time')
    expect(out).toContain('Typical miss: 30m off the estimate')
  })
  it('singularizes the header for a single forecast', () => {
    expect(formatAccuracyLine(stats({ total: 1, accurate: 1, underPredicted: 0, overPredicted: 0 }))).toContain('(1 forecast scored)')
  })
  it('formats miss <1h in minutes, ≥1h in hours (incl. the 1h boundary)', () => {
    expect(formatAccuracyLine(stats({ medianAbsErrorHours: 2.5 }))).toContain('Typical miss: 2.5h off the estimate')
    expect(formatAccuracyLine(stats({ medianAbsErrorHours: 1 }))).toContain('Typical miss: 1.0h off the estimate') // boundary: err===1 → hours
    expect(formatAccuracyLine(stats({ medianAbsErrorHours: 0.99 }))).toContain('Typical miss: 59m off the estimate')
  })
  it('reports directional bias in plain language (incl. all-accurate → balanced)', () => {
    expect(formatAccuracyLine(stats({ underPredicted: 3, overPredicted: 0 }))).toContain('Bias: under-estimates (incidents ran longer than predicted)')
    expect(formatAccuracyLine(stats({ underPredicted: 0, overPredicted: 3 }))).toContain('Bias: over-estimates (recovered faster than predicted)')
    expect(formatAccuracyLine(stats({ underPredicted: 1, overPredicted: 1 }))).toContain('Bias: balanced')
    expect(formatAccuracyLine(stats({ accurate: 4, underPredicted: 0, overPredicted: 0 }))).toContain('Bias: balanced')
  })
  it('is empty until the corpus has a predicted incident (omit, never "0%")', () => {
    expect(formatAccuracyLine(stats({ total: 0 }))).toBe('')
    expect(formatAccuracyLine(null)).toBe('')
    expect(formatAccuracyLine(undefined)).toBe('')
  })
  it('appears in the full daily summary only when total > 0', () => {
    expect(buildDailySummary({ ...minimal, accuracy: stats() })).toContain('AI Recovery Prediction Accuracy')
    expect(buildDailySummary({ ...minimal, accuracy: stats({ total: 0 }) })).not.toContain('AI Recovery Prediction Accuracy')
  })
})

describe('formatExtActivitySection (#837)', () => {
  it('renders polls (~, WAE estimate) + reports when both present', () => {
    const s = formatExtActivitySection({ polls: 4212, reports: 3 })
    expect(s).toContain('Chrome Extension')
    expect(s).toContain('~4212 status polls')
    expect(s).toContain('3 issue reports')
  })
  it('omits polls when the SQL API is unconfigured (polls null), shows reports only', () => {
    const s = formatExtActivitySection({ polls: null, reports: 2 })
    expect(s).not.toContain('status polls')
    expect(s).toContain('2 issue reports')
  })
  it('singular "report" for 1', () => {
    expect(formatExtActivitySection({ polls: null, reports: 1 })).toContain('1 issue report\n'.trim())
    expect(formatExtActivitySection({ polls: null, reports: 1 })).not.toContain('reports')
  })
  it('polls only when no reports', () => {
    const s = formatExtActivitySection({ polls: 10, reports: 0 })
    expect(s).toContain('~10 status polls')
    expect(s).not.toContain('report')
  })
  it('empty string when absent or both signals empty', () => {
    expect(formatExtActivitySection(null)).toBe('')
    expect(formatExtActivitySection(undefined)).toBe('')
    expect(formatExtActivitySection({ polls: null, reports: 0 })).toBe('')
  })
})

describe('formatAudienceLine (#842-B)', () => {
  const counts = (o: Partial<AudienceCounts>): AudienceCounts => ({
    total: 0, activeTotal: 0,
    bySource: { x: 0, search: 0, feed: 0, owned: 0, direct: 0, plugin: 0 },
    activeBySource: { x: 0, search: 0, feed: 0, owned: 0, direct: 0, plugin: 0 },
    ...o,
  })

  it('leads with the active-outage subset by source + total when an outage was viewed', () => {
    const line = formatAudienceLine(counts({
      total: 320, activeTotal: 240,
      bySource: { x: 210, search: 60, feed: 30, owned: 12, direct: 20, plugin: 0 },
      activeBySource: { x: 180, search: 40, feed: 15, owned: 8, direct: 5, plugin: 0 },
    }))
    expect(line).toContain('Outage Audience')
    expect(line).toContain('240 during outages')
    expect(line).toContain('X 180 · search 40 · feed 15 · owned 8 · direct 5') // #936 owned bucket rendered
    expect(line).toContain('320 total views')
  })

  it('drops zero buckets from the breakdown', () => {
    const line = formatAudienceLine(counts({
      total: 100, activeTotal: 100,
      bySource: { x: 100, search: 0, feed: 0, owned: 0, direct: 0, plugin: 0 },
      activeBySource: { x: 100, search: 0, feed: 0, owned: 0, direct: 0, plugin: 0 },
    }))
    expect(line).toContain('X 100')
    expect(line).not.toContain('search 0')
    expect(line).not.toContain('feed 0')
    expect(line).not.toContain('owned 0')
  })

  it('falls back to the general is-down audience when no active outage was viewed', () => {
    const line = formatAudienceLine(counts({
      total: 50, activeTotal: 0,
      bySource: { x: 10, search: 35, feed: 5, owned: 0, direct: 0, plugin: 0 },
    }))
    expect(line).toContain('is-down Audience')
    expect(line).toContain('50 views')
    expect(line).toContain('search 35')
    expect(line).toContain('no active outages')
  })

  it('returns empty (section omitted) when null or no views', () => {
    expect(formatAudienceLine(null)).toBe('')
    expect(formatAudienceLine(undefined)).toBe('')
    expect(formatAudienceLine(counts({ total: 0 }))).toBe('')
  })
})
