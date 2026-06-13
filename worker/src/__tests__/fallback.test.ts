import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getFallbacks, buildFallbackText, buildGroupedFallbackText, EXCLUDE_FALLBACK, tierFor, tierLabelFor, API_TIER } from '../fallback'

const mockServices = [
  { id: 'claude', category: 'api', name: 'Claude API', status: 'operational', aiwatchScore: 85 },
  { id: 'openai', category: 'api', name: 'OpenAI API', status: 'degraded', aiwatchScore: 72 },
  { id: 'groq', category: 'api', name: 'Groq Cloud', status: 'operational', aiwatchScore: 93 },
  { id: 'together', category: 'api', name: 'Together AI', status: 'operational', aiwatchScore: 89 },
  { id: 'gemini', category: 'api', name: 'Gemini API', status: 'operational', aiwatchScore: 78 },
  { id: 'mistral', category: 'api', name: 'Mistral API', status: 'operational', aiwatchScore: 76 },
  { id: 'elevenlabs', category: 'api', name: 'ElevenLabs', status: 'operational', aiwatchScore: 80 },
  { id: 'assemblyai', category: 'api', name: 'AssemblyAI', status: 'operational', aiwatchScore: 90 },
  { id: 'deepgram', category: 'api', name: 'Deepgram', status: 'operational', aiwatchScore: 85 },
  { id: 'claudeai', category: 'app', name: 'claude.ai', status: 'operational', aiwatchScore: 60 },
  { id: 'chatgpt', category: 'app', name: 'ChatGPT', status: 'down', aiwatchScore: 55 },
  { id: 'cursor', category: 'agent', name: 'Cursor', status: 'operational', aiwatchScore: 70 },
]

