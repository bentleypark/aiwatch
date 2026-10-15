// #1695 — the three cron call sites that handle a snapshot, driven through the real `scheduled()` handler
// (`cronAlertCheck` is not exported): the first-sight inline analysis, and both resolution paths.

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
const event = { scheduledTime: Date.parse('2026-08-12T12:07:00.000Z'), cron: '*/5 * * * *' } as ScheduledEvent
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
const OPERATIONAL: ServiceStatus[] = SERVICES.map(s => ({ id: s.id, name: s.name, status: 'operational', incidents: [] } as unknown as ServiceStatus))
const svcId = SERVICES[0].id

const incident = (over: Record<string, unknown> = {}) => ({
  id: 'cron-1', title: 'Elevated error rates on the API', status: 'resolved', impact: 'major',
  startedAt: '2026-08-12T11:20:00.000Z', resolvedAt: '2026-08-12T11:50:00.000Z', duration: '30m',
  timeline: [
    { stage: 'investigating', text: 'We are investigating elevated error rates.', at: '2026-08-12T11:25:00.000Z' },
    { stage: 'resolved', text: 'This incident has been resolved.', at: '2026-08-12T11:50:00.000Z' },
  ],
  ...over,
})
const analysis = { summary: 's', estimatedRecovery: '1–2h', estimatedRecoveryHours: 2, affectedScope: ['API'], needsFallback: false, analyzedAt: '2026-08-12T11:30:00.000Z', incidentId: 'cron-1', model: 'gemma', timelineHash: '2026-08-12T11:25:00.000Z' }
const snapshot = { at: '2026-08-12T11:30:00.000Z', elapsedMin: 10, stage: 'investigating', updates: 1, sinceLastUpdateMin: 5, impact: 'major', estimateHours: 2, historyMatches: 1 }

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

async function run(seed: Record<string, string>, services: ServiceStatus[], env: Record<string, unknown> = {}) {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(event.scheduledTime)
  const { kv, store } = fakeKv(seed, services)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) =>
    String(input) === HOOK ? new Response(null, { status: 204 }) : new Response('', { status: 503 }))
  vi.mocked(fetchAllServices).mockResolvedValue({ raw: services, enriched: services, pageComponents: {}, upstreamFeeds: [], fetchStats: { maxInFlight: 0, answered: 0, timeouts: 0, httpErrors: 0, otherErrors: 0, waitingAtStartAnswered: 0, waitingAtStartTimeouts: 0 } })
  await workerModule.scheduled(event, { STATUS_CACHE: kv, DISCORD_WEBHOOK_URL: HOOK, ...env } as never, ctx)
  const alerts = fetchSpy.mock.calls.filter(([u]) => String(u) === HOOK).map(([, init]) => String((init as RequestInit).body))
  return Object.assign(store, { alerts })
}

const withIncident = (inc: ReturnType<typeof incident>, status = 'operational') =>
  OPERATIONAL.map(s => (s.id === svcId ? { ...s, status, incidents: [inc] } : s)) as unknown as ServiceStatus[]

const seeded = { [`ai:analysis:${svcId}:cron-1`]: JSON.stringify(analysis), [`ai:snaps:${svcId}:cron-1`]: JSON.stringify([snapshot]) }
const folded = (store: Map<string, string>) => {
  const history = JSON.parse(store.get(`incident:history:${svcId}`) ?? '[]') as Array<{ incId: string; predictionSnapshots?: unknown[] }>
  const month = [...store.keys()].find(k => k.startsWith('incident:ledger:2026-08:'))
  return { history, ledger: month ? JSON.parse(store.get(month)!) as Array<{ incId: string; predictionSnapshots?: unknown[] }> : [] }
}

describe('#1695 — the cron keeps the snapshot at each call site', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

  it('the "Incident Resolved" path folds the snapshot into the record and the ledger', async () => {
    const store = await run({ 'alerted:new:cron-1': JSON.stringify([svcId]), ...seeded }, withIncident(incident()))
    const { history, ledger } = folded(store)
    expect(history.find(r => r.incId === 'cron-1')?.predictionSnapshots).toHaveLength(1)
    expect(ledger.find(r => r.incId === 'cron-1')?.predictionSnapshots).toHaveLength(1)
  }, TEST_TIMEOUT_MS)

  it('the status-edge recovery path folds the snapshot into the record and the ledger', async () => {
    const store = await run({ [`alerted:down:${svcId}`]: '2026-08-12T11:20:00.000Z', ...seeded }, withIncident(incident()))
    const { history, ledger } = folded(store)
    expect(history.find(r => r.incId === 'cron-1')?.predictionSnapshots).toHaveLength(1)
    expect(ledger.find(r => r.incId === 'cron-1')?.predictionSnapshots).toHaveLength(1)
  }, TEST_TIMEOUT_MS)

  it('a first analysis made inline when the incident is first announced keeps its snapshot', async () => {
    const active = incident({ status: 'investigating', resolvedAt: null, duration: null, startedAt: '2026-08-12T11:30:00.000Z', timeline: [{ stage: 'investigating', text: 'We are investigating elevated error rates.', at: '2026-08-12T11:32:00.000Z' }] })
    const ai = { run: vi.fn().mockResolvedValue({ response: JSON.stringify({ summary: 'Elevated errors.', estimatedRecovery: '1–2h', affectedScope: ['API'], needsFallback: false }) }) }
    const store = await run({}, withIncident(active, 'degraded'), { AI: ai })
    expect(ai.run).toHaveBeenCalled()
    expect(store.alerts.some(a => a.includes('New Incident') && a.includes('Elevated errors.'))).toBe(true)
    const snaps = JSON.parse(store.get(`ai:snaps:${svcId}:cron-1`) ?? '[]')
    expect(snaps).toHaveLength(1)
    expect(snaps[0]).toMatchObject({ stage: 'investigating', updates: 1, model: 'gemma' })
  }, TEST_TIMEOUT_MS)
})
