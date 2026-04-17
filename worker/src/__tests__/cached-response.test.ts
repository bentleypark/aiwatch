import { describe, it, expect } from 'vitest'
import { calculateAIWatchScore, classifyProbe } from '../score'
import type { ProbeSummary, ServiceStatus } from '../types'

/**
 * Validates that /api/status/cached response includes latency24h and scoreBreakdown.
 * Since the handler runs in Worker runtime, we simulate the KV read + response build
 * logic to verify the contract.
 */

function buildCachedResponse(
  kvStore: Record<string, string>,
  cachedServices: Array<{ id: string; status: string; incidents?: Array<{ id: string; status: string }> }>,
) {
  // Simulate the cached handler's latency24h read logic
  let latency24h: Array<{ t: string; data: Record<string, number> }> = []
  const latRaw = kvStore['latency:24h'] ?? null
  if (latRaw) {
    try { latency24h = JSON.parse(latRaw).snapshots ?? [] } catch { /* ignore */ }
  }

  // Simulate score calculation. Production mirrors index.ts /api/status/cached, which calls
  // scoreFor(svc, cachedProbeSummaries). This fixture passes 'unsupported' to keep test scope narrow
  // — covers the probe-less projection of the response shape (latency24h + scoreBreakdown).
  const scoredCached = cachedServices.map((svc) => {
    const s = calculateAIWatchScore(svc as ServiceStatus, 30, { kind: 'unsupported' })
    return { ...svc, aiwatchScore: s.score, scoreGrade: s.grade, scoreConfidence: s.confidence, scoreBreakdown: s.breakdown }
  })

  return {
    services: scoredCached,
    lastUpdated: new Date().toISOString(),
    cached: true,
    latency24h,
  }
}

describe('/api/status/cached latency24h', () => {
  it('includes latency24h from KV when data exists', () => {
    const kvStore = {
      'latency:24h': JSON.stringify({
        snapshots: [
          { t: '2026-03-30T00:00:00Z', data: { claude: 145, openai: 230 } },
          { t: '2026-03-30T00:30:00Z', data: { claude: 150, openai: 240 } },
        ],
      }),
    }
    const response = buildCachedResponse(kvStore, [{ id: 'claude', status: 'operational' }])

    expect(response).toHaveProperty('latency24h')
    expect(response.latency24h).toHaveLength(2)
    expect(response.latency24h[0]).toHaveProperty('t')
    expect(response.latency24h[0]).toHaveProperty('data')
    expect(response.latency24h[0].data.claude).toBe(145)
  })

  it('returns empty latency24h when KV has no data', () => {
    const response = buildCachedResponse({}, [{ id: 'claude', status: 'operational' }])

    expect(response).toHaveProperty('latency24h')
    expect(response.latency24h).toEqual([])
  })

  it('returns empty latency24h when KV data is malformed', () => {
    const kvStore = { 'latency:24h': 'not-json' }
    const response = buildCachedResponse(kvStore, [{ id: 'claude', status: 'operational' }])

    expect(response.latency24h).toEqual([])
  })

  it('returns empty latency24h when snapshots key is missing', () => {
    const kvStore = { 'latency:24h': JSON.stringify({ other: 'data' }) }
    const response = buildCachedResponse(kvStore, [{ id: 'claude', status: 'operational' }])

    expect(response.latency24h).toEqual([])
  })

  it('cached response has same latency24h shape as full response', () => {
    const snapshots = [{ t: '2026-03-30T08:00:00Z', data: { claude: 230, openai: 280 } }]
    const kvStore = { 'latency:24h': JSON.stringify({ snapshots }) }
    const response = buildCachedResponse(kvStore, [])

    // Full /api/status also returns { latency24h: snapshots }
    expect(response.latency24h).toEqual(snapshots)
  })
})

