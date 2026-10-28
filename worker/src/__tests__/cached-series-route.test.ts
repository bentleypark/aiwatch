// #1531 — `/api/status/cached?series=0` through the real route: the Edge pages get the payload without
// the probe time series, and the default response the SPA reads keeps it.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import workerModule from '../index'
import type { ServiceStatus } from '../types'

const SNAPSHOT = { t: '2026-09-29T14:45:00Z', data: { claude: { status: 401, rtt: 120 } } }

function makeEnv(opts: { snapshot?: boolean; snapshotDelayMs?: number } = {}) {
  const reads: string[] = []
  const store = new Map<string, string>([
    ['probe:24h', JSON.stringify({ snapshots: [SNAPSHOT] })],
  ])
  if (opts.snapshot !== false) {
    store.set('services:latest', JSON.stringify({
      services: [{
        id: 'claude', name: 'Claude API', provider: 'Anthropic', category: 'api', status: 'operational',
        latency: null, uptime30d: 99.9, lastChecked: '2026-09-29T14:45:00Z', incidents: [],
      } as unknown as ServiceStatus],
      cachedAt: '2026-09-29T14:45:00Z',
    }))
  }
  const stall = (k: string) => k === 'services:latest' && opts.snapshotDelayMs ? new Promise((r) => setTimeout(r, opts.snapshotDelayMs)) : Promise.resolve()
  const kv = {
    get: async (k: string) => { reads.push(k); await stall(k); return store.get(k) ?? null },
    getWithMetadata: async (k: string) => { reads.push(k); await stall(k); return { value: store.get(k) ?? null, metadata: null } },
    put: async () => {}, delete: async () => {}, list: async () => ({ keys: [], list_complete: true }),
  } as unknown as KVNamespace
  return { env: { ALLOWED_ORIGIN: '*', STATUS_CACHE: kv } as unknown as Parameters<typeof workerModule.fetch>[1], reads }
}

let edgeCache: Map<string, Response>
let puts: string[]

beforeEach(() => {
  edgeCache = new Map()
  puts = []
  ;(globalThis as unknown as { caches: unknown }).caches = {
    default: {
      match: async (req: Request) => edgeCache.get(req.url)?.clone(),
      put: async (req: Request, res: Response) => { puts.push(req.url); edgeCache.set(req.url, res) },
    },
  }
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks() })

async function get(query: string, opts: { origin?: string; snapshot?: boolean; snapshotDelayMs?: number } = {}) {
  const { env, reads } = makeEnv(opts)
  const pending: Promise<unknown>[] = []
  const res = await workerModule.fetch(
    new Request(`https://example.com/api/status/cached${query}`, opts.origin ? { headers: { Origin: opts.origin } } : {}),
    env,
    { waitUntil: (p: Promise<unknown>) => { pending.push(p.catch(() => {})) }, passThroughOnException: () => {} } as never,
  )
  await Promise.all(pending)
  return { status: res.status, body: await res.json() as Record<string, unknown>, reads }
}

describe('/api/status/cached time series (#1531)', () => {
  it('default response carries probe24h and no latency24h (#1636)', async () => {
    const { status, body, reads } = await get('')
    expect(status).toBe(200)
    expect(body.probe24h).toEqual([SNAPSHOT])
    expect(body).not.toHaveProperty('latency24h')
    expect(reads).toContain('probe:24h')
    expect(reads).not.toContain('latency:24h')
  }, 60_000)

  it('?series=0 omits probe24h and never reads it from KV', async () => {
    const { status, body, reads } = await get('?series=0')
    expect(status).toBe(200)
    expect(body).not.toHaveProperty('probe24h')
    expect(reads).not.toContain('probe:24h')
    expect((body.services as unknown[]).length).toBe(1)
  }, 60_000)
})

describe('/api/status/cached?series=0 edge cache (#1531 part 2)', () => {
  it('a second Edge request inside the window is answered from caches.default with no KV reads', async () => {
    const first = await get('?series=0')
    expect(first.reads.length).toBeGreaterThan(0)
    const second = await get('?series=0')
    expect(second.status).toBe(200)
    expect(second.reads).toEqual([])
    expect(second.body).toEqual(first.body)
  }, 60_000)

  it('incidental query params share the one canonical entry', async () => {
    await get('?series=0&v=123')
    const second = await get('?series=0')
    expect(second.reads).toEqual([])
  }, 60_000)

  it('a request carrying an Origin bypasses the shared entry (its CORS headers are per-origin)', async () => {
    await get('?series=0')
    const browser = await get('?series=0', { origin: 'https://ai-watch.dev' })
    expect(browser.reads.length).toBeGreaterThan(0)
    expect(puts).toHaveLength(1)
  }, 60_000)

  it('the default response is never written to the edge cache', async () => {
    await get('')
    expect(puts).toEqual([])
  }, 60_000)

  it('a no-snapshot 503 is not cached', async () => {
    const miss = await get('?series=0', { snapshot: false })
    expect(miss.status).toBe(503)
    expect(puts).toEqual([])
  }, 60_000)
})

describe('/api/status/cached?series=0 stalled edge-cache lookup (#1531)', () => {
  it('a caches.default.match that never settles falls through to the KV snapshot', async () => {
    ;(globalThis as unknown as { caches: unknown }).caches = {
      default: { match: () => new Promise(() => {}), put: async () => {} },
    }
    const warn = vi.mocked(console.warn)
    const started = Date.now()
    const { status, body, reads } = await get('?series=0')
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(status).toBe(200)
    expect((body.services as unknown[]).length).toBe(1)
    expect(reads).toContain('services:latest')
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'edge-cache-timeout' }))
  }, 60_000)

  it('a later stall is not blamed on the abandoned lookup in the stage-watchdog line', async () => {
    ;(globalThis as unknown as { caches: unknown }).caches = {
      default: { match: () => new Promise(() => {}), put: async () => {} },
    }
    const warn = vi.mocked(console.warn)
    await get('?series=0', { snapshotDelayMs: 3_500 })
    const line = warn.mock.calls.map((c) => c[0]).find((l) => (l as { event?: string })?.event === 'stage-watchdog') as { pending: string[]; done: Record<string, number> }
    expect(line.pending).toEqual(['snapshot'])
    expect(line.done).toHaveProperty('edge-cache')
  }, 60_000)
})

describe('/api/status/cached?series=0&view= (#1831)', () => {
  it('a view is cut from the payload it builds, and the full payload is what the edge cache keeps', async () => {
    const { status, body } = await get('?series=0&view=is-down&id=claude')
    expect(status).toBe(200)
    expect((body.services as Array<{ id: string }>).map((s) => s.id)).toEqual(['claude'])
    expect(body).toHaveProperty('fallbacks')
    expect(puts).toEqual(['https://example.com/api/status/cached?series=0'])
    const full = await get('?series=0')
    expect(full.reads).toEqual([])
    expect(full.body).not.toHaveProperty('fallbacks')
  }, 60_000)

  it('a view is cut from the edge-cache entry with no KV reads', async () => {
    await get('?series=0')
    const { status, body, reads } = await get('?series=0&view=is-down&id=claude')
    expect(status).toBe(200)
    expect(reads).toEqual([])
    expect((body.services as Array<{ id: string }>).map((s) => s.id)).toEqual(['claude'])
    expect(body).toHaveProperty('fallbacks')
  }, 60_000)
})
