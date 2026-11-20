// #2058 — a local worker marked AIWATCH_LOCAL=1 sends nothing to the operator channels.

import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ServiceStatus } from '../types'

vi.mock('../services', async () => {
  const actual = await vi.importActual<typeof import('../services')>('../services')
  return { ...actual, fetchAllServices: vi.fn() }
})
vi.mock('../last-good-copy', async () => {
  const actual = await vi.importActual<typeof import('../last-good-copy')>('../last-good-copy')
  return { ...actual, writeLastGoodCopy: vi.fn(async () => 'written') }
})

import { SERVICES, fetchAllServices } from '../services'
import workerDefault, { StatusRefresher } from '../index'
import { hiddenKeys, withLocalOutboundMuted, OPERATOR_ALERT_KEYS, PRODUCTION_WRITE_KEYS } from '../local-outbound'
import { CRON_HEARTBEAT_KEY } from '../cron-heartbeat'
import { writeLastGoodCopy } from '../last-good-copy'

const HOOK = 'https://example.invalid/hook'
const OPERATIONAL: ServiceStatus[] = SERVICES.map((s) => ({ id: s.id, name: s.name, status: 'operational', incidents: [] } as unknown as ServiceStatus))

describe('hiddenKeys', () => {
  const ALL = [...PRODUCTION_WRITE_KEYS, ...OPERATOR_ALERT_KEYS].sort()
  it.each([
    [{}, []],
    [{ AIWATCH_LOCAL: '1' }, ALL],
    [{ AIWATCH_LOCAL: '1', AIWATCH_LOCAL_ALERTS: '1' }, [...PRODUCTION_WRITE_KEYS]],
    [{ AIWATCH_LOCAL: '0' }, []],
    [{ AIWATCH_LOCAL: 'true' }, []],
    [{ AIWATCH_LOCAL_ALERTS: '1' }, []],
  ])('%j → %j', (env, want) => {
    expect([...hiddenKeys(env)].sort()).toEqual(want)
  })
})

describe('withLocalOutboundMuted', () => {
  it('hides only the operator outbound keys, and only when muted', () => {
    const base = { AIWATCH_LOCAL: '1', DISCORD_WEBHOOK_URL: HOOK, NTFY_TOPIC: 't', BLOB_READ_WRITE_TOKEN: 'b', STATUS_CACHE: 'kv', ALLOWED_ORIGIN: '*' }
    const env = withLocalOutboundMuted(base)
    for (const k of [...OPERATOR_ALERT_KEYS, ...PRODUCTION_WRITE_KEYS]) {
      expect((env as Record<string, unknown>)[k]).toBeUndefined()
      expect(k in env).toBe(false)
    }
    expect(env.STATUS_CACHE).toBe('kv')
    expect(env.ALLOWED_ORIGIN).toBe('*')
    expect(withLocalOutboundMuted({ ...base, AIWATCH_LOCAL: undefined })).toEqual({ ...base, AIWATCH_LOCAL: undefined })
  })

  it('returns the production env object itself', () => {
    const prod = { DISCORD_WEBHOOK_URL: HOOK }
    expect(withLocalOutboundMuted(prod)).toBe(prod)
  })
})

function hookSpy() {
  const posted: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (url === HOOK) posted.push(JSON.parse(String(init?.body)).embeds?.[0]?.title ?? '')
    return new Response('{}', { status: 200 })
  })
  return posted
}

function memKv(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed))
  return {
    get: async (key: string) => (key === 'services:latest' ? JSON.stringify(OPERATIONAL) : store.get(key) ?? null),
    getWithMetadata: async () => ({ value: null, metadata: null }),
    put: async (key: string, value: string) => { store.set(key, value) },
    delete: async (key: string) => { store.delete(key) },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
  } as unknown as KVNamespace
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext

