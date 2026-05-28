import { describe, it, expect, vi } from 'vitest'
import {
  kindFromKey,
  svcIdsForAlert,
  buildFeedEntry,
  appendAlertFeed,
  readAlertFeed,
  ALERT_FEED_KEY,
  type AlertFeedEntry,
} from '../alert-feed'
import type { ServiceStatus } from '../services'

function mockKV(store: Record<string, string> = {}) {
  return {
    get: vi.fn(async (k: string) => store[k] ?? null),
    put: vi.fn(async (k: string, v: string) => { store[k] = v }),
  } as unknown as KVNamespace
}

const svc = (id: string, incIds: string[] = [], incStatus = 'investigating'): ServiceStatus => ({
  id,
  name: id,
  status: 'operational',
  incidents: incIds.map((iid) => ({ id: iid, title: `${iid} title`, status: incStatus, startedAt: '2026-05-28T00:00:00Z' })),
} as unknown as ServiceStatus)

describe('kindFromKey', () => {
  it('maps each operator dedup-key prefix to its kind', () => {
    expect(kindFromKey('alerted:new:inc1')).toBe('new')
    expect(kindFromKey('alerted:res:inc1')).toBe('resolved')
    expect(kindFromKey('alerted:down:openai')).toBe('down')
    expect(kindFromKey('alerted:degraded:openai')).toBe('degraded')
    expect(kindFromKey('alerted:recovered:openai')).toBe('recovered')
  })
  it('returns null for operator-only / unknown keys', () => {
    expect(kindFromKey('alerted:flap:openai:foo')).toBeNull()
    expect(kindFromKey('alert:count:2026-05-28')).toBeNull()
    expect(kindFromKey('whatever')).toBeNull()
  })
})

describe('svcIdsForAlert', () => {
  it('status keys → the svcId tail', () => {
    expect(svcIdsForAlert(['alerted:down:openai'], 'down', [])).toEqual(['openai'])
    expect(svcIdsForAlert(['alerted:degraded:claude'], 'degraded', [])).toEqual(['claude'])
    expect(svcIdsForAlert(['alerted:recovered:gemini'], 'recovered', [])).toEqual(['gemini'])
  })

  it('incident keys → services whose incidents include the incId', () => {
    const services = [svc('claude', ['inc1']), svc('claudeai', ['inc1']), svc('openai', ['inc9'])]
    expect(svcIdsForAlert(['alerted:new:inc1'], 'new', services).sort()).toEqual(['claude', 'claudeai'])
    expect(svcIdsForAlert(['alerted:res:inc9'], 'resolved', services)).toEqual(['openai'])
  })

  it('resolved-kind resolves svcIds from a resolved-status incident (still present in the snapshot)', () => {
    // Locks the status-agnostic contract: a resolved alert is built from an incident whose status is
    // 'resolved' but still in svc.incidents — alertTarget:'custom' filtering must still find it.
    const services = [svc('cohere', ['incR'], 'resolved')]
    expect(svcIdsForAlert(['alerted:res:incR'], 'resolved', services)).toEqual(['cohere'])
  })

  it('handles incident ids that themselves contain colons (aistudio:/vertex:)', () => {
    const services = [svc('aistudio', ['aistudio:abc:123'])]
    expect(svcIdsForAlert(['alerted:new:aistudio:abc:123'], 'new', services)).toEqual(['aistudio'])
  })

  it('unions _mergedKeys (Together AI grouping) and dedups', () => {
    const services = [svc('together', ['m1', 'm2'])]
    expect(svcIdsForAlert(['alerted:new:m1', 'alerted:new:m2'], 'new', services)).toEqual(['together'])
    // status merge keys → unique svcId tails (same id collapses)
    expect(svcIdsForAlert(['alerted:down:together', 'alerted:down:together'], 'down', [])).toEqual(['together'])
    // status merge across DISTINCT svcIds → both, deduped, order preserved
    expect(svcIdsForAlert(['alerted:down:openai', 'alerted:down:claude'], 'down', [])).toEqual(['openai', 'claude'])
  })
})

describe('buildFeedEntry', () => {
  it('builds an entry mirroring the operator embed', () => {
    const services = [svc('claude', ['inc1'])]
    const entry = buildFeedEntry(
      { key: 'alerted:new:inc1', title: '🔴 Claude — New Incident', color: 0xED4245 },
      'API errors\n┈┈┈\n[View on AIWatch](https://ai-watch.dev/#claude)',
      services,
      1000,
    )
    expect(entry).toEqual({
      key: 'alerted:new:inc1',
      kind: 'new',
      svcIds: ['claude'],
      embed: { title: '🔴 Claude — New Incident', description: 'API errors\n┈┈┈\n[View on AIWatch](https://ai-watch.dev/#claude)', color: 0xED4245 },
      ts: 1000,
    })
  })

  it('returns null for an unknown (operator-only) alert key', () => {
    expect(buildFeedEntry({ key: 'alert:count:x', title: 't', color: 1 }, 'd', [])).toBeNull()
  })
})

