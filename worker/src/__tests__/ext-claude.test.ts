import { describe, it, expect } from 'vitest'
import { buildExtClaudePayload, isExtClaudeRequest, EXT_CLAUDE_IDS, type ScoredService } from '../ext-claude'
import { isStatuslineRequest } from '../statusline'
import type { ServiceStatus } from '../types'

// A scored service fixture — ServiceStatus enriched with aiwatchScore + scoreGrade
// (what scoreFor produces in index.ts before buildExtClaudePayload is called).
function svc(overrides: Partial<ScoredService> & Record<string, unknown> = {}): ScoredService {
  return {
    id: 'claude',
    name: 'Claude API',
    provider: 'Anthropic',
    category: 'api',
    status: 'operational',
    incidents: [],
    aiwatchScore: 90,
    scoreGrade: 'excellent',
    ...overrides,
  } as ScoredService
}

// Full scored set: the three Claude surfaces + per-category fallback candidates.
function scoredSet(): ScoredService[] {
  return [
    // api
    svc({ id: 'claude', name: 'Claude API', category: 'api', status: 'down', aiwatchScore: 88, scoreGrade: 'good' }),
    svc({ id: 'openai', name: 'OpenAI API', category: 'api', status: 'operational', aiwatchScore: 91, scoreGrade: 'excellent' }),
    svc({ id: 'gemini', name: 'Gemini API', category: 'api', status: 'operational', aiwatchScore: 84, scoreGrade: 'good' }),
    svc({ id: 'mistral', name: 'Mistral API', category: 'api', status: 'degraded', aiwatchScore: 70, scoreGrade: 'fair' }),
    // app
    svc({ id: 'claudeai', name: 'claude.ai', category: 'app', status: 'operational', aiwatchScore: 75, scoreGrade: 'good' }),
    svc({ id: 'chatgpt', name: 'ChatGPT', category: 'app', status: 'operational', aiwatchScore: 80, scoreGrade: 'good' }),
    // agent
    svc({ id: 'claudecode', name: 'Claude Code', category: 'agent', status: 'operational', aiwatchScore: 82, scoreGrade: 'good' }),
    svc({ id: 'codex', name: 'Codex', category: 'agent', status: 'operational', aiwatchScore: 79, scoreGrade: 'good' }),
    svc({ id: 'cursor', name: 'Cursor', category: 'agent', status: 'down', aiwatchScore: 60, scoreGrade: 'degrading' }),
  ]
}

describe('isExtClaudeRequest (#837)', () => {
  it('matches ?src=ext-claude exactly', () => {
    expect(isExtClaudeRequest(new URLSearchParams('src=ext-claude'))).toBe(true)
  })
  it('does not match statusline / dashboard / absent / near-misses', () => {
    expect(isExtClaudeRequest(new URLSearchParams('src=statusline-compact'))).toBe(false)
    expect(isExtClaudeRequest(new URLSearchParams('src=dashboard'))).toBe(false)
    expect(isExtClaudeRequest(new URLSearchParams(''))).toBe(false)
    expect(isExtClaudeRequest(new URLSearchParams('src=ext-claudex'))).toBe(false)
    expect(isExtClaudeRequest(new URLSearchParams('src=ext-claude-'))).toBe(false)
  })
})

