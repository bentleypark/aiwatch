import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ServiceStatus } from '../types'
import {
  REFRESH_COMPONENT_INTERVAL_MS, REFRESH_COUNTER_INTERVAL_MS, REFRESH_MIN_GAP_MS, REFRESH_REQUEST_GAP_MS, REFRESH_RUN_DEAD_MS, REFRESH_STALE_MS,
  isDue, shouldRequestRefresh, shouldScheduleRun,
} from '../status-refresh'
import { followUpPollDelay } from '../../../src/utils/dataTimestamp'

const fetchAllServices = vi.fn()
vi.mock('../services', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services')>()),
  fetchAllServices: (...args: unknown[]) => fetchAllServices(...args),
}))
const { default: workerModule, StatusRefresher, cacheWrite, runStatusRefresh } = await import('../index')

const T = Date.parse('2026-11-04T12:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()

describe('the dashboard re-polls exactly when the Worker starts a refresh', () => {
  it.each([0, 1, REFRESH_STALE_MS - 1, REFRESH_STALE_MS, REFRESH_STALE_MS + 1, 2 * REFRESH_STALE_MS])('snapshot age %i ms', (ageMs) => {
    const workerRefreshes = shouldRequestRefresh(iso(T - ageMs), 0, T)
    const dashboardRePolls = followUpPollDelay(new Date(T - ageMs), T) != null
    expect(dashboardRePolls).toBe(workerRefreshes)
  })
})

describe('shouldRequestRefresh', () => {
  it.each([
    ['fresh snapshot', iso(T - REFRESH_STALE_MS), 0, false],
    ['stale snapshot', iso(T - REFRESH_STALE_MS - 1), 0, true],
    ['stale, but this isolate asked moments ago', iso(T - 10 * REFRESH_STALE_MS), T - REFRESH_REQUEST_GAP_MS + 1, false],
    ['stale, isolate asked a gap ago', iso(T - 10 * REFRESH_STALE_MS), T - REFRESH_REQUEST_GAP_MS, true],
    ['no timestamp', undefined, 0, true],
    ['unparseable timestamp', 'not-a-date', 0, true],
  ])('%s', (_name, cachedAt, lastRequestAt, expected) => {
    expect(shouldRequestRefresh(cachedAt, lastRequestAt, T)).toBe(expected)
  })
})

describe('shouldScheduleRun', () => {
  const idle = { alarmAt: null, runStartedAt: T - 10 * REFRESH_MIN_GAP_MS, runFinishedAt: T - 9 * REFRESH_MIN_GAP_MS }
  it.each([
    ['idle, last run long ago', idle, true],
    ['never ran', { alarmAt: null, runStartedAt: 0, runFinishedAt: 0 }, true],
    ['alarm already set', { ...idle, alarmAt: T + 1 }, false],
    ['last run started under the gap ago', { alarmAt: null, runStartedAt: T - REFRESH_MIN_GAP_MS + 1, runFinishedAt: T - 1 }, false],
    ['last run started exactly the gap ago', { alarmAt: null, runStartedAt: T - REFRESH_MIN_GAP_MS, runFinishedAt: T - 1 }, true],
    ['a run is in progress', { alarmAt: null, runStartedAt: T - 2 * REFRESH_MIN_GAP_MS, runFinishedAt: T - 3 * REFRESH_MIN_GAP_MS }, false],
    ['a run started past the dead limit and never finished', { alarmAt: null, runStartedAt: T - REFRESH_RUN_DEAD_MS, runFinishedAt: T - REFRESH_RUN_DEAD_MS - 1 }, true],
  ])('%s', (_name, state, expected) => {
    expect(shouldScheduleRun(state, T)).toBe(expected)
  })
})

describe('isDue', () => {
  it.each([
    [0, true],
    [T - REFRESH_COUNTER_INTERVAL_MS, true],
    [T - REFRESH_COUNTER_INTERVAL_MS + 1, false],
  ])('last write at %s', (last, expected) => {
    expect(isDue(last, T, REFRESH_COUNTER_INTERVAL_MS)).toBe(expected)
  })
})

const SERVICES = [
  { id: 'claude', name: 'Claude API', provider: 'Anthropic', category: 'api', status: 'operational', latency: null, uptime30d: 99.9, lastChecked: iso(T), incidents: [] },
] as unknown as ServiceStatus[]

function memoryKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  const puts: string[] = []
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    getWithMetadata: async (k: string) => ({ value: store.get(k) ?? null, metadata: null }),
    list: async ({ prefix }: { prefix: string }) => ({ keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }),
    put: async (k: string, v: string) => { puts.push(k); store.set(k, v) },
    delete: async (k: string) => { store.delete(k) },
  } as unknown as KVNamespace
  return { kv, store, puts }
}

