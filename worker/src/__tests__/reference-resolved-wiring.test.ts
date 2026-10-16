// #1698 — an incident announced while counted, now carried only in `referenceIncidents`, still gets its
// Resolved alert from the real cron. Same harness as alerted-gone-wiring.test.ts.

import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ServiceStatus } from '../services'
import { TEST_TIMEOUT_MS } from './helpers/unreadable-source'

vi.mock('../services', async () => {
  const actual = await vi.importActual<typeof import('../services')>('../services')
  return { ...actual, fetchAllServices: vi.fn() }
})

import workerModule from '../index'
import { SERVICES, CACHE_KEY, fetchAllServices } from '../services'

const HOOK = 'https://example.invalid/hook'
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext

function fakeKv(seed: Record<string, string>, services: ServiceStatus[]) {
  const store = new Map<string, string>(Object.entries(seed))
  const reads: string[] = []
  store.set(CACHE_KEY, JSON.stringify({ services, upstreamFeeds: [], cachedAt: new Date().toISOString() }))
  return {
    store,
    reads,
    kv: {
      get: async (key: string) => { reads.push(key); return store.get(key) ?? null },
      getWithMetadata: async () => ({ value: null, metadata: null }),
      put: async (key: string, value: string) => { store.set(key, value) },
      delete: async (key: string) => { store.delete(key) },
      list: async ({ prefix }: { prefix: string }) => ({ keys: [...store.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true, cacheStatus: null }),
    } as unknown as KVNamespace,
  }
}

describe('#1698 scheduled() closes an announced incident that moved to referenceIncidents', () => {
  afterEach(() => { vi.restoreAllMocks() })

  async function run(ref: Record<string, unknown>, seed: Record<string, string>) {
    const live = SERVICES.map((s) => ({
      id: s.id, name: s.name, provider: s.provider, category: s.category, status: 'operational', incidents: [],
      ...(s.id === 'openrouter' ? { referenceIncidents: [ref] } : {}),
    })) as unknown as ServiceStatus[]
    const { kv, store, reads } = fakeKv(seed, live)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) =>
      String(input) === HOOK ? new Response(null, { status: 204 }) : new Response('', { status: 503 }))
    vi.mocked(fetchAllServices).mockResolvedValue({ raw: live, enriched: live, pageComponents: {}, upstreamFeeds: [], fetchStats: { maxInFlight: 0, answered: 0, timeouts: 0, httpErrors: 0, otherErrors: 0, waitingAtStartAnswered: 0, waitingAtStartTimeouts: 0 } })
    await workerModule.scheduled({ scheduledTime: Date.now(), cron: '*/5 * * * *' } as ScheduledEvent, { STATUS_CACHE: kv, DISCORD_WEBHOOK_URL: HOOK } as never, ctx)
    const bodies = fetchSpy.mock.calls.filter(([u]) => String(u) === HOOK).map(([, init]) => String((init as RequestInit).body))
    return { bodies, store, reads }
  }

  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()
  const ref = (id: string, status: string) => ({
    id, title: 'Web app degraded', status, impact: 'minor', duration: status === 'resolved' ? '1h 0m' : null, timeline: [],
    startedAt: minutesAgo(70), resolvedAt: status === 'resolved' ? minutesAgo(10) : null,
  })

  it('sends its Resolved alert and records alerted:res', async () => {
    const { bodies, store } = await run(ref('refR', 'resolved'), { 'alerted:new:refR': JSON.stringify(['openrouter']) })
    expect(bodies.some((b) => b.includes('Resolved') && b.includes('OpenRouter'))).toBe(true)
    expect(store.get('alerted:res:refR')).toBeTruthy()
    expect(store.get('recovered:openrouter:refR')).toBeTruthy()
  }, TEST_TIMEOUT_MS)

  it('reads no alert marker for an open reference incident', async () => {
    const { bodies, reads } = await run(ref('refOpen', 'investigating'), {})
    expect(reads.filter((k) => k.includes('refOpen'))).toEqual([])
    expect(bodies.some((b) => b.includes('refOpen') || b.includes('New Incident'))).toBe(false)
  }, TEST_TIMEOUT_MS)
})
