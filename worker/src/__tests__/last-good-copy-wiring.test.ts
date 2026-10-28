// #1531 Part 7 — the real scheduled handler uploads the last-good copy once an hour.
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('../services', async () => {
  const actual = await vi.importActual<typeof import('../services')>('../services')
  return { ...actual, fetchAllServices: vi.fn() }
})
vi.mock('../last-good-copy', () => ({ writeLastGoodCopy: vi.fn(async () => 'written') }))
import { fetchAllServices, SERVICES, CACHE_KEY } from '../services'
import { writeLastGoodCopy } from '../last-good-copy'
import workerModule from '../index'
import { TEST_TIMEOUT_MS } from './helpers/unreadable-source'
import type { ServiceStatus } from '../types'

describe('scheduled() → writeLastGoodCopy', () => {
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.mocked(writeLastGoodCopy).mockClear() })

  async function runAt(iso: string, token: string | undefined) {
    const roster = SERVICES.map((c) => ({ id: c.id, name: c.name, category: c.category, status: 'operational', incidents: [], lastChecked: iso } as unknown as ServiceStatus))
    const store: Record<string, string> = { [CACHE_KEY]: JSON.stringify({ services: roster, cachedAt: iso }) }
    const kv = {
      get: async (k: string) => store[k] ?? null,
      getWithMetadata: async (k: string) => ({ value: store[k] ?? null, metadata: null }),
      put: async (k: string, v: string) => { store[k] = v },
      delete: async (k: string) => { delete store[k] },
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    } as unknown as KVNamespace
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(fetchAllServices).mockResolvedValue({ raw: roster, enriched: roster, pageComponents: {}, upstreamFeeds: [], fetchStats: { maxInFlight: 0, answered: 0, timeouts: 0, httpErrors: 0, otherErrors: 0, waitingAtStartAnswered: 0, waitingAtStartTimeouts: 0 } })
    const event = { scheduledTime: Date.parse(iso), cron: '*/5 * * * *' } as ScheduledEvent
    await workerModule.scheduled(event, { STATUS_CACHE: kv, BLOB_READ_WRITE_TOKEN: token } as never, ctx)
  }

  it('uploads the cached payload in the hourly slot, with the secret token', async () => {
    await runAt('2026-10-28T12:02:00.000Z', 'tok')
    expect(writeLastGoodCopy).toHaveBeenCalledTimes(1)
    const [payload, token] = vi.mocked(writeLastGoodCopy).mock.calls[0]
    expect(token).toBe('tok')
    expect((payload as { services: unknown[] } | null)?.services).toHaveLength(SERVICES.length)
  }, TEST_TIMEOUT_MS)

  it('stays out of the cycles between slots', async () => {
    await runAt('2026-10-28T12:07:00.000Z', 'tok')
    expect(writeLastGoodCopy).not.toHaveBeenCalled()
  }, TEST_TIMEOUT_MS)

  it('does nothing without the token', async () => {
    await runAt('2026-10-28T12:02:00.000Z', undefined)
    expect(writeLastGoodCopy).not.toHaveBeenCalled()
  }, TEST_TIMEOUT_MS)
})
