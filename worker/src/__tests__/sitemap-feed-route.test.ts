import { describe, it, expect, vi, beforeEach } from 'vitest'
import workerModule from '../index'
import type { ServiceStatus } from '../types'

// #887 — the route serves the projection; a missing branch would fall through to the full payload,
// which carries no lastChangedAt, and the sitemap would lose every lastmod with no error.
const SERVICES = [{
  id: 'claude', name: 'Claude API', provider: 'Anthropic', category: 'api', status: 'operational',
  latency: null, uptime30d: 99.9, lastChecked: new Date(0).toISOString(),
  incidents: [{ id: 'a', title: 'x', status: 'resolved', impact: 'minor', startedAt: '2026-10-25T08:00:00.000Z',
    resolvedAt: '2026-10-25T09:00:00.000Z', duration: '1h', timeline: [] }],
}] as unknown as ServiceStatus[]

function envWith(snapshot: unknown) {
  const store = new Map<string, string>(snapshot ? [['services:latest', JSON.stringify(snapshot)]] : [])
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    getWithMetadata: async (k: string) => ({ value: store.get(k) ?? null, metadata: null }),
    list: async () => ({ keys: [], list_complete: true }),
    put: async () => {}, delete: async () => {},
  } as unknown as KVNamespace
  return { ALLOWED_ORIGIN: '*', STATUS_CACHE: kv } as unknown as Parameters<typeof workerModule.fetch>[1]
}

const fetchSitemapFeed = (env: Parameters<typeof workerModule.fetch>[1]) => workerModule.fetch(
  new Request('https://example.com/api/status/cached?src=sitemap'), env,
  { waitUntil: () => {}, passThroughOnException: () => {} } as never,
)

describe('/api/status/cached?src=sitemap (#887)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('answers with each service\'s lastChangedAt and nothing else', async () => {
    const res = await fetchSitemapFeed(envWith({ services: SERVICES, cachedAt: '2026-10-26T00:00:00.000Z' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ services: [{ id: 'claude', lastChangedAt: '2026-10-25T09:00:00.000Z' }] })
  })

  it('answers 503 no-store when there is no snapshot', async () => {
    const res = await fetchSitemapFeed(envWith(null))
    expect(res.status).toBe(503)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })
})
