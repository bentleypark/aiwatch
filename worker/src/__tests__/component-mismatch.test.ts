import { describe, it, expect, vi } from 'vitest'
import { COMPONENT_ID_SERVICES, SERVICES } from '../services'
import { detectComponentMismatches, TRACKING_ALERT_STALE_MS, TRACKING_COUNT_DECAY_MS, type KVLike } from '../utils'

function mockKV(store: Record<string, string> = {}): KVLike {
  return {
    get: vi.fn(async (key: string) => store[key] ?? null),
    put: vi.fn(async (key: string, value: string) => { store[key] = value }),
    delete: vi.fn(async (key: string) => { delete store[key] }),
  }
}

describe('COMPONENT_ID_SERVICES', () => {
  it('contains only services with statusComponentId', () => {
    expect(COMPONENT_ID_SERVICES.length).toBeGreaterThan(0)
    for (const svc of COMPONENT_ID_SERVICES) {
      expect(svc.statusComponentId).toBeTruthy()
      expect(svc.id).toBeTruthy()
      expect(svc.name).toBeTruthy()
    }
  })

  it('includes known services that use statusComponentId', () => {
    const ids = COMPONENT_ID_SERVICES.map((s) => s.id)
    // Claude services use statusComponentId
    expect(ids).toContain('claude')
    expect(ids).toContain('claudeai')
    expect(ids).toContain('claudecode')
  })
})

describe('#783/#1175 — OpenAI shared-page services source their component list from components.json', () => {
  // status.openai.com's summary.json serves only PART of the page and rotates which part, so an id
  // resolved against it resolves or not by luck of the window. Without componentsUrl the badge can't see
  // a component outside it AND — when the missing id is the primary — the statusComponentId miss-check
  // false-fires the migration alert every cycle (the #783 Codex regression; openai already had the fix).
  // #1175 — chatgpt was exempted here on the grounds that its primary ("Conversations") is in the window.
  // That is the wrong criterion: the badge is a worst-of over ALL its statusComponentIds, so a
  // summary.json-complete PRIMARY says nothing about the ids the badge actually reads.
  const COMPONENTS_JSON = 'https://status.openai.com/api/v2/components.json'

  it.each(['openai', 'codex', 'chatgpt'])('%s sources its component list from components.json', (id) => {
    const svc = SERVICES.find((s) => s.id === id)!
    expect(svc).toBeTruthy()
    expect(svc.apiUrl).toContain('summary.json')
    expect(svc.componentsUrl).toBe(COMPONENTS_JSON)    // component LIST from the superset
    // the primary must be one of the worst-of statusComponentIds it scopes the badge to
    expect(svc.statusComponentIds).toContain(svc.statusComponentId)
  })
})

