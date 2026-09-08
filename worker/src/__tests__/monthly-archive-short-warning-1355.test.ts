// #1355 — the month-end archive's "ready" Discord ping must flag a short `daysCollected`
// unconditionally. An earlier version tried to suppress the warning for a service's "first month of
// archiving" using the prior period's archive existing as a proxy, but `daysCollected` counts DATES
// site-wide (one shared counter per day, not per service), so no service's onboarding can ever
// produce a legitimately short count — there is no live case left to suppress for, and the proxy had
// its own failure mode: a genuinely missed prior month made its own absence check silence the very
// warning #1355 exists to raise. See `worker/src/index.ts`'s `maybeNotifyArchiveReady`.

import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ServiceStatus } from '../services'

vi.mock('../services', async () => {
  const actual = await vi.importActual<typeof import('../services')>('../services')
  return { ...actual, fetchAllServices: vi.fn() }
})

import workerModule from '../index'
import { SERVICES, fetchAllServices } from '../services'

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
const NORMAL_EVENT = { scheduledTime: Date.parse('2026-08-01T00:07:00.000Z'), cron: '*/5 * * * *' } as ScheduledEvent
const ARCHIVE_KEY = 'archive:monthly:2026-07' // month being archived when "now" is 2026-08-01

const OPERATIONAL: ServiceStatus[] = SERVICES.map(s => (
  { id: s.id, name: s.name, status: 'operational', incidents: [] } as unknown as ServiceStatus
))
const SERVICES_LATEST = JSON.stringify(OPERATIONAL)

function makeKv(options: {
  historyDays?: number // how many of July's 31 days have a history:2026-07-DD entry
} = {}) {
  // ARCHIVE_KEY starts absent — the normal 00:00 run builds and writes it fresh — so `put`/`get` need
  // to be a real round-trip: `maybeNotifyArchiveReady` reads back what the build just wrote.
  const store = new Map<string, string>()
  const kv = {
    get: async (key: string) => {
      if (key === 'services:latest') return SERVICES_LATEST
      if (key.startsWith('incidents:monthly:')) return null
      if (key.startsWith('history:2026-07-')) {
        const day = Number(key.slice('history:2026-07-'.length))
        const historyDays = options.historyDays ?? 31
        return day <= historyDays ? JSON.stringify({ claude: { ok: 288, total: 288 } }) : null
      }
      if (key.startsWith('archive:notified:')) return null // never yet notified — allow the send path to run
      return store.get(key) ?? null
    },
    getWithMetadata: async () => ({ value: null, metadata: null }),
    put: async (key: string, value: string) => { store.set(key, value) },
    delete: async (key: string) => { store.delete(key) },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
  } as unknown as KVNamespace
  return { kv }
}

async function runCron(event: ScheduledEvent, kv: KVNamespace) {
  vi.mocked(fetchAllServices).mockResolvedValue({ raw: OPERATIONAL, enriched: OPERATIONAL, pageComponents: {}, upstreamFeeds: [] })
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 200 }))
  await workerModule.scheduled(event, {
    STATUS_CACHE: kv,
    DISCORD_WEBHOOK_URL: 'https://example.invalid/hook',
  } as never, ctx)
  return fetchMock
}

/** The "monthly archive ready" ping body, or undefined if none was sent. */
function readyBody(fetchMock: { mock: { calls: unknown[][] } }) {
  const call = fetchMock.mock.calls.find(([url]) => url === 'https://example.invalid/hook')
  return call ? JSON.parse((call[1] as RequestInit).body as string) : undefined
}

describe('month-end short-archive Discord signal (#1355)', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('warns when the archive is short', async () => {
    const { kv } = makeKv({ historyDays: 30 })

    const fetchMock = await runCron(NORMAL_EVENT, kv)

    const body = readyBody(fetchMock)
    expect(body).toBeDefined()
    expect(JSON.stringify(body)).toContain('of 31')
    expect(JSON.stringify(body)).toContain('⚠️ Short by')
    // The written archive itself is unaffected by the warning — it still ships with what it has.
    const archive = JSON.parse((await kv.get(ARCHIVE_KEY)) as string)
    expect(archive.daysCollected).toBe(30)
  })

  it('does NOT warn when the archive is complete', async () => {
    const { kv } = makeKv({ historyDays: 31 })

    const fetchMock = await runCron(NORMAL_EVENT, kv)

    const body = readyBody(fetchMock)
    expect(body).toBeDefined()
    expect(JSON.stringify(body)).not.toContain('⚠️ Short by')
  })
})