describe('wiring — the real scheduled() handler', () => {
  afterEach(() => { vi.restoreAllMocks() })

  async function runCron(markers: Record<string, string>) {
    vi.mocked(fetchAllServices).mockResolvedValue({ raw: OPERATIONAL, enriched: OPERATIONAL, pageComponents: {}, upstreamFeeds: [], fetchStats: { maxInFlight: 0, answered: 0, timeouts: 0, httpErrors: 0, otherErrors: 0, waitingAtStartAnswered: 0, waitingAtStartTimeouts: 0 } })
    const posted = hookSpy()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await workerDefault.scheduled({ scheduledTime: Date.parse('2026-09-15T09:02:00.000Z'), cron: '*/5 * * * *' } as ScheduledEvent, {
      STATUS_CACHE: memKv(),
      DISCORD_WEBHOOK_URL: HOOK,
      ...markers,
    } as never, ctx)
    return posted
  }

  it('a deployed run (no marker) posts to the operator webhook', async () => {
    expect((await runCron({})).length).toBeGreaterThan(0)
  })

  it('a local run posts nothing', async () => {
    expect(await runCron({ AIWATCH_LOCAL: '1' })).toEqual([])
  })

  it('a local run that opts in posts again', async () => {
    expect((await runCron({ AIWATCH_LOCAL: '1', AIWATCH_LOCAL_ALERTS: '1' })).length).toBeGreaterThan(0)
  })

  it.each([
    [{}, true],
    [{ AIWATCH_LOCAL: '1' }, false],
    [{ AIWATCH_LOCAL: '1', AIWATCH_LOCAL_ALERTS: '1' }, false],
  ])('the 09:02Z last-good copy is written to Vercel Blob with markers %j: %s', async (markers, want) => {
    vi.mocked(fetchAllServices).mockResolvedValue({ raw: OPERATIONAL, enriched: OPERATIONAL, pageComponents: {}, upstreamFeeds: [], fetchStats: { maxInFlight: 0, answered: 0, timeouts: 0, httpErrors: 0, otherErrors: 0, waitingAtStartAnswered: 0, waitingAtStartTimeouts: 0 } })
    vi.mocked(writeLastGoodCopy).mockClear()
    hookSpy()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await workerDefault.scheduled({ scheduledTime: Date.parse('2026-09-15T09:02:00.000Z'), cron: '*/5 * * * *' } as ScheduledEvent, {
      STATUS_CACHE: memKv(), DISCORD_WEBHOOK_URL: HOOK, BLOB_READ_WRITE_TOKEN: 'blob-token', ...markers,
    } as never, ctx)
    expect(vi.mocked(writeLastGoodCopy).mock.calls.length > 0).toBe(want)
  })

})

describe('wiring — the StatusRefresher Durable Object', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it.each([
    [{}, ['🔴 Worker Error — API 장애']],
    [{ AIWATCH_LOCAL: '1' }, []],
  ])('a failed refresh with markers %j posts %j', async (markers, want) => {
    vi.mocked(fetchAllServices).mockRejectedValue(new Error('all sources down'))
    const posted = hookSpy()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const storage = new Map<string, unknown>()
    const state = { storage: { get: async (k: string) => storage.get(k), put: async (k: string, v: unknown) => { storage.set(k, v) } } } as unknown as DurableObjectState
    await new StatusRefresher(state, { STATUS_CACHE: memKv(), DISCORD_WEBHOOK_URL: HOOK, ...markers } as never).alarm()
    expect(posted).toEqual(want)
  })
})

describe('wiring — the real fetch handler (the cron watchdog)', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

  it.each([
    [{}, ['🚨 Cron stalled']],
    [{ AIWATCH_LOCAL: '1' }, []],
  ])('a stale cron-written heartbeat with markers %j posts %j', async (markers, want) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse('2026-11-20T14:04:32Z') + (Object.keys(markers).length + 1) * 10 * 60_000)
    const posted = hookSpy()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const pending: Promise<unknown>[] = []
    const c = { waitUntil: (p: Promise<unknown>) => { pending.push(p) }, passThroughOnException: () => {} } as unknown as ExecutionContext
    const kv = memKv({ [CRON_HEARTBEAT_KEY]: JSON.stringify({ at: Date.parse('2026-11-20T13:42:18.944Z') }) })
    await workerDefault.fetch(new Request('http://localhost:8988/api/no-such-route'), { STATUS_CACHE: kv, DISCORD_WEBHOOK_URL: HOOK, ...markers } as never, c)
    await Promise.all(pending)
    expect(posted).toEqual(want)
  })
})