describe('getFallbacks', () => {
  it('returns top 2 by tier proximity then score (openai T1 → claude/gemini T1)', () => {
    const result = getFallbacks('openai', 'api', mockServices)
    expect(result).toEqual([
      { name: 'Claude API', score: 85 },
      { name: 'Gemini API', score: 78 },
    ])
  })

  it('excludes the affected service itself', () => {
    const result = getFallbacks('claude', 'api', mockServices)
    expect(result.find(f => f.name === 'Claude API')).toBeUndefined()
  })

  it('excludes non-operational services', () => {
    const result = getFallbacks('claude', 'api', mockServices)
    expect(result.find(f => f.name === 'OpenAI API')).toBeUndefined()
  })

  it('#550 — excludes an operational candidate with ANY unresolved incident phase', () => {
    // Each top-score T2 peer is operational but carries an active incident in a different phase
    // (investigating/identified/monitoring) — all three phases must disqualify (the rule is "any
    // status !== 'resolved'"). together's only incident is resolved, so it stays eligible.
    const services = [
      { id: 'mistral', category: 'api', name: 'Mistral API', status: 'operational', aiwatchScore: 76 },
      { id: 'groq', category: 'api', name: 'Groq Cloud', status: 'operational', aiwatchScore: 93, incidents: [{ status: 'investigating' }] },
      { id: 'cohere', category: 'api', name: 'Cohere API', status: 'operational', aiwatchScore: 92, incidents: [{ status: 'identified' }] },
      { id: 'fireworks', category: 'api', name: 'Fireworks AI', status: 'operational', aiwatchScore: 91, incidents: [{ status: 'monitoring' }] },
      { id: 'together', category: 'api', name: 'Together AI', status: 'operational', aiwatchScore: 89, incidents: [{ status: 'resolved' }] },
    ]
    const result = getFallbacks('mistral', 'api', services)
    expect(result.find(f => f.name === 'Groq Cloud')).toBeUndefined()    // investigating → dropped
    expect(result.find(f => f.name === 'Cohere API')).toBeUndefined()    // identified → dropped
    expect(result.find(f => f.name === 'Fireworks AI')).toBeUndefined()  // monitoring → dropped
    expect(result.find(f => f.name === 'Together AI')).toBeDefined()     // only a resolved incident → eligible
  })

  it('#616 — excludes a stale-source candidate (incidentSourceStale, #591) even when operational with a high Score', () => {
    // deepseek is excluded from Score ranking because its incident feed is stale (#591). It is
    // operational with an inflated Score and not in EXCLUDE_FALLBACK, so without the guard it would
    // win the tier-2 slot. Ranking-excluded → must not be recommended as a trusted fallback either.
    const services = [
      { id: 'mistral', category: 'api', name: 'Mistral API', status: 'degraded', aiwatchScore: 76 },
      { id: 'deepseek', category: 'api', name: 'DeepSeek API', status: 'operational', aiwatchScore: 95, incidentSourceStale: true },
      { id: 'together', category: 'api', name: 'Together AI', status: 'operational', aiwatchScore: 89 },
    ]
    const result = getFallbacks('mistral', 'api', services)
    expect(result.find(f => f.name === 'DeepSeek API')).toBeUndefined() // stale source → dropped
    expect(result.find(f => f.name === 'Together AI')).toBeDefined()    // healthy → eligible
  })

  it('#602/#601 step B — degraded Runway recommends its video sibling Luma OVER a higher-scored tier-3 infra service', () => {
    // openrouter (tier 3 Infra) has a higher Score than luma, so pre-step-B it won the Infra-tier slot
    // and Runway got recommended an LLM router. With the Video tier (5), luma (distance 0) outranks it.
    const services = [
      { id: 'runway', category: 'api', name: 'Runway', status: 'degraded', aiwatchScore: 70 },
      { id: 'luma', category: 'api', name: 'Luma (Dream Machine)', status: 'operational', aiwatchScore: 75 },
      { id: 'openrouter', category: 'api', name: 'OpenRouter', status: 'operational', aiwatchScore: 95 },
    ]
    const result = getFallbacks('runway', 'api', services)
    expect(result[0]?.name).toBe('Luma (Dream Machine)')
  })

  it('#602 — degraded Luma recommends Runway first (reverse video pairing) over higher-scored infra', () => {
    const services = [
      { id: 'luma', category: 'api', name: 'Luma (Dream Machine)', status: 'degraded', aiwatchScore: 70 },
      { id: 'runway', category: 'api', name: 'Runway', status: 'operational', aiwatchScore: 75 },
      { id: 'openrouter', category: 'api', name: 'OpenRouter', status: 'operational', aiwatchScore: 95 },
    ]
    const result = getFallbacks('luma', 'api', services)
    expect(result[0]?.name).toBe('Runway')
  })

  it('returns empty for EXCLUDE_FALLBACK services', () => {
    expect(getFallbacks('replicate', 'api', mockServices)).toEqual([])
    expect(getFallbacks('huggingface', 'api', mockServices)).toEqual([])
  })

  it('returns voice tier fallbacks for ElevenLabs', () => {
    const result = getFallbacks('elevenlabs', 'api', mockServices)
    expect(result).toHaveLength(2)
    expect(result[0].name).toBe('AssemblyAI')
    expect(result[1].name).toBe('Deepgram')
  })

  it('excludes EXCLUDE_FALLBACK services from candidates', () => {
    const services = [
      { id: 'openai', category: 'api', name: 'OpenAI API', status: 'down', aiwatchScore: 86 },
      { id: 'huggingface', category: 'api', name: 'Hugging Face', status: 'operational', aiwatchScore: 100 },
      { id: 'cohere', category: 'api', name: 'Cohere API', status: 'operational', aiwatchScore: 100 },
      { id: 'deepseek', category: 'api', name: 'DeepSeek API', status: 'operational', aiwatchScore: 100 },
    ]
    const result = getFallbacks('openai', 'api', services)
    expect(result).toHaveLength(2)
    expect(result.every(f => f.name !== 'Hugging Face')).toBe(true)
    expect(result[0].name).toBe('Cohere API')
    expect(result[1].name).toBe('DeepSeek API')
  })

  it('T2 service recommends T2 peers first', () => {
    const result = getFallbacks('mistral', 'api', mockServices)
    // mistral is T2, should prefer T2 peers (groq, together) over T1 (claude, gemini)
    expect(result[0].name).toBe('Groq Cloud')
    expect(result[1].name).toBe('Together AI')
  })

  it('Fireworks AI appears as T2 fallback when higher-score T2 peers are down', () => {
    const services = [
      { id: 'together', category: 'api', name: 'Together AI', status: 'degraded', aiwatchScore: 89 },
      { id: 'groq', category: 'api', name: 'Groq Cloud', status: 'degraded', aiwatchScore: 93 },
      { id: 'fireworks', category: 'api', name: 'Fireworks AI', status: 'operational', aiwatchScore: 85 },
      { id: 'cohere', category: 'api', name: 'Cohere API', status: 'operational', aiwatchScore: 76 },
      { id: 'claude', category: 'api', name: 'Claude API', status: 'operational', aiwatchScore: 90 },
      { id: 'deepseek', category: 'api', name: 'DeepSeek API', status: 'operational', aiwatchScore: 80 },
    ]
    const result = getFallbacks('together', 'api', services)
    // together is T2 → prefer operational T2 peers by Score: fireworks(85) > deepseek(80) > cohere(76)
    expect(result[0].name).toBe('Fireworks AI')
    expect(result[1].name).toBe('DeepSeek API')
  })

  it('Fireworks AI is not excluded from fallback candidates', () => {
    expect(EXCLUDE_FALLBACK).not.toContain('fireworks')
  })

  it('only returns services from the same category', () => {
    const result = getFallbacks('chatgpt', 'app', mockServices)
    expect(result).toEqual([{ name: 'claude.ai', score: 60 }])
  })

  it('handles null aiwatchScore', () => {
    const services = [
      { id: 'a', category: 'api', name: 'A', status: 'operational', aiwatchScore: null },
      { id: 'b', category: 'api', name: 'B', status: 'degraded', aiwatchScore: 50 },
    ]
    const result = getFallbacks('b', 'api', services)
    expect(result).toEqual([{ name: 'A', score: null }])
  })

  it('returns empty when all same-category services are down', () => {
    const services = [
      { id: 'a', category: 'app', name: 'A', status: 'down', aiwatchScore: 50 },
      { id: 'b', category: 'app', name: 'B', status: 'degraded', aiwatchScore: 40 },
    ]
    expect(getFallbacks('a', 'app', services)).toEqual([])
  })
})

