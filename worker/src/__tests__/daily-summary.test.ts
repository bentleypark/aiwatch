import { describe, it, expect } from 'vitest'
import { formatFeedClientLine, formatSubscribedFeedsLine, buildDailySummary, computeLatencyAvg, isInSummaryWindow, formatDegradationSection, formatV1TrafficSection, classifyDegradation, formatSubscriberDelta, formatFeedTrafficSection, formatBadgeTrafficSection, formatExtActivitySection, formatStatuslineTrafficSection, formatStatuslineDeltaSuffix, formatPluginTrafficSection, formatPushLine, formatAccuracyLine, formatReferralLine, formatAudienceLine, formatAiUsageSection } from '../daily-summary'
import { BADGE_UNKNOWN_SERVICE } from '../api-traffic'
import type { ServiceStatus } from '../types'
import type { AccuracyStats } from '../incident-history'
import { AUDIENCE_SOURCES, type AudienceCounts, type AudienceSource } from '../outage-audience'

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
    expect(result).toContain('$0.009')
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

describe('formatFeedClientLine (#1273)', () => {
  it('prints no residual when the breakdown exceeds the total', () => {
    // An inconsistent triple cannot arise from `parseFeedTrafficResponse` (the `counted` gate makes
    // buckets a subset of the totals), but this function is exported and takes all three freely. The
    // `> 0` guard is what stops a negative residual rendering; `!== 0` would print `-30 unclassified`.
    expect(formatFeedClientLine({ slack: 40 }, 10, {})).toBe('\n   Clients: slack 40')
  })

  it('prints no unserved term for a negative unserved count', () => {
    // The same argument one line up in the source, on the guard one line up — which was the only one
    // of the pair with no test, so `unservedTotal > 0` → `!== 0` survived the whole suite.
    //
    // `classified` has to exceed `total` by at least the negative unserved amount, or `unclassified`
    // (`total - classified - unservedTotal`) turns POSITIVE and its own term fires instead — which is
    // a different guard, and an assertion that trips it proves nothing about this one.
    expect(formatFeedClientLine({ slack: 10 }, 0, { bot: -5 })).toBe('\n   Clients: slack 10')
  })

  it('prints both residual terms when both are real, so neither absorbs the other', () => {
    // 100 polls: 40 classified, 25 to a feed we do not serve, 35 carrying no client blob. One label
    // for the last two would make the arithmetic unreadable, which is why they are separate terms.
    expect(formatFeedClientLine({ slack: 40 }, 100, { bot: 25 }))
      .toBe('\n   Clients: slack 40 · 25 unserved · 35 unclassified')
  })
})

describe('formatSubscribedFeedsLine (#1273)', () => {
  // Direct tests: this function is exported but was reached only through formatFeedTrafficSection,
  // and every render fixture there had belowFloor === 0 — so six independent mutations of the
  // below-floor term passed the whole suite. The signal was computed right and rendered by
  // untested code.
  const slack = (n: number) => ({ slack: n })

  it('names suppressed feeds so "0 per-service" cannot read as a quiet window', () => {
    expect(formatSubscribedFeedsLine({ claude: slack(2), chatgpt: slack(1) }))
      .toBe('\n   Feeds: 0 per-service subscribed · 2 below floor')
  })

  it('renders nothing at all when nothing QUALIFIED', () => {
    expect(formatSubscribedFeedsLine({})).toBe('')
    expect(formatSubscribedFeedsLine({ hf: { bot: 90 } })).toBe('')
  })

  it('carries the note alongside a non-empty per-service list', () => {
    expect(formatSubscribedFeedsLine({ claude: slack(72), mistral: slack(2) }))
      .toBe('\n   Feeds: 1 per-service subscribed (claude) · 1 below floor')
  })

  it('never prints a zero note', () => {
    expect(formatSubscribedFeedsLine({ claude: slack(72) })).toBe('\n   Feeds: 1 per-service subscribed (claude)')
  })

  it('keeps the all-feed OUT of both the count and the floor note', () => {
    // The operator holds exactly one subscription and it is this one. Counting it below the floor
    // re-merges the split the separation exists to keep.
    expect(formatSubscribedFeedsLine({ __all__: slack(2) })).toBe('')
    expect(formatSubscribedFeedsLine({ __all__: slack(77), claude: slack(72) }))
      .toBe('\n   Feeds: 1 per-service subscribed (claude) · all-feed active')
  })

  it('excludes unserved URLs from the floor note', () => {
    // A 404 wave of low-volume /feed/<random> hits would otherwise inflate the one number added to
    // keep "0 per-service" honest — in the direction that most looks like growth.
    expect(formatSubscribedFeedsLine({ __unknown__: slack(1) })).toBe('')
  })
})