describe('buildExtClaudePayload (#837)', () => {
  it('emits exactly the three Anthropic surfaces in EXT_CLAUDE_IDS order', () => {
    const out = buildExtClaudePayload(scoredSet(), '2026-06-30T00:00:00Z')
    expect(out.services.map((s) => s.id)).toEqual([...EXT_CLAUDE_IDS])
    expect(out.cachedAt).toBe('2026-06-30T00:00:00Z')
  })

  it('order is EXT_CLAUDE_IDS regardless of input order', () => {
    const shuffled = [...scoredSet()].reverse()
    const out = buildExtClaudePayload(shuffled, 't')
    expect(out.services.map((s) => s.id)).toEqual(['claude', 'claudeai', 'claudecode'])
  })

  it('attaches status + score + grade for each surface', () => {
    const out = buildExtClaudePayload(scoredSet(), 't')
    const claude = out.services.find((s) => s.id === 'claude')!
    expect(claude).toMatchObject({ name: 'Claude API', status: 'down', score: 88, grade: 'good' })
  })

  it('passes through uptime30d (null when absent)', () => {
    const set = [
      svc({ id: 'claude', category: 'api', status: 'operational', aiwatchScore: 90, scoreGrade: 'excellent', uptime30d: 99.87 }),
      svc({ id: 'claudeai', category: 'app', status: 'operational', aiwatchScore: 70, scoreGrade: 'good' }), // no uptime30d → null
      svc({ id: 'claudecode', category: 'agent', status: 'operational', aiwatchScore: 70, scoreGrade: 'good' }),
    ]
    const out = buildExtClaudePayload(set, 't')
    expect(out.services.find((s) => s.id === 'claude')!.uptime30d).toBe(99.87)
    expect(out.services.find((s) => s.id === 'claudeai')!.uptime30d).toBeNull()
  })

  it('attaches a per-category fallback (api→api, app→app, agent→agent)', () => {
    const out = buildExtClaudePayload(scoredSet(), 't')
    const claude = out.services.find((s) => s.id === 'claude')!
    const claudeai = out.services.find((s) => s.id === 'claudeai')!
    const claudecode = out.services.find((s) => s.id === 'claudecode')!
    // api fallback: operational api peers by tier proximity then score — openai (T1) before gemini (T1, lower score)
    expect(claude.fallback).toEqual([
      { name: 'OpenAI API', score: 91 },
      { name: 'Gemini API', score: 84 },
    ])
    // app fallback: the only other operational app candidate
    expect(claudeai.fallback).toEqual([{ name: 'ChatGPT', score: 80 }])
    // agent fallback: codex operational; cursor (down) excluded
    expect(claudecode.fallback).toEqual([{ name: 'Codex', score: 79 }])
  })

  it('fallback excludes non-operational candidates (mistral degraded, cursor down)', () => {
    const out = buildExtClaudePayload(scoredSet(), 't')
    const allFallbackNames = out.services.flatMap((s) => s.fallback.map((f) => f.name))
    expect(allFallbackNames).not.toContain('Mistral API')
    expect(allFallbackNames).not.toContain('Cursor')
  })

  it('#550 — fallback excludes an operational candidate carrying an unresolved incident', () => {
    // buildExtClaudePayload passes the FULL scored set (incidents intact) as the
    // candidate pool — this is the wiring unique to this module. A top-score peer that
    // is operational but mid-incident must be dropped (else the extension recommends a
    // service the same incident banner contradicts). getFallbacks owns the rule; here
    // we prove the pool reaches it.
    const set: ScoredService[] = [
      svc({ id: 'claude', name: 'Claude API', category: 'api', status: 'down', aiwatchScore: 88, scoreGrade: 'good' }),
      svc({ id: 'openai', name: 'OpenAI API', category: 'api', status: 'operational', aiwatchScore: 95, scoreGrade: 'excellent', incidents: [{ status: 'investigating', title: 'Elevated API errors' } as never] }),
      svc({ id: 'gemini', name: 'Gemini API', category: 'api', status: 'operational', aiwatchScore: 84, scoreGrade: 'good' }),
    ]
    const claude = buildExtClaudePayload(set, 't').services.find((s) => s.id === 'claude')!
    expect(claude.fallback).toEqual([{ name: 'Gemini API', score: 84 }]) // OpenAI (active incident) dropped despite top score
  })

  it('#616 — fallback excludes an incidentSourceStale candidate', () => {
    const set: ScoredService[] = [
      svc({ id: 'claude', name: 'Claude API', category: 'api', status: 'down', aiwatchScore: 88, scoreGrade: 'good' }),
      svc({ id: 'openai', name: 'OpenAI API', category: 'api', status: 'operational', aiwatchScore: 95, scoreGrade: 'excellent', incidentSourceStale: true }),
      svc({ id: 'gemini', name: 'Gemini API', category: 'api', status: 'operational', aiwatchScore: 84, scoreGrade: 'good' }),
    ]
    const claude = buildExtClaudePayload(set, 't').services.find((s) => s.id === 'claude')!
    expect(claude.fallback).toEqual([{ name: 'Gemini API', score: 84 }]) // OpenAI (stale source) dropped
  })

  it('payload is lite — each service carries only the projected keys', () => {
    const out = buildExtClaudePayload(scoredSet(), 't')
    expect(Object.keys(out.services[0]).sort()).toEqual(['components', 'fallback', 'grade', 'id', 'incidents', 'name', 'recentlyResolved', 'recoveryBaseline', 'reports', 'score', 'status', 'uptime30d'])
    // heavy ServiceStatus fields must not leak
    expect(out.services[0]).not.toHaveProperty('aiwatchScore')
    expect(out.services[0]).not.toHaveProperty('provider')
    expect(out.services[0]).not.toHaveProperty('category')
  })

  it('with no context: incidents empty, reports zeroed', () => {
    const claude = buildExtClaudePayload(scoredSet(), 't').services.find((s) => s.id === 'claude')!
    expect(claude.incidents).toEqual([])
    expect(claude.reports).toEqual({ count: 0, recent: [] })
  })

  it('null score/grade pass through as null (withheld Score)', () => {
    const set = scoredSet().map((s) => (s.id === 'claude' ? { ...s, aiwatchScore: null, scoreGrade: null } : s))
    const out = buildExtClaudePayload(set, 't')
    const claude = out.services.find((s) => s.id === 'claude')!
    expect(claude.score).toBeNull()
    expect(claude.grade).toBeNull()
  })

  it('empty scored set → empty services + passthrough cachedAt', () => {
    expect(buildExtClaudePayload([], null)).toEqual({ services: [], cachedAt: null, reference: { components: [], incidents: [] }, latestReport: null })
    expect(buildExtClaudePayload([], 't').services).toEqual([])
  })

  it('skips a missing surface (e.g. claudecode absent from cache)', () => {
    const set = scoredSet().filter((s) => s.id !== 'claudecode')
    const out = buildExtClaudePayload(set, 't')
    expect(out.services.map((s) => s.id)).toEqual(['claude', 'claudeai'])
  })
})

