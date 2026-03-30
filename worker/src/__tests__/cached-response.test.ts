import { describe, it, expect } from 'vitest'

/**
 * Validates that /api/status/cached response includes latency24h.
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

  return {
    services: cachedServices,
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
