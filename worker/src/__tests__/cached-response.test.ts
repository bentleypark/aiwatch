import { describe, it, expect } from 'vitest'
import { calculateAIWatchScore } from '../score'
import type { ServiceStatus } from '../types'

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

  // Simulate score calculation (mirrors index.ts /api/status/cached handler)
  const scoredCached = cachedServices.map((svc) => {
    const s = calculateAIWatchScore(svc as ServiceStatus)
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

describe('/api/status/cached scoreBreakdown', () => {
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

  it('scoreBreakdown matches full /api/status contract', () => {
    const services = [
      { id: 'claude', status: 'operational', uptime30d: 100, incidents: [] },
    ]
    const response = buildCachedResponse({}, services)
    const svc = response.services[0]

    // Full response includes: aiwatchScore, scoreGrade, scoreConfidence, scoreBreakdown
    expect(svc).toHaveProperty('aiwatchScore')
    expect(svc).toHaveProperty('scoreGrade')
    expect(svc).toHaveProperty('scoreConfidence')
    expect(svc).toHaveProperty('scoreBreakdown')
    expect(svc.scoreBreakdown).toEqual({ uptime: expect.any(Number), incidents: expect.any(Number), recovery: expect.any(Number) })
  })

  it('scoreBreakdown.uptime is null when service has no uptime data', () => {
    const services = [
      { id: 'gemini', status: 'operational', uptime30d: null, incidents: [] },
    ]
    const response = buildCachedResponse({}, services)

    expect(response.services[0].scoreBreakdown.uptime).toBeNull()
    expect(response.services[0].scoreBreakdown.incidents).toBe(30) // full score, 0 affected days
    expect(response.services[0].scoreBreakdown.recovery).toBe(20) // full score, no incidents
  })
})
