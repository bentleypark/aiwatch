// #880 — pin the Jina AI service config. The badge, uptime and incident list cover every model component
// on the page; only a text-embedding or reranker outage recommends an alternative (`fallbackComponents`),
// so a code-embeddings, CLIP, VLM, r.jina.ai or s.jina.ai outage shows as an outage and recommends
// nothing. Ids/names read from status.jina.ai components.json on 2026-10-11.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { SERVICES, fetchAllServices, filterIncidents, resolveSvcStatus, resolveSvcComponents, fallbackSuppressedFor } from '../services'
import { API_TIER, EXCLUDE_FALLBACK, getFallbacks, getGroupedFallbacks } from '../fallback'
import { SUPPRESSIONS_KEY, invalidateSuppressionCache } from '../suppression'
import type { Incident } from '../types'

const jina = SERVICES.find((s) => s.id === 'jina')!

// The live page roster: [id, name, group header?]
const PAGE: Array<[string, string, boolean]> = [
  ['b2tt4jb1x7pz', 'jina-reranker-m0', false],
  ['7b9xrr2ksh44', 'jina-embeddings-v5-text-small', false],
  ['lbtxhdqvr205', 'jina-vlm', false],
  ['phbgjfg719q6', 'jina-reranker-v2-base-multilingual', false],
  ['yxvtk6kpvycp', 'r.jina.ai', false],
  ['67hcttb83zzv', 'jina-embeddings-v5-text-nano', false],
  ['895s37lq7d5q', 's.jina.ai', false],
  ['d52c7tz1hnpd', 'jina-reranker-v3', false],
  ['fc5zn3rkh5bd', 'jina-embeddings-v4', false],
  ['d7nnpf4sr394', 'Rest Rerankers', false],
  ['v6lh7spvvvf5', 'jina-embeddings-v3', false],
  ['3f6qdtwq4yv6', 'jina-clip-v2', false],
  ['dwcjc0rgg6hn', 'jina-code-embeddings-500m', false],
  ['cm0h2r8mw593', 'jina-code-embeddings-1500m', false],
  ['skb1snhyjd6h', 'Rest Embeddings', false],
  ['6d9w2f73tz7v', 'Reader', true],
  ['hq1bx2j16lhs', 'Embedding Models', true],
  ['ftwn2h2xvr77', 'Reranker Models', true],
]
const FALLBACK_SCOPE = [
  'jina-embeddings-v4', 'jina-embeddings-v3', 'jina-embeddings-v5-text-small', 'jina-embeddings-v5-text-nano', 'Rest Embeddings',
  'jina-reranker-v2-base-multilingual', 'jina-reranker-v3', 'jina-reranker-m0', 'Rest Rerankers',
]
const OUTSIDE_SCOPE = ['jina-code-embeddings-500m', 'jina-code-embeddings-1500m', 'jina-clip-v2', 'jina-vlm', 'r.jina.ai', 's.jina.ai']

const GROUP_OF: Record<string, string> = {
  'jina-reranker-m0': 'ftwn2h2xvr77', 'jina-reranker-v2-base-multilingual': 'ftwn2h2xvr77', 'jina-reranker-v3': 'ftwn2h2xvr77', 'Rest Rerankers': 'ftwn2h2xvr77',
  'jina-vlm': '6d9w2f73tz7v', 'r.jina.ai': '6d9w2f73tz7v', 's.jina.ai': '6d9w2f73tz7v',
}
const groupIdOf = (name: string, group: boolean) => (group ? null : (GROUP_OF[name] ?? 'hq1bx2j16lhs'))
const summary = (down: string[]) => ({
  status: { indicator: down.length ? 'major' : 'none' },
  components: PAGE.map(([id, name, group], position) => ({ id, name, group, position, group_id: groupIdOf(name, group), status: down.includes(name) ? 'major_outage' : 'operational' })),
})
const incident = (componentNames: string[], status = 'investigating'): Incident => ({
  id: 'i1', title: 'Service outage', status, impact: 'minor', startedAt: '2026-10-11T00:00:00Z', duration: null, componentNames,
} as unknown as Incident)

// The ServiceStatus fields the fallback gate reads, built from the real resolvers + the real verdict.
const jinaStatus = (down: string[], score = 70) => {
  const components = resolveSvcComponents(jina, summary(down))
  const incidents = filterIncidents(down.map((n) => incident([n])), jina)
  return {
    id: 'jina', category: 'api', name: 'Jina AI', status: resolveSvcStatus(jina, summary(down), incidents), aiwatchScore: score,
    components, incidents,
    ...(fallbackSuppressedFor(jina.fallbackComponents!, components, incidents) ? { fallbackSuppressed: true } : {}),
  }
}
const op = (id: string, name: string, score: number) => ({ id, category: 'api', name, status: 'operational', aiwatchScore: score })
const pool = [op('voyageai', 'Voyage AI', 80), op('claude', 'Claude API', 95), op('cohere', 'Cohere API', 90), op('pinecone', 'Pinecone', 85)]