describe('buildFallbackText', () => {
  it('formats fallback list with scores', () => {
    const text = buildFallbackText([
      { name: 'Groq Cloud', score: 93 },
      { name: 'Together AI', score: 89 },
    ])
    expect(text).toBe('👉 Suggested fallback: Groq Cloud (Score 93) · Together AI (Score 89)')
  })

  it('formats fallback without score', () => {
    const text = buildFallbackText([{ name: 'Claude API', score: null }])
    expect(text).toBe('👉 Suggested fallback: Claude API')
  })

  it('returns an empty string when there are no fallbacks (#641 — no subjective "no fallback" claim)', () => {
    expect(buildFallbackText([])).toBe('')
  })
})

describe('buildGroupedFallbackText', () => {
  const services = [
    { id: 'claude', category: 'api', name: 'Claude API', status: 'down', aiwatchScore: 85 },
    { id: 'claudeai', category: 'app', name: 'claude.ai', status: 'down', aiwatchScore: 60 },
    { id: 'claude-code', category: 'agent', name: 'Claude Code', status: 'down', aiwatchScore: 70 },
    { id: 'openai', category: 'api', name: 'OpenAI API', status: 'operational', aiwatchScore: 86 },
    { id: 'gemini', category: 'api', name: 'Gemini API', status: 'operational', aiwatchScore: 76 },
    { id: 'chatgpt', category: 'app', name: 'ChatGPT', status: 'operational', aiwatchScore: 67 },
    { id: 'characterai', category: 'app', name: 'Character.AI', status: 'operational', aiwatchScore: 79 },
    { id: 'cursor', category: 'agent', name: 'Cursor', status: 'operational', aiwatchScore: 75 },
    { id: 'github-copilot', category: 'agent', name: 'GitHub Copilot', status: 'operational', aiwatchScore: 80 },
  ]

  it('returns multi-category fallback for grouped incident', () => {
    const text = buildGroupedFallbackText(['claude', 'claudeai', 'claude-code'], services)
    expect(text).toContain('LLM:')
    expect(text).toContain('OpenAI API (Score 86)')
    expect(text).toContain('AI Apps:')
    expect(text).toContain('ChatGPT')
    expect(text).toContain('Coding Agent:')
    expect(text).toContain('GitHub Copilot')
  })

  it('deduplicates tier groups', () => {
    const text = buildGroupedFallbackText(['claude', 'claudeai'], services)
    const llmMatches = text.match(/LLM:/g)
    expect(llmMatches).toHaveLength(1)
  })

  it('skips excluded services', () => {
    const text = buildGroupedFallbackText(['characterai', 'claudeai'], services)
    // characterai is in EXCLUDE_FALLBACK, only app from claudeai
    expect(text).toContain('AI Apps:')
    expect(text).not.toContain('Character.AI:')
  })

  it('returns an empty string when all services are excluded (#641 — no "no fallback" claim)', () => {
    expect(buildGroupedFallbackText(['replicate', 'huggingface'], services)).toBe('')
  })

  it('returns single tier group when only one affected', () => {
    const text = buildGroupedFallbackText(['claude'], services)
    expect(text).toContain('LLM:')
    expect(text).not.toContain('AI Apps:')
    expect(text).not.toContain('Coding Agent:')
  })

  it('uses tier label (Voice) instead of category label (API) for voice services', () => {
    const voiceServices = [
      { id: 'elevenlabs', category: 'api', name: 'ElevenLabs', status: 'degraded', aiwatchScore: 54 },
      { id: 'assemblyai', category: 'api', name: 'AssemblyAI', status: 'operational', aiwatchScore: 84 },
      { id: 'deepgram', category: 'api', name: 'Deepgram', status: 'operational', aiwatchScore: 70 },
    ]
    const text = buildGroupedFallbackText(['elevenlabs'], voiceServices)
    expect(text).toContain('Voice:')
    expect(text).not.toContain('API:')
  })
})