function fakeState() {
  const data = new Map<string, unknown>()
  let alarm: number | null = null
  const storage = {
    get: async (k: string) => data.get(k),
    put: async (k: string, v: unknown) => { data.set(k, v) },
    getAlarm: async () => alarm,
    setAlarm: async (at: number) => { alarm = at },
  }
  return { state: { storage } as unknown as DurableObjectState, data, alarmAt: () => alarm, clearAlarm: () => { alarm = null } }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  fetchAllServices.mockReset()
  fetchAllServices.mockResolvedValue({ raw: SERVICES, enriched: SERVICES, pageComponents: {}, upstreamFeeds: [], fetchStats: { maxInFlight: 0, answered: 0, timeouts: 0, httpErrors: 0, otherErrors: 0, waitingAtStartAnswered: 0, waitingAtStartTimeouts: 0 } })
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('StatusRefresher', () => {
  it('sets its alarm on a request when idle, and not again while that alarm is pending', async () => {
    const { kv } = memoryKv()
    const s = fakeState()
    const refresher = new StatusRefresher(s.state, { STATUS_CACHE: kv } as never)
    expect((await refresher.fetch()).status).toBe(202)
    expect(s.alarmAt()).toBe(T)
    expect((await refresher.fetch()).status).toBe(204)
  })

  it('writes the snapshot on every run and the daily counters at most once per counter interval', async () => {
    const { kv, puts, store } = memoryKv()
    const s = fakeState()
    const refresher = new StatusRefresher(s.state, { STATUS_CACHE: kv } as never)

    await refresher.alarm()
    expect(puts).toContain('services:latest')
    expect(puts).toContain('daily:2026-11-04')
    expect(JSON.parse(store.get('services:latest')!).cachedAt).toBe(iso(T))

    puts.length = 0
    vi.setSystemTime(T + REFRESH_MIN_GAP_MS)
    await refresher.alarm()
    expect(puts).toContain('services:latest')
    expect(puts).not.toContain('daily:2026-11-04')
    expect(JSON.parse(store.get('services:latest')!).cachedAt).toBe(iso(T + REFRESH_MIN_GAP_MS))

    puts.length = 0
    vi.setSystemTime(T + REFRESH_COUNTER_INTERVAL_MS)
    await refresher.alarm()
    expect(puts).toContain('daily:2026-11-04')
  })

  it('writes the upstream feeds of the run into the snapshot (#1072)', async () => {
    const feeds = [{ id: 'github', name: 'GitHub', status: 'degraded', incidents: [] }]
    fetchAllServices.mockResolvedValueOnce({ raw: SERVICES, enriched: SERVICES, pageComponents: {}, upstreamFeeds: feeds, fetchStats: { maxInFlight: 0, answered: 0, timeouts: 0, httpErrors: 0, otherErrors: 0, waitingAtStartAnswered: 0, waitingAtStartTimeouts: 0 } })
    const { kv, store } = memoryKv()
    await new StatusRefresher(fakeState().state, { STATUS_CACHE: kv } as never).alarm()
    expect(JSON.parse(store.get('services:latest')!).upstreamFeeds).toEqual(feeds)
  })

  it('records the run as finished when the fetch throws, so the next request can schedule one', async () => {
    fetchAllServices.mockRejectedValueOnce(new Error('boom'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { kv, puts } = memoryKv()
    const s = fakeState()
    const refresher = new StatusRefresher(s.state, { STATUS_CACHE: kv } as never)
    await refresher.alarm()
    expect(puts).toEqual([])
    expect(s.data.get('counterWriteAt')).toBeUndefined()
    vi.setSystemTime(T + REFRESH_MIN_GAP_MS)
    expect((await refresher.fetch()).status).toBe(202)
  })

  it('alerts the operator when the run throws', async () => {
    fetchAllServices.mockRejectedValueOnce(new Error('boom'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const posted: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => { posted.push(String(init.body)); return new Response(null, { status: 204 }) }))
    const { kv } = memoryKv()
    await new StatusRefresher(fakeState().state, { STATUS_CACHE: kv, DISCORD_WEBHOOK_URL: 'https://discord.example/hook' } as never).alarm()
    vi.unstubAllGlobals()
    expect(posted).toHaveLength(1)
    expect(posted[0]).toContain('Worker Error')
    expect(posted[0]).toContain('boom')
  })
})

describe('the daily counters and their archive', () => {
  it('cacheWrite (the /api/status path) writes the counters and archives yesterday into history:', async () => {
    vi.setSystemTime(Date.parse('2026-09-10T12:00:00Z'))
    const { kv, puts } = memoryKv({ 'daily:2026-09-09': JSON.stringify({ claude: { ok: 1, total: 1 } }) })
    expect(await cacheWrite(kv, SERVICES, [])).toBe(true)
    expect(puts).toEqual(expect.arrayContaining(['services:latest', 'daily:2026-09-10', 'history:2026-09-09']))
  })

  it('a refresher run that writes the counters archives yesterday into history:', async () => {
    vi.setSystemTime(Date.parse('2026-09-20T12:00:00Z'))
    const { kv, puts } = memoryKv({ 'daily:2026-09-19': JSON.stringify({ claude: { ok: 1, total: 1 } }) })
    await new StatusRefresher(fakeState().state, { STATUS_CACHE: kv } as never).alarm()
    expect(puts).toEqual(expect.arrayContaining(['daily:2026-09-20', 'history:2026-09-19']))
  })

  it('a refresher run that skips the counters does not archive', async () => {
    vi.setSystemTime(Date.parse('2026-09-25T12:00:00Z'))
    const { kv, puts } = memoryKv({ 'daily:2026-09-24': JSON.stringify({ claude: { ok: 1, total: 1 } }) })
    const s = fakeState()
    s.data.set('counterWriteAt', Date.now())
    await new StatusRefresher(s.state, { STATUS_CACHE: kv } as never).alarm()
    expect(puts).toEqual(['services:latest'])
  })
})

describe('StatusRefresher while a run is in progress', () => {
  it('does not set its alarm, so runs do not stack', async () => {
    let finish: (v: unknown) => void = () => {}
    fetchAllServices.mockReturnValueOnce(new Promise((r) => { finish = r }))
    const { kv } = memoryKv()
    const s = fakeState()
    const refresher = new StatusRefresher(s.state, { STATUS_CACHE: kv } as never)
    vi.setSystemTime(T + 10 * REFRESH_MIN_GAP_MS)
    const run = refresher.alarm()
    await vi.waitFor(() => expect(fetchAllServices).toHaveBeenCalled())
    vi.setSystemTime(T + 12 * REFRESH_MIN_GAP_MS)
    expect((await refresher.fetch()).status).toBe(204)
    expect(s.alarmAt()).toBeNull()
    finish({ raw: SERVICES, enriched: SERVICES, pageComponents: {}, upstreamFeeds: [], fetchStats: { maxInFlight: 0, answered: 0, timeouts: 0, httpErrors: 0, otherErrors: 0, waitingAtStartAnswered: 0, waitingAtStartTimeouts: 0 } })
    await run
    expect((await refresher.fetch()).status).toBe(202)
  })
})

describe('StatusRefresher checks for new status-page components (#992)', () => {
  const PAGE = 'https://status.example.com/api/v2/summary.json'
  it('alerts on a component the page did not have, and checks again only after the component interval', async () => {
    fetchAllServices.mockResolvedValue({ raw: SERVICES, enriched: SERVICES, pageComponents: { [PAGE]: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] }, upstreamFeeds: [], fetchStats: { maxInFlight: 0, answered: 0, timeouts: 0, httpErrors: 0, otherErrors: 0, waitingAtStartAnswered: 0, waitingAtStartTimeouts: 0 } })
    const posted: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { posted.push(`${url} ${String(init.body)}`); return new Response(null, { status: 204 }) }))
    const { kv, store } = memoryKv({ [`component-seen:${PAGE}`]: JSON.stringify(['a']) })
    const s = fakeState()
    const refresher = new StatusRefresher(s.state, { STATUS_CACHE: kv, DISCORD_WEBHOOK_URL: 'https://discord.example/hook' } as never)
    await refresher.alarm()
    expect(posted).toHaveLength(1)
    expect(posted[0]).toContain('New status-page component')
    expect([...store.keys()].some((k) => k.startsWith('discord-sent:'))).toBe(true)
    expect(JSON.parse(store.get(`component-seen:${PAGE}`)!)).toEqual(expect.arrayContaining(['a', 'b']))

    store.set(`component-seen:${PAGE}`, JSON.stringify(['a']))
    vi.setSystemTime(Date.now() + REFRESH_COMPONENT_INTERVAL_MS - 1)
    await refresher.alarm()
    expect(posted).toHaveLength(1)
    vi.setSystemTime(Date.now() + 1)
    await refresher.alarm()
    expect(posted).toHaveLength(2)
    vi.unstubAllGlobals()
  })
})

