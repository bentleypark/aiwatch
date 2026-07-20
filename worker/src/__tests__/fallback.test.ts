import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getFallbacks, buildFallbackText, buildGroupedFallbackText, getGroupedFallbacks, EXCLUDE_FALLBACK, tierFor, tierLabelFor, API_TIER, isSpecializedSubTier, routingTier, capabilityOfComponent, effectiveTierFor, CAPABILITY_TIER, isCapabilityProvider, CAPABILITY_PROVIDERS } from '../fallback'

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

  it('#811 — a non-reliability ADVISORY (Claude model-access suspension) does NOT disqualify an operational candidate', () => {
    // The live 2026-06-27 case: Claude carries "We've suspended access to Claude Mythos 5 and Claude
    // Fable 5" (status monitoring, badge operational — an access advisory, not an outage). Pre-#811 the
    // bare status!==resolved rule dropped it; now it stays eligible. An outage-signal title still drops it.
    const ADVISORY = "We've suspended access to Claude Mythos 5 and Claude Fable 5"
    const services = [
      { id: 'openai', category: 'api', name: 'OpenAI API', status: 'degraded', aiwatchScore: 70 },
      { id: 'claude', category: 'api', name: 'Claude API', status: 'operational', aiwatchScore: 95, incidents: [{ status: 'monitoring', title: ADVISORY }] },
      { id: 'mistral', category: 'api', name: 'Mistral API', status: 'operational', aiwatchScore: 60 },
    ]
    expect(getFallbacks('openai', 'api', services).find(f => f.name === 'Claude API')).toBeDefined() // advisory ignored → eligible

    // Same incident phase, but an OUTAGE-signal title → still disqualified (#550 preserved).
    const outage = [
      { id: 'openai', category: 'api', name: 'OpenAI API', status: 'degraded', aiwatchScore: 70 },
      { id: 'claude', category: 'api', name: 'Claude API', status: 'operational', aiwatchScore: 95, incidents: [{ status: 'monitoring', title: 'Elevated error rates on the Messages API' }] },
      { id: 'mistral', category: 'api', name: 'Mistral API', status: 'operational', aiwatchScore: 60 },
    ]
    expect(getFallbacks('openai', 'api', outage).find(f => f.name === 'Claude API')).toBeUndefined() // outage signal → dropped

    // A title-less unresolved incident (legacy data) still disqualifies — no regression to #550.
    const legacy = [
      { id: 'openai', category: 'api', name: 'OpenAI API', status: 'degraded', aiwatchScore: 70 },
      { id: 'claude', category: 'api', name: 'Claude API', status: 'operational', aiwatchScore: 95, incidents: [{ status: 'investigating' }] },
      { id: 'mistral', category: 'api', name: 'Mistral API', status: 'operational', aiwatchScore: 60 },
    ]
    expect(getFallbacks('openai', 'api', legacy).find(f => f.name === 'Claude API')).toBeUndefined() // no title → still counts
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

  it('#1062 — ElevenLabs (TTS) recommends only capability-sharing Voice peers (Deepgram), NOT AssemblyAI (STT)', () => {
    // Pre-#1062 this returned [AssemblyAI(STT), Deepgram] — AssemblyAI is transcription-only and cannot
    // substitute a text-to-speech caller. Now only Deepgram (STT+TTS) qualifies; AssemblyAI is filtered.
    const result = getFallbacks('elevenlabs', 'api', mockServices)
    expect(result).toEqual([{ name: 'Deepgram', score: 85 }])
    expect(result.find(f => f.name === 'AssemblyAI')).toBeUndefined()
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

describe('#1062 facet A — Voice tier STT/TTS capability gating', () => {
  const voice = [
    { id: 'elevenlabs', category: 'api', name: 'ElevenLabs', status: 'operational', aiwatchScore: 80 },
    { id: 'assemblyai', category: 'api', name: 'AssemblyAI', status: 'operational', aiwatchScore: 90 },
    { id: 'deepgram', category: 'api', name: 'Deepgram', status: 'operational', aiwatchScore: 85 },
  ]

  it('AssemblyAI (STT) recommends only Deepgram (STT), NOT ElevenLabs (TTS)', () => {
    const result = getFallbacks('assemblyai', 'api', voice.map(s => s.id === 'assemblyai' ? { ...s, status: 'degraded' } : s))
    expect(result).toEqual([{ name: 'Deepgram', score: 85 }])
  })

  it('Deepgram (STT+TTS) bridges both — recommends ElevenLabs AND AssemblyAI, Score-ordered', () => {
    const result = getFallbacks('deepgram', 'api', voice.map(s => s.id === 'deepgram' ? { ...s, status: 'degraded' } : s))
    // Both share a capability with Deepgram (AssemblyAI=STT, ElevenLabs=TTS). Same tier (distance 0) so
    // ordering is Score-descending: AssemblyAI(90) before ElevenLabs(80). Assert the real order (no .sort()).
    expect(result).toEqual([{ name: 'AssemblyAI', score: 90 }, { name: 'ElevenLabs', score: 80 }])
  })

  it('suppresses (empty) when the only capability-sharing sibling is itself down', () => {
    // ElevenLabs (TTS) is down and Deepgram (the only TTS sibling) is also down → AssemblyAI (STT) must
    // NOT be offered as a wrong-capability substitute. Route-else-suppress: no recommendation is correct.
    const services = [
      { id: 'elevenlabs', category: 'api', name: 'ElevenLabs', status: 'down', aiwatchScore: 80 },
      { id: 'deepgram', category: 'api', name: 'Deepgram', status: 'down', aiwatchScore: 85 },
      { id: 'assemblyai', category: 'api', name: 'AssemblyAI', status: 'operational', aiwatchScore: 90 },
    ]
    expect(getFallbacks('elevenlabs', 'api', services)).toEqual([])
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

  it('#554 — keeps a candidate whose provider matches an affected service (parity guard vs dashboard)', () => {
    // Faithful mirror of the dashboard `#554` headline test: ChatGPT (OpenAI) down + Claude Code
    // (Anthropic) degraded; claude.ai (Anthropic) is operational. claude.ai's provider (Anthropic)
    // matches an affected service (Claude Code), so the dashboard's former blanket rule dropped it →
    // empty fallback. The worker has no such rule, so claude.ai IS recommended. The `provider` fields
    // are populated so that if a future change re-adds a provider exclusion reading them, claude.ai
    // would drop and this test breaks — catching the cross-surface drift.
    const svcs = [
      { id: 'chatgpt', category: 'app', name: 'ChatGPT', provider: 'OpenAI', status: 'down', aiwatchScore: 67 },
      { id: 'claude-code', category: 'agent', name: 'Claude Code', provider: 'Anthropic', status: 'degraded', aiwatchScore: 70 },
      { id: 'claudeai', category: 'app', name: 'claude.ai', provider: 'Anthropic', status: 'operational', aiwatchScore: 84 },
      { id: 'characterai', category: 'app', name: 'Character.AI', provider: 'Character AI', status: 'operational', aiwatchScore: 79 },
    ]
    const text = buildGroupedFallbackText(['chatgpt', 'claude-code'], svcs)
    expect(text).toContain('claude.ai')  // recommended despite sharing Anthropic with the degraded Claude Code
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

// #1027 — coding agents share ONE tier (11). The CLI/IDE/Plugin sub-tiers (11/12/13, added in #402)
// encoded a delivery-FORM axis that collapsed once every agent shipped both a CLI and an IDE surface,
// so a single-form label was inaccurate. With all six at tier 11, tier-distance is always 0 and
// ordering reduces to Score within the agent category (top-2). These tests pin that contract.
//
// The #402 "Junie-as-#1 from an inflated Score" failure is now guarded at the SCORE layer (coverage
// gate #802 + low-confidence withholding #713) rather than by form sub-tiers — a shallow-history
// agent can't carry a *trusted* Score to the top slot. getFallbacks itself filters on status/incident,
// not Score/confidence, so these fixtures pass raw Scores and assert the pure Score ordering.
describe('getFallbacks — coding agents share one tier, Score-ordered (#1027)', () => {
  const agentServices = [
    { id: 'claudecode', category: 'agent', name: 'Claude Code', status: 'operational', aiwatchScore: 70 },
    { id: 'codex',      category: 'agent', name: 'Codex',       status: 'operational', aiwatchScore: 75 },
    { id: 'cursor',     category: 'agent', name: 'Cursor',      status: 'operational', aiwatchScore: 99 },
    { id: 'windsurf',   category: 'agent', name: 'Windsurf',    status: 'operational', aiwatchScore: 65 },
    { id: 'copilot',    category: 'agent', name: 'GitHub Copilot', status: 'operational', aiwatchScore: 78 },
    { id: 'junie',      category: 'agent', name: 'Junie',       status: 'operational', aiwatchScore: 95 },
  ]

  it('Claude Code affected → top-2 by Score across all agents = [Cursor 99, Junie 95]', () => {
    // No more same-form preference: the two highest-Score operational peers win regardless of form.
    const result = getFallbacks('claudecode', 'agent', agentServices)
    expect(result[0].name).toBe('Cursor') // Score 99
    expect(result[1].name).toBe('Junie')  // Score 95
  })

  it('Codex affected → same top-2 by Score = [Cursor 99, Junie 95]', () => {
    // The live #402 trigger was a Codex outage; post-#1027 it recommends the best-scored operational
    // agents, not a same-form peer.
    const result = getFallbacks('codex', 'agent', agentServices)
    expect(result[0].name).toBe('Cursor')
    expect(result[1].name).toBe('Junie')
  })

  it('affected service is excluded even when it is the highest Score (Cursor affected → [Junie 95, Copilot 78])', () => {
    const result = getFallbacks('cursor', 'agent', agentServices)
    expect(result.find(f => f.name === 'Cursor')).toBeUndefined()
    expect(result[0].name).toBe('Junie')          // 95
    expect(result[1].name).toBe('GitHub Copilot') // 78
  })

  it('down peers AND operational-but-incident-carrying peers are both dropped before Score ordering', () => {
    // junie is down; cursor (the highest Score, 99) stays 'operational' but carries an UNRESOLVED
    // incident — hasActiveIncident must drop it too, exercising the operational-with-incident path for
    // an agent (not just a 'down' status). Copilot is the affected source. Remaining eligible:
    // claudecode 70, codex 75, windsurf 65 → top-2 = [Codex 75, Claude Code 70].
    const services = agentServices.map(s => {
      if (s.id === 'junie') return { ...s, status: 'down' }
      if (s.id === 'cursor') return { ...s, incidents: [{ status: 'investigating', title: 'Editor outage' }] }
      return s
    })
    const result = getFallbacks('copilot', 'agent', services)
    expect(result.find(f => f.name === 'Junie')).toBeUndefined()          // down
    expect(result.find(f => f.name === 'Cursor')).toBeUndefined()         // operational + active incident
    expect(result.find(f => f.name === 'GitHub Copilot')).toBeUndefined() // affected source
    expect(result[0].name).toBe('Codex')       // 75
    expect(result[1].name).toBe('Claude Code') // 70 (windsurf 65 lower)
  })

  it('agent-category-wide outage → no recommendation (empty result, empty fallback text)', () => {
    // The boundary the old tier-walk suite gestured at: when every peer agent is down/affected there is
    // nothing left to recommend. With the tiers collapsed there is no walk to a neighbouring tier, so
    // getFallbacks must return [] and buildFallbackText must emit '' (never a misleading "no fallback").
    const services = agentServices.map(s =>
      s.id === 'cursor' ? s : { ...s, status: 'down' }, // cursor is the affected source; all others down
    )
    const result = getFallbacks('cursor', 'agent', services)
    expect(result).toEqual([])
    expect(buildFallbackText(result)).toBe('')
  })

  it('a null-Score agent sinks to the bottom via `?? 0` (the only structural backstop after #1027)', () => {
    // #1027 removed the form sub-tiers, so the sole thing keeping a dataless agent out of the top slot is
    // the `aiwatchScore ?? 0` coalesce in the sort. A withheld/null Score must order LAST, below every
    // real Score. (Note: this does NOT protect against a shallow-history agent with an *inflated* non-null
    // Score — that #402 risk is procedural-only post-#1027; see the comment in fallback.ts.)
    const services = agentServices.map(s =>
      s.id === 'junie' ? { ...s, aiwatchScore: null } : s, // junie was 95 → now null
    )
    const result = getFallbacks('claudecode', 'agent', services)
    expect(result[0].name).toBe('Cursor') // 99
    expect(result[1].name).toBe('GitHub Copilot') // 78 — junie(null) no longer in the top-2
    expect(result.find(f => f.name === 'Junie')).toBeUndefined()
  })

  it('Score ties keep both peers eligible (order is stable but the tie is not dropped)', () => {
    // The one ambiguity the collapse introduces: two agents at an equal Score. V8 sort is stable so the
    // input order is preserved, but the contract that matters is that BOTH tied peers remain candidates
    // (a tie must not silently drop one). copilot & junie both 88 here.
    const services = agentServices.map(s =>
      s.id === 'copilot' || s.id === 'junie' ? { ...s, aiwatchScore: 88 } : s,
    )
    const result = getFallbacks('claudecode', 'agent', services)
    expect(result[0].name).toBe('Cursor') // 99 still first
    expect(['GitHub Copilot', 'Junie']).toContain(result[1].name) // one of the tied 88s takes slot 2
  })

  it('every agent resolves to tier 11 (no residual 12/13 sub-tiers)', () => {
    for (const id of ['claudecode', 'codex', 'cursor', 'windsurf', 'copilot', 'junie']) {
      expect(tierFor(id)).toBe(11)
    }
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

  it('#756 — does not exclude the image-generation siblings (Stability + FLUX)', () => {
    expect(EXCLUDE_FALLBACK).not.toContain('stability')
    expect(EXCLUDE_FALLBACK).not.toContain('bfl')
  })
})

describe('#756 image fallback sub-tier (Stability ↔ FLUX)', () => {
  const svc = (id: string, name: string, status = 'operational', aiwatchScore = 90) =>
    ({ id, name, category: 'api', status, aiwatchScore })

  it('a degraded image service recommends its image sibling over an LLM/voice service', () => {
    const services = [
      svc('bfl', 'Black Forest Labs (FLUX)', 'down'),
      svc('stability', 'Stability AI', 'operational', 88),
      svc('claude', 'Claude API', 'operational', 95),
      svc('elevenlabs', 'ElevenLabs', 'operational', 92),
    ]
    const result = getFallbacks('bfl', 'api', services)
    expect(result[0].name).toBe('Stability AI') // Tier 7 dist 0 beats any LLM/voice tier
  })

  it('is symmetric — Stability recommends FLUX', () => {
    const services = [
      svc('stability', 'Stability AI', 'down'),
      svc('bfl', 'Black Forest Labs (FLUX)', 'operational', 84),
      svc('claude', 'Claude API', 'operational', 95),
    ]
    const result = getFallbacks('stability', 'api', services)
    expect(result[0].name).toBe('Black Forest Labs (FLUX)')
  })
})

describe('#857 vector fallback sub-tier (Pinecone ↔ turbopuffer)', () => {
  const svc = (id: string, name: string, status = 'operational', aiwatchScore: number | null = 90) =>
    ({ id, name, category: 'api', status, aiwatchScore })

  it('#857 — pinecone is no longer in EXCLUDE_FALLBACK (vector sibling added)', () => {
    expect(EXCLUDE_FALLBACK).not.toContain('pinecone')
    expect(EXCLUDE_FALLBACK).not.toContain('turbopuffer')
    expect(API_TIER.pinecone).toBe(8)
    expect(API_TIER.turbopuffer).toBe(8)
    expect(tierLabelFor(8)).toBe('Vector')
  })

  it('a down vector DB recommends its vector sibling over an LLM/voice service', () => {
    const services = [
      svc('pinecone', 'Pinecone', 'down'),
      svc('turbopuffer', 'turbopuffer', 'operational', null), // no official uptime → score may be null; still recommended
      svc('claude', 'Claude API', 'operational', 95),
      svc('elevenlabs', 'ElevenLabs', 'operational', 92),
    ]
    const result = getFallbacks('pinecone', 'api', services)
    expect(result[0].name).toBe('turbopuffer') // Tier 8 dist 0 beats any LLM/voice tier, even with a null score
  })

  it('is symmetric — a down turbopuffer recommends Pinecone', () => {
    const services = [
      svc('turbopuffer', 'turbopuffer', 'down', null),
      svc('pinecone', 'Pinecone', 'operational', 80),
      svc('claude', 'Claude API', 'operational', 95),
    ]
    const result = getFallbacks('turbopuffer', 'api', services)
    expect(result[0].name).toBe('Pinecone')
  })
})

describe('#859 specialized sub-tier does not bleed cross-tier for its 2nd recommendation', () => {
  const svc = (id: string, name: string, tierNote: string, status = 'operational', aiwatchScore = 90) =>
    ({ id, name, category: 'api', status, aiwatchScore, tierNote })

  it('isSpecializedSubTier: LLM tiers 1-3 false, sub-tiers 4-8 true, agents/apps false', () => {
    expect([1, 2, 3].every(t => !isSpecializedSubTier(t))).toBe(true)
    expect([4, 5, 6, 7, 8].every(t => isSpecializedSubTier(t))).toBe(true)
    expect(isSpecializedSubTier(11)).toBe(false) // CLI agent
    expect(isSpecializedSubTier(21)).toBe(false) // app
    expect(isSpecializedSubTier(99)).toBe(false) // unknown fallthrough
  })

  it('image (Stability, T7) down → only its image sibling, NOT an observability service', () => {
    // Before #859: getFallbacks filled the 2nd slot with Langfuse (T6, distance 1) — an observability
    // tool recommended as an image-gen alternative. Now the sub-tier is capped to same-tier.
    const services = [
      svc('stability', 'Stability AI', 'image', 'down'),
      svc('bfl', 'Black Forest Labs (FLUX)', 'image', 'operational', 84),
      svc('langfuse', 'Langfuse', 'observability', 'operational', 99), // highest score, adjacent tier
      svc('helicone', 'Helicone', 'observability', 'operational', 97),
    ]
    const result = getFallbacks('stability', 'api', services)
    expect(result.map(r => r.name)).toEqual(['Black Forest Labs (FLUX)']) // ONLY the image sibling
  })

  it('video (Runway, T5) down → only Luma, NOT a cross-tier service', () => {
    const services = [
      svc('runway', 'Runway', 'video', 'down'),
      svc('luma', 'Luma (Dream Machine)', 'video', 'operational', 70),
      svc('langfuse', 'Langfuse', 'observability', 'operational', 99),
      svc('claude', 'Claude API', 'llm', 'operational', 95),
    ]
    const result = getFallbacks('runway', 'api', services)
    expect(result.map(r => r.name)).toEqual(['Luma (Dream Machine)'])
  })

  it('observability (LangSmith, T6) down → its observability siblings only', () => {
    const services = [
      svc('langsmith', 'LangChain (LangSmith)', 'observability', 'down'),
      svc('helicone', 'Helicone', 'observability', 'operational', 88),
      svc('langfuse', 'Langfuse', 'observability', 'operational', 86),
      svc('claude', 'Claude API', 'llm', 'operational', 99),
    ]
    const result = getFallbacks('langsmith', 'api', services)
    expect(result.map(r => r.name).sort()).toEqual(['Helicone', 'Langfuse'])
  })

  it('REGRESSION: an LLM (T2) still gets cross-tier fill (behavior unchanged for tiers 1-3)', () => {
    // together (T2) with no other T2 present still recommends across LLM tiers (claude T1, openrouter T3).
    const services = [
      svc('together', 'Together AI', 'llm', 'down'),
      svc('claude', 'Claude API', 'llm', 'operational', 95),
      svc('openrouter', 'OpenRouter', 'llm', 'operational', 80),
    ]
    const result = getFallbacks('together', 'api', services)
    expect(result.map(r => r.name)).toEqual(['Claude API', 'OpenRouter']) // cross-tier fill intact
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
    expect(tierLabelFor(11)).toBe('Coding Agent') // #1027 — single agent tier
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

describe('getGroupedFallbacks (#781) — per-category structure + perGroup parity', () => {
  const svcs = [
    { id: 'claude', category: 'api', name: 'Claude API', status: 'degraded', aiwatchScore: 80 },
    { id: 'claudeai', category: 'app', name: 'claude.ai', status: 'down', aiwatchScore: 60 },
    { id: 'claudecode', category: 'agent', name: 'Claude Code', status: 'degraded', aiwatchScore: 70 },
    { id: 'openai', category: 'api', name: 'OpenAI API', status: 'operational', aiwatchScore: 90 },
    { id: 'gemini', category: 'api', name: 'Gemini API', status: 'operational', aiwatchScore: 63 },
    { id: 'chatgpt', category: 'app', name: 'ChatGPT', status: 'operational', aiwatchScore: 85 },
    { id: 'codex', category: 'agent', name: 'Codex', status: 'operational', aiwatchScore: 75 },
  ]

  it('single-category incident → ONE group with the top-2 alternatives (flat parity)', () => {
    const groups = getGroupedFallbacks(['claude'], svcs)
    expect(groups).toHaveLength(1)
    expect(groups[0].fallbacks.map(f => f.name)).toEqual(['OpenAI API', 'Gemini API'])
  })

  it('multi-category incident → one group per category, ONE alternative each (dashboard parity)', () => {
    const groups = getGroupedFallbacks(['claude', 'claudeai', 'claudecode'], svcs)
    const byLabel = Object.fromEntries(groups.map(g => [g.label, g.fallbacks.map(f => f.name)]))
    expect(byLabel['LLM']).toEqual(['OpenAI API'])
    expect(byLabel['AI Apps']).toEqual(['ChatGPT'])
    expect(byLabel['Coding Agent']).toEqual(['Codex']) // #1027 — claudecode/codex share tier 11 → 'Coding Agent'
  })

  it('excludes operational / EXCLUDE_FALLBACK affected services from anchoring a group', () => {
    const groups = getGroupedFallbacks(['claude', 'openai'], svcs)
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBe('LLM')
  })

  it('buildGroupedFallbackText renders the groups (multi-category → labeled lines)', () => {
    const text = buildGroupedFallbackText(['claude', 'claudecode'], svcs)
    expect(text).toContain('👉 Suggested fallback:')
    expect(text).toContain('LLM: OpenAI API')
    expect(text).toContain('Coding Agent: Codex') // #1027 — claudecode/codex tier 11 → 'Coding Agent'
  })
})

describe('#1062 facet B — capability routing on a secondary-component outage', () => {
  // A multi-capability service whose per-component snapshot shows ONLY a secondary surface degraded.
  const openai = (comps: Array<{ name: string; status: string }> | undefined) => ({ id: 'openai', category: 'api', name: 'OpenAI API', status: 'down', aiwatchScore: 72, components: comps })
  const pool = [
    { id: 'claude', category: 'api', name: 'Claude API', status: 'operational', aiwatchScore: 95 },
    { id: 'gemini', category: 'api', name: 'Gemini API', status: 'operational', aiwatchScore: 90 },
    { id: 'stability', category: 'api', name: 'Stability AI', status: 'operational', aiwatchScore: 70 },
    { id: 'bfl', category: 'api', name: 'Black Forest Labs (FLUX)', status: 'operational', aiwatchScore: 65 },
    { id: 'runway', category: 'api', name: 'Runway', status: 'operational', aiwatchScore: 60 },
    { id: 'luma', category: 'api', name: 'Luma (Dream Machine)', status: 'operational', aiwatchScore: 55 },
    { id: 'elevenlabs', category: 'api', name: 'ElevenLabs', status: 'operational', aiwatchScore: 80 },
    { id: 'deepgram', category: 'api', name: 'Deepgram', status: 'operational', aiwatchScore: 85 },
    { id: 'assemblyai', category: 'api', name: 'AssemblyAI', status: 'operational', aiwatchScore: 90 },
  ]

  // #761 — Mistral joins this path (its Nuxt page now yields components[]). Pinned with Mistral's REAL
  // component names, so a rename upstream fails here rather than silently reverting to LLM peers.
  describe('mistral (#761) — the Nuxt-derived snapshot drives the same routing', () => {
    const mistralPool = [
      { id: 'cohere', category: 'api', name: 'Cohere API', status: 'operational', aiwatchScore: 95 },
      { id: 'cerebras', category: 'api', name: 'Cerebras Inference', status: 'operational', aiwatchScore: 95 },
      ...pool.filter((p) => ['assemblyai', 'elevenlabs', 'deepgram'].includes(p.id)),
    ]
    const mistral = (comps: Array<{ name: string; status: string }>) => ({
      id: 'mistral', category: 'api', name: 'Mistral API', status: 'degraded', aiwatchScore: 88, components: comps,
    })
    const allOperational = [
      'Chat Completions API', 'Embeddings API', 'OCR API', 'Agents API', 'Conversations API', 'Audio API',
      'Integrations API', 'Files API', 'Batch API', 'Workflows API', 'AI Registry Prompts API', 'AI Registry Skills API',
    ].map((name) => ({ name, status: 'operational' }))
    const only = (name: string) => allOperational.map((c) => (c.name === name ? { ...c, status: 'degraded' } : c))

    it('routes an Audio-API-only outage to the Voice tier (the case #1062 reported)', () => {
      const svc = mistral(only('Audio API'))
      expect(routingTier(svc)).toBe(CAPABILITY_TIER.audio)
      const groups = getGroupedFallbacks(['mistral'], [svc, ...mistralPool])
      expect(groups).toHaveLength(1)
      expect(groups[0].label).toBe('Audio / speech')
      expect(groups[0].fallbacks.map((f) => f.name)).not.toContain('Cohere API') // never an LLM peer
    })

    it('SUPPRESSES an Embeddings-API-only outage until #880 adds an embeddings tier', () => {
      // Deliberate, recorded behaviour change: previously this emitted default LLM peers. OpenAI and
      // Cohere already suppress here; #761 makes Mistral consistent rather than leaving it with a
      // wrong-capability recommendation. Flip this test when #880 lands.
      const svc = mistral(only('Embeddings API'))
      expect(routingTier(svc)).toBe(-1) // ROUTE_SUPPRESS
      expect(getFallbacks('mistral', 'api', [svc, ...mistralPool])).toEqual([])
      expect(getGroupedFallbacks(['mistral'], [svc, ...mistralPool])).toEqual([])
    })

    it('falls back to normal LLM peers when the primary surface is degraded', () => {
      const svc = mistral(only('Chat Completions API'))
      expect(routingTier(svc)).toBeNull()
      const groups = getGroupedFallbacks(['mistral'], [svc, ...mistralPool])
      expect(groups[0].label).toBe('LLM')
      expect(groups[0].fallbacks.map((f) => f.name)).toContain('Cohere API')
    })

    it('does NOT route when two distinct secondary capabilities are degraded (ambiguous)', () => {
      const svc = mistral(allOperational.map((c) =>
        c.name === 'Audio API' || c.name === 'Embeddings API' ? { ...c, status: 'degraded' } : c))
      expect(routingTier(svc)).toBeNull()
      expect(getGroupedFallbacks(['mistral'], [svc, ...mistralPool])[0].label).toBe('LLM')
    })
  })

  describe('capabilityOfComponent — component name → capability', () => {
    it('maps modality component names to their capability; anything else is the primary llm', () => {
      expect(capabilityOfComponent('Images')).toBe('image')
      expect(capabilityOfComponent('Sora')).toBe('video')
      expect(capabilityOfComponent('Audio')).toBe('audio')
      expect(capabilityOfComponent('Realtime')).toBe('realtime')
      expect(capabilityOfComponent('Embeddings')).toBe('embeddings')
      expect(capabilityOfComponent('Chat Completions')).toBe('llm')
      expect(capabilityOfComponent('Responses')).toBe('llm')
      expect(capabilityOfComponent('Login')).toBe('llm')
    })
  })

  describe('routingTier — when to route / suppress / default', () => {
    const svc = (comps: Array<{ name: string; status: string }> | undefined) => ({ id: 'openai', category: 'api', name: 'OpenAI API', status: 'down', components: comps })
    it('routes a single secondary-capability outage to that capability tier', () => {
      expect(routingTier(svc([{ name: 'Chat Completions', status: 'operational' }, { name: 'Images', status: 'down' }]))).toBe(7)
      expect(routingTier(svc([{ name: 'Chat Completions', status: 'operational' }, { name: 'Sora', status: 'down' }]))).toBe(5)
      expect(routingTier(svc([{ name: 'Chat Completions', status: 'operational' }, { name: 'Audio', status: 'degraded' }]))).toBe(4)
    })
    it('suppresses (-1) a secondary capability with no peer tier (realtime; embeddings pre-#880)', () => {
      expect(routingTier(svc([{ name: 'Chat Completions', status: 'operational' }, { name: 'Realtime', status: 'down' }]))).toBe(-1)
      expect(routingTier(svc([{ name: 'Chat Completions', status: 'operational' }, { name: 'Embeddings', status: 'down' }]))).toBe(-1)
    })
    it('defaults (null) when the primary llm surface is degraded, or ambiguous/absent signal', () => {
      // primary among the degraded → LLM peers, not a modality reroute
      expect(routingTier(svc([{ name: 'Chat Completions', status: 'down' }, { name: 'Images', status: 'down' }]))).toBeNull()
      // ≥2 distinct secondary capabilities → ambiguous, don't guess
      expect(routingTier(svc([{ name: 'Images', status: 'down' }, { name: 'Audio', status: 'down' }]))).toBeNull()
      // no per-component signal
      expect(routingTier(svc(undefined))).toBeNull()
      expect(routingTier(svc([]))).toBeNull()
      expect(routingTier(undefined)).toBeNull()
    })
  })

  it('OpenAI Images-only outage → recommends the Image tier (Stability/FLUX), NOT LLM peers', () => {
    const services = [openai([{ name: 'Chat Completions', status: 'operational' }, { name: 'Images', status: 'down' }]), ...pool]
    const result = getFallbacks('openai', 'api', services)
    expect(result).toEqual([{ name: 'Stability AI', score: 70 }, { name: 'Black Forest Labs (FLUX)', score: 65 }])
    expect(result.find(f => f.name === 'Claude API')).toBeUndefined()
  })

  it('OpenAI Sora-only outage → recommends the Video tier (Runway/Luma)', () => {
    const services = [openai([{ name: 'Chat Completions', status: 'operational' }, { name: 'Sora', status: 'down' }]), ...pool]
    expect(getFallbacks('openai', 'api', services)).toEqual([{ name: 'Runway', score: 60 }, { name: 'Luma (Dream Machine)', score: 55 }])
  })

  it('OpenAI Audio-only outage → recommends the Voice tier (top-2 by Score; NOT STT/TTS-gated)', () => {
    // Routed audio is NOT facet-A gated: openai is untagged in SERVICE_CAPABILITY, so all 3 Voice
    // services are eligible and it reduces to top-2 by Score. AssemblyAI(90) > Deepgram(85) > ElevenLabs(80).
    // Exact assertion (not `.every`, which passes vacuously on []) so an audio-route regression to empty fails.
    const services = [openai([{ name: 'Chat Completions', status: 'operational' }, { name: 'Audio', status: 'down' }]), ...pool]
    expect(getFallbacks('openai', 'api', services)).toEqual([{ name: 'AssemblyAI', score: 90 }, { name: 'Deepgram', score: 85 }])
  })

  it('OpenAI Realtime-only outage → SUPPRESSED (no peer tier), not an LLM peer', () => {
    const services = [openai([{ name: 'Chat Completions', status: 'operational' }, { name: 'Realtime', status: 'down' }]), ...pool]
    expect(getFallbacks('openai', 'api', services)).toEqual([])
  })

  it('Cohere embeddings-only outage → SUPPRESSED until Voyage un-excluded (#880)', () => {
    const cohere = { id: 'cohere', category: 'api', name: 'Cohere API', status: 'down', aiwatchScore: 76,
      components: [{ name: 'Coral', status: 'operational' }, { name: 'embeddings', status: 'down' }] }
    expect(getFallbacks('cohere', 'api', [cohere, ...pool])).toEqual([])
  })

  it('OpenAI whole-API outage (primary degraded) → falls back to LLM peers (default, unchanged)', () => {
    const services = [openai([{ name: 'Chat Completions', status: 'down' }, { name: 'Images', status: 'down' }]), ...pool]
    expect(getFallbacks('openai', 'api', services)).toEqual([{ name: 'Claude API', score: 95 }, { name: 'Gemini API', score: 90 }])
  })

  it('a service without components[] is unaffected (Mistral-style, #761) — default LLM peers', () => {
    const mistral = { id: 'mistral', category: 'api', name: 'Mistral API', status: 'down', aiwatchScore: 76 }
    const result = getFallbacks('mistral', 'api', [mistral, ...pool])
    // mistral is tier 2 → tier-1 LLM peers by distance; routing is a no-op with no components
    expect(result.map(f => f.name)).toEqual(['Claude API', 'Gemini API'])
  })

  describe('getGroupedFallbacks — routed group is LABELLED by the capability tier', () => {
    it('labels a routed OpenAI-Images outage by CAPABILITY ("Image generation"), not the LLM tier, + tags capability', () => {
      const services = [openai([{ name: 'Chat Completions', status: 'operational' }, { name: 'Images', status: 'down' }]), ...pool]
      const groups = getGroupedFallbacks(['openai'], services)
      expect(groups).toHaveLength(1)
      expect(groups[0].label).toBe('Image generation') // #1062 facet B — self-describing (not bare "Image")
      expect(groups[0].capability).toBe('image')
      expect(groups[0].fallbacks.map(f => f.name)).toEqual(['Stability AI', 'Black Forest Labs (FLUX)'])
    })
    it('effectiveTierFor returns the routed tier for a secondary outage, else the service tier', () => {
      expect(effectiveTierFor(openai([{ name: 'Chat Completions', status: 'operational' }, { name: 'Images', status: 'down' }]))).toBe(7)
      expect(effectiveTierFor(openai([{ name: 'Chat Completions', status: 'down' }]))).toBe(1) // primary → own tier
      expect(CAPABILITY_TIER).toEqual({ image: 7, video: 5, audio: 4 })
    })

    // A SUPPRESSED anchor (Realtime-only OpenAI) has effectiveTierFor = its own LLM tier, so its group
    // key is `api:LLM`. It must NOT reserve that key: a genuinely-LLM-down sibling (mistral) sharing the
    // key must still get its LLM group, regardless of order. (Pre-fix, `seen.add` before the empty check
    // dropped the sibling's group when the suppressed anchor came first.)
    const suppressedOpenai = { id: 'openai', category: 'api', name: 'OpenAI API', status: 'down', aiwatchScore: 72,
      components: [{ name: 'Chat Completions', status: 'operational' }, { name: 'Realtime', status: 'down' }] }
    const mistralDown = { id: 'mistral', category: 'api', name: 'Mistral API', status: 'down', aiwatchScore: 76 }

    it('a suppressed anchor does not steal a later LLM sibling\'s group (suppressed ordered FIRST)', () => {
      const services = [suppressedOpenai, mistralDown, ...pool]
      const groups = getGroupedFallbacks(['openai', 'mistral'], services)
      // openai realtime → suppressed (no group). mistral (LLM) → its LLM group survives.
      expect(groups).toHaveLength(1)
      expect(groups[0].label).toBe('LLM')
      expect(groups[0].fallbacks.map(f => f.name)).toContain('Claude API')
    })

    it('a suppressed anchor does not steal a later LLM sibling\'s group (suppressed ordered LAST)', () => {
      const groups = getGroupedFallbacks(['mistral', 'openai'], [mistralDown, suppressedOpenai, ...pool])
      expect(groups).toHaveLength(1)
      expect(groups[0].label).toBe('LLM')
    })

    it('a routed Image outage + an LLM outage yield TWO groups (perGroup=1 each), suppressed one not counted', () => {
      const imagesOpenai = openai([{ name: 'Chat Completions', status: 'operational' }, { name: 'Images', status: 'down' }])
      const groups = getGroupedFallbacks(['openai', 'mistral'], [imagesOpenai, mistralDown, ...pool])
      expect(groups.map(g => g.label).sort()).toEqual(['Image generation', 'LLM'])
      expect(groups.every(g => g.fallbacks.length === 1)).toBe(true) // perGroup=1 with 2 rendered groups
    })

    it('buildGroupedFallbackText (Discord render layer) emits the routed "Image generation:" label end-to-end', () => {
      // Proves the components signal is actually threaded through the render path callers use, not only
      // the pure getGroupedFallbacks — the objects passed here carry components[] like the real ScoredService.
      const imagesOpenai = openai([{ name: 'Chat Completions', status: 'operational' }, { name: 'Images', status: 'down' }])
      const text = buildGroupedFallbackText(['openai'], [imagesOpenai, ...pool])
      expect(text).toContain('Image generation: Stability AI')
      expect(text).not.toContain('LLM:')
    })
  })
})

describe('#1062 facet C — reverse: a dedicated capability service also recommends the multimodal provider', () => {
  const svc = (id: string, name: string, status = 'operational', aiwatchScore = 90) => ({ id, name, category: 'api', status, aiwatchScore })

  describe('isCapabilityProvider', () => {
    it('OpenAI provides image/video/audio (their tiers); not observability/vector/LLM tiers', () => {
      expect(isCapabilityProvider('openai', 7)).toBe(true)  // image
      expect(isCapabilityProvider('openai', 5)).toBe(true)  // video
      expect(isCapabilityProvider('openai', 4)).toBe(true)  // audio (Voice tier)
      expect(isCapabilityProvider('openai', 6)).toBe(false) // observability — no capability
      expect(isCapabilityProvider('openai', 8)).toBe(false) // vector — no capability
      expect(isCapabilityProvider('openai', 1)).toBe(false) // LLM tier itself
      expect(isCapabilityProvider('claude', 7)).toBe(false) // Claude has no image API
      expect(CAPABILITY_PROVIDERS).toEqual({ image: ['openai'], video: ['openai'], audio: ['openai'] })
    })
  })

  it('Stability (image) down → FLUX sibling FIRST, then OpenAI (DALL·E) — not Claude/other LLMs', () => {
    const services = [
      svc('stability', 'Stability AI', 'down'),
      svc('bfl', 'Black Forest Labs (FLUX)', 'operational', 84),
      svc('openai', 'OpenAI API', 'operational', 99),
      svc('claude', 'Claude API', 'operational', 95),
      svc('gemini', 'Gemini API', 'operational', 92),
    ]
    // FLUX (tier 7, dist 0) beats OpenAI (tier 1, dist 6) despite OpenAI's higher Score; Claude/Gemini excluded.
    expect(getFallbacks('stability', 'api', services)).toEqual([
      { name: 'Black Forest Labs (FLUX)', score: 84 },
      { name: 'OpenAI API', score: 99 },
    ])
  })

  it('Stability AND FLUX both down → OpenAI (the multimodal image provider) is offered', () => {
    const services = [
      svc('stability', 'Stability AI', 'down'),
      svc('bfl', 'Black Forest Labs (FLUX)', 'down'),
      svc('openai', 'OpenAI API', 'operational', 99),
      svc('claude', 'Claude API', 'operational', 95),
    ]
    expect(getFallbacks('stability', 'api', services)).toEqual([{ name: 'OpenAI API', score: 99 }])
  })

  it('Runway (video) down → Luma sibling first, then OpenAI (Sora)', () => {
    const services = [
      svc('runway', 'Runway', 'down'),
      svc('luma', 'Luma (Dream Machine)', 'operational', 80),
      svc('openai', 'OpenAI API', 'operational', 99),
    ]
    expect(getFallbacks('runway', 'api', services)).toEqual([
      { name: 'Luma (Dream Machine)', score: 80 },
      { name: 'OpenAI API', score: 99 },
    ])
  })

  it('ElevenLabs (voice) down → Deepgram sibling, then OpenAI (Audio); AssemblyAI still STT-excluded (facet A)', () => {
    const services = [
      svc('elevenlabs', 'ElevenLabs', 'down'),
      svc('deepgram', 'Deepgram', 'operational', 85),
      svc('assemblyai', 'AssemblyAI', 'operational', 90),
      svc('openai', 'OpenAI API', 'operational', 99),
    ]
    const names = getFallbacks('elevenlabs', 'api', services).map(f => f.name)
    expect(names).toContain('Deepgram')      // shares tts
    expect(names).toContain('OpenAI API')    // audio provider
    expect(names).not.toContain('AssemblyAI') // STT-only, no shared capability with TTS ElevenLabs
  })

  it('a DEGRADED OpenAI is NOT offered as an image alternative (its worst-of status already reflects a down component)', () => {
    const services = [
      svc('stability', 'Stability AI', 'down'),
      svc('bfl', 'Black Forest Labs (FLUX)', 'operational', 84),
      svc('openai', 'OpenAI API', 'degraded', 99), // e.g. its own Images is down → overall degraded → excluded
    ]
    expect(getFallbacks('stability', 'api', services)).toEqual([{ name: 'Black Forest Labs (FLUX)', score: 84 }])
  })

  it('does NOT widen non-capability specialized tiers (observability/vector) — LangSmith down offers only its siblings', () => {
    const services = [
      svc('langsmith', 'LangChain (LangSmith)', 'down'),
      svc('helicone', 'Helicone', 'operational', 80),
      svc('openai', 'OpenAI API', 'operational', 99),
    ]
    // tier 6 has no capability → OpenAI must NOT be pulled in.
    expect(getFallbacks('langsmith', 'api', services).map(f => f.name)).toEqual(['Helicone'])
  })
})
