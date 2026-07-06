import { describe, it, expect } from 'vitest'
import {
  isSuppressed,
  isSuppressedByIdTitle,
  applySuppressions,
  normalizeSuppressions,
  sameSuppressionTarget,
  mutateSuppressions,
  readSuppressionsFresh,
  type SuppressionEntry,
} from '../suppression'
import type { Incident, ServiceStatus } from '../types'

function inc(overrides: Partial<Incident> = {}): Incident {
  return {
    id: 'inc-1',
    title: 'Test incident',
    status: 'investigating',
    impact: 'major',
    startedAt: '2026-06-15T10:00:00Z',
    resolvedAt: null,
    duration: null,
    timeline: [],
    ...overrides,
  }
}

function svc(id: string, incidents: Incident[]): ServiceStatus {
  return {
    id,
    name: id,
    provider: 'x',
    category: 'api',
    status: 'operational',
    latency: null,
    uptime30d: 99.99,
    lastChecked: '2026-07-06T00:00:00Z',
    incidents,
  }
}

const FEDRAMP = inc({ id: 'fr-1', title: 'FedRAMP workspaces and API orgs have degraded performance' })
const REAL = inc({ id: 'real-1', title: 'Image API requests failing with 401s' })

describe('isSuppressed / isSuppressedByIdTitle', () => {
  it('incident-scope matches by exact id, ignores title', () => {
    const list: SuppressionEntry[] = [{ scope: 'incident', incId: 'fr-1' }]
    expect(isSuppressed(FEDRAMP, 'openai', list)).toBe(true)
    expect(isSuppressed(REAL, 'openai', list)).toBe(false)
  })

  it('service-pattern matches svcId + title substring (case-insensitive)', () => {
    const list: SuppressionEntry[] = [{ scope: 'service-pattern', svcId: 'openai', match: 'fedramp' }]
    expect(isSuppressed(FEDRAMP, 'openai', list)).toBe(true)
    expect(isSuppressed(REAL, 'openai', list)).toBe(false)
  })

  it('service-pattern does NOT leak across services (wrong svcId)', () => {
    const list: SuppressionEntry[] = [{ scope: 'service-pattern', svcId: 'openai', match: 'fedramp' }]
    expect(isSuppressed(FEDRAMP, 'chatgpt', list)).toBe(false)
  })

  it('empty list suppresses nothing', () => {
    expect(isSuppressedByIdTitle('fr-1', 'FedRAMP …', 'openai', [])).toBe(false)
  })
})

describe('applySuppressions', () => {
  it('removes suppressed incidents from the matching service only', () => {
    const services = [svc('openai', [FEDRAMP, REAL]), svc('chatgpt', [FEDRAMP])]
    const list: SuppressionEntry[] = [{ scope: 'service-pattern', svcId: 'openai', match: 'fedramp' }]
    const out = applySuppressions(services, list)
    expect(out[0].incidents.map((i) => i.id)).toEqual(['real-1'])
    expect(out[1].incidents.map((i) => i.id)).toEqual(['fr-1']) // chatgpt untouched (svcId scoped)
  })

  it('is identity (same reference) when nothing is suppressed', () => {
    const services = [svc('openai', [REAL])]
    const out = applySuppressions(services, [{ scope: 'incident', incId: 'nope' }])
    expect(out[0]).toBe(services[0])
  })

  it('empty list returns input array unchanged', () => {
    const services = [svc('openai', [FEDRAMP])]
    expect(applySuppressions(services, [])).toBe(services)
  })
})

describe('normalizeSuppressions', () => {
  it('keeps well-formed entries and drops malformed rows', () => {
    const parsed = [
      { scope: 'incident', incId: 'a', reason: 'r' },
      { scope: 'incident' }, // missing incId → drop
      { scope: 'service-pattern', svcId: 'openai', match: 'fedramp' },
      { scope: 'service-pattern', svcId: 'openai' }, // missing match → drop
      { scope: 'bogus', incId: 'x' }, // bad scope → drop
      null,
      42,
    ]
    const out = normalizeSuppressions(parsed)
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ scope: 'incident', incId: 'a', reason: 'r' })
    expect(out[1]).toMatchObject({ scope: 'service-pattern', svcId: 'openai', match: 'fedramp' })
  })

  it('returns [] for non-array input', () => {
    expect(normalizeSuppressions(null)).toEqual([])
    expect(normalizeSuppressions({})).toEqual([])
  })
})

