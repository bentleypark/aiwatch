import { describe, it, expect } from 'vitest'
import { buildStatuslinePayload, isStatuslineRequest } from '../statusline'
import type { ServiceStatus } from '../types'

function svc(overrides: Partial<ServiceStatus> = {}): ServiceStatus {
  return {
    id: 'claude',
    name: 'Claude API',
    provider: 'Anthropic',
    category: 'api',
    status: 'operational',
    incidents: [],
    ...overrides,
  } as ServiceStatus
}

describe('buildStatuslinePayload (#438)', () => {
  it('projects each service down to id/name/status only', () => {
    const cached = {
      cachedAt: '2026-05-20T00:00:00Z',
      services: [
        svc({ id: 'claude', name: 'Claude API', status: 'operational', latency: 142, uptime30d: 99.9, aiwatchScore: 92, incidents: [{ id: 'i1' } as never] }),
        svc({ id: 'openai', name: 'OpenAI API', status: 'down' }),
      ],
    }
    const out = buildStatuslinePayload(cached)
    expect(out.services).toEqual([
      { id: 'claude', name: 'Claude API', status: 'operational' },
      { id: 'openai', name: 'OpenAI API', status: 'down' },
    ])
    // The heavy fields the statusline doesn't use must be dropped
    expect(out.services[0]).not.toHaveProperty('latency')
    expect(out.services[0]).not.toHaveProperty('incidents')
    expect(out.services[0]).not.toHaveProperty('aiwatchScore')
    expect(out.cachedAt).toBe('2026-05-20T00:00:00Z')
  })

  it('returns empty services + null cachedAt when the cache is missing', () => {
    expect(buildStatuslinePayload(null)).toEqual({ services: [], cachedAt: null })
    expect(buildStatuslinePayload({ services: [] })).toEqual({ services: [], cachedAt: null })
  })

  it('projects exactly the keys the Statusline.jsx jq filters read (id/name/status)', () => {
    // Contract guard: the snippet jq selects .services[].id/.name/.status. A field
    // rename here would silently blank every installed statusline.
    const out = buildStatuslinePayload({ cachedAt: 't', services: [svc()] })
    expect(Object.keys(out.services[0]).sort()).toEqual(['id', 'name', 'status'])
  })
})

describe('/api/status/cached statusline routing contract (#438)', () => {
  // Mirrors the index.ts dispatch (worker/src/index.ts /api/status/cached): a
  // statusline-tagged request short-circuits to the lite payload; everything else
  // falls through to the full ~2 MB path. This is the core bandwidth guarantee —
  // pinned here because the handler branch itself is inline in the fetch dispatcher
  // (repo pattern: cached-response.test.ts simulates rather than invokes).
  function dispatch(search: string, cache: { services: ServiceStatus[]; cachedAt?: string } | null) {
    const sp = new URLSearchParams(search)
    if (isStatuslineRequest(sp)) return { path: 'lite' as const, body: buildStatuslinePayload(cache) }
    return { path: 'full' as const }
  }

  it('routes statusline-tagged requests to the lite payload', () => {
    const cache = { cachedAt: 't', services: [svc({ aiwatchScore: 92, incidents: [{ id: 'i' } as never] })] }
    const r = dispatch('src=statusline-degraded_only', cache)
    expect(r.path).toBe('lite')
    expect(r.body).toEqual(buildStatuslinePayload(cache))
    expect(r.body!.services[0]).not.toHaveProperty('aiwatchScore')
  })

  it('routes untagged + non-statusline requests to the full path', () => {
    expect(dispatch('', { services: [] }).path).toBe('full')
    expect(dispatch('src=dashboard', { services: [] }).path).toBe('full')
  })
})

describe('isStatuslineRequest (#438)', () => {
  it('matches the ?src=statusline-<preset> tag', () => {
    expect(isStatuslineRequest(new URLSearchParams('src=statusline-degraded_only'))).toBe(true)
    expect(isStatuslineRequest(new URLSearchParams('src=statusline-compact_badge'))).toBe(true)
  })

  it('does not match regular or untagged requests', () => {
    expect(isStatuslineRequest(new URLSearchParams(''))).toBe(false)
    expect(isStatuslineRequest(new URLSearchParams('src=dashboard'))).toBe(false)
    expect(isStatuslineRequest(new URLSearchParams('foo=statusline-x'))).toBe(false)
  })
})
