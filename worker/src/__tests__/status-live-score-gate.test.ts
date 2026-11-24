import { afterEach, describe, expect, it, vi } from 'vitest'
import workerModule from '../index'
import { CACHE_KEY, SERVICES } from '../services'
import { HEALTHY_SUMMARY, TEST_TIMEOUT_MS } from './helpers/unreadable-source'
import { lazyPage, ninetyDays } from './helpers/lazy-status-page'

// #2061 — the dashboard falls back to the live /api/status route whenever /api/status/cached fails, so
// the coverage gate has to hold on it too. status.moonshot.cn is served with uptime for every component,
// which puts `kimicode` (added 2026-11-20) at `high` confidence: its null number can only be the gate's.
// The clock is pinned so the day count does not drift out from under the assertion.

const PAGE = 'https://status.moonshot.cn'
const kimicode = SERVICES.find((s) => s.id === 'kimicode')!
const kimi = SERVICES.find((s) => s.id === 'kimi')!
const IDS = [...(kimicode.statusComponentIds ?? []), kimi.statusComponentId!]
const COMPONENTS = IDS.map((id) => ({ id, name: id, group: false, status: 'operational' }))

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

type Live = { id: string; aiwatchScore: number | null; scoreGrade: string | null; scoreConfidence: string; coverageDays?: number }

async function pollLive() {
  const store = new Map<string, string>([[CACHE_KEY, JSON.stringify({
    services: [{ id: 'claude', name: 'Claude API', status: 'operational', incidents: [], lastChecked: new Date().toISOString() }],
    upstreamFeeds: [],
    cachedAt: new Date().toISOString(),
  })]])
  const pending: Promise<unknown>[] = []
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p) }, passThroughOnException: () => {} } as unknown as ExecutionContext
  const res = await workerModule.fetch(new Request('https://aiwatch.test/api/status'), env(store), ctx)
  const body = await res.json() as { services: Live[] }
  await Promise.all(pending)
  return body.services
}

describe('/api/status (live) withholds the Score of a service under the coverage gate', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('kimicode has no number and grade at 4 days; kimi, on the same page, keeps its own', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-24T12:00:00Z') })
    const days = ninetyDays('2026-11-24')
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
      if (url.startsWith(PAGE) && url.includes('/uptime_showcase')) {
        return json({ timelines: Object.fromEntries(IDS.map((c) => [c, { component: { code: c }, days }])) })
      }
      if (url.startsWith(`${PAGE}/api/v2/summary.json`)) return json({ status: { indicator: 'none' }, components: COMPONENTS, incidents: [], scheduled_maintenances: [] })
      if (url.startsWith(`${PAGE}/api/v2/incidents.json`)) return json({ incidents: [] })
      if (url === PAGE || url === `${PAGE}/`) return new Response(lazyPage(IDS), { status: 200, headers: { 'Content-Type': 'text/html' } })
      return json(HEALTHY_SUMMARY)
    }))
    const services = await pollLive()
    const gated = services.find((s) => s.id === 'kimicode')!
    const established = services.find((s) => s.id === 'kimi')!
    expect(gated.coverageDays).toBe(4)
    expect(gated.scoreConfidence).toBe('high')
    expect(gated.aiwatchScore).toBeNull()
    expect(gated.scoreGrade).toBeNull()
    expect(established.coverageDays).toBeGreaterThanOrEqual(30)
    expect(established.aiwatchScore).not.toBeNull()
  }, TEST_TIMEOUT_MS)
})
