// #1778 — the cron records each counted RTT degradation as an event in the monthly accumulator.
// Driven through the real `scheduled()` handler (same construction as alerted-gone-wiring.test.ts).

import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ServiceStatus } from '../services'
import { TEST_TIMEOUT_MS } from './helpers/unreadable-source'
import { degradationMonthlyKey } from '../monthly-archive'
import { PROBE_TARGETS } from '../probe'

vi.mock('../services', async () => {
  const actual = await vi.importActual<typeof import('../services')>('../services')
  return { ...actual, fetchAllServices: vi.fn() }
})

import workerModule from '../index'
import { SERVICES, CACHE_KEY, fetchAllServices } from '../services'

const HOOK = 'https://example.invalid/hook'
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
const target = PROBE_TARGETS[0].id
const quiet = PROBE_TARGETS[1].id

function fakeKv(seed: Record<string, string>, services: ServiceStatus[]) {
  const store = new Map<string, string>(Object.entries(seed))
  store.set(CACHE_KEY, JSON.stringify({ services, upstreamFeeds: [], cachedAt: new Date().toISOString() }))
  return {
    store,
    kv: {
      get: async (key: string) => store.get(key) ?? null,
      getWithMetadata: async () => ({ value: null, metadata: null }),
      put: async (key: string, value: string) => { store.set(key, value) },
      delete: async (key: string) => { store.delete(key) },
      list: async ({ prefix }: { prefix: string }) => ({ keys: [...store.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true, cacheStatus: null }),
    } as unknown as KVNamespace,
  }
}

/** Twelve calm probes, then three failed ones ending one slot before now. */
function spikingProbeHistory(now: number) {
  const slot = 5 * 60_000
  const snapshots = Array.from({ length: 15 }, (_, i) => {
    const t = new Date(now - (15 - i) * slot).toISOString()
    const probe = i < 12 ? { status: 200, rtt: 100 } : { status: 0, rtt: -1 }
    return { t, data: { [target]: probe, [quiet]: probe } }
  })
  return JSON.stringify({ snapshots })
}

describe('#1778 — scheduled() records a degradation event', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('appends the counted degradation, with the cached status it was judged against, to the month accumulator', async () => {
    const now = Date.now()
    const live = SERVICES.map((s) => ({ id: s.id, name: s.name, status: s.id === target ? 'degraded' : 'operational', incidents: [] } as unknown as ServiceStatus))
    const { kv, store } = fakeKv({ 'probe:24h': spikingProbeHistory(now) }, live)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) =>
      String(input) === HOOK ? new Response(null, { status: 204 }) : new Response('', { status: 503 }))
    vi.mocked(fetchAllServices).mockResolvedValue({ raw: live, enriched: live, pageComponents: {}, upstreamFeeds: [], fetchStats: { maxInFlight: 0, answered: 0, timeouts: 0, httpErrors: 0, otherErrors: 0, waitingAtStartAnswered: 0, waitingAtStartTimeouts: 0 } })

    await workerModule.scheduled({ scheduledTime: now, cron: '*/5 * * * *' } as ScheduledEvent, { STATUS_CACHE: kv, DISCORD_WEBHOOK_URL: HOOK } as never, ctx)

    const acc = JSON.parse(store.get(degradationMonthlyKey()) ?? 'null')
    const mine = (acc?.events ?? []).filter((e: { svcId: string }) => e.svcId === target)
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({ svcId: target, noStatus: false, status: 'degraded' })
    expect(mine[0].failed).toBeGreaterThanOrEqual(3)
    expect(mine[0].probes).toBe(mine[0].failed)
    expect(Date.parse(mine[0].since)).toBeLessThan(Date.parse(mine[0].at))
    const offPage = (acc?.events ?? []).filter((e: { svcId: string }) => e.svcId === quiet)
    expect(offPage).toHaveLength(1)
    expect(offPage[0]).toMatchObject({ noStatus: true, status: 'operational' })
  }, TEST_TIMEOUT_MS)
})
