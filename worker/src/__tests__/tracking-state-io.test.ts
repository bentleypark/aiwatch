import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchAllServices, SERVICES } from '../services'

// #1224 — the whole point of the consolidated `tracking:state` blob is that `fetchAllServices` costs
// exactly ONE real KV read and AT MOST one real KV write per invocation, independent of how many of
// the 45 services actually changed tracking state. This file pins that contract directly, since
// round 2's review found it was previously unverifiable (an isolate-local cache's effectiveness
// depended on production traffic topology this repo cannot observe) and round 3 replaced the
// mechanism specifically to make it a structural guarantee instead of a measured hope.
//
// Real timers throughout (not fake): `fetchAllServices` fans out to all 45 real SERVICES, and a
// stubbed `fetch` that throws still exercises `fetchWithRetry`'s real 1s backoff per URL, so each
// case here genuinely takes several real seconds — hence the explicit 30s timeouts below.

const TEST_TIMEOUT_MS = 30_000

function trackingMockKV(seed: Record<string, string> = {}) {
  const store: Record<string, string> = { ...seed }
  return {
    store,
    get: vi.fn(async (k: string) => store[k] ?? null),
    put: vi.fn(async (k: string, v: string) => { store[k] = v }),
    delete: vi.fn(async (k: string) => { delete store[k] }),
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchAllServices tracking-state I/O contract (#1224)', () => {
  it('issues exactly one tracking:state read, regardless of the 45-service fan-out', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    const kv = trackingMockKV()

    await fetchAllServices(kv as unknown as KVNamespace)

    const trackingGets = kv.get.mock.calls.filter((c) => c[0] === 'tracking:state')
    expect(trackingGets.length).toBe(1)
  }, TEST_TIMEOUT_MS)

  it('issues at most one tracking:state write per invocation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    const kv = trackingMockKV()

    await fetchAllServices(kv as unknown as KVNamespace)

    const trackingPuts = kv.put.mock.calls.filter((c) => c[0] === 'tracking:state')
    expect(trackingPuts.length).toBeLessThanOrEqual(1)
  }, TEST_TIMEOUT_MS)

  it('writes the blob once when a network-down cycle books fetch failures for the services that use this tracking path', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    const kv = trackingMockKV()

    await fetchAllServices(kv as unknown as KVNamespace)

    const trackingPuts = kv.put.mock.calls.filter((c) => c[0] === 'tracking:state')
    expect(trackingPuts.length).toBe(1) // every failing service just changed state for the first time
    const written = JSON.parse(trackingPuts[0][1])
    expect(Object.keys(written).length).toBeGreaterThan(0)
  }, TEST_TIMEOUT_MS)

  it('reads and writes exactly once even when the blob starts non-empty', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    // Pre-seed the blob as if a previous cycle already booked a service's first failure — pins that
    // the 1-read/≤1-write counts hold starting from a non-empty blob too, not just from {}.
    const kv = trackingMockKV({ 'tracking:state': JSON.stringify({ claude: { failCount: 1, failCountAt: new Date().toISOString() } }) })

    await fetchAllServices(kv as unknown as KVNamespace)

    expect(kv.get.mock.calls.filter((c) => c[0] === 'tracking:state').length).toBe(1)
    expect(kv.put.mock.calls.filter((c) => c[0] === 'tracking:state').length).toBeLessThanOrEqual(1)
  }, TEST_TIMEOUT_MS)

  it('drops tracking entries for service ids no longer in SERVICES (#1224 — an orphaned failSince must not page the operator forever)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    const kv = trackingMockKV({
      'tracking:state': JSON.stringify({
        'retired-service-id': { failCount: 3, failCountAt: '2020-01-01T00:00:00.000Z', failSince: '2020-01-01T00:00:00.000Z' },
      }),
    })
    expect(SERVICES.some((s) => s.id === 'retired-service-id')).toBe(false) // guards the fixture's own premise

    await fetchAllServices(kv as unknown as KVNamespace)

    const finalRaw = kv.store['tracking:state']
    expect(finalRaw).toBeDefined() // the prune itself is a change, so a write must have happened
    const final = JSON.parse(finalRaw)
    expect(final['retired-service-id']).toBeUndefined()
  }, TEST_TIMEOUT_MS)
})
