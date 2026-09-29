// #1531 — `/api/status/cached?series=0` through the real route: the Edge pages get the payload without
// the time series, and the default response the SPA reads keeps both.

import { describe, it, expect, vi, afterEach } from 'vitest'
import workerModule from '../index'
import type { ServiceStatus } from '../types'

const SNAPSHOT = { t: '2026-09-29T14:45:00Z', data: { claude: { status: 401, rtt: 120 } } }

function makeEnv() {
  const reads: string[] = []
  const store = new Map<string, string>([
    ['services:latest', JSON.stringify({
      services: [{
        id: 'claude', name: 'Claude API', provider: 'Anthropic', category: 'api', status: 'operational',
        latency: null, uptime30d: 99.9, lastChecked: '2026-09-29T14:45:00Z', incidents: [],
      } as unknown as ServiceStatus],
      cachedAt: '2026-09-29T14:45:00Z',
    })],
    ['probe:24h', JSON.stringify({ snapshots: [SNAPSHOT] })],
    ['latency:24h', JSON.stringify({ snapshots: [{ t: SNAPSHOT.t, data: { claude: 120 } }] })],
  ])
  const kv = {
    get: async (k: string) => { reads.push(k); return store.get(k) ?? null },
    getWithMetadata: async (k: string) => { reads.push(k); return { value: store.get(k) ?? null, metadata: null } },
    put: async () => {}, delete: async () => {}, list: async () => ({ keys: [], list_complete: true }),
  } as unknown as KVNamespace
  return { env: { ALLOWED_ORIGIN: '*', STATUS_CACHE: kv } as unknown as Parameters<typeof workerModule.fetch>[1], reads }
}

async function get(query: string) {
  const { env, reads } = makeEnv()
  const res = await workerModule.fetch(
    new Request(`https://example.com/api/status/cached${query}`),
    env,
    { waitUntil: (p: Promise<unknown>) => { void p.catch(() => {}) }, passThroughOnException: () => {} } as never,
  )
  return { status: res.status, body: await res.json() as Record<string, unknown>, reads }
}

describe('/api/status/cached time series (#1531)', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('default response carries probe24h + latency24h (the SPA reads both)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { status, body, reads } = await get('')
    expect(status).toBe(200)
    expect(body.probe24h).toEqual([SNAPSHOT])
    expect(body.latency24h).toHaveLength(1)
    expect(reads).toContain('probe:24h')
    expect(reads).toContain('latency:24h')
  }, 60_000)

  it('?series=0 omits both keys and never reads them from KV', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { status, body, reads } = await get('?series=0')
    expect(status).toBe(200)
    expect(body).not.toHaveProperty('probe24h')
    expect(body).not.toHaveProperty('latency24h')
    expect(reads).not.toContain('probe:24h')
    expect(reads).not.toContain('latency:24h')
    expect((body.services as unknown[]).length).toBe(1)
  }, 60_000)
})