describe('jina config (#880)', () => {
  it('badges on every model component, and the fallback scope is the 9 text-embedding + reranker models', () => {
    const leaves = PAGE.filter(([, , group]) => !group).map(([id]) => id).sort()
    expect([...jina.statusComponentIds!].sort()).toEqual(leaves)
    expect([...jina.fallbackComponents!].sort()).toEqual([...FALLBACK_SCOPE].sort())
    expect(jina.incidentComponents).toBeUndefined()
  })

  it('every page component is in the badge scope or roster-audit excluded (the 3 group headers), never both', () => {
    const scoped = new Set(jina.statusComponentIds)
    const excluded = new Set(jina.rosterAuditExclude)
    for (const [id, , group] of PAGE) {
      expect(scoped.has(id)).toBe(!group)
      expect(excluded.has(id)).toBe(group)
    }
  })

  it.each(OUTSIDE_SCOPE)('a %s outage is shown as an outage but recommends nothing', (name) => {
    const svc = jinaStatus([name])
    expect(svc.status).toBe('down')
    expect(svc.incidents).toHaveLength(1)
    expect(svc.fallbackSuppressed).toBe(true)
    expect(getFallbacks('jina', 'api', [svc, ...pool])).toEqual([])
    expect(getGroupedFallbacks(['jina'], [svc, ...pool])).toEqual([])
  })

  it.each(FALLBACK_SCOPE)('a %s outage recommends Voyage AI under the Embeddings label', (name) => {
    const svc = jinaStatus([name])
    expect(svc.status).toBe('down')
    expect(svc.fallbackSuppressed).toBeUndefined()
    expect(getFallbacks('jina', 'api', [svc, ...pool])).toEqual([{ name: 'Voyage AI', score: 80 }])
    const groups = getGroupedFallbacks(['jina'], [svc, ...pool])
    expect(groups.map((g) => [g.label, g.fallbacks])).toEqual([['Embeddings', [{ name: 'Voyage AI', score: 80 }]]])
  })

  it('an in-scope and an out-of-scope outage together still recommend Voyage AI', () => {
    const svc = jinaStatus(['s.jina.ai', 'jina-embeddings-v4'])
    expect(getFallbacks('jina', 'api', [svc, ...pool])).toEqual([{ name: 'Voyage AI', score: 80 }])
  })

  it('the breakdown shows every component, grouped by the page groups', () => {
    const comps = resolveSvcComponents(jina, summary([]))
    expect(comps.map((c) => c.name).sort()).toEqual(PAGE.filter(([, , g]) => !g).map(([, n]) => n).sort())
    const groupOf = Object.fromEntries(comps.map((c) => [c.name, c.group]))
    expect([groupOf['s.jina.ai'], groupOf['jina-embeddings-v4'], groupOf['jina-reranker-m0']]).toEqual(['Reader', 'Embedding Models', 'Reranker Models'])
  })

  it('holds short incidents before alerting', () => {
    expect(jina.holdShortIncidents).toBe(true)
  })
})

