// #1118 — the cron actually runs the announced-but-gone check. Driven through the real `scheduled()`
// handler (same construction as cache-reseed-wiring.test.ts) because `cronAlertCheck` is not exported.

import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ServiceStatus } from '../services'
import { TEST_TIMEOUT_MS } from './helpers/unreadable-source'
import { GONE_HOLD_MS, GONE_SEEN_PREFIX } from '../alerted-gone'

vi.mock('../services', async () => {
  const actual = await vi.importActual<typeof import('../services')>('../services')
  return { ...actual, fetchAllServices: vi.fn() }
})

import workerModule from '../index'
import { SERVICES, CACHE_KEY, fetchAllServices } from '../services'

const HOOK = 'https://example.invalid/hook'
const event = { scheduledTime: Date.parse('2026-08-12T12:07:00.000Z'), cron: '*/5 * * * *' } as ScheduledEvent
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
const OPERATIONAL: ServiceStatus[] = SERVICES.map(s => ({ id: s.id, name: s.name, status: 'operational', incidents: [] } as unknown as ServiceStatus))

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

describe('#1118 — scheduled() runs the announced-but-gone check', () => {
  afterEach(() => { vi.restoreAllMocks() })

  async function run(seed: Record<string, string>, degraded?: string) {
    const live = degraded ? OPERATIONAL.map((s) => (s.id === degraded ? { ...s, status: 'degraded' } : s)) as ServiceStatus[] : OPERATIONAL
    const { kv, store } = fakeKv(seed, live)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) =>
      String(input) === HOOK ? new Response(null, { status: 204 }) : new Response('', { status: 503 }))
    vi.mocked(fetchAllServices).mockResolvedValue({ raw: live, enriched: live, pageComponents: {}, upstreamFeeds: [], fetchStats: { maxInFlight: 0, answered: 0, timeouts: 0, httpErrors: 0, otherErrors: 0, waitingAtStartAnswered: 0, waitingAtStartTimeouts: 0 } })
    await workerModule.scheduled(event, { STATUS_CACHE: kv, DISCORD_WEBHOOK_URL: HOOK } as never, ctx)
    const bodies = fetchSpy.mock.calls.filter(([u]) => String(u) === HOOK).map(([, init]) => String((init as RequestInit).body))
    return { bodies, store }
  }

  const svcId = SERVICES[0].id
  const confirmedHold = () => JSON.stringify({ first: Date.now() - GONE_HOLD_MS - 60_000, last: Date.now() - 300_000 })

  it('an announced, never-closed incident that the card does not carry is sent to the operator', async () => {
    const { bodies, store } = await run({ 'alerted:new:wire-1': JSON.stringify([svcId]), [`${GONE_SEEN_PREFIX}wire-1`]: confirmedHold() })
    expect(bodies.some((b) => b.includes('no longer on the card, never closed') && b.includes('wire-1'))).toBe(true)
    expect(store.get('alerted:gone:wire-1')).toBe('reported')
  }, TEST_TIMEOUT_MS)

  it('an Azure OpenAI incident, whose RSS feed never marks one resolved, is not reported', async () => {
    const azure = SERVICES.find((s) => s.azureRssUrl)!.id
    const { bodies, store } = await run({ 'alerted:new:wire-1': JSON.stringify([azure]), [`${GONE_SEEN_PREFIX}wire-1`]: confirmedHold() })
    expect(bodies.some((b) => b.includes('no longer on the card'))).toBe(false)
    expect(store.get('alerted:gone:wire-1')).toBeUndefined()
  }, TEST_TIMEOUT_MS)

  it('the same incident, closed, sends nothing', async () => {
    const { bodies } = await run({ 'alerted:new:wire-1': JSON.stringify([svcId]), 'alerted:res:wire-1': '1', [`${GONE_SEEN_PREFIX}wire-1`]: confirmedHold() })
    expect(bodies.some((b) => b.includes('no longer on the card'))).toBe(false)
  }, TEST_TIMEOUT_MS)

  it('the same incident, tombstoned while its withdrawal notice is held (service degraded), is left to the withdrawal path', async () => {
    const tombstone = { svcId, incId: 'wire-1', title: 'T', startedAt: new Date(Date.now() - 3600_000).toISOString(), prunedAt: new Date().toISOString() }
    const { bodies, store } = await run({ 'alerted:new:wire-1': JSON.stringify([svcId]), 'incidents:withdrawn': JSON.stringify([tombstone]), [`${GONE_SEEN_PREFIX}wire-1`]: confirmedHold() }, svcId)
    expect(bodies.some((b) => b.includes('no longer on the card'))).toBe(false)
    expect(store.get('alerted:gone:wire-1')).toBeUndefined()
    expect(store.get('alerted:wd:wire-1')).toBeUndefined()
  }, TEST_TIMEOUT_MS)
})
