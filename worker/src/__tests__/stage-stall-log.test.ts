import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { recordStageStall, stageStallContext, stageStallPoint } from '../stage-stall-log'
import workerModule from '../index'
import type { StageWatchdogLine } from '../stage-watchdog'
import type { ServiceStatus } from '../types'

const line = (over: Partial<StageWatchdogLine> = {}): StageWatchdogLine => ({
  event: 'stage-watchdog', route: 'status-cached', afterMs: 3000, done: {}, pending: [], ...over,
})
const CTX = { colo: 'FRA', view: 'is-down', id: 'junie' }

describe('stageStallPoint', () => {
  it('lays out a line with several done stages and one pending', () => {
    expect(stageStallPoint(line({ done: { 'edge-cache': 34, snapshot: 179 }, pending: ['security'] }), CTX)).toEqual({
      indexes: ['stage-stall:status-cached'],
      blobs: ['status-cached', 'security', 'FRA', 'is-down', 'junie', '{"edge-cache":34,"snapshot":179}'],
      doubles: [3000],
    })
  })

  it('keeps a line with nothing done and several pending stages', () => {
    const p = stageStallPoint(line({ pending: ['snapshot', 'series'] }), { colo: 'BOM', view: '', id: '' })
    expect(p.blobs).toEqual(['status-cached', 'snapshot,series', 'BOM', '', '', '{}'])
  })
})

describe('recordStageStall', () => {
  it('does nothing without a binding', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => recordStageStall(undefined, line(), CTX)).not.toThrow()
    expect(warn).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it('swallows a write that throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const analytics = { writeDataPoint: () => { throw new Error('boom') } } as unknown as AnalyticsEngineDataset
    expect(() => recordStageStall(analytics, line(), CTX)).not.toThrow()
    expect(warn).toHaveBeenCalledWith('[wae] stage-stall writeDataPoint failed:', 'boom')
    vi.restoreAllMocks()
  })
})

describe('stageStallContext', () => {
  it('reads colo, view and id from the request', () => {
    const req = new Request('https://x/api/status/cached?series=0&view=is-down&id=grokbot')
    Object.defineProperty(req, 'cf', { value: { colo: 'SIN' } })
    expect(stageStallContext(req, new URL(req.url))).toEqual({ colo: 'SIN', view: 'is-down', id: 'grokbot' })
  })

  it('falls back to UNK and empty strings', () => {
    const req = new Request('https://x/api/status/cached?series=0')
    expect(stageStallContext(req, new URL(req.url))).toEqual({ colo: 'UNK', view: '', id: '' })
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
  const points: AnalyticsEngineDataPoint[] = []
  const ANALYTICS = { writeDataPoint: (p: AnalyticsEngineDataPoint) => { points.push(p) } }
  return { env: { ALLOWED_ORIGIN: '*', STATUS_CACHE: kv, ANALYTICS } as unknown as Parameters<typeof workerModule.fetch>[1], release, points }
}

describe('/api/status/cached stall record (#1934)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    ;(globalThis as unknown as { caches: unknown }).caches = { default: { match: async () => undefined, put: async () => {} } }
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  const fetchCached = (env: Parameters<typeof workerModule.fetch>[1]) => {
    const req = new Request('https://example.com/api/status/cached?series=0&view=is-down&id=claude')
    Object.defineProperty(req, 'cf', { value: { colo: 'EWR' } })
    return workerModule.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} } as never)
  }
  const stalls = (points: AnalyticsEngineDataPoint[]) => points.filter((p) => p.indexes?.[0] === 'stage-stall:status-cached')

  it('a stalled stage writes exactly one point, with the colo and the requested view', async () => {
    const { env, release, points } = makeEnv('incident:recovery-baseline')
    const res = fetchCached(env)
    await vi.advanceTimersByTimeAsync(3000)
    const written = stalls(points)
    expect(written).toHaveLength(1)
    expect(written[0].blobs?.slice(0, 5)).toEqual(['status-cached', 'recovery-baseline', 'EWR', 'is-down', 'claude'])
    release()
    expect((await res).status).toBe(200)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(stalls(points)).toHaveLength(1)
  })

  it('a request that finishes in time writes none', async () => {
    const { env, points } = makeEnv(null)
    expect((await fetchCached(env)).status).toBe(200)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(stalls(points)).toHaveLength(0)
  })
})