describe('buildExtClaudePayload — incidents + gated reports (#837 PR2)', () => {
  function inc(overrides: Record<string, unknown> = {}) {
    return { id: 'inc1', title: 'Elevated API errors', status: 'investigating', impact: 'major', startedAt: '2026-06-30T00:00:00Z', duration: null, timeline: [], ...overrides } as never
  }

  it('#1772 — lists every unresolved incident (monitoring kept with its phase; resolved excluded)', () => {
    const set = [
      svc({ id: 'claude', name: 'Claude API', category: 'api', status: 'down', aiwatchScore: 50, scoreGrade: 'degrading', incidents: [
        inc({ id: 'i-inv', status: 'investigating', title: 'API errors', impact: 'major' }),
        inc({ id: 'i-idf', status: 'identified', title: 'Root cause found', impact: 'minor' }),
        inc({ id: 'i-mon', status: 'monitoring', title: 'Recovering' }),
        inc({ id: 'i-res', status: 'resolved', title: 'Old one' }),
      ] }),
      svc({ id: 'claudeai', category: 'app', status: 'operational', aiwatchScore: 70, scoreGrade: 'good' }),
      svc({ id: 'claudecode', category: 'agent', status: 'operational', aiwatchScore: 70, scoreGrade: 'good' }),
    ]
    const claude = buildExtClaudePayload(set, 't').services.find((s) => s.id === 'claude')!
    // 'identified' is a real active phase — a denylist→allowlist refactor that dropped it would fail here.
    expect(claude.incidents.map((i) => i.id)).toEqual(['i-inv', 'i-idf', 'i-mon'])
    expect(claude.incidents[2]).toMatchObject({ title: 'Recovering', status: 'monitoring' })
    expect(claude.incidents[0]).toMatchObject({ title: 'API errors', status: 'investigating', impact: 'major' })
  })

  it('#1772 — orders ongoing incidents before monitoring ones, keeping input order within each', () => {
    const set = [
      svc({ id: 'claude', name: 'Claude API', category: 'api', status: 'degraded', aiwatchScore: 50, scoreGrade: 'degrading', incidents: [
        inc({ id: 'i-mon1', status: 'monitoring' }),
        inc({ id: 'i-inv', status: 'investigating' }),
        inc({ id: 'i-mon2', status: 'monitoring' }),
        inc({ id: 'i-idf', status: 'identified' }),
      ] }),
      svc({ id: 'claudeai', category: 'app', status: 'operational', aiwatchScore: 70, scoreGrade: 'good' }),
      svc({ id: 'claudecode', category: 'agent', status: 'operational', aiwatchScore: 70, scoreGrade: 'good' }),
    ]
    const claude = buildExtClaudePayload(set, 't').services.find((s) => s.id === 'claude')!
    expect(claude.incidents.map((i) => i.id)).toEqual(['i-inv', 'i-idf', 'i-mon1', 'i-mon2'])
  })

  it('#1384 — excludes a retainedBridge ghost from the "current issue" list too', () => {
    // A `retainedBridge` entry (services.ts `mergeRetainedIncidentHistory`) unresolved at migration
    // time never resolves for the life of the finite migration bridge, so without this exclusion the
    // extension popup would show a stale ghost from a retiring source as the "current issue"
    // indefinitely. Currently inert (Replicate is not in EXT_CLAUDE_IDS) but pinned generically here.
    const set = [
      svc({ id: 'claude', name: 'Claude API', category: 'api', status: 'down', aiwatchScore: 50, scoreGrade: 'degrading', incidents: [
        inc({ id: 'i-inv', status: 'investigating', title: 'API errors', impact: 'major' }),
        inc({ id: 'i-ghost', status: 'investigating', title: 'Ongoing at cutover', retainedBridge: true }),
      ] }),
      svc({ id: 'claudeai', category: 'app', status: 'operational', aiwatchScore: 70, scoreGrade: 'good' }),
      svc({ id: 'claudecode', category: 'agent', status: 'operational', aiwatchScore: 70, scoreGrade: 'good' }),
    ]
    const claude = buildExtClaudePayload(set, 't').services.find((s) => s.id === 'claude')!
    expect(claude.incidents.map((i) => i.id)).toEqual(['i-inv'])
  })

  const NOW = Date.parse('2026-06-30T02:00:00Z')
  const analysis = (o: Record<string, unknown> = {}) => ({
    summary: 'API returning 529s.', progress: 'Mitigation underway.', estimatedRecovery: '1–3h', estimatedRecoveryHours: 3,
    affectedScope: ['Claude API', 'Claude Fable 5.1'], needsFallback: true, analyzedAt: '2026-06-30T01:50:00Z',
    incidentId: 'i-act', model: 'gemma', ...o,
  }) as never
  const trio = (claude: Record<string, unknown>) => [
    svc({ id: 'claude', name: 'Claude API', category: 'api', aiwatchScore: 50, scoreGrade: 'degrading', ...claude }),
    svc({ id: 'claudeai', category: 'app', status: 'operational', aiwatchScore: 70, scoreGrade: 'good' }),
    svc({ id: 'claudecode', category: 'agent', status: 'operational', aiwatchScore: 70, scoreGrade: 'good' }),
  ]

  it('#1772 — a live incident carries the modal lines, plus the joined aiSummary older popups render', () => {
    const set = trio({ status: 'down', incidents: [inc({ id: 'i-act', startedAt: '2026-06-30T01:00:00Z' })] })
    const out = buildExtClaudePayload(set, 't', { analysisMap: { 'claude:i-act': analysis() }, nowMs: NOW })
    const i = out.services.find((s) => s.id === 'claude')!.incidents[0]
    expect(i.aiSummary).toBe('API returning 529s. Mitigation underway.')
    expect(i.ai).toEqual({
      summary: 'API returning 529s. Mitigation underway.',
      lines: ['⏱ Est. Recovery: 1–3h', '📡 Scope: Claude API, Claude Fable 5.1'],
      analyzedAt: '2026-06-30T01:50:00Z',
      model: 'Gemma',
    })
    const none = buildExtClaudePayload(set, 't').services.find((s) => s.id === 'claude')!
    expect(none.incidents[0]).not.toHaveProperty('aiSummary')
    expect(none.incidents[0]).not.toHaveProperty('ai')
  })

  it('#1772 — an incident past its estimate reads elapsed vs estimate, as in the modal', () => {
    const set = trio({ status: 'down', incidents: [inc({ id: 'i-act', startedAt: '2026-06-29T22:00:00Z' })] })
    const i = buildExtClaudePayload(set, 't', { analysisMap: { 'claude:i-act': analysis({ affectedScope: [] }) }, nowMs: NOW })
      .services.find((s) => s.id === 'claude')!.incidents[0]
    expect(i.ai!.lines).toEqual(['⏱ Est. Recovery: Ongoing ~4h · exceeded ~1–3h est.'])
  })

  it('#1772 — caps the summary pair at 500 characters, as the modal does', () => {
    const set = trio({ status: 'down', incidents: [inc({ id: 'i-act' })] })
    const i = buildExtClaudePayload(set, 't', { analysisMap: { 'claude:i-act': analysis({ summary: 'a'.repeat(400), progress: 'b'.repeat(400) }) }, nowMs: NOW })
      .services.find((s) => s.id === 'claude')!.incidents[0]
    expect(i.ai!.summary).toHaveLength(500)
    expect(i.aiSummary).toHaveLength(500)
  })

  it('#1772 — an analysis with no summary counts as none', () => {
    const set = trio({ status: 'down', incidents: [inc({ id: 'i-act' })] })
    const i = buildExtClaudePayload(set, 't', { analysisMap: { 'claude:i-act': analysis({ summary: '' }) }, nowMs: NOW })
      .services.find((s) => s.id === 'claude')!.incidents[0]
    expect(i).not.toHaveProperty('ai')
  })

  it('#1772 — a monitoring incident carries no analysis even when the map has one', () => {
    const set = trio({ status: 'operational', incidents: [inc({ id: 'i-mon', status: 'monitoring' })] })
    const i = buildExtClaudePayload(set, 't', { analysisMap: { 'claude:i-mon': analysis() }, nowMs: NOW })
      .services.find((s) => s.id === 'claude')!.incidents[0]
    expect(i).not.toHaveProperty('aiSummary')
    expect(i).not.toHaveProperty('ai')
  })

  describe('#1772 — recentlyResolved', () => {
    const resolved = (o: Record<string, unknown> = {}) => inc({ id: 'i-res', status: 'resolved', startedAt: '2026-06-30T01:00:00Z', resolvedAt: '2026-06-30T01:19:00Z', ...o })
    const done = analysis({ incidentId: 'i-res', estimatedRecoveryHours: 0.67, estimatedRecovery: '20–40m', resolvedAt: '2026-06-30T01:19:00Z' })
    const recent = (claude: Record<string, unknown>, map: Record<string, never>) =>
      buildExtClaudePayload(trio(claude), 't', { analysisMap: map, nowMs: NOW }).services.find((s) => s.id === 'claude')!.recentlyResolved

    it('carries predicted vs actual, the durable summary only, and resolvedAt', () => {
      expect(recent({ status: 'operational', incidents: [resolved()] }, { 'claude:i-res': done })).toEqual([{
        id: 'i-res', title: 'Elevated API errors', status: 'resolved', impact: 'major', resolvedAt: '2026-06-30T01:19:00Z',
        ai: {
          summary: 'API returning 529s.',
          lines: ['🎯 Predicted vs actual: est ~40m · actual 19m (faster than est.)', '📡 Scope: Claude API, Claude Fable 5.1'],
          analyzedAt: '2026-06-30T01:50:00Z',
          model: 'Gemma',
        },
      }])
    })

    it('drops an analysis with no resolvedAt stamp, or no analysis at all', () => {
      expect(recent({ status: 'operational', incidents: [resolved()] }, { 'claude:i-res': analysis({ incidentId: 'i-res' }) })).toEqual([])
      expect(recent({ status: 'operational', incidents: [resolved()] }, {})).toEqual([])
    })

    it('drops one resolved more than 3h ago', () => {
      expect(recent({ status: 'operational', incidents: [resolved({ resolvedAt: '2026-06-29T22:59:00Z' })] }, { 'claude:i-res': done })).toEqual([])
    })

    it('drops them on a service that is not operational, or that has a live analysis', () => {
      expect(recent({ status: 'degraded', incidents: [resolved()] }, { 'claude:i-res': done })).toEqual([])
      expect(recent({ status: 'operational', incidents: [inc({ id: 'i-act' }), resolved()] }, { 'claude:i-act': analysis(), 'claude:i-res': done })).toEqual([])
    })

    it('keeps them beside a live incident that has no analysis', () => {
      expect(recent({ status: 'operational', incidents: [inc({ id: 'i-act' }), resolved()] }, { 'claude:i-res': done }).map((i) => i.id)).toEqual(['i-res'])
    })
  })

  it('reports: gated map present → count + recent (cat/ts/desc, capped 5)', () => {
    const feed = Array.from({ length: 7 }, (_, n) => ({ cat: 'outage', ts: 1000 + n, desc: `note ${n}` }))
    const out = buildExtClaudePayload(scoredSet(), 't', { reportFeedMap: { claude: feed } })
    const claude = out.services.find((s) => s.id === 'claude')!
    expect(claude.reports.count).toBe(7)
    expect(claude.reports.recent).toHaveLength(5)
    expect(claude.reports.recent[0]).toEqual({ cat: 'outage', ts: 1000, desc: 'note 0' })
  })

  it('reports: desc is length-capped (140) to bound the projection', () => {
    const long = 'x'.repeat(300)
    const out = buildExtClaudePayload(scoredSet(), 't', { reportFeedMap: { claude: [{ cat: 'errors', ts: 1, desc: long }] } })
    expect(out.services.find((s) => s.id === 'claude')!.reports.recent[0].desc).toHaveLength(140)
  })

  it('reports: missing desc → empty string (not undefined)', () => {
    const out = buildExtClaudePayload(scoredSet(), 't', { reportFeedMap: { claude: [{ cat: 'errors', ts: 1 }] } })
    expect(out.services.find((s) => s.id === 'claude')!.reports.recent[0].desc).toBe('')
  })

  it('reports: service absent from the gated map → count 0 (crowd cannot surface uncorroborated)', () => {
    const out = buildExtClaudePayload(scoredSet(), 't', { reportFeedMap: { claudeai: [{ cat: 'errors', ts: 5 }] } })
    expect(out.services.find((s) => s.id === 'claude')!.reports).toEqual({ count: 0, recent: [] })
    expect(out.services.find((s) => s.id === 'claudeai')!.reports.count).toBe(1)
  })
})