// #402 — coding-agent tier (T11 CLI / T12 IDE / T13 Plugin) regression coverage.
// Pre-#402 every agent fell through to `?? 99`, so getFallbacks ordered purely by Score, which let
// Junie (new service, shallow incident history → inflated Score) appear as #1 for unrelated agents.
// These tests pin the post-fix contract — same-tier peer ranks above cross-tier peers regardless of
// Score, so the recommendation matches the affected agent's usage pattern (CLI/IDE/Plugin).
describe('getFallbacks — coding agent tiers (#402)', () => {
  // Adversarial Score layout: each tier's "wrong" candidates are given Scores that beat the
  // correct same-tier peer, so a Score-only sort surfaces them first. Tier-distance sort must
  // override that bias for the assertions below to pass.
  //
  // The two highest-Score services (cursor 99 / junie 95) sit in different tiers (T12 / T13)
  // intentionally. That way, every "affected → expected #1" assertion below names a service that
  // is NOT the highest Score in the fixture, so a regression that drops the tier-distance term and
  // collapses to Score-only ordering provably fails — pinned by the simulator at the bottom of
  // each test comment.
  const agentServices = [
    { id: 'claudecode', category: 'agent', name: 'Claude Code', status: 'operational', aiwatchScore: 70 },
    { id: 'codex',      category: 'agent', name: 'Codex',       status: 'operational', aiwatchScore: 75 },
    { id: 'cursor',     category: 'agent', name: 'Cursor',      status: 'operational', aiwatchScore: 99 },
    { id: 'windsurf',   category: 'agent', name: 'Windsurf',    status: 'operational', aiwatchScore: 65 },
    { id: 'copilot',    category: 'agent', name: 'GitHub Copilot', status: 'operational', aiwatchScore: 78 },
    { id: 'junie',      category: 'agent', name: 'Junie',       status: 'operational', aiwatchScore: 95 },
  ]

  it('Claude Code (T11 CLI) → Codex first, despite Cursor + Junie having higher Scores', () => {
    // Score-only regression would yield [Cursor 99, Junie 95]; tier-distance must produce Codex first.
    const result = getFallbacks('claudecode', 'agent', agentServices)
    expect(result[0].name).toBe('Codex')                // T11 same-tier peer (dist 0)
    expect(result[1].name).toBe('Cursor')               // T12 dist 1, Cursor 99 > Windsurf 65
  })

  it('Cursor (T12 IDE) → Windsurf first as same-tier peer, despite Junie having a higher Score', () => {
    // Score-only regression would yield [Junie 95, Copilot 78]; tier-distance must produce Windsurf first.
    const result = getFallbacks('cursor', 'agent', agentServices)
    expect(result[0].name).toBe('Windsurf')             // T12 same-tier peer (dist 0)
    // Second slot: T11 and T13 are equidistant (1) — Score breaks the tie. Junie 95 wins.
    expect(result[1].name).toBe('Junie')
  })

  it('GitHub Copilot (T13 Plugin) → Junie first, despite Cursor having a higher Score', () => {
    // The "Junie #1 is correct" case — but only when Junie is the same-tier peer of the affected
    // agent. Pre-bump fixture had cursor 80 < junie 95, so Score-only happened to agree with the
    // tier verdict; the new cursor 99 makes this assertion load-bearing.
    const result = getFallbacks('copilot', 'agent', agentServices)
    expect(result[0].name).toBe('Junie')                // T13 same-tier peer (dist 0)
    expect(result[1].name).toBe('Cursor')               // T12 dist 1 beats CLI dist 2
  })

  it('Codex (T11 CLI) → Claude Code first, mirroring the claudecode case', () => {
    // Symmetry pin for the CLI tier — the live #402 trigger was a Codex outage, so this is the
    // exact scenario users hit. Score-only regression gives [Cursor 99, Junie 95]; tier yields
    // Claude Code despite its Score 70.
    const result = getFallbacks('codex', 'agent', agentServices)
    expect(result[0].name).toBe('Claude Code')
    expect(result[1].name).toBe('Cursor')               // T12 dist 1, Cursor 99 > Windsurf 65
  })

  it('Junie (T13 Plugin) → GitHub Copilot first, mirroring the copilot case', () => {
    // The "new service has its first outage" scenario that motivated #402. With Junie itself
    // affected, the only same-tier candidate is Copilot — and that must win even though Cursor's
    // Score (99) is higher.
    const result = getFallbacks('junie', 'agent', agentServices)
    expect(result[0].name).toBe('GitHub Copilot')       // T13 same-tier peer
    expect(result[1].name).toBe('Cursor')               // T12 dist 1 beats CLI dist 2
  })

  it('Plugin tier wiped out (copilot affected, junie down) → walks to IDE tier (Cursor + Windsurf)', () => {
    // Sibling-outage realism: when the only same-tier peer is unhealthy, the recommendation must
    // walk to the nearest healthy tier rather than skip into a far tier just because Score is high.
    // Score-only regression here produces [Cursor 99, Codex 75]; tier-walk produces [Cursor 99, Windsurf 65]
    // because both IDE peers are dist 1 vs CLI peers at dist 2 — Windsurf 65 still beats Codex 75
    // on tier-distance. Second-slot assertion is what makes this load-bearing.
    const services = agentServices.map(s =>
      s.id === 'junie' ? { ...s, status: 'down' } : s,
    )
    const result = getFallbacks('copilot', 'agent', services)
    expect(result.find(f => f.name === 'Junie')).toBeUndefined()
    expect(result[0].name).toBe('Cursor')               // T12 dist 1, Score 99
    expect(result[1].name).toBe('Windsurf')             // T12 dist 1, Score 65 — still beats Codex 75 (T11 dist 2)
  })
})

