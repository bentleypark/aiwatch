// #1418 — the Reddit scan cadence, driven through the real `scheduled()` handler.

import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ServiceStatus } from '../services'

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

function fakeKv() {
  const store = new Map<string, string>()
  return {
    get: async (k: string) => store.get(k) ?? null,
    getWithMetadata: async () => ({ value: null, metadata: null }),
    put: async (k: string, v: string) => { store.set(k, v) },
    delete: async (k: string) => { store.delete(k) },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
  } as unknown as KVNamespace
}

// Mid-month, off 09:00/10:00, so neither the monthly nor the daily-summary branch is entangled.
async function runAt(iso: string) {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const svc = SERVICES.map(s => ({ id: s.id, name: s.name, status: 'operational', incidents: [] } as unknown as ServiceStatus))
  vi.mocked(fetchAllServices).mockResolvedValue({ raw: svc, enriched: svc, pageComponents: {}, upstreamFeeds: [] } as never)
  vi.mocked(detectRedditPosts).mockResolvedValue([])
  vi.mocked(detectSecurityAlerts).mockResolvedValue([])
  vi.mocked(fetchOSVAlerts).mockResolvedValue([])
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 200 }))
  const event = { scheduledTime: Date.parse(iso), cron: '*/5 * * * *' } as ScheduledEvent
  await workerModule.scheduled(event, { STATUS_CACHE: fakeKv(), DISCORD_WEBHOOK_URL: 'https://example.invalid/hook' } as never, ctx)
}

describe('#1418 Reddit scan cadence — through scheduled()', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.mocked(detectRedditPosts).mockReset(); vi.mocked(detectSecurityAlerts).mockReset(); vi.mocked(fetchOSVAlerts).mockReset() })

  it('a quarter-hour tick scans Reddit and leaves HN/OSV alone', async () => {
    await runAt('2026-08-12T12:17:00.000Z')
    expect(vi.mocked(detectRedditPosts)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(detectSecurityAlerts)).not.toHaveBeenCalled()
    expect(vi.mocked(fetchOSVAlerts)).not.toHaveBeenCalled()
  })

  it('the top-of-hour tick scans Reddit and runs HN/OSV', async () => {
    await runAt('2026-08-12T12:02:00.000Z')
    expect(vi.mocked(detectRedditPosts)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(detectSecurityAlerts)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(fetchOSVAlerts)).toHaveBeenCalled()
  })

  it('an off-slot tick scans nothing', async () => {
    await runAt('2026-08-12T12:07:00.000Z')
    expect(vi.mocked(detectRedditPosts)).not.toHaveBeenCalled()
    expect(vi.mocked(detectSecurityAlerts)).not.toHaveBeenCalled()
  })
})
