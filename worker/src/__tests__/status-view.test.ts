// #1831 — the per-page projections the Edge is-down pages read instead of the whole lean payload.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { parseStatusView, buildIsDownView, buildIsDownGroupView, type ViewService, type LeanStatusPayload } from '../status-view'

afterEach(() => { vi.restoreAllMocks() })

const svc = (id: string, over: Partial<ViewService> = {}): ViewService => ({
  id, name: id.toUpperCase(), category: 'api', status: 'operational', incidents: [],
  aiwatchScore: 80, scoreConfidence: 'high', ...over,
})
const payload = (services: ViewService[], extra: Partial<LeanStatusPayload> = {}): LeanStatusPayload => ({
  services, lastUpdated: '2026-10-28T00:00:00Z', cached: true, upstreamLinks: [], ...extra,
})
const params = (q: string) => new URLSearchParams(q)

describe('parseStatusView', () => {
  it('reads an is-down view and a group view', () => {
    expect(parseStatusView(params('view=is-down&id=claude'))).toEqual({ kind: 'is-down', id: 'claude' })
    expect(parseStatusView(params('view=is-down-group&ids=claude,claudeai&status=openai'))).toEqual({ kind: 'is-down-group', ids: ['claude', 'claudeai'], statusIds: ['openai'] })
  })

  it('is no view without a target, or for an unknown view', () => {
    expect(parseStatusView(params('series=0'))).toBeNull()
    expect(parseStatusView(params('view=is-down'))).toBeNull()
    expect(parseStatusView(params('view=is-down-group&status=openai'))).toBeNull()
    expect(parseStatusView(params('view=dashboard&id=claude'))).toBeNull()
  })
})

describe('buildIsDownView', () => {
  it('carries only the target, with its rank inside its own confidence tier', () => {
    const view = buildIsDownView(payload([
      svc('claude', { status: 'down', aiwatchScore: 70 }),
      svc('openai', { aiwatchScore: 90 }),
      svc('gemini', { aiwatchScore: 99, scoreConfidence: 'medium' }),
    ]), 'claude')
    expect(view.services).toHaveLength(1)
    expect(view.services[0]).toMatchObject({ id: 'claude', rank: 2, rankTied: false, totalRanked: 2 })
  })

  it('leaves an unranked target without rank fields', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const view = buildIsDownView(payload([svc('claude', { scoreConfidence: 'low', aiwatchScore: null })]), 'claude')
    expect(view.services[0]).not.toHaveProperty('rank')
  })

  it.each([
    ['under 30 days of coverage (#802)', { coverageDays: 12 }],
    ['an unrecognized confidence (#1186)', { scoreConfidence: 'unknown' }],
  ])('does not rank a target with %s', (_label, over) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const view = buildIsDownView(payload([svc('claude', over as Partial<ViewService>), svc('openai')]), 'claude')
    expect(view.services[0]).not.toHaveProperty('rank')
  })

  it('leaves peers without reliable data out of the ranked pool', () => {
    const view = buildIsDownView(payload([
      svc('claude', { aiwatchScore: 70 }),
      svc('openai', { aiwatchScore: 90, coverageDays: 12 }),
      svc('gemini', { aiwatchScore: 95, incidentSourceStale: true }),
      svc('mistral', { aiwatchScore: 85 }),
    ]), 'claude')
    expect(view.services[0]).toMatchObject({ rank: 2, totalRanked: 2 })
  })

  it('carries the upstream links (#1053)', () => {
    const links = [{ dependentId: 'cursor', upstreamId: 'claude' }]
    expect(buildIsDownView(payload([svc('claude')], { upstreamLinks: links }), 'claude').upstreamLinks).toEqual(links)
  })

  it('lists fallbacks with the fields the page renders', () => {
    const view = buildIsDownView(payload([
      svc('claude', { status: 'down' }),
      svc('openai', { aiwatchScore: 90 }),
    ]), 'claude')
    expect(view.fallbacks).toEqual([{ id: 'openai', name: 'OPENAI', score: 90, status: 'operational' }])
    expect(view).not.toHaveProperty('fallbackGroups')
  })

  it('recommends a candidate whose only open incident is an advisory, and not one with an outage (#811)', () => {
    const view = buildIsDownView(payload([
      svc('claude', { status: 'down' }),
      svc('openai', { incidents: [{ status: 'investigating', title: 'Delayed Costs data in the Compliance API' }] }),
      svc('gemini', { incidents: [{ status: 'investigating', title: 'Elevated error rates' }] }),
    ]), 'claude')
    expect(view.fallbacks?.map((f) => f.id)).toEqual(['openai'])
  })

  it('groups a listed service\'s substitutes by use', () => {
    const view = buildIsDownView(payload([
      svc('cohere', { status: 'down' }),
      svc('openai'),
      svc('voyageai'),
    ]), 'cohere')
    expect(view.fallbackGroups?.map((g) => g.use)).toEqual(['chat and generation', 'embeddings and reranking'])
    expect(view.fallbacks?.map((f) => f.id)).toEqual(['openai', 'voyageai'])
  })

  it('keeps only the target\'s share of the payload-wide maps', () => {
    const view = buildIsDownView(payload([svc('claude'), svc('openai')], {
      aiAnalysis: { claude: [{ incidentId: 'a' }], openai: [{ incidentId: 'b' }] },
      recoveryBaseline: { claude: { n: 1 }, openai: { n: 2 } },
      supplyChainBanner: { affectedNow: [] },
    }), 'claude')
    expect(view.aiAnalysis).toEqual({ claude: [{ incidentId: 'a' }] })
    expect(view.recoveryBaseline).toEqual({ claude: { n: 1 } })
    expect(view.supplyChainBanner).toEqual({ affectedNow: [] })
  })

  it('passes the fleet-wide estimate accuracy through whole, and omits it when the payload has none', () => {
    const accuracy = { total: 32, accurate: 12, overPredicted: 14, underPredicted: 6, since: '2026-09-01' }
    expect(buildIsDownView(payload([svc('claude')], { estimateAccuracy: accuracy }), 'claude').estimateAccuracy).toEqual(accuracy)
    expect(buildIsDownView(payload([svc('claude')]), 'claude')).not.toHaveProperty('estimateAccuracy')
  })

  it('an unknown id yields no service and no fallbacks', () => {
    const view = buildIsDownView(payload([svc('openai')]), 'claude')
    expect(view.services).toEqual([])
    expect(view).not.toHaveProperty('fallbacks')
  })
})

describe('buildIsDownGroupView', () => {
  it('keeps the members in full and only id + status for the status-only services', () => {
    const view = buildIsDownGroupView(payload([
      svc('claude', { aiwatchScore: 91 }),
      svc('openai', { status: 'degraded', aiwatchScore: 88 }),
      svc('groq'),
    ], { aiAnalysis: { claude: [{ incidentId: 'a' }], openai: [{ incidentId: 'b' }] } }), ['claude'], ['openai', 'claude'])
    expect(view.services).toEqual([
      expect.objectContaining({ id: 'claude', aiwatchScore: 91 }),
      { id: 'openai', status: 'degraded' },
    ])
    expect(view.aiAnalysis).toEqual({ claude: [{ incidentId: 'a' }] })
  })
})