describe('EXCLUDE_FALLBACK', () => {
  it('contains inference/embedding/infra services but not voice services', () => {
    expect(EXCLUDE_FALLBACK).toContain('replicate')
    expect(EXCLUDE_FALLBACK).toContain('huggingface')
    expect(EXCLUDE_FALLBACK).toContain('voyageai')
    expect(EXCLUDE_FALLBACK).toContain('modal')
    expect(EXCLUDE_FALLBACK).not.toContain('elevenlabs')
    expect(EXCLUDE_FALLBACK).not.toContain('assemblyai')
    expect(EXCLUDE_FALLBACK).not.toContain('deepgram')
  })

  it('does not exclude coding agent services', () => {
    expect(EXCLUDE_FALLBACK).not.toContain('copilot')
    expect(EXCLUDE_FALLBACK).not.toContain('cursor')
    expect(EXCLUDE_FALLBACK).not.toContain('claudecode')
    expect(EXCLUDE_FALLBACK).not.toContain('windsurf')
  })
})

// #403 — pin the warn-once behavior for the silent-fallback hardening helpers.
// These tests use unique synthetic ids per test (not real service ids) so the module-scope
// warned-set never collides between tests, even if vitest runs them in shared module scope.
describe('tierFor (#403 warn-once helper)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => { warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}) })
  afterEach(() => { warnSpy.mockRestore() })

  it('returns the mapped tier for a known service id (no warning)', () => {
    expect(tierFor('claude')).toBe(API_TIER.claude)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('returns 99 and warns once for an unknown service id', () => {
    const fakeId = '__test_warn_once_unknown_a__'
    expect(tierFor(fakeId)).toBe(99)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0]).toContain(fakeId)
  })

  it('repeated calls for the same unknown id do not re-warn', () => {
    const fakeId = '__test_warn_once_unknown_b__'
    tierFor(fakeId)
    tierFor(fakeId)
    tierFor(fakeId)
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('warns separately for each distinct unknown id (not silenced globally)', () => {
    tierFor('__test_warn_once_unknown_c1__')
    tierFor('__test_warn_once_unknown_c2__')
    expect(warnSpy).toHaveBeenCalledTimes(2)
  })
})

describe('tierLabelFor (#403)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => { warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}) })
  afterEach(() => { warnSpy.mockRestore() })

  it('returns the mapped label for a known tier (no warning)', () => {
    expect(tierLabelFor(1)).toBe('LLM')
    expect(tierLabelFor(11)).toBe('CLI Agent')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('returns undefined and warns once for an unknown tier', () => {
    // Using 9999 instead of 99 — 99 is the API_TIER fallback sentinel and a future change might
    // legitimately add a TIER_LABEL[99] = "Unknown". A clearly-unmapped tier number stays unmapped.
    expect(tierLabelFor(9999)).toBeUndefined()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0]).toContain('9999')
  })

  it('repeated calls for the same unknown tier do not re-warn', () => {
    tierLabelFor(8888)
    tierLabelFor(8888)
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })
})
