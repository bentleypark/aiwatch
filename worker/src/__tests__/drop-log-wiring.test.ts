import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ServiceStatus } from '../types'

vi.mock('../services', async () => {
  const actual = await vi.importActual<typeof import('../services')>('../services')
  return { ...actual, fetchAllServices: vi.fn() }
})

import workerModule from '../index'
import { SERVICES, fetchAllServices } from '../services'

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext

const OPERATIONAL: ServiceStatus[] = SERVICES.map((s) => (
  { id: s.id, name: s.name, status: 'operational', incidents: [] } as unknown as ServiceStatus
))

const RUN_AT = '2026-09-15T09:02:00.000Z'

function makeKv(seed: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(seed))
  return {
    get: async (key: string) => (key === 'services:latest' ? JSON.stringify(OPERATIONAL) : store.get(key) ?? null),
    getWithMetadata: async () => ({ value: null, metadata: null }),
    put: async (key: string, value: string) => { store.set(key, value) },
    delete: async (key: string) => { store.delete(key) },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
  } as unknown as KVNamespace
}

const SQL = 'https://api.cloudflare.com/client/v4/accounts/acct/analytics_engine/sql'

async function runCron(kv: KVNamespace, env: Record<string, unknown> = {}, dropRows: unknown = { data: [] }, at = RUN_AT): Promise<string | undefined> {
  vi.mocked(fetchAllServices).mockResolvedValue({ raw: OPERATIONAL, enriched: OPERATIONAL, pageComponents: {}, upstreamFeeds: [], fetchStats: { maxInFlight: 0, answered: 0, timeouts: 0, httpErrors: 0, otherErrors: 0, waitingAtStartAnswered: 0, waitingAtStartTimeouts: 0 } })
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (url === SQL && typeof init?.body === 'string' && init.body.includes("'drop:")) return new Response(JSON.stringify(dropRows), { status: 200 })
    return new Response('{}', { status: 200 })
  })
  await workerModule.scheduled({ scheduledTime: Date.parse(at), cron: '*/5 * * * *' } as ScheduledEvent, {
    STATUS_CACHE: kv,
    DISCORD_WEBHOOK_URL: 'https://example.invalid/hook',
    ...env,
  } as never, ctx)
  for (const call of fetchMock.mock.calls) {
    if (call[0] !== 'https://example.invalid/hook') continue
    const body = (call[1] as RequestInit | undefined)?.body
    if (typeof body === 'string' && body.includes('AIWatch Daily Report')) return body
  }
  return undefined
}

const CREDS = { CF_ACCOUNT_ID: 'acct', CF_ANALYTICS_TOKEN: 'tok' }

// Runs first: `writeProbeSnapshot` keys its once-per-slot guard on the real clock, so a later cron in this file would find the slot taken.
describe('#1257 the cron hands its Analytics binding to the probe writer', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('a probe slot skipped on a failed read is recorded through env.ANALYTICS', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const ANALYTICS = { writeDataPoint: vi.fn() }
    const kv = makeKv({})
    const get = kv.get.bind(kv)
    ;(kv as { get: unknown }).get = async (key: string) => { if (key === 'probe:24h') throw new Error('KV down'); return get(key) }
    await runCron(kv, { ANALYTICS })
    const drops = ANALYTICS.writeDataPoint.mock.calls.map((c) => c[0] as { indexes: string[]; blobs: string[] }).filter((p) => p.indexes[0] === 'drop:probe-snapshot')
    expect(drops.map((p) => p.blobs[1])).toEqual(['read-failed'])
  })
})

describe('#1257 the weekly briefing hands its Analytics binding to the stale-source read', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('a changelog source it could not read is recorded through env.ANALYTICS', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ANALYTICS = { writeDataPoint: vi.fn() }
    const kv = makeKv({})
    const get = kv.get.bind(kv)
    ;(kv as { get: unknown }).get = async (key: string) => { if (key.startsWith('changelog:last-fetch:')) throw new Error('KV down'); return get(key) }
    await runCron(kv, { ANALYTICS }, { data: [] }, '2026-09-13T00:02:00.000Z')
    const drops = ANALYTICS.writeDataPoint.mock.calls.map((c) => c[0] as { indexes: string[]; blobs: string[] }).filter((p) => p.indexes[0] === 'drop:stale-sources')
    expect(drops.length).toBeGreaterThan(0)
    expect(new Set(drops.map((p) => p.blobs[1]))).toEqual(new Set(['source-read-failed']))
  })
})

describe('#1257 the drop count reaches the daily Discord report', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('names each counted drop', async () => {
    const body = await runCron(makeKv({}), CREDS, { data: [{ site: 'probe-snapshot', reason: 'read-failed', n: 22 }] })
    expect(body).toContain('probe-snapshot · read-failed ×22')
  })

  it('says none when the read succeeded and found nothing', async () => {
    const body = await runCron(makeKv({}), CREDS)
    expect(body).toContain('Silent drops** (24h): none')
  })

  it('says unreadable without credentials, instead of none', async () => {
    const body = await runCron(makeKv({}))
    expect(body).toBeDefined()
    expect(body).toContain('Silent drops** (24h): unreadable')
  })
})