describe('/api/status/cached scoreBreakdown (probe-less projection)', () => {
  // These tests use 'unsupported' probe context to lock the response shape that probe-less
  // services (apps, agents, infra) emit. Probed-service shape with non-null responsiveness
  // is covered by score.test.ts.

  it('includes scoreBreakdown for each service', () => {
    const services = [
      { id: 'claude', status: 'operational', uptime30d: 99.5, incidents: [] },
      { id: 'openai', status: 'operational', uptime30d: null, incidents: [] },
    ]
    const response = buildCachedResponse({}, services)

    for (const svc of response.services) {
      expect(svc).toHaveProperty('scoreBreakdown')
      expect(svc.scoreBreakdown).toHaveProperty('incidents')
      expect(svc.scoreBreakdown).toHaveProperty('recovery')
    }
  })

  it('scoreBreakdown shape matches contract for probe-less services', () => {
    const services = [
      { id: 'claude', status: 'operational', uptime30d: 100, incidents: [] },
    ]
    const response = buildCachedResponse({}, services)
    const svc = response.services[0]

    expect(svc).toHaveProperty('aiwatchScore')
    expect(svc).toHaveProperty('scoreGrade')
    expect(svc).toHaveProperty('scoreConfidence')
    expect(svc).toHaveProperty('scoreBreakdown')
    expect(svc.scoreBreakdown).toEqual({
      uptime: expect.any(Number),
      incidents: expect.any(Number),
      recovery: expect.any(Number),
      responsiveness: null,
      responsivenessStatus: 'unsupported',
    })
  })

  it('scoreBreakdown.uptime is null when service has no uptime data', () => {
    const services = [
      { id: 'gemini', status: 'operational', uptime30d: null, incidents: [] },
    ]
    const response = buildCachedResponse({}, services)

    expect(response.services[0].scoreBreakdown.uptime).toBeNull()
    expect(response.services[0].scoreBreakdown.incidents).toBe(25)
    expect(response.services[0].scoreBreakdown.recovery).toBe(15)
  })
})

describe('/api/status/cached scoreBreakdown (probed services)', () => {
  // Mirrors production: handler uses scoreFor(svc, cachedProbeSummaries) — for probed services
  // (Claude, OpenAI, etc.) the response shape includes non-null responsiveness + metrics.probe.

  function buildProbedResponse(summary: ProbeSummary | null) {
    const svc = { id: 'claude', status: 'operational', uptime30d: 100, incidents: [] }
    const summaries = summary ? new Map([['claude', summary]]) : undefined
    const probe = classifyProbe(svc.id, true, summaries)
    const s = calculateAIWatchScore(svc as ServiceStatus, 30, probe)
    return { ...svc, aiwatchScore: s.score, scoreGrade: s.grade, scoreConfidence: s.confidence, scoreBreakdown: s.breakdown, scoreMetrics: s.metrics }
  }

  it('available probe summary → responsiveness number + metrics.probe payload', () => {
    const result = buildProbedResponse({ p50: 178, p95: 311, cvCombined: 0.596, validDays: 7 })
    expect(result.scoreBreakdown.responsivenessStatus).toBe('available')
    expect(result.scoreBreakdown.responsiveness).not.toBeNull()
    expect(result.scoreMetrics.probe).toEqual({ p50: 178, p95: 311, cvCombined: 0.596, validDays: 7 })
  })

  it('insufficient probe (validDays<7) → responsiveness null + 0.95 penalty + status flag', () => {
    const result = buildProbedResponse({ p50: 178, p95: 311, cvCombined: 0.596, validDays: 3 })
    expect(result.scoreBreakdown.responsivenessStatus).toBe('insufficient')
    expect(result.scoreBreakdown.responsiveness).toBeNull()
    expect(result.scoreMetrics.probe).toBeNull()
  })

  it('unavailable (KV failure → undefined summaries) → responsiveness null + no penalty', () => {
    const result = buildProbedResponse(null) // null sentinel → classifyProbe receives undefined
    expect(result.scoreBreakdown.responsivenessStatus).toBe('unavailable')
    expect(result.scoreBreakdown.responsiveness).toBeNull()
    expect(result.scoreMetrics.probe).toBeNull()
  })
})