describe('detectComponentMismatches (#135)', () => {
  const services = [
    { id: 'claude', name: 'Claude API', statusComponentId: 'comp-claude' },
    { id: 'openai', name: 'OpenAI API', statusComponentId: 'comp-openai' },
    { id: 'gemini', name: 'Gemini API', statusComponentId: 'comp-gemini' },
  ]

  // #1224 — miss counts now live in the consolidated `tracking:state` blob, not individual
  // `component-missing:{id}` keys. `alerted:component-missing:{id}` (the alert dedup marker) is
  // unaffected by the consolidation and still reads/writes its own key.
  // #1224 round 4 — componentMissCount only counts while its paired componentMissAt is fresh
  // (TRACKING_ALERT_STALE_MS), so every entry gets a default fresh timestamp unless the test
  // overrides it (e.g. to exercise the staleness gate itself).
  const trackingKV = (blob: Record<string, { componentMissCount?: number; componentMissAt?: string }>, extra: Record<string, string> = {}) => {
    const now = new Date().toISOString()
    const stamped = Object.fromEntries(Object.entries(blob).map(([id, entry]) => [id, { componentMissAt: now, ...entry }]))
    return mockKV({ 'tracking:state': JSON.stringify(stamped), ...extra })
  }

  it('returns service when miss count reaches threshold (3)', async () => {
    const kv = trackingKV({ claude: { componentMissCount: 3 } })
    const results = await detectComponentMismatches(services, kv)
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('claude')
    expect(results[0].missCount).toBe(3)
    expect(results[0].alertKey).toBe('alerted:component-missing:claude')
    expect(results[0].statusComponentId).toBe('comp-claude')
  })

  it('returns service when miss count exceeds threshold', async () => {
    const kv = trackingKV({ openai: { componentMissCount: 10 } })
    const results = await detectComponentMismatches(services, kv)
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('openai')
    expect(results[0].missCount).toBe(10)
  })

  it('does not return when miss count below threshold', async () => {
    const kv = trackingKV({ claude: { componentMissCount: 2 } })
    const results = await detectComponentMismatches(services, kv)
    expect(results).toHaveLength(0)
  })

  it('does not return when no miss counter exists', async () => {
    const kv = mockKV()
    const results = await detectComponentMismatches(services, kv)
    expect(results).toHaveLength(0)
  })

  it('deduplicates: skips if already alerted (24h TTL)', async () => {
    const kv = trackingKV({ claude: { componentMissCount: 5 } }, { 'alerted:component-missing:claude': '1' })
    const results = await detectComponentMismatches(services, kv)
    expect(results).toHaveLength(0)
  })

  it('returns multiple services simultaneously', async () => {
    const kv = trackingKV({
      claude: { componentMissCount: 3 },
      openai: { componentMissCount: 4 },
      gemini: { componentMissCount: 1 }, // below threshold
    })
    const results = await detectComponentMismatches(services, kv)
    expect(results).toHaveLength(2)
    expect(results.map((r) => r.id)).toEqual(['claude', 'openai'])
  })

  it('treats a corrupt tracking:state blob as empty (fails open — #1224)', async () => {
    const kv = mockKV({ 'tracking:state': 'not json{' })
    const results = await detectComponentMismatches(services, kv)
    expect(results).toHaveLength(0)
  })

  it('supports custom threshold', async () => {
    const kv = trackingKV({ claude: { componentMissCount: 4 } })
    expect(await detectComponentMismatches(services, kv, 5)).toHaveLength(0) // 4 < 5
    expect(await detectComponentMismatches(services, kv, 4)).toHaveLength(1) // 4 >= 4
  })

  it('fails open (empty results) when the blob read throws — #1224: one read now covers every service, so a throw can no longer spare unaffected services the way a per-key read could', async () => {
    const kv = mockKV({ 'tracking:state': JSON.stringify({ openai: { componentMissCount: 5 } }) })
    kv.get = vi.fn(async (key: string) => {
      if (key === 'tracking:state') throw new Error('KV read error')
      return null
    })
    const results = await detectComponentMismatches(services, kv)
    expect(results).toHaveLength(0)
  })

  // #1224 round 4 (I1) — the mirror of C1: a dead source stops calling trackComponentMiss/
  // resetComponentMiss entirely, so a frozen componentMissCount would otherwise re-alert every 24h
  // forever with no automatic recovery.
  it('does NOT return a service whose componentMissAt has gone stale — a frozen count from a source that stopped resolving components entirely', async () => {
    const staleAt = new Date(Date.now() - (TRACKING_ALERT_STALE_MS + 5 * 60_000)).toISOString() // past the stale gate
    const kv = trackingKV({ claude: { componentMissCount: 5, componentMissAt: staleAt } })
    const results = await detectComponentMismatches(services, kv)
    expect(results).toHaveLength(0)
  })

  it('DOES still return a service whose componentMissAt is fresh — the genuinely-still-drifting case', async () => {
    const kv = trackingKV({ claude: { componentMissCount: 5, componentMissAt: new Date(Date.now() - 5 * 60_000).toISOString() } })
    const results = await detectComponentMismatches(services, kv)
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('claude')
  })

  // Pins the 2x margin itself (round 5, Important #1), mirroring the same test on the failCountAt
  // side: a componentMissAt this old is past the raw TRACKING_COUNT_DECAY_MS window but still within
  // TRACKING_ALERT_STALE_MS — the legitimate mid-reclimb staleness a genuinely still-drifting service
  // produces. A regression to a 1x margin would wrongly suppress this.
  it('DOES still return a service whose componentMissAt is older than the raw decay window but still within the 2x alert margin', async () => {
    const midReclimbAt = new Date(Date.now() - (TRACKING_COUNT_DECAY_MS + 10 * 60_000)).toISOString()
    expect(TRACKING_ALERT_STALE_MS).toBeGreaterThan(TRACKING_COUNT_DECAY_MS + 10 * 60_000)
    const kv = trackingKV({ claude: { componentMissCount: 5, componentMissAt: midReclimbAt } })
    const results = await detectComponentMismatches(services, kv)
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('claude')
  })
})