describe('formatFeedTrafficSection (#548, #1273)', () => {
  // Shorthand: one feed polled only by `slack`.
  const slack = (n: number) => ({ slack: n })

  it('renders the 24h total with the all-vs-per-service split', () => {
    const out = formatFeedTrafficSection({ all: 120, service: 45, total: 165, byFeed: {} })
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
    const out = formatFeedTrafficSection({ all: 64, service: 7, total: 71, byFeed: {}, newItems: 2 })
    expect(out).toContain('Last 24h: 71 polls (all-feed 64 · per-service ~7) · 2 new items')
  })
  it('uses the singular "item" for a count of 1', () => {
    const one = { all: 1, service: 0, total: 1, byFeed: {}, newItems: 1 }
    expect(formatFeedTrafficSection(one)).toContain('· 1 new item')
    expect(formatFeedTrafficSection(one)).not.toContain('1 new items')
  })
  it('shows "· 0 new items" on a quiet day (count present but zero)', () => {
    expect(formatFeedTrafficSection({ all: 30, service: 0, total: 30, byFeed: {}, newItems: 0 })).toContain('· 0 new items')
  })
  it('omits the suffix entirely when newItems is absent (KV read failed)', () => {
    const out = formatFeedTrafficSection({ all: 30, service: 0, total: 30, byFeed: {} })
    expect(out).toContain('Last 24h: 30 polls')
    expect(out).not.toContain('new item')
  })

  // #1273 — the client split. Without it a crawler sweep and a subscriber both just raise `total`.
  it('rolls the nested map up into the client split, ordered by count desc', () => {
    // Steady state: every request contributes to a variant total AND a byFeed bucket, so the two
    // must balance. 77 + 72 + 24 = 173.
    const out = formatFeedTrafficSection({
      all: 77, service: 96, total: 173,
      byFeed: { __all__: slack(77), claude: slack(72), huggingface: { bot: 24 } },
    })
    expect(out).toContain('Clients: slack 149 · bot 24')
    expect(out).not.toContain('unclassified')
  })

  it('names UNSERVED (404) separately from UNCLASSIFIED — they are different facts', () => {
    // `rollupByClient` drops the `__unknown__` bucket, so the gap it leaves is traffic the handler
    // does not serve. One label cannot say both that and "instrumentation has not caught up".
    const out = formatFeedTrafficSection({
      all: 0, service: 162, total: 162,
      byFeed: { __unknown__: slack(90), claude: slack(72) },
    })
    expect(out).toContain('Clients: slack 72 · 90 unserved')
    expect(out).not.toContain('90 unclassified')
  })

  it('names both terms when a deploy-boundary window ALSO carries 404 traffic', () => {
    const out = formatFeedTrafficSection({
      all: 0, service: 200, total: 200,
      byFeed: { __unknown__: slack(20), claude: slack(72) },
    })
    // 200 total − 72 classified − 20 unserved = 108 rows with no client blob at all.
    expect(out).toContain('Clients: slack 72 · 20 unserved · 108 unclassified')
  })

  it('names the residual when the breakdown sums to LESS than the total (deploy-boundary window)', () => {
    // Rows written before #1273 carry no client blob: they count toward the total and toward no
    // class. Printing a smaller breakdown under a bigger total with no residual reads as a bug, or
    // worse as a measured absence. This is the one-time transient the deploy day produces.
    const out = formatFeedTrafficSection({
      all: 77, service: 508, total: 585,
      byFeed: { __all__: slack(77), claude: slack(72), huggingface: { bot: 24 } },
    })
    expect(out).toContain('Clients: slack 149 · bot 24 · 412 unclassified')
  })
  it('breaks client ties on the class name so the line is stable across runs', () => {
    const out = formatFeedTrafficSection({ all: 0, service: 8, total: 8, byFeed: { a: { slack: 4 }, b: { bot: 4 } } })
    expect(out).toContain('Clients: bot 4 · slack 4')
  })
  it('renders exactly the pre-#1273 section when nothing was classified', () => {
    // A window that predates the deploy has no blob2/blob3, so byFeed is empty — both added lines
    // must vanish rather than render empty labels.
    const out = formatFeedTrafficSection({ all: 30, service: 0, total: 30, byFeed: {} })
    expect(out).not.toContain('Clients')
    expect(out).not.toContain('Feeds:')
    expect(out).toContain('Last 24h: 30 polls')
  })

  // #1273 — the subscribed-feeds line: the one signal here that needs no cadence divisor.
  it('counts per-service feeds and reports the all-feed SEPARATELY, never inside the count', () => {
    // The operator holds exactly one subscription and it is the all-feed, so folding it into the
    // headline publishes an adoption number that is +1 by construction.
    const out = formatFeedTrafficSection({
      all: 77, service: 432, total: 509,
      byFeed: {
        __all__: slack(77), claude: slack(72), chatgpt: slack(72), openai: slack(72),
        codex: slack(72), gemini: slack(72), cursor: slack(72),
      },
    })
    expect(out).toContain('Feeds: 6 per-service subscribed (chatgpt, claude, codex, cursor, gemini, openai)')
    expect(out).toContain('· all-feed active')
    // The raw sentinel must never reach Discord — `__x__` also renders as underline there.
    expect(out).not.toContain('__all__')
  })

  it('reports 0 per-service when only the operator all-feed qualifies', () => {
    const out = formatFeedTrafficSection({ all: 77, service: 0, total: 77, byFeed: { __all__: slack(77) } })
    expect(out).toContain('Feeds: 0 per-service subscribed (all-feed active)')
  })

  it('never renders the __unknown__ sentinel as a subscribed feed', () => {
    const out = formatFeedTrafficSection({
      all: 0, service: 162, total: 162,
      byFeed: { __unknown__: slack(90), claude: slack(72) },
    })
    expect(out).toContain('Feeds: 1 per-service subscribed (claude)')
    expect(out).not.toContain('__unknown__')
    // Unserved traffic is excluded from the client rollup too, so it surfaces under its own label
    // rather than inflating `Clients: slack` with requests the handler never served.
    expect(out).toContain('Clients: slack 72 · 90 unserved')
  })
  it('EXCLUDES crawler-only feeds from the subscribed count', () => {
    // The regression this line exists to prevent: a crawler sweeping every feed must not read as a
    // subscription wave. Only the slack-polled feed counts.
    const out = formatFeedTrafficSection({
      all: 0, service: 100, total: 100,
      byFeed: { claude: slack(72), huggingface: { bot: 24 }, mistral: { bot: 4 } },
    })
    expect(out).toContain('Feeds: 1 per-service subscribed (claude)')
    expect(out).not.toContain('huggingface')
  })
  it('still reports a window whose ONLY traffic was unserved', () => {
    // The early return suppressed the `unserved` term in exactly the case it exists for: an unserved
    // wave large enough to BE the window rendered as nothing at all, which reads as a quiet day.
    const out = formatFeedTrafficSection({ all: 0, service: 50, total: 50, byFeed: { __unknown__: { bot: 50 } } })
    expect(out.trimEnd().endsWith('Clients: — · 50 unserved')).toBe(true)
  })

  it('omits the line entirely when only crawlers polled (never "0 subscribed")', () => {
    const out = formatFeedTrafficSection({ all: 0, service: 28, total: 28, byFeed: { a: { bot: 28 } } })
    expect(out).not.toContain('Feeds:')
    expect(out).toContain('Clients: bot 28')
  })
  it('caps the name list and reports the remainder', () => {
    const byFeed = Object.fromEntries(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((k, i) => [k, { slack: 100 - i }]),
    )
    const out = formatFeedTrafficSection({ all: 0, service: 772, total: 772, byFeed })
    expect(out).toContain('Feeds: 8 per-service subscribed (a, b, c, d, e, f, +2 more)')
  })
})