describe('jina through fetchAllServices (#880)', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); invalidateSuppressionCache() })
  const run = async (down: string[], incidentOn: string[] = down, suppressed: string[] = []) => {
    invalidateSuppressionCache()
    const components = PAGE.map(([id, name, group], position) => ({
      id, name, group, position, group_id: groupIdOf(name, group), showcase: true,
      status: down.includes(name) ? 'major_outage' : 'operational', created_at: '2026-02-20T00:00:00Z',
    }))
    const incidents = incidentOn.map((name) => ({
      id: `inc-${name}`, name: `Service outage: ${name}`, status: 'investigating', impact: 'minor',
      created_at: '2026-10-11T00:00:00Z', updated_at: '2026-10-11T00:00:00Z', started_at: '2026-10-11T00:00:00Z', resolved_at: null,
      shortlink: 'https://stspg.io/x', page_id: 'nldp3ndmy0vf',
      incident_updates: [{ status: 'investigating', created_at: '2026-10-11T00:00:00Z', body: `Service ${name} is experiencing issues.`,
        affected_components: [{ code: PAGE.find(([, n2]) => n2 === name)![0], name, old_status: 'operational', new_status: 'major_outage' }] }],
      components: components.filter((c) => c.name === name),
    }))
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === 'https://status.jina.ai/api/v2/summary.json') return json({ status: { indicator: down.length ? 'major' : 'none' }, components, incidents })
      if (url === 'https://status.jina.ai/api/v2/incidents.json') return json({ incidents })
      return new Response('upstream error', { status: 503 })
    }))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const list = suppressed.map((name) => ({ scope: 'incident', incId: `inc-${name}` }))
    const kv = { get: async (k: string) => (k === SUPPRESSIONS_KEY ? JSON.stringify(list) : null), put: async () => {}, delete: async () => {}, list: async () => ({ keys: [] }) }
    const { raw, enriched } = await fetchAllServices(kv as never)
    const svc = raw.find((x) => x.id === 'jina')!
    expect(enriched.find((x) => x.id === 'jina')!.fallbackSuppressed).toBe(svc.fallbackSuppressed)
    return svc
  }

  it('a healthy page carries no fallbackSuppressed', async () => {
    const svc = await run([])
    expect(svc.status).toBe('operational')
    expect(svc.fallbackSuppressed).toBeUndefined()
  })

  it('an s.jina.ai outage is Down and carries fallbackSuppressed', async () => {
    const svc = await run(['s.jina.ai'])
    expect(svc.status).toBe('down')
    expect(svc.fallbackSuppressed).toBe(true)
  })

  it('a jina-embeddings-v4 outage is Down and carries no fallbackSuppressed', async () => {
    const svc = await run(['jina-embeddings-v4'])
    expect(svc.status).toBe('down')
    expect(svc.fallbackSuppressed).toBeUndefined()
  })

  it('a suppressed in-scope incident does not keep an out-of-scope outage recommending Voyage', async () => {
    const svc = await run(['s.jina.ai'], ['s.jina.ai', 'jina-embeddings-v4'], ['jina-embeddings-v4'])
    expect(svc.incidents.filter((i) => i.status !== 'resolved').map((i) => i.id)).toEqual(['inc-s.jina.ai'])
    expect(svc.fallbackSuppressed).toBe(true)
  })
})

describe('fallbackSuppressedFor (#880)', () => {
  const scope = ['A', 'B']
  const comps = (down: string[]) => ['A', 'B', 'C'].map((name) => ({ name, status: down.includes(name) ? 'down' : 'operational' }))

  it('suppresses when only out-of-scope components are affected', () => {
    expect(fallbackSuppressedFor(scope, comps(['C']), [incident(['C'])])).toBe(true)
  })
  it('does not suppress when a scoped component is non-operational, matched case-insensitively', () => {
    expect(fallbackSuppressedFor(['a'], comps(['A']), [])).toBe(false)
  })
  it('does not suppress when an active incident names a scoped component while its status reads operational', () => {
    expect(fallbackSuppressedFor(scope, comps([]), [incident(['B'])])).toBe(false)
  })
  it('ignores a resolved incident on a scoped component', () => {
    expect(fallbackSuppressedFor(scope, comps(['C']), [incident(['A'], 'resolved')])).toBe(true)
  })
  it('does not suppress an active incident that names no component (cannot tell)', () => {
    expect(fallbackSuppressedFor(scope, comps(['C']), [incident([])])).toBe(false)
  })
  it('does not suppress when nothing is affected (a healthy day keeps the static alternatives)', () => {
    expect(fallbackSuppressedFor(scope, comps([]), [])).toBe(false)
    expect(fallbackSuppressedFor(scope, comps([]), [incident(['C'], 'resolved')])).toBe(false)
  })
  it('does not suppress without a component snapshot to judge from', () => {
    expect(fallbackSuppressedFor(scope, [], [incident(['C'])])).toBe(false)
  })
})

describe('Embeddings fallback tier (#880)', () => {
  it('voyageai and jina are tier 9 and neither is excluded', () => {
    expect(API_TIER.voyageai).toBe(9)
    expect(API_TIER.jina).toBe(9)
    expect(EXCLUDE_FALLBACK).not.toContain('voyageai')
    expect(EXCLUDE_FALLBACK).not.toContain('jina')
  })

  it('a Voyage outage recommends Jina, and only Jina', () => {
    const services = [{ ...op('voyageai', 'Voyage AI', 80), status: 'down' }, op('jina', 'Jina AI', 70), ...pool.slice(1)]
    expect(getFallbacks('voyageai', 'api', services)).toEqual([{ name: 'Jina AI', score: 70 }])
  })
})
