import { afterEach, describe, expect, it, vi } from 'vitest'
import workerModule from '../index'
import { CACHE_KEY } from '../services'
import type { ServiceStatus } from '../types'
import { HEALTHY_SUMMARY, TEST_TIMEOUT_MS, stubFetchDegradedClaudePage } from './helpers/unreadable-source'

// #1235 — `/api/status` serves `enriched`, which shows a readable `degraded` as the cached `operational`
// record. Both CACHE_KEY writers on this route write `raw`, never `enriched`.

const HOUR = 3_600_000
let clock = Date.parse('2030-01-01T00:00:00.000Z')

function env(store: Map<string, string>) {
  return {
    STATUS_CACHE: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => { store.set(k, v) },
      delete: async (k: string) => { store.delete(k) },
      list: async () => ({ keys: [], list_complete: true }),
    },
    ANALYTICS: { writeDataPoint: () => {} },
    ALLOWED_ORIGIN: '*',
  } as unknown as Parameters<typeof workerModule.fetch>[1]
}

async function poll(store: Map<string, string>) {
  const pending: Promise<unknown>[] = []
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p) }, passThroughOnException: () => {} } as unknown as ExecutionContext
  const res = await workerModule.fetch(new Request('https://aiwatch.test/api/status'), env(store), ctx)
  const body = await res.json() as { services: ServiceStatus[] }
  await Promise.all(pending)
  return body.services.find((s) => s.id === 'claude')?.status
}

function cachedOperational() {
  return new Map([[CACHE_KEY, JSON.stringify({
    services: [{ id: 'claude', name: 'Claude API', status: 'operational', incidents: [], lastChecked: new Date(Date.now() - 60_000).toISOString() }],
    upstreamFeeds: [],
    cachedAt: new Date(Date.now() - 60_000).toISOString(),
  })]])
}

describe('#1235 — the enriched smoothing lasts one poll', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  // Each test starts an hour past the last, so the module's 10-minute cacheWrite throttle is expired.
  function startClock() {
    clock += HOUR
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(clock)
  }

  it('cacheWrite path: smoothed on the first poll, degraded on the next', async () => {
    startClock()
    stubFetchDegradedClaudePage()
    const store = cachedOperational()

    expect(await poll(store)).toBe('operational')
    vi.setSystemTime(clock + 60_000)
    expect(await poll(store)).toBe('degraded')
  }, TEST_TIMEOUT_MS)

  it('throttled live-edge refresh path: smoothed on the first poll, degraded on the next', async () => {
    startClock()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(HEALTHY_SUMMARY), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    const store = cachedOperational()
    expect(await poll(store)).toBe('operational')

    stubFetchDegradedClaudePage()
    vi.setSystemTime(clock + 60_000)
    expect(await poll(store)).toBe('operational')
    vi.setSystemTime(clock + 120_000)
    expect(await poll(store)).toBe('degraded')
  }, TEST_TIMEOUT_MS)
})
