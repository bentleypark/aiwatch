// #1701 — /feed closes an incident it served while counted after it moves to `referenceIncidents`, and
// never opens or closes one it cannot confirm it served.
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ServiceStatus } from '../services'
import { buildFeedWithMeta } from '../rss'
import { TEST_TIMEOUT_MS } from './helpers/unreadable-source'

vi.mock('../services', async () => {
  const actual = await vi.importActual<typeof import('../services')>('../services')
  return { ...actual, fetchAllServices: vi.fn() }
})

import workerModule from '../index'
import { SERVICES, CACHE_KEY } from '../services'

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()
const inc = (id: string, status: string) => ({
  id, title: 'Web app degraded', status, impact: 'minor', duration: status === 'resolved' ? '1h 0m' : null, timeline: [],
  startedAt: minutesAgo(70), resolvedAt: status === 'resolved' ? minutesAgo(10) : null,
})

async function feed(openrouter: Record<string, unknown>, seed: Record<string, string>, throwOn: string[] = []) {
  const services = SERVICES.map((s) => ({
    id: s.id, name: s.name, provider: s.provider, category: s.category, status: 'operational', incidents: [],
    ...(s.id === 'openrouter' ? openrouter : {}),
  })) as unknown as ServiceStatus[]
  const store = new Map<string, string>(Object.entries(seed))
  const reads: string[] = []
  store.set(CACHE_KEY, JSON.stringify({ services, upstreamFeeds: [], cachedAt: new Date().toISOString() }))
  const kv = {
    get: async (key: string) => { reads.push(key); if (throwOn.includes(key)) throw new Error('kv blip'); return store.get(key) ?? null },
    getWithMetadata: async () => ({ value: null, metadata: null }),
    put: async (key: string, value: string) => { store.set(key, value) },
    delete: async (key: string) => { store.delete(key) },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
  } as unknown as KVNamespace
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const res = await workerModule.fetch(new Request('https://aiwatch-worker.example/feed.xml'), { STATUS_CACHE: kv } as never, ctx)
  return { xml: await res.text(), warns: warn.mock.calls.map((c) => c.join(' ')), reads }
}

describe('#1701 /feed and incidents in referenceIncidents', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('closes a served one with its resolved item and AI prediction line', async () => {
    const analysis = JSON.stringify({ summary: 'S', estimatedRecovery: '~2h', estimatedRecoveryHours: 2, firstEstimatedRecoveryHours: 2, affectedScope: [] })
    const { xml } = await feed({ referenceIncidents: [inc('refR', 'resolved')] }, { 'feed:active-emitted:refR': '1', 'ai:analysis:openrouter:refR': analysis })
    expect(xml).toContain('openrouter:refR:resolved')
    expect(xml).toContain('AI prediction')
  }, TEST_TIMEOUT_MS)

  it('does not close one it cannot confirm it served, and says so', async () => {
    const { xml, warns } = await feed({ referenceIncidents: [inc('refR', 'resolved')] }, {}, ['feed:active-emitted:refR'])
    expect(xml).not.toContain('refR')
    expect(warns.some((w) => w.includes('refR') && w.includes('not emitting'))).toBe(true)
  }, TEST_TIMEOUT_MS)

  it('still fails open for a counted incident', async () => {
    const { xml } = await feed({ incidents: [inc('cntR', 'resolved')] }, {}, ['feed:active-emitted:cntR'])
    expect(xml).toContain('openrouter:cntR:resolved')
  }, TEST_TIMEOUT_MS)

  it('never opens an active item for an open one, and reads nothing for it', async () => {
    const { xml, reads } = await feed({ referenceIncidents: [inc('refOpen', 'investigating')] }, { 'feed:active-emitted:refOpen': '1' })
    expect(xml).not.toContain('refOpen')
    expect(reads.filter((k) => k.includes('refOpen'))).toEqual([])
  }, TEST_TIMEOUT_MS)

  it('a direct render without servedActive emits nothing for one', () => {
    const svc = { id: 'openrouter', name: 'OpenRouter', provider: 'OpenRouter', category: 'api', status: 'operational', incidents: [], referenceIncidents: [inc('refR', 'resolved')] } as unknown as ServiceStatus
    expect(buildFeedWithMeta([svc], { scope: 'all' }).xml).not.toContain('refR')
  })

  it('a direct render never opens one, even when servedActive lists it', () => {
    const svc = { id: 'openrouter', name: 'OpenRouter', provider: 'OpenRouter', category: 'api', status: 'operational', incidents: [], referenceIncidents: [inc('refOpen', 'investigating')] } as unknown as ServiceStatus
    expect(buildFeedWithMeta([svc], { scope: 'all' }, new Date(), undefined, undefined, new Set(['refOpen'])).xml).not.toContain('refOpen')
  })

  it('leaves an incident another service counts to that service', () => {
    const claude = { id: 'claude', name: 'Claude API', provider: 'Anthropic', category: 'api', status: 'operational', incidents: [], referenceIncidents: [inc('X', 'resolved')] } as unknown as ServiceStatus
    const claudeai = { id: 'claudeai', name: 'claude.ai', provider: 'Anthropic', category: 'app', status: 'operational', incidents: [inc('X', 'resolved')] } as unknown as ServiceStatus
    const served = new Set(['X'])
    const all = buildFeedWithMeta([claude, claudeai], { scope: 'all' }, new Date(), undefined, undefined, served).xml
    expect(all).toContain('aiwatch:claudeai:X:resolved')
    expect(all).not.toContain('aiwatch:claude:X')
    const own = buildFeedWithMeta([claude, claudeai], { scope: 'service', service: claude }, new Date(), undefined, undefined, served).xml
    expect(own).not.toContain('X:resolved')
  })
})
