// #1809 — the security:monthly:* accumulator, driven through the real `scheduled()` handler.

import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ServiceStatus } from '../services'
import type { SecurityAlert } from '../security-monitor'

vi.mock('../services', async () => {
  const actual = await vi.importActual<typeof import('../services')>('../services')
  return { ...actual, fetchAllServices: vi.fn() }
})
vi.mock('../reddit', async () => {
  const actual = await vi.importActual<typeof import('../reddit')>('../reddit')
  return { ...actual, detectRedditPosts: vi.fn() }
})
vi.mock('../security-monitor', async () => {
  const actual = await vi.importActual<typeof import('../security-monitor')>('../security-monitor')
  return { ...actual, detectSecurityAlerts: vi.fn(), fetchOSVAlerts: vi.fn() }
})

import workerModule from '../index'
import { SERVICES, fetchAllServices } from '../services'
import { detectRedditPosts } from '../reddit'
import { detectSecurityAlerts, fetchOSVAlerts } from '../security-monitor'

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
const NOW = '2026-09-10T04:01:11.527Z'
const MONTH_KEY = 'security:monthly:2026-09'

function fakeKv(seed: Record<string, string>) {
  const store = new Map(Object.entries(seed))
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    getWithMetadata: async () => ({ value: null, metadata: null }),
    put: async (k: string, v: string) => { store.set(k, v) },
    delete: async (k: string) => { store.delete(k) },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
  } as unknown as KVNamespace
  return { kv, store }
}

const alert = (url: string): SecurityAlert => ({
  source: 'osv', id: url, title: url, url, severity: 'high', kvKey: `security:seen:osv:${url}`, service: 'LangChain',
})

async function runWith(alerts: SecurityAlert[], seed: Record<string, string>) {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const svc = SERVICES.map(s => ({ id: s.id, name: s.name, status: 'operational', incidents: [] } as unknown as ServiceStatus))
  vi.mocked(fetchAllServices).mockResolvedValue({ raw: svc, enriched: svc, pageComponents: {}, upstreamFeeds: [] } as never)
  vi.mocked(detectRedditPosts).mockResolvedValue([])
  vi.mocked(detectSecurityAlerts).mockResolvedValue(alerts)
  vi.mocked(fetchOSVAlerts).mockResolvedValue([])
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 200 }))
  const { kv, store } = fakeKv(seed)
  const event = { scheduledTime: Date.parse(NOW), cron: '*/5 * * * *' } as ScheduledEvent
  await workerModule.scheduled(event, { STATUS_CACHE: kv, DISCORD_WEBHOOK_URL: 'https://example.invalid/hook' } as never, ctx)
  return JSON.parse(store.get(MONTH_KEY) ?? 'null') as Array<{ url: string; detectedAt: string }> | null
}

describe('#1809 security:monthly accumulation — through scheduled()', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.mocked(detectRedditPosts).mockReset()
    vi.mocked(detectSecurityAlerts).mockReset()
    vi.mocked(fetchOSVAlerts).mockReset()
  })

  it('stores a URL once when one run carries it twice, after the entries already stored', async () => {
    const dup = 'https://github.com/advisories/GHSA-gr75-jv2w-4656'
    const stored = { title: 'old', url: 'https://osv.dev/a', source: 'osv', detectedAt: '2026-09-01T00:00:00.000Z' }

    const monthly = await runWith([alert(dup), alert(dup), alert('https://osv.dev/a')], { [MONTH_KEY]: JSON.stringify([stored]) })

    expect(monthly).toEqual([stored, expect.objectContaining({ url: dup, detectedAt: NOW })])
  })
})
