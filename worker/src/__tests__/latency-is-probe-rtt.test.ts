import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchAllServices } from '../services'
import { TEST_TIMEOUT_MS, mockKV, seededTracking, stubFetchFailingClaudePage, probeFixture } from './helpers/unreadable-source'

// #1633 — `latency` reaches /api/v1/status, services:latest and latency:24h straight from
// fetchAllServices' `raw`, so it is asserted there, on the real entry point.

afterEach(() => { vi.unstubAllGlobals() })

describe('fetchAllServices publishes probe RTT as latency, and nothing for an unprobed service (#1633)', () => {
  it('a probed service carries its latest RTT; a service read from a healthy status page but absent from the probe snapshot carries null', async () => {
    stubFetchFailingClaudePage()
    const kv = mockKV(seededTracking([]))
    const probes = probeFixture([
      { minAgo: 5, status: 401, rtt: 210 },
      { minAgo: 0, status: 401, rtt: 180 },
    ])

    const { raw, enriched } = await fetchAllServices(kv as unknown as KVNamespace, probes)
    const byId = (list: typeof raw, id: string) => list.find((s) => s.id === id)

    expect(byId(raw, 'claude')?.latency).toBe(180)
    // openai's page is read successfully (status-page timing WAS published here before #1633).
    expect(byId(raw, 'openai')?.status).toBe('operational')
    expect(byId(raw, 'openai')?.latency).toBeNull()
    expect(byId(raw, 'azureopenai')?.latency).toBeNull()
    expect(raw.filter((s) => s.id !== 'claude').every((s) => s.latency === null)).toBe(true)
    expect(byId(enriched, 'claude')?.latency).toBe(180)
  }, TEST_TIMEOUT_MS)

  it('the enriched cache fallback carries the fresh latency, not the cached snapshot\'s', async () => {
    stubFetchFailingClaudePage()
    // 412 = a status-page fetch time held by a services:latest snapshot written before #1633.
    const cached = { services: [{ id: 'claude', name: 'Claude API', provider: 'Anthropic', category: 'api', status: 'operational', latency: 412, uptime30d: 99.9, lastChecked: new Date().toISOString(), incidents: [] }] }
    const kv = mockKV({ ...seededTracking(['claude']), 'services:latest': JSON.stringify(cached) })
    const failing = probeFixture([
      { minAgo: 5, status: 0, rtt: -1 },
      { minAgo: 0, status: 0, rtt: -1 },
    ])

    const { raw, enriched } = await fetchAllServices(kv as unknown as KVNamespace, failing)

    // The premise: a fresh `degraded` over a cached `operational` is what takes the fallback branch.
    expect(raw.find((s) => s.id === 'claude')?.status).toBe('degraded')
    const claude = enriched.find((s) => s.id === 'claude')
    expect(claude?.status).toBe('operational')
    expect(claude?.latency).toBeNull()
  }, TEST_TIMEOUT_MS)
})
