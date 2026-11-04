// #1405 — the cron sends maintenance alerts. Driven through the real `scheduled()` handler, the same
// construction as alerted-gone-wiring.test.ts, because `cronAlertCheck` is not exported.

import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ServiceStatus } from '../services'
import { TEST_TIMEOUT_MS } from './helpers/unreadable-source'

vi.mock('../services', async () => {
  const actual = await vi.importActual<typeof import('../services')>('../services')
  return { ...actual, fetchAllServices: vi.fn() }
})

import workerModule from '../index'
import { SERVICES, CACHE_KEY, fetchAllServices } from '../services'
import { ALERT_FEED_KEY, type AlertFeedEntry } from '../alert-feed'

const HOOK = 'https://example.invalid/hook'
const event = { scheduledTime: Date.parse('2026-11-04T12:07:00.000Z'), cron: '*/5 * * * *' } as ScheduledEvent
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
const svcId = SERVICES[0].id

function services(windowStartMs: number): ServiceStatus[] {
  return SERVICES.map((s) => ({
    id: s.id, name: s.name, status: 'operational', incidents: [],
    ...(s.id === svcId ? { scheduledMaintenances: [{
      id: 'wire-mw', title: 'Database upgrade', scheduledFor: new Date(windowStartMs).toISOString(),
      scheduledUntil: new Date(windowStartMs + 3600_000).toISOString(), componentNames: ['API'],
    }] } : {}),
  } as unknown as ServiceStatus))
}

function fakeKv(store: Map<string, string>, ttls: Map<string, number | undefined>) {
  return {
    get: async (key: string) => store.get(key) ?? null,
    getWithMetadata: async () => ({ value: null, metadata: null }),
    put: async (key: string, value: string, opts?: { expirationTtl?: number }) => { store.set(key, value); ttls.set(key, opts?.expirationTtl) },
    delete: async (key: string) => { store.delete(key) },
    list: async ({ prefix }: { prefix: string }) => ({ keys: [...store.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true, cacheStatus: null }),
  } as unknown as KVNamespace
}

describe('#1405 — scheduled() sends maintenance alerts', () => {
  afterEach(() => { vi.restoreAllMocks() })

  async function run(store: Map<string, string>, ttls: Map<string, number | undefined>, live: ServiceStatus[]) {
    store.set(CACHE_KEY, JSON.stringify({ services: live, upstreamFeeds: [], cachedAt: new Date().toISOString() }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) =>
      String(input) === HOOK ? new Response(null, { status: 204 }) : new Response('', { status: 503 }))
    fetchSpy.mockClear()
    vi.mocked(fetchAllServices).mockResolvedValue({ raw: live, enriched: live, pageComponents: {}, upstreamFeeds: [], fetchStats: { maxInFlight: 0, answered: 0, timeouts: 0, httpErrors: 0, otherErrors: 0, waitingAtStartAnswered: 0, waitingAtStartTimeouts: 0 } })
    await workerModule.scheduled(event, { STATUS_CACHE: fakeKv(store, ttls), DISCORD_WEBHOOK_URL: HOOK } as never, ctx)
    return fetchSpy.mock.calls.filter(([u]) => String(u) === HOOK).map(([, init]) => String((init as RequestInit).body))
  }

  it('announces an upcoming window once, then sends the start alert once it begins', async () => {
    const store = new Map<string, string>()
    const ttls = new Map<string, number | undefined>()
    const start = Date.now() + 2 * 3600_000
    const upcoming = services(start)

    const first = await run(store, ttls, upcoming)
    expect(first.filter((b) => b.includes('Maintenance Scheduled') && b.includes('Database upgrade'))).toHaveLength(1)
    expect(store.has('alerted:mnt:wire-mw')).toBe(true)
    expect(ttls.get('alerted:mnt:wire-mw')).toBe(365 * 86_400)
    const feed = JSON.parse(store.get(ALERT_FEED_KEY) ?? '[]') as AlertFeedEntry[]
    expect(feed.find((e) => e.key === 'alerted:mnt:wire-mw')).toMatchObject({ kind: 'maintenance', svcIds: [svcId] })

    const again = await run(store, ttls, upcoming)
    expect(again.some((b) => b.includes('Maintenance'))).toBe(false)

    const begun = await run(store, ttls, services(Date.now() - 60_000))
    expect(begun.filter((b) => b.includes('Maintenance Started'))).toHaveLength(1)
    expect(store.has('alerted:mnt-start:wire-mw')).toBe(true)
  }, TEST_TIMEOUT_MS)
})
