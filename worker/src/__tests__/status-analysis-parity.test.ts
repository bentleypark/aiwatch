import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServiceStatus } from '../types'

vi.mock('../services', async () => {
  const actual = await vi.importActual<typeof import('../services')>('../services')
  return { ...actual, fetchAllServices: vi.fn() }
})

import workerModule from '../index'
import { CACHE_KEY, fetchAllServices } from '../services'

const NOW = Date.now()
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString()
const inc = (id: string, o: Record<string, unknown> = {}) =>
  ({ id, title: `T ${id}`, status: 'investigating', impact: 'major', startedAt: iso(300), duration: null, timeline: [], ...o })
const resolved = (id: string, minAgo: number, o: Record<string, unknown> = {}) =>
  inc(id, { status: 'resolved', resolvedAt: iso(minAgo), ...o })
const analysis = (incidentId: string, o: Record<string, unknown> = {}) => ({
  summary: `S ${incidentId}.`, progress: 'P.', estimatedRecovery: '4–8h', estimatedRecoveryHours: 8,
  affectedScope: ['X'], needsFallback: false, analyzedAt: iso(5), incidentId, model: 'gemma', ...o,
})
const svc = (id: string, name: string, status: string, incidents: unknown[]) =>
  ({ id, name, provider: 'P', category: 'api', status, incidents, lastChecked: iso(1) }) as unknown as ServiceStatus

const SERVICES_FIXTURE = (): ServiceStatus[] => [
  svc('claude', 'Claude API', 'operational', [
    inc('live'),
    inc('monitoring1', { status: 'monitoring' }),
    resolved('done1', 30),
  ]),
  svc('claudeai', 'claude.ai', 'operational', [
    resolved('done2', 30),
    resolved('old3', 240),
    resolved('bare4', 20),
    resolved('both8', 25),
    resolved('unres5', 10),
    resolved('derived6', 15, { derived: 'status_history', derivedDay: '2026-11-01' }),
  ]),
  svc('claudecode', 'Claude Code', 'degraded', [resolved('deg7', 30)]),
  svc('openai', 'OpenAI API', 'operational', []),
]

const KV_SEED: Record<string, string> = {
  'ai:analysis:claude:live': JSON.stringify(analysis('live')),
  'ai:analysis:claude:monitoring1': JSON.stringify(analysis('monitoring1')),
  'ai:analysis:claude:done1': JSON.stringify(analysis('done1', { resolvedAt: iso(30) })),
  'ai:analysis:claudeai:done2': JSON.stringify(analysis('done2', { resolvedAt: iso(30) })),
  'ai:analysis:claudeai:old3': JSON.stringify(analysis('old3', { resolvedAt: iso(240) })),
  'recovered:claudeai:old3': '1',
  'recovered:claudeai:bare4': '1',
  'ai:analysis:claudeai:both8': JSON.stringify(analysis('both8', { resolvedAt: iso(25) })),
  'recovered:claudeai:both8': '1',
  'ai:analysis:claudeai:unres5': JSON.stringify(analysis('unres5')),
  'ai:analysis:claudeai:derived6': JSON.stringify(analysis('derived6', { resolvedAt: iso(15) })),
  'recovered:claudeai:derived6': '1',
  'ai:analysis:claudecode:deg7': JSON.stringify(analysis('deg7', { resolvedAt: iso(30) })),
  'recovered:claudecode:deg7': '1',
}

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

async function poll(path: string, store: Map<string, string>) {
  const pending: Promise<unknown>[] = []
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p) }, passThroughOnException: () => {} } as unknown as ExecutionContext
  const res = await workerModule.fetch(new Request(`https://aiwatch.test${path}`), env(store), ctx)
  expect(res.status).toBe(200)
  const body = await res.json() as { aiAnalysis?: Record<string, Array<{ incidentId: string }>>; recentlyRecovered?: Record<string, string[]> }
  await Promise.all(pending)
  return body
}

const live = () => {
  const services = SERVICES_FIXTURE()
  vi.mocked(fetchAllServices).mockResolvedValue({
    raw: services, enriched: services, pageComponents: {}, upstreamFeeds: [],
    fetchStats: { maxInFlight: 0, answered: 0, timeouts: 0, httpErrors: 0, otherErrors: 0, waitingAtStartAnswered: 0, waitingAtStartTimeouts: 0 },
  })
  return poll('/api/status', new Map(Object.entries(KV_SEED)))
}

const cached = () => poll('/api/status/cached', new Map(Object.entries({
  ...KV_SEED,
  [CACHE_KEY]: JSON.stringify({ services: SERVICES_FIXTURE(), upstreamFeeds: [], cachedAt: iso(1) }),
})))

const ids = (m: Record<string, Array<{ incidentId: string }>> | undefined) =>
  Object.fromEntries(Object.entries(m ?? {}).map(([k, v]) => [k, v.map((a) => a.incidentId).sort()]))
const sorted = (m: Record<string, string[]> | undefined) =>
  Object.fromEntries(Object.entries(m ?? {}).map(([k, v]) => [k, [...v].sort()]))

describe('the analyses a status response carries are the same on the live and the cached route', () => {
  beforeEach(() => {
    ;(globalThis as unknown as { caches: unknown }).caches = { default: { match: async () => undefined, put: async () => undefined } }
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
  })
  afterEach(() => vi.unstubAllGlobals())

  it('live route: a live incident, and a recently resolved one only for an operational service with none', async () => {
    const body = await live()
    expect(ids(body.aiAnalysis)).toEqual({ claude: ['live'], claudeai: ['both8', 'done2'] })
    expect(sorted(body.recentlyRecovered)).toEqual({ claudeai: ['bare4', 'both8', 'done2'] })
  })

  it('cached route: the same', async () => {
    const body = await cached()
    expect(ids(body.aiAnalysis)).toEqual({ claude: ['live'], claudeai: ['both8', 'done2'] })
    expect(sorted(body.recentlyRecovered)).toEqual({ claudeai: ['bare4', 'both8', 'done2'] })
  })

  it('both routes answer one fixture identically', async () => {
    const [a, b] = [await live(), await cached()]
    expect(ids(a.aiAnalysis)).toEqual(ids(b.aiAnalysis))
    expect(sorted(a.recentlyRecovered)).toEqual(sorted(b.recentlyRecovered))
  })
})
