import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { startStageWatchdog } from '../stage-watchdog'
import workerModule from '../index'
import type { ServiceStatus } from '../types'

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }) })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('startStageWatchdog', () => {
  it('at afterMs, names the stages still pending and when each finished one settled', async () => {
    const log = vi.fn()
    const wd = startStageWatchdog('r', 3000, log)
    let release!: () => void
    wd.track('slow', new Promise<void>((r) => { release = r }))
    wd.track('fast', new Promise((r) => setTimeout(r, 40)))
    wd.track('failed', Promise.reject(new Error('x'))).catch(() => {})
    await vi.advanceTimersByTimeAsync(3000)
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith({ event: 'stage-watchdog', route: 'r', afterMs: 3000, done: { fast: 40, failed: 0 }, pending: ['slow'] })
    release()
  })

  it('stays silent when stopped before afterMs', async () => {
    const log = vi.fn()
    const wd = startStageWatchdog('r', 3000, log)
    await wd.track('a', Promise.resolve(1))
    wd.stop()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(log).not.toHaveBeenCalled()
  })
})

const SERVICES = [{
  id: 'claude', name: 'Claude API', provider: 'Anthropic', category: 'api', status: 'operational',
  latency: null, uptime30d: 99.9, lastChecked: new Date(0).toISOString(), incidents: [],
}] as unknown as ServiceStatus[]

function makeEnv(stall: string | null) {
  const store = new Map<string, string>([
    ['services:latest', JSON.stringify({ services: SERVICES, cachedAt: new Date(0).toISOString() })],
    ['probe:summaries', JSON.stringify([])],
  ])
  let release!: () => void
  const stalled = new Promise<void>((r) => { release = r })
  const answer = async <T>(key: string, value: () => T) => {
    if (key === stall) await stalled
    return value()
  }
  const kv = {
    get: (k: string) => answer(k, () => store.get(k) ?? null),
    getWithMetadata: (k: string) => answer(k, () => ({ value: store.get(k) ?? null, metadata: null })),
    list: ({ prefix }: { prefix: string }) => answer(`list:${prefix}`, () => ({ keys: [], list_complete: true })),
    put: async () => {}, delete: async () => {},
  } as unknown as KVNamespace
  return { env: { ALLOWED_ORIGIN: '*', STATUS_CACHE: kv } as unknown as Parameters<typeof workerModule.fetch>[1], release }
}

describe('/api/status/cached stage watchdog (#1531)', () => {
  let warn: { mock: { calls: unknown[][] } }
  beforeEach(() => {
    ;(globalThis as unknown as { caches: unknown }).caches = { default: { match: async () => undefined, put: async () => {} } }
    vi.spyOn(console, 'log').mockImplementation(() => {})
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  const watchdogLines = () => warn.mock.calls.map(([line]) => line).filter((l: unknown) => (l as { event?: string })?.event === 'stage-watchdog')
  const fetchCached = (env: Parameters<typeof workerModule.fetch>[1], query = '?series=0') => workerModule.fetch(
    new Request(`https://example.com/api/status/cached${query}`), env,
    { waitUntil: () => {}, passThroughOnException: () => {} } as never,
  )

  it('a request still waiting at 3 s logs the stage it is waiting on, before it ends', async () => {
    const { env, release } = makeEnv('alert:feed:recent')
    const res = fetchCached(env)
    await vi.advanceTimersByTimeAsync(3000)
    const lines = watchdogLines()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ route: 'status-cached', pending: ['alert-feed'] })
    expect(Object.keys((lines[0] as { done: object }).done).sort())
      .toEqual(['analyses', 'edge-cache', 'probe-summaries', 'report-feed', 'security', 'snapshot'])
    release()
    expect((await res).status).toBe(200)
  })

  it('the default path tracks its time-series read', async () => {
    const { env, release } = makeEnv('probe:24h')
    const res = fetchCached(env, '')
    await vi.advanceTimersByTimeAsync(3000)
    expect(watchdogLines()).toMatchObject([{ pending: ['series'] }])
    release()
    expect((await res).status).toBe(200)
  })

  it('a request that finishes in time logs nothing', async () => {
    const { env } = makeEnv(null)
    expect((await fetchCached(env)).status).toBe(200)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(watchdogLines()).toHaveLength(0)
  })
})