describe('sameSuppressionTarget', () => {
  it('compares by target identity, not metadata', () => {
    const a: SuppressionEntry = { scope: 'incident', incId: 'x', reason: 'one' }
    const b: SuppressionEntry = { scope: 'incident', incId: 'x', reason: 'two' }
    expect(sameSuppressionTarget(a, b)).toBe(true)
  })
  it('service-pattern identity is case-insensitive on match', () => {
    const a: SuppressionEntry = { scope: 'service-pattern', svcId: 'openai', match: 'FedRAMP' }
    const b: SuppressionEntry = { scope: 'service-pattern', svcId: 'openai', match: 'fedramp' }
    expect(sameSuppressionTarget(a, b)).toBe(true)
  })
  it('different scopes never match', () => {
    expect(sameSuppressionTarget(
      { scope: 'incident', incId: 'x' },
      { scope: 'service-pattern', svcId: 'x', match: 'x' },
    )).toBe(false)
  })
})

describe('mutateSuppressions', () => {
  it('adds a new service-pattern entry with metadata', () => {
    const r = mutateSuppressions([], { action: 'add', scope: 'service-pattern', svcId: 'openai', match: 'fedramp', reason: 'gov scope', by: 'admin', createdAt: '2026-07-06T00:00:00Z' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.changed).toBe(true)
    expect(r.list[0]).toMatchObject({ scope: 'service-pattern', svcId: 'openai', match: 'fedramp', reason: 'gov scope', by: 'admin' })
  })

  it('add is idempotent (dedup by target, changed=false)', () => {
    const start: SuppressionEntry[] = [{ scope: 'service-pattern', svcId: 'openai', match: 'fedramp' }]
    const r = mutateSuppressions(start, { action: 'add', scope: 'service-pattern', svcId: 'openai', match: 'fedramp' })
    expect(r.ok && r.changed).toBe(false)
    if (r.ok) expect(r.list).toHaveLength(1)
  })

  it('removes an existing entry', () => {
    const start: SuppressionEntry[] = [{ scope: 'incident', incId: 'fr-1' }]
    const r = mutateSuppressions(start, { action: 'remove', scope: 'incident', incId: 'fr-1' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.changed).toBe(true)
    expect(r.list).toHaveLength(0)
  })

  it('remove of an absent entry is a no-op (changed=false)', () => {
    const r = mutateSuppressions([], { action: 'remove', scope: 'incident', incId: 'nope' })
    expect(r.ok && r.changed).toBe(false)
  })

  it('validates required fields + scope + action', () => {
    expect(mutateSuppressions([], { action: 'add', scope: 'incident' }).ok).toBe(false)
    expect(mutateSuppressions([], { action: 'add', scope: 'service-pattern', svcId: 'openai' }).ok).toBe(false)
    expect(mutateSuppressions([], { action: 'add', scope: 'bogus' as 'incident', incId: 'x' }).ok).toBe(false)
    expect(mutateSuppressions([], { action: 'nope' as 'add', scope: 'incident', incId: 'x' }).ok).toBe(false)
  })
})

describe('readSuppressionsFresh', () => {
  const kvWith = (value: string | null | (() => never)): KVNamespace =>
    ({ get: async () => { if (typeof value === 'function') return value(); return value } } as unknown as KVNamespace)

  it('returns [] when kv is absent', async () => {
    expect(await readSuppressionsFresh(undefined)).toEqual([])
  })

  it('parses + normalizes a stored list', async () => {
    const kv = kvWith(JSON.stringify([{ scope: 'service-pattern', svcId: 'openai', match: 'fedramp' }, { bogus: true }]))
    const out = await readSuppressionsFresh(kv)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ scope: 'service-pattern', svcId: 'openai', match: 'fedramp' })
  })

  it('returns [] on empty key / read throw / malformed JSON (never breaks the caller)', async () => {
    expect(await readSuppressionsFresh(kvWith(null))).toEqual([])
    expect(await readSuppressionsFresh(kvWith(() => { throw new Error('kv down') }))).toEqual([])
    expect(await readSuppressionsFresh(kvWith('not json'))).toEqual([])
  })
})