describe('/api/status/cached asks the refresher', () => {
  let clock = T + 3_600_000
  async function getCached(snapshotAgeMs: number, advanceMs = 10 * REFRESH_REQUEST_GAP_MS) {
    clock += advanceMs
    vi.setSystemTime(clock)
    ;(globalThis as unknown as { caches: unknown }).caches = { default: { match: async () => undefined, put: async () => {} } }
    const { kv } = memoryKv({ 'services:latest': JSON.stringify({ services: SERVICES, cachedAt: iso(clock - snapshotAgeMs) }) })
    const stubFetch = vi.fn(async () => new Response(null, { status: 202 }))
    const ns = { idFromName: (n: string) => n, get: () => ({ fetch: stubFetch }) }
    const waited: Promise<unknown>[] = []
    const res = await workerModule.fetch(
      new Request('https://example.com/api/status/cached', { headers: { Origin: 'https://ai-watch.dev' } }),
      { ALLOWED_ORIGIN: '*', STATUS_CACHE: kv, STATUS_REFRESHER: ns } as never,
      { waitUntil: (p: Promise<unknown>) => { waited.push(p) }, passThroughOnException: () => {} } as never,
    )
    await Promise.all(waited)
    return { status: res.status, stubFetch }
  }

  it('when the snapshot is stale', async () => {
    const { status, stubFetch } = await getCached(REFRESH_STALE_MS + 1_000)
    expect(status).toBe(200)
    expect(stubFetch).toHaveBeenCalledTimes(1)
  })

  it('not when the snapshot is fresh', async () => {
    const { status, stubFetch } = await getCached(1_000)
    expect(status).toBe(200)
    expect(stubFetch).not.toHaveBeenCalled()
  })

  it('at most once per request gap from one isolate', async () => {
    await getCached(REFRESH_STALE_MS + 1_000)
    const again = await getCached(REFRESH_STALE_MS + 1_000, REFRESH_REQUEST_GAP_MS - 1)
    expect(again.stubFetch).not.toHaveBeenCalled()
    const later = await getCached(REFRESH_STALE_MS + 1_000, 1)
    expect(later.stubFetch).toHaveBeenCalledTimes(1)
  })
})

describe('runStatusRefresh', () => {
  it('records its run on the status-fetch-run index as the refresh route', async () => {
    const rows: Array<{ blobs?: string[] }> = []
    const { kv } = memoryKv()
    await runStatusRefresh({ STATUS_CACHE: kv, ANALYTICS: { writeDataPoint: (r: { blobs?: string[] }) => { rows.push(r) } } } as never, false, false)
    expect(rows.some((r) => r.blobs?.[0] === 'refresh')).toBe(true)
  })

  it('writes nothing when the fetch returned no services', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    fetchAllServices.mockResolvedValueOnce({ raw: [], enriched: [], pageComponents: {}, upstreamFeeds: [], fetchStats: { maxInFlight: 0, answered: 0, timeouts: 0, httpErrors: 0, otherErrors: 0, waitingAtStartAnswered: 0, waitingAtStartTimeouts: 0 } })
    const { kv, puts } = memoryKv()
    await runStatusRefresh({ STATUS_CACHE: kv } as never, true, false)
    expect(puts).toEqual([])
  })
})