describe('/api/status/cached ext-claude routing contract (#837)', () => {
  // Mirrors the index.ts dispatch order: ext-claude is checked BEFORE statusline,
  // and both before the full ~2.8 MB path. Pinned here because the handler branch is
  // inline in the fetch dispatcher (repo pattern: simulate the routing decision).
  function dispatch(search: string, cache: ScoredService[]): 'ext' | 'lite' | 'full' {
    const sp = new URLSearchParams(search)
    if (isExtClaudeRequest(sp)) return 'ext'
    if (isStatuslineRequest(sp)) return 'lite'
    return 'full'
  }

  it('routes ext-claude → ext, statusline → lite, neither → full', () => {
    const c = scoredSet()
    expect(dispatch('src=ext-claude', c)).toBe('ext')
    expect(dispatch('src=statusline-compact', c)).toBe('lite')
    expect(dispatch('src=dashboard', c)).toBe('full')
    expect(dispatch('', c)).toBe('full')
  })
})

describe('buildExtClaudePayload — Cowork, Console and the latest report (#1711)', () => {
  const COWORK = { id: 'bpp5gb3hpjcl', name: 'Claude Cowork', status: 'degraded' as const }
  const CLAUDEAI_OWN = { id: 'rwppv331jlwc', name: 'claude.ai', status: 'operational' as const }
  const CONSOLE = { id: '0qbwn08sd68x', name: 'Claude Console (platform.claude.com)', status: 'down' as const }
  const inc = (id: string, status: string) => ({ id, title: `Console ${id}`, status, impact: 'major', startedAt: 't', duration: null, timeline: [] })

  function set() {
    return scoredSet().map((s) =>
      s.id === 'claudeai' ? { ...s, components: [CLAUDEAI_OWN, COWORK] }
        : s.id === 'claude' ? { ...s, referenceComponents: [CONSOLE], referenceIncidents: [inc('c-mon', 'monitoring'), inc('c-live', 'investigating'), inc('c-done', 'resolved'), { ...inc('c-ghost', 'investigating'), retainedBridge: true }] }
          : s.id === 'claudecode' ? { ...s, referenceComponents: [CONSOLE], referenceIncidents: [inc('c-live', 'investigating')] }
            : s) as ScoredService[]
  }

  it('lists every component of a multi-component surface, so claude.ai itself is distinguishable from Cowork', () => {
    const out = buildExtClaudePayload(set(), 't')
    expect(out.services.find((s) => s.id === 'claudeai')!.components).toEqual([
      { name: 'claude.ai', status: 'operational' },
      { name: 'Claude Cowork', status: 'degraded' },
    ])
    expect(out.services.find((s) => s.id === 'claude')!.components).toEqual([])
  })

  it('emits nothing for a single-component surface', () => {
    const single = scoredSet().map((s) => (s.id === 'claudeai' ? { ...s, components: [CLAUDEAI_OWN] } : s)) as ScoredService[]
    expect(buildExtClaudePayload(single, 't').services.find((s) => s.id === 'claudeai')!.components).toEqual([])
  })

  it('carries Console as a reference component with its unresolved incidents, once each, outside the services', () => {
    const out = buildExtClaudePayload(set(), 't')
    expect(out.reference.components).toEqual([{ name: 'Claude Console (platform.claude.com)', status: 'down' }])
    expect(out.reference.incidents).toEqual([
      { id: 'c-live', title: 'Console c-live', status: 'investigating', impact: 'major' },
      { id: 'c-mon', title: 'Console c-mon', status: 'monitoring', impact: 'major' },
    ])
    expect(out.services.find((s) => s.id === 'claude')!.incidents).toEqual([])
    expect(out.services.find((s) => s.id === 'claude')!.status).toBe('down')
  })

  it('#1772 — carries each surface recovery baseline, and null for a surface without one', () => {
    const b = { n: 48, medianMin: 64, p80Min: 161, since: '2026-07-22' }
    const out = buildExtClaudePayload(scoredSet(), 't', { recoveryBaselines: { claude: b, openai: { ...b, n: 99 } } })
    expect(out.services.map((s) => [s.id, s.recoveryBaseline])).toEqual([['claude', b], ['claudeai', null], ['claudecode', null]])
    expect(buildExtClaudePayload(scoredSet(), 't').services.every((s) => s.recoveryBaseline === null)).toBe(true)
  })

  it('passes the latest published report through, and null without one', () => {
    const latestReport = { month: '2026-08', url: 'https://ai-watch.dev/reports/2026-08/', services: [{ id: 'claude', incidents: 18, downtimeMin: 600 }] }
    expect(buildExtClaudePayload(set(), 't', { latestReport }).latestReport).toEqual(latestReport)
    expect(buildExtClaudePayload(set(), 't').latestReport).toBeNull()
  })
})