describe('formatBadgeTrafficSection (#1157)', () => {
  it('renders the 24h total with the top-3 requested services', () => {
    const out = formatBadgeTrafficSection({ byService: { claude: 12, openai: 5, gemini: 2, grok: 1 }, total: 20 })
    expect(out).toContain('Badge Requests')
    expect(out).toContain('Last 24h: 20')
    expect(out).toContain('claude 12 · openai 5 · gemini 2') // top-3 by count, grok (4th) excluded
  })
  it('returns empty string when badge traffic is unavailable (SQL API not configured)', () => {
    expect(formatBadgeTrafficSection(null)).toBe('')
    expect(formatBadgeTrafficSection(undefined)).toBe('')
  })
  it('returns empty string on a zero-request day', () => {
    expect(formatBadgeTrafficSection({ byService: {}, total: 0 })).toBe('')
  })
  it('omits the parenthesized breakdown when byService is empty but total is somehow positive', () => {
    const out = formatBadgeTrafficSection({ byService: {}, total: 3 })
    expect(out).toBe('\n🖼️ **Badge Requests**\n   Last 24h: 3')
  })
  it('excludes BADGE_UNKNOWN_SERVICE from the top-3 ranking and reports it as a separate suffix', () => {
    const out = formatBadgeTrafficSection({ byService: { claude: 12, [BADGE_UNKNOWN_SERVICE]: 999, openai: 5 }, total: 1016 })
    expect(out).toContain('Last 24h: 1016 (claude 12 · openai 5) · 999 unknown-id')
    expect(out).not.toContain('__unknown__')
  })
  it('omits the unknown-id suffix when there are no misses', () => {
    const out = formatBadgeTrafficSection({ byService: { claude: 12 }, total: 12 })
    expect(out).not.toContain('unknown-id')
  })
  it('excludes zero-count entries from the top-3 slice', () => {
    const out = formatBadgeTrafficSection({ byService: { claude: 5, openai: 0 }, total: 5 })
    expect(out).toContain('(claude 5)')
    expect(out).not.toContain('openai')
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
    const out = buildDailySummary({
      ...base,
      feedTraffic: { all: 10, service: 5, total: 15, byFeed: { __all__: { slack: 10 }, claude: { slack: 5 } } },
    })
    expect(out).toContain('📡 **Feed Polls (RSS/Slack)**')
    expect(out).toContain('Last 24h: 15')
    // #1273 — pins buildDailySummary's OWN data→output wiring for the client split, not just the
    // formatter's: a section can be correct in isolation and never reach the message.
    expect(out).toContain('Clients: slack 15')
    expect(out).toContain('Feeds: 1 per-service subscribed (claude)')
  })
  // #1157 — pins buildDailySummary's OWN data→output contract for badgeTraffic (already covered by
  // formatBadgeTrafficSection's unit tests above, but this confirms the `data.badgeTraffic` field is
  // actually read and threaded to the formatter inside buildDailySummary). NOTE: this does NOT cover
  // the index.ts cron-assembly call site — see the source-scan test below for that; a dropped
  // `badgeTraffic,` there (a real bug this PR shipped, caught only via PR review) leaves THIS test
  // green, because it constructs its own literal rather than exercising index.ts's object literal.
  it('renders the badge-request section when badgeTraffic is present (#1157)', () => {
    const out = buildDailySummary({ ...base, badgeTraffic: { byService: { claude: 7 }, total: 7 } })
    expect(out).toContain('🖼️ **Badge Requests**')
    expect(out).toContain('Last 24h: 7')
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
  // #1055 — build the per-source map from AUDIENCE_SOURCES rather than a literal, so widening the
  // bucket enum doesn't require editing every fixture below (it widened by 3 here). Callers pass only
  // the buckets they care about; the rest zero-fill.
  const src = (o: Partial<Record<AudienceSource, number>> = {}): Record<AudienceSource, number> =>
    Object.fromEntries(AUDIENCE_SOURCES.map((s) => [s, o[s] ?? 0])) as Record<AudienceSource, number>

  const counts = (o: Partial<AudienceCounts>): AudienceCounts => ({
    total: 0, activeTotal: 0,
    bySource: src(),
    activeBySource: src(),
    ...o,
  })

  it('leads with the active-outage subset by source + total when an outage was viewed', () => {
    const line = formatAudienceLine(counts({
      total: 320, activeTotal: 240,
      bySource: src({ x: 210, search: 60, feed: 30, owned: 12, direct: 20 }),
      activeBySource: src({ x: 180, search: 40, feed: 15, owned: 8, direct: 5 }),
    }))
    expect(line).toContain('Outage Audience')
    expect(line).toContain('240 during outages')
    expect(line).toContain('X 180 · search 40 · feed 15 · owned 8 · direct 5') // #936 owned bucket rendered
    expect(line).toContain('320 total views')
  })

  it('renders the #1055 buckets with their operator labels', () => {
    // The labels are the ONLY surface a human reads, and nothing else asserts them: with every
    // fixture zero-filling the new buckets, mislabelling `refhost` as "direct" would restore exactly
    // the ambiguity #1055 removes and no test would notice.
    const line = formatAudienceLine(counts({
      total: 15, activeTotal: 15,
      activeBySource: src({ reddit: 5, hn: 3, refhost: 7 }),
    }))
    expect(line).toContain('Reddit 5')
    expect(line).toContain('HN 3')
    expect(line).toContain('other-ref 7')
    expect(line).not.toContain('direct') // refhost must NOT read as direct
  })

  it('drops zero buckets from the breakdown', () => {
    const line = formatAudienceLine(counts({
      total: 100, activeTotal: 100,
      bySource: src({ x: 100 }),
      activeBySource: src({ x: 100 }),
    }))
    expect(line).toContain('X 100')
    expect(line).not.toContain('search 0')
    expect(line).not.toContain('feed 0')
    expect(line).not.toContain('owned 0')
  })

  it('falls back to the general is-down audience when no active outage was viewed', () => {
    const line = formatAudienceLine(counts({
      total: 50, activeTotal: 0,
      bySource: src({ x: 10, search: 35, feed: 5 }),
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

// ── #955: AI usage section ──

describe('formatAiUsageSection', () => {
  it('returns empty string when nothing ran', () => {
    expect(formatAiUsageSection(null)).toBe('')
    expect(formatAiUsageSection({ calls: 0, success: 0, failed: 0 })).toBe('')
  })

  it('renders succeeded/attempted per model', () => {
    const out = formatAiUsageSection({ calls: 10, success: 8, failed: 2, gemma: 7, sonnet: 1, gemmaAttempts: 10, sonnetAttempts: 3 })
    expect(out).toContain('10 calls (8 success, 2 failed)')
    expect(out).toContain('(Gemma: 7/10, Sonnet: 1/3)')
    expect(out).toContain('$0.009')
  })

  it('surfaces timeouts as their own outcome', () => {
    const out = formatAiUsageSection({ calls: 5, success: 3, failed: 1, timedOut: 1, gemma: 3, gemmaAttempts: 5 })
    expect(out).toContain('3 success, 1 failed, 1 timed out')
  })

  // The whole point of the attempt counters: a fallback that is always reached and never
  // succeeds is broken, not unlucky. `Sonnet: 0` alone could never say that.
  it('warns when Sonnet is attempted but never succeeds', () => {
    const out = formatAiUsageSection({ calls: 16, success: 9, failed: 7, gemma: 9, sonnet: 0, gemmaAttempts: 16, sonnetAttempts: 7 })
    expect(out).toContain('⚠️ Sonnet fallback: 7 attempts, 0 successes')
  })

  it('stays quiet when Sonnet was never reached', () => {
    const out = formatAiUsageSection({ calls: 9, success: 9, failed: 0, gemma: 9, gemmaAttempts: 9 })
    expect(out).not.toContain('⚠️')
  })

  it('renders a pre-#955 counter payload without attempt counts', () => {
    const out = formatAiUsageSection({ calls: 5, success: 4, failed: 1, gemma: 3, sonnet: 1 })
    expect(out).toContain('(Gemma: 3, Sonnet: 1)')
    expect(out).not.toContain('/')
  })
})

describe('#820 Reddit source-dead warning', () => {
  const base = {
    services: [makeSvc({ id: 'a', name: 'Svc A' })],
    aiUsage: null,
    latencySnapshots: [],
    incidentCountToday: { newCount: 0, resolvedCount: 0 },
  }

  it('replaces the post count with a DOWN warning when the source is blocked', () => {
    const out = buildDailySummary({ ...base, redditCount: 0, redditSourceDead: { reason: 'block', at: Date.now() } })
    expect(out).toContain('Reddit source DOWN')
    expect(out).toContain('detection is dark')
    expect(out).not.toContain('posts detected')
  })

  it('the warning outranks a stale non-zero count', () => {
    // `reddit:seen:*` keys live 24h, so a source that dies at noon still shows a real count.
    // Printing it would read as health on the very day detection went dark.
    const out = buildDailySummary({ ...base, redditCount: 3, redditSourceDead: { reason: 'block', at: Date.now() } })
    expect(out).toContain('Reddit source DOWN')
    expect(out).not.toContain('3 posts detected')
  })

  it('carries the reason — a block and an unreachable streak need different remediations', () => {
    const blocked = buildDailySummary({ ...base, redditCount: 0, redditSourceDead: { reason: 'block', at: Date.now() } })
    expect(blocked).toContain('block status')
    const streak = buildDailySummary({ ...base, redditCount: 0, redditSourceDead: { reason: 'streak', at: Date.now() } })
    // Must not assert a single confident cause — a real egress problem, a 200 bot wall, and
    // sustained Reddit rate-limiting (#820 round 3) all land on this same reason.
    expect(streak).toContain('no subreddit returned a usable response')
    expect(streak).toContain('rate-limiting')
    const partial = buildDailySummary({ ...base, redditCount: 0, redditSourceDead: { reason: 'partial', at: Date.now() } })
    expect(partial).toContain('partly dark')
  })

  it('#820 round 1 — throttled gets a distinct, quieter line, not the "source DOWN" alarm', () => {
    // Reddit rate-limits ~85% of requests against the shared Cloudflare egress-IP pool as a matter
    // of course (measured live) — alarming on that every run trains the operator to stop reading
    // this line, exactly the failure #820 exists to prevent one layer up.
    const out = buildDailySummary({ ...base, redditCount: 0, redditSourceDead: { reason: 'throttled', at: Date.now() } })
    expect(out).toContain('rate-limited')
    expect(out).toContain('429')
    expect(out).not.toContain('Reddit source DOWN')
  })

  it('throttled with a non-zero redditCount appends the "still detected today" count — round 5 coverage', () => {
    // Every prior throttled test used redditCount: 0. A plausible, even common, production
    // combination — a daily-accumulated reddit:seen:* count from an earlier successful run
    // coexisting with a later throttled run — had no test proving the count suffix actually renders.
    const withCount = buildDailySummary({ ...base, redditCount: 7, redditSourceDead: { reason: 'throttled', at: Date.now() } })
    expect(withCount).toContain('7 posts still detected today')
    const withoutCount = buildDailySummary({ ...base, redditCount: 0, redditSourceDead: { reason: 'throttled', at: Date.now() } })
    expect(withoutCount).not.toContain('posts still detected today')
  })

  it('renders the age it is given — the writer preserving the true start is pinned in reddit.test.ts', () => {
    // `markRedditSourceDead` carries the original `at` forward across hourly re-marks, so these
    // ages are reachable in production rather than fixture-only.
    const hourAgo = buildDailySummary({ ...base, redditCount: 0, redditSourceDead: { reason: 'block', at: Date.now() - 3600_000 } })
    expect(hourAgo).toContain('for 1h')
    const dayAgo = buildDailySummary({ ...base, redditCount: 0, redditSourceDead: { reason: 'block', at: Date.now() - 26 * 3600_000 } })
    expect(dayAgo).toContain('for 1d+')
  })

  it('an UNKNOWN health read warns rather than reporting health', () => {
    // A KV failure must not render as a quiet day — that is #820 one layer up.
    const out = buildDailySummary({ ...base, redditCount: 0, redditSourceDead: 'unknown' })
    expect(out).toContain('health UNKNOWN')
    expect(out).not.toContain('posts detected')
  })

  it('a healthy source keeps the ordinary count line and never warns', () => {
    const out = buildDailySummary({ ...base, redditCount: 4, redditSourceDead: null })
    expect(out).toContain('4 posts detected')
    expect(out).not.toContain('Reddit source DOWN')
  })

  it('an absent field is healthy — the warning must not fire on legacy callers', () => {
    const out = buildDailySummary({ ...base, redditCount: 2 })
    expect(out).toContain('2 posts detected')
    expect(out).not.toContain('Reddit source DOWN')
  })
})