describe('appendAlertFeed + readAlertFeed', () => {
  const entry = (key: string, ts: number): AlertFeedEntry => ({
    key, kind: 'new', svcIds: ['claude'], embed: { title: key, description: 'd', color: 1 }, ts,
  })

  it('no-ops on empty entries (no KV write)', async () => {
    const kv = mockKV()
    await appendAlertFeed(kv, [], 1000)
    expect((kv.put as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  it('appends and round-trips through readAlertFeed', async () => {
    const store: Record<string, string> = {}
    const kv = mockKV(store)
    const now = 10_000
    await appendAlertFeed(kv, [entry('alerted:new:a', now)], now)
    const read = await readAlertFeed(kv, 30 * 60_000, now)
    expect(read.map((e) => e.key)).toEqual(['alerted:new:a'])
    expect(store[ALERT_FEED_KEY]).toBeTruthy()
  })

  it('merges with existing entries on append', async () => {
    const store: Record<string, string> = {}
    const kv = mockKV(store)
    await appendAlertFeed(kv, [entry('alerted:new:a', 1000)], 1000)
    await appendAlertFeed(kv, [entry('alerted:new:b', 2000)], 2000)
    const read = await readAlertFeed(kv, 30 * 60_000, 2000)
    expect(read.map((e) => e.key)).toEqual(['alerted:new:a', 'alerted:new:b'])
  })

  it('prunes entries older than 2h on write', async () => {
    const store: Record<string, string> = {}
    const kv = mockKV(store)
    const t0 = 0
    await appendAlertFeed(kv, [entry('old', t0)], t0)
    const later = t0 + 2 * 3600_000 + 1
    await appendAlertFeed(kv, [entry('fresh', later)], later)
    const read = await readAlertFeed(kv, 3 * 3600_000, later)
    expect(read.map((e) => e.key)).toEqual(['fresh'])
  })

  it('readAlertFeed filters to the requested window', async () => {
    const store: Record<string, string> = {}
    const kv = mockKV(store)
    const now = 100 * 60_000
    await appendAlertFeed(kv, [entry('stale', now - 40 * 60_000), entry('recent', now - 5 * 60_000)], now)
    const read = await readAlertFeed(kv, 30 * 60_000, now)
    expect(read.map((e) => e.key)).toEqual(['recent'])
  })

  it('caps stored entries at 50 (size guard)', async () => {
    const store: Record<string, string> = {}
    const kv = mockKV(store)
    const now = 1000
    const many = Array.from({ length: 60 }, (_, i) => entry(`k${i}`, now))
    await appendAlertFeed(kv, many, now)
    const stored = JSON.parse(store[ALERT_FEED_KEY]) as AlertFeedEntry[]
    expect(stored).toHaveLength(50)
    expect(stored[stored.length - 1].key).toBe('k59') // keeps the newest tail
  })

  it('prunes stale entries BEFORE capping, so stale entries do not consume cap slots', async () => {
    const store: Record<string, string> = {}
    const kv = mockKV(store)
    const now = 10 * 3600_000 // 10h, so the stale batch is well past the 2h prune horizon
    // Pre-seed 50 stale entries (all >2h old) directly.
    const stale = Array.from({ length: 50 }, (_, i) => entry(`stale${i}`, now - 5 * 3600_000))
    store[ALERT_FEED_KEY] = JSON.stringify(stale)
    // Append 3 fresh — prune must drop all 50 stale first so the 3 fresh survive (not evicted by cap).
    await appendAlertFeed(kv, [entry('f1', now), entry('f2', now), entry('f3', now)], now)
    const stored = JSON.parse(store[ALERT_FEED_KEY]) as AlertFeedEntry[]
    expect(stored.map((e) => e.key)).toEqual(['f1', 'f2', 'f3'])
  })

  it('readAlertFeed returns [] when key missing or unparseable', async () => {
    expect(await readAlertFeed(mockKV(), 30 * 60_000, 0)).toEqual([])
    expect(await readAlertFeed(mockKV({ [ALERT_FEED_KEY]: 'not json' }), 30 * 60_000, 0)).toEqual([])
  })

  it('appendAlertFeed recovers if existing feed is corrupt (starts fresh)', async () => {
    const store: Record<string, string> = { [ALERT_FEED_KEY]: '{bad' }
    const kv = mockKV(store)
    await appendAlertFeed(kv, [entry('alerted:new:a', 1000)], 1000)
    const read = await readAlertFeed(kv, 30 * 60_000, 1000)
    expect(read.map((e) => e.key)).toEqual(['alerted:new:a'])
  })
})
