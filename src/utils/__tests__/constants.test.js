// #403 — pin the frontend `tierFor` / `tierLabelFor` warn-once behavior.
// Mirrors worker/src/__tests__/fallback.test.ts; the parallel implementation is intentional
// because the worker can't import frontend code at runtime.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { tierFor, tierLabelFor, API_TIER, TIER_LABEL, getFallbacks, getGroupedFallbacks, getGroupedFallbacksExcludingRegionSwitchable, hasRegionSwitch, shouldShowFallback, hasActiveIncident, SERVICE_CATEGORIES, ALL_SERVICE_IDS, categoryRankOf, outboundReferralUrl, SERVICE_SITE_URL, EXCLUDE_FALLBACK, isSpecializedSubTier, CAPABILITY_TIER, COMPONENT_CAPABILITY, CAPABILITY_PROVIDERS } from '../constants'

// #646 — the Overview renders one section per SERVICE_CATEGORIES bucket (llm/agents/voice/inference/
// video/apps, #658). Its render has a defensive "other" catch-all for any service no bucket claims,
// but that path should stay empty: the six buckets must PARTITION ALL_SERVICE_IDS exactly. This pins
// the real failure mode (a new service added to ALL_SERVICE_IDS but forgotten in SERVICE_CATEGORIES →
// it falls into "other") at the source, so it surfaces in unit tests rather than as a stray "Services"
// section in the UI.
describe('outboundReferralUrl (#842 SPA wedge)', () => {
  it('appends a disclosed ref param to a curated URL', () => {
    expect(outboundReferralUrl('gemini')).toBe('https://ai.google.dev?ref=ai-watch.dev')
    expect(outboundReferralUrl('elevenlabs')).toBe('https://elevenlabs.io?ref=ai-watch.dev')
  })
  it('returns null for an uncurated / unknown id (graceful)', () => {
    expect(outboundReferralUrl('bedrock')).toBeNull() // EXCLUDE_FALLBACK, intentionally absent
    expect(outboundReferralUrl('zzz')).toBeNull()
  })
  it('every curated URL is https + no EXCLUDE_FALLBACK service has one', () => {
    for (const u of Object.values(SERVICE_SITE_URL)) expect(u.startsWith('https://')).toBe(true)
    for (const id of EXCLUDE_FALLBACK) expect(SERVICE_SITE_URL[id]).toBeUndefined()
  })
})

describe('SERVICE_CATEGORIES partitions ALL_SERVICE_IDS (#646 Overview sections)', () => {
  const SECTION_KEYS = ['llm', 'agents', 'voice', 'inference', 'observability', 'video', 'image', 'apps'] // #658/#601/#756 — + voice + observability + video + image, dev-audience order
  const sectionIds = SECTION_KEYS.flatMap((k) => SERVICE_CATEGORIES[k].ids)

  it("'all' is the meta-bucket with no id list", () => {
    expect(SERVICE_CATEGORIES.all.ids).toBeNull()
  })

  it('the section buckets are disjoint (no service in two categories)', () => {
    expect(sectionIds.length).toBe(new Set(sectionIds).size)
  })

  it('the section buckets cover every service in ALL_SERVICE_IDS (no leftover, no extra)', () => {
    expect([...sectionIds].sort()).toEqual([...ALL_SERVICE_IDS].sort())
  })
})

// #676 — the sidebar service list sorts by categoryRankOf so it mirrors the filter chips + Overview
// sections (LLM → Agents → Voice → Inference → Video → Apps; Agents before Apps, Apps last).
describe('categoryRankOf (#676 sidebar/list category order)', () => {
  const SECTION_KEYS = ['llm', 'agents', 'voice', 'inference', 'observability', 'video', 'image', 'apps']

  it('ranks each bucket by its #658/#601/#756 canonical position (llm=0 … apps=7)', () => {
    SECTION_KEYS.forEach((key, rank) => {
      for (const id of SERVICE_CATEGORIES[key].ids) {
        expect(categoryRankOf(id), `${id} (${key})`).toBe(rank)
      }
    })
  })

  it('orders Agents before Apps, and Apps last (the #676 fix)', () => {
    expect(categoryRankOf('claudecode')).toBeLessThan(categoryRankOf('claudeai')) // agent < app
    const appRank = categoryRankOf('chatgpt')
    for (const id of ALL_SERVICE_IDS) {
      if (!SERVICE_CATEGORIES.apps.ids.includes(id)) {
        expect(categoryRankOf(id), `${id} must rank before apps`).toBeLessThan(appRank)
      }
    }
  })

  it('sorting ALL_SERVICE_IDS by rank yields a stable LLM→Agents→Voice→Inference→Video→Apps grouping', () => {
    const sorted = [...ALL_SERVICE_IDS].sort((a, b) => categoryRankOf(a) - categoryRankOf(b))
    const ranks = sorted.map(categoryRankOf)
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b)) // non-decreasing → buckets contiguous + ordered
  })

  it('returns Infinity for an unknown id (sorts last, never throws)', () => {
    expect(categoryRankOf('not-a-service')).toBe(Infinity)
  })
})

describe('tierFor (#403 frontend warn-once helper)', () => {
  let warnSpy
  beforeEach(() => { warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}) })
  afterEach(() => { warnSpy.mockRestore() })

  it('returns the mapped tier for a known service id (no warning)', () => {
    expect(tierFor('claude')).toBe(API_TIER.claude)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('returns 99 and warns once for an unknown service id', () => {
    const fakeId = '__fe_test_warn_once_a__'
    expect(tierFor(fakeId)).toBe(99)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0]).toContain(fakeId)
  })

  it('repeated calls for the same unknown id do not re-warn', () => {
    const fakeId = '__fe_test_warn_once_b__'
    tierFor(fakeId)
    tierFor(fakeId)
    tierFor(fakeId)
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })
})

describe('tierLabelFor (#403)', () => {
  let warnSpy
  beforeEach(() => { warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}) })
  afterEach(() => { warnSpy.mockRestore() })

  it('returns the mapped label for known tier numbers (no warning)', () => {
    expect(tierLabelFor(1)).toBe('LLM')
    expect(tierLabelFor(11)).toBe('Coding Agent') // #1027 — single agent tier
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('returns undefined and warns once for an unknown tier', () => {
    expect(tierLabelFor(7777)).toBeUndefined()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0]).toContain('7777')
  })

  it('every API_TIER value has a TIER_LABEL entry — no silent label degradation expected at runtime', () => {
    // Mirrors the cross-mirror sync test at the unit level. If a future contributor adds a tier
    // number to API_TIER without also extending TIER_LABEL, runtime tierLabelFor warnings would
    // fire — this test catches it earlier.
    const tierValues = new Set(Object.values(API_TIER))
    for (const tier of tierValues) {
      expect(TIER_LABEL[tier], `tier ${tier} appears in API_TIER but has no TIER_LABEL entry`).toBeDefined()
    }
  })
})

describe('getGroupedFallbacks (#445 multi-category incident alternatives)', () => {
  // Real service IDs so tierFor/tierLabelFor resolve without warnings.
  const op = (id, category, provider, aiwatchScore) => ({ id, category, provider, aiwatchScore, status: 'operational' })
  // Affected: an Anthropic incident spanning LLM API + coding agent + AI app, all one provider.
  const affected = [
    { ...op('claude', 'api', 'Anthropic', 80), status: 'down' },
    { ...op('claudecode', 'agent', 'Anthropic', 80), status: 'down' },
    { ...op('claudeai', 'app', 'Anthropic', 80), status: 'down' },
  ]
  const candidates = [
    op('groq', 'api', 'Groq', 90),
    op('fireworks', 'api', 'Fireworks', 88),
    op('codex', 'agent', 'OpenAI', 86),
    op('chatgpt', 'app', 'OpenAI', 84),
  ]
  const all = [...affected, ...candidates]

  it('returns one group per affected category — not just the first service category', () => {
    const groups = getGroupedFallbacks(affected, all)
    const cats = groups.map(g => g.category).sort()
    expect(cats).toEqual(['agent', 'api', 'app'])
    // Each group recommends candidates from its own category only.
    const byCat = Object.fromEntries(groups.map(g => [g.category, g.items.map(i => i.id)]))
    expect(byCat.api).toEqual(['groq'])        // tier-2 LLM, top score in category
    expect(byCat.agent).toEqual(['codex'])
    expect(byCat.app).toEqual(['chatgpt'])
  })

  it('caps each group to 1 item when multiple categories are affected, 2 when single', () => {
    const multi = getGroupedFallbacks(affected, all)
    expect(multi.every(g => g.items.length === 1)).toBe(true)

    const single = getGroupedFallbacks([affected[0]], all)  // only Claude API affected
    expect(single).toHaveLength(1)
    expect(single[0].items.map(i => i.id)).toEqual(['groq', 'fireworks'])  // up to 2
  })

  it('#554 — KEEPS an operational same-provider candidate (parity with worker; no blanket provider exclusion)', () => {
    // OpenAI runs both an affected service (chatgpt down) and an operational candidate (codex).
    // The former dashboard-only rule dropped codex for sharing the OpenAI provider; #554 keeps it —
    // codex is itself operational + incident-free, and the worker/is-down surfaces never excluded it.
    const affectedOpenAI = [{ ...op('chatgpt', 'app', 'OpenAI', 80), status: 'down' }, affected[1]]
    const groups = getGroupedFallbacks(affectedOpenAI, all)
    const agentGroup = groups.find(g => g.category === 'agent')
    expect(agentGroup?.items.map(i => i.id) ?? []).toContain('codex')
  })

  it('#554 — ChatGPT gets claude.ai as an app fallback even when Claude Code (Anthropic) is degraded', () => {
    // The reported empty-fallback hole: claude.ai is operational (only Claude Code, a different
    // Anthropic surface, is degraded), but the old blanket provider rule dropped it because Anthropic
    // counted as "affected" → ChatGPT's app group collapsed to zero. #554 recommends it.
    const affected2 = [
      { ...op('chatgpt', 'app', 'OpenAI', 80), status: 'down' },
      { ...op('codex', 'agent', 'OpenAI', 80), status: 'down' },
      { ...op('claudecode', 'agent', 'Anthropic', 80), status: 'degraded' },
    ]
    const pool = [...affected2, op('claudeai', 'app', 'Anthropic', 84)]  // claudeai operational
    const appGroup = getGroupedFallbacks(affected2, pool).find(g => g.category === 'app')
    expect(appGroup?.items.map(i => i.id) ?? []).toContain('claudeai')
  })

  it('does not recommend a non-operational candidate', () => {
    // End-to-end contract: a down candidate (groq) must not surface. (Enforced by
    // getFallbacks' operational filter; the helper's nonOperationalIds set is a
    // redundant guard — this asserts the observable behavior either way.)
    const downGroq = all.map(s => s.id === 'groq' ? { ...s, status: 'down' } : s)
    const groups = getGroupedFallbacks(affected, downGroq)
    const apiGroup = groups.find(g => g.category === 'api')
    expect(apiGroup?.items.map(i => i.id) ?? []).toEqual(['fireworks'])  // groq dropped, next best
  })

  it('subdivides same-category affected services by tier label into separate groups', () => {
    // groq (tier-2 → 'LLM') and deepgram (tier-4 → 'Voice') are both category 'api'
    // but map to different tier labels, so they must yield TWO groups, not one —
    // exercising the `${category}:${tierLabel}` subdivision + numGroups=2 → perGroup=1.
    const affApi = [
      { ...op('groq', 'api', 'Groq', 70), status: 'down' },
      { ...op('deepgram', 'api', 'Deepgram', 70), status: 'down' },
    ]
    const pool = [...affApi, op('fireworks', 'api', 'Fireworks', 88), op('assemblyai', 'api', 'AssemblyAI', 82)]
    const groups = getGroupedFallbacks(affApi, pool)
    expect(groups.map(g => g.label).sort()).toEqual(['LLM', 'Voice'])
    expect(groups.every(g => g.items.length === 1)).toBe(true)  // perGroup=1 when numGroups>1
  })

  it('returns [] when every affected service is in EXCLUDE_FALLBACK', () => {
    const excluded = [
      { ...op('bedrock', 'api', 'AWS', 90), status: 'down' },
      { ...op('characterai', 'app', 'Character AI', 90), status: 'down' },
    ]
    expect(getGroupedFallbacks(excluded, all)).toEqual([])
  })

  it('returns [] for an empty affected list', () => {
    expect(getGroupedFallbacks([], all)).toEqual([])
  })

  it('preserves affected-service order in the returned groups', () => {
    // affected = [claude (api), claudecode (agent), claudeai (app)] — groups emit in that order.
    const groups = getGroupedFallbacks(affected, all)
    expect(groups.map(g => g.category)).toEqual(['api', 'agent', 'app'])
  })

  it('attaches a non-empty label to each group', () => {
    const groups = getGroupedFallbacks(affected, all)
    expect(groups.every(g => typeof g.label === 'string' && g.label.length > 0)).toBe(true)
  })

  it('returns [] for invalid inputs', () => {
    expect(getGroupedFallbacks(null, all)).toEqual([])
    expect(getGroupedFallbacks(affected, null)).toEqual([])
  })
})

describe('#1062 facet A — frontend getFallbacks Voice STT/TTS capability gate', () => {
  // Pins the frontend WIRING (constants.js getFallbacks calls sharesCapability), not just the pure fn /
  // data parity the api-tier-sync test covers — deleting the `&& sharesCapability(...)` filter clause
  // must fail here (feedback_mutation_test_both_directions: 순수fn 초록 ≠ 배선 초록).
  const v = (id, name, status, aiwatchScore) => ({ id, category: 'api', name, status, aiwatchScore, incidents: [] })

  it('ElevenLabs (TTS) recommends only Deepgram (STT+TTS), NOT AssemblyAI (STT)', () => {
    const services = [
      v('elevenlabs', 'ElevenLabs', 'degraded', 80),
      v('assemblyai', 'AssemblyAI', 'operational', 90), // higher Score, but STT-only → filtered
      v('deepgram', 'Deepgram', 'operational', 85),
    ]
    // Without the gate this returns [assemblyai(90), deepgram(85)] (top-2 by Score); with it, only deepgram.
    expect(getFallbacks(services[0], services).map(f => f.id)).toEqual(['deepgram'])
  })

  it('AssemblyAI (STT) recommends only Deepgram, NOT ElevenLabs (TTS)', () => {
    const services = [
      v('assemblyai', 'AssemblyAI', 'degraded', 90),
      v('elevenlabs', 'ElevenLabs', 'operational', 80),
      v('deepgram', 'Deepgram', 'operational', 85),
    ]
    expect(getFallbacks(services[0], services).map(f => f.id)).toEqual(['deepgram'])
  })

  it('suppresses (empty) when the only capability-sharing sibling is itself down', () => {
    // ElevenLabs (TTS) down + Deepgram (the only TTS sibling) down → AssemblyAI (STT) must NOT be offered.
    // Without the gate this would surface AssemblyAI — the exact wrong-capability recommendation #1062 kills.
    const services = [
      v('elevenlabs', 'ElevenLabs', 'down', 80),
      v('deepgram', 'Deepgram', 'down', 85),
      v('assemblyai', 'AssemblyAI', 'operational', 90),
    ]
    expect(getFallbacks(services[0], services)).toEqual([])
  })
})

describe('#1062 facet B — frontend capability routing on a secondary-component outage', () => {
  // Pins the frontend WIRING: getFallbacks/getGroupedFallbacks must call routingTier/effectiveTierFor.
  const op2 = (id, name, score) => ({ id, category: 'api', name, status: 'operational', aiwatchScore: score, incidents: [] })
  const openai = (comps) => ({ id: 'openai', category: 'api', name: 'OpenAI API', status: 'down', aiwatchScore: 72, incidents: [], components: comps })
  const pool = [
    op2('claude', 'Claude API', 95), op2('gemini', 'Gemini API', 90),
    op2('stability', 'Stability AI', 70), op2('bfl', 'Black Forest Labs (FLUX)', 65),
    op2('runway', 'Runway', 60), op2('luma', 'Luma (Dream Machine)', 55),
  ]

  it('OpenAI Images-only outage → Image tier (Stability/FLUX), NOT LLM peers', () => {
    const src = openai([{ name: 'Chat Completions', status: 'operational' }, { name: 'Images', status: 'down' }])
    const ids = getFallbacks(src, [src, ...pool]).map(f => f.id)
    expect(ids).toEqual(['stability', 'bfl'])
    expect(ids).not.toContain('claude')
  })

  it('OpenAI Realtime-only outage → suppressed (empty), not an LLM peer', () => {
    const src = openai([{ name: 'Chat Completions', status: 'operational' }, { name: 'Realtime', status: 'down' }])
    expect(getFallbacks(src, [src, ...pool])).toEqual([])
  })

  it('OpenAI whole-API outage (primary degraded) → LLM peers (default, unchanged)', () => {
    const src = openai([{ name: 'Chat Completions', status: 'down' }, { name: 'Images', status: 'down' }])
    expect(getFallbacks(src, [src, ...pool]).map(f => f.id)).toEqual(['claude', 'gemini'])
  })

  it('≥2 distinct secondary caps degraded → default LLM peers (ambiguous, no reroute)', () => {
    const src = openai([{ name: 'Images', status: 'down' }, { name: 'Audio', status: 'down' }])
    expect(getFallbacks(src, [src, ...pool]).map(f => f.id)).toEqual(['claude', 'gemini'])
  })

  it('no components[] → default LLM peers (Mistral-style, unaffected)', () => {
    const src = { id: 'openai', category: 'api', name: 'OpenAI API', status: 'down', aiwatchScore: 72, incidents: [] }
    expect(getFallbacks(src, [src, ...pool]).map(f => f.id)).toEqual(['claude', 'gemini'])
  })

  it('getGroupedFallbacks labels a routed OpenAI-Images outage by CAPABILITY ("Image generation") + tags capability', () => {
    const src = openai([{ name: 'Chat Completions', status: 'operational' }, { name: 'Images', status: 'down' }])
    const groups = getGroupedFallbacks([src], [src, ...pool])
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBe('Image generation') // #1062 facet B — self-describing, not bare "Image"
    expect(groups[0].capability).toBe('image')
    expect(groups[0].items.map(i => i.id)).toEqual(['stability', 'bfl'])
  })

  it('a suppressed anchor does not steal a later LLM sibling\'s group (both orderings)', () => {
    // openai Realtime-only → suppressed; effectiveTierFor falls back to its LLM tier (key api:LLM). It
    // must NOT reserve that key — mistral (LLM, down) must still get its group either way.
    const suppressed = openai([{ name: 'Chat Completions', status: 'operational' }, { name: 'Realtime', status: 'down' }])
    const mistral = { id: 'mistral', category: 'api', name: 'Mistral API', status: 'down', aiwatchScore: 76, incidents: [] }
    for (const order of [[suppressed, mistral], [mistral, suppressed]]) {
      const groups = getGroupedFallbacks(order, [...order, ...pool])
      expect(groups).toHaveLength(1)
      expect(groups[0].label).toBe('LLM')
      expect(groups[0].items.map(i => i.id)).toContain('claude')
    }
  })

  it('routed Image outage + LLM outage → two groups (perGroup=1)', () => {
    const images = openai([{ name: 'Chat Completions', status: 'operational' }, { name: 'Images', status: 'down' }])
    const mistral = { id: 'mistral', category: 'api', name: 'Mistral API', status: 'down', aiwatchScore: 76, incidents: [] }
    const groups = getGroupedFallbacks([images, mistral], [images, mistral, ...pool])
    expect(groups.map(g => g.label).sort()).toEqual(['Image generation', 'LLM'])
    expect(groups.every(g => g.items.length === 1)).toBe(true)
  })
})

describe('#1062 facet C — frontend: a dedicated capability service also recommends the multimodal provider', () => {
  const v = (id, name, status, score) => ({ id, category: 'api', name, status, aiwatchScore: score, incidents: [] })

  it('Stability (image) down → FLUX sibling first, then OpenAI (DALL·E); not Claude', () => {
    const services = [
      v('stability', 'Stability AI', 'down', 88),
      v('bfl', 'Black Forest Labs (FLUX)', 'operational', 84),
      v('openai', 'OpenAI API', 'operational', 99),
      v('claude', 'Claude API', 'operational', 95),
    ]
    expect(getFallbacks(services[0], services).map(f => f.id)).toEqual(['bfl', 'openai'])
  })

  it('Stability AND FLUX both down → OpenAI is offered (mutation: dropping the facet-C clause would return [])', () => {
    const services = [
      v('stability', 'Stability AI', 'down', 88),
      v('bfl', 'Black Forest Labs (FLUX)', 'down', 84),
      v('openai', 'OpenAI API', 'operational', 99),
    ]
    expect(getFallbacks(services[0], services).map(f => f.id)).toEqual(['openai'])
  })

  it('a degraded OpenAI is NOT offered (overall status reflects its down component)', () => {
    const services = [
      v('stability', 'Stability AI', 'down', 88),
      v('bfl', 'Black Forest Labs (FLUX)', 'operational', 84),
      v('openai', 'OpenAI API', 'degraded', 99),
    ]
    expect(getFallbacks(services[0], services).map(f => f.id)).toEqual(['bfl'])
  })
})

describe('hasActiveIncident / getFallbacks active-incident exclusion (#550)', () => {
  const op = (id, category, aiwatchScore, extra = {}) => ({ id, category, aiwatchScore, status: 'operational', incidents: [], ...extra })
  const inc = (status) => ({ id: `${status}-inc`, status })

  it('hasActiveIncident is true for any unresolved incident, false otherwise', () => {
    expect(hasActiveIncident({ incidents: [inc('investigating')] })).toBe(true)
    expect(hasActiveIncident({ incidents: [inc('identified')] })).toBe(true)
    expect(hasActiveIncident({ incidents: [inc('monitoring')] })).toBe(true)
    expect(hasActiveIncident({ incidents: [inc('resolved')] })).toBe(false)
    expect(hasActiveIncident({ incidents: [] })).toBe(false)
    expect(hasActiveIncident({})).toBe(false)
  })

  it('excludes an operational candidate that has an unresolved incident', () => {
    // The screenshot case: Claude Code degraded; Codex is operational but "investigating" an incident.
    const source = { id: 'claudecode', category: 'agent', status: 'degraded', incidents: [inc('investigating')] }
    const codexInvestigating = op('codex', 'agent', 89, { incidents: [inc('investigating')] })
    const windsurf = op('windsurf', 'agent', 92)
    const ids = getFallbacks(source, [source, codexInvestigating, windsurf]).map(f => f.id)
    expect(ids).not.toContain('codex')   // active incident → not a healthy fallback
    expect(ids).toContain('windsurf')
  })

  it('#811 — a non-reliability advisory (Claude model-access suspension) does NOT exclude an operational candidate', () => {
    // The live 2026-06-27 case: Claude Code carries the Anthropic "suspended access to Mythos 5/Fable 5"
    // advisory (operational badge). When another agent (Cursor) is down, Claude Code must stay recommendable.
    const source = { id: 'cursor', category: 'agent', status: 'degraded', incidents: [inc('investigating')] }
    const ADVISORY = "We've suspended access to Claude Mythos 5 and Claude Fable 5"
    const claudecode = op('claudecode', 'agent', 95, { incidents: [{ id: 'adv', status: 'monitoring', title: ADVISORY }] })
    expect(getFallbacks(source, [source, claudecode]).map(f => f.id)).toContain('claudecode') // advisory ignored
    // An OUTAGE-signal title still disqualifies (#550 preserved).
    const claudecodeOutage = op('claudecode', 'agent', 95, { incidents: [{ id: 'o', status: 'monitoring', title: 'Elevated error rates on Claude Code' }] })
    expect(getFallbacks(source, [source, claudecodeOutage]).map(f => f.id)).not.toContain('claudecode')
  })

  it('still recommends a candidate whose only incident is resolved', () => {
    const source = { id: 'claudecode', category: 'agent', status: 'degraded', incidents: [inc('investigating')] }
    const codexResolved = op('codex', 'agent', 89, { incidents: [inc('resolved')] })
    const ids = getFallbacks(source, [source, codexResolved]).map(f => f.id)
    expect(ids).toContain('codex')
  })

  it('#616 — excludes a stale-source candidate (incidentSourceStale, #591) even when operational with a high Score', () => {
    // deepseek is excluded from Score ranking because its incident feed is stale (#591). Operational
    // with an inflated Score and not in EXCLUDE_FALLBACK, so without the guard it would win the slot.
    const source = { id: 'mistral', category: 'api', status: 'degraded', incidents: [] }
    const deepseekStale = op('deepseek', 'api', 95, { incidentSourceStale: true })
    const together = op('together', 'api', 89)
    const ids = getFallbacks(source, [source, deepseekStale, together]).map(f => f.id)
    expect(ids).not.toContain('deepseek') // stale source → not a trusted fallback
    expect(ids).toContain('together')
  })

  it('getGroupedFallbacks drops an operational-but-active-incident candidate', () => {
    const affected = [{ id: 'claudecode', category: 'agent', provider: 'Anthropic', status: 'degraded', incidents: [inc('investigating')] }]
    const pool = [
      ...affected,
      op('codex', 'agent', 89, { provider: 'OpenAI', incidents: [inc('investigating')] }),
      op('windsurf', 'agent', 92, { provider: 'Windsurf' }),
    ]
    const groups = getGroupedFallbacks(affected, pool)
    const agentItems = (groups.find(g => g.category === 'agent')?.items ?? []).map(i => i.id)
    expect(agentItems).not.toContain('codex')
    expect(agentItems).toContain('windsurf')
  })
})

describe('shouldShowFallback (#454 status-based modal gate)', () => {
  it('shows for a degraded service (the needsFallback:false bug case)', () => {
    // Overview shows fallbacks for degraded; the modal must too, regardless of
    // how the AI classified needsFallback.
    expect(shouldShowFallback([{ id: 'cursor', status: 'degraded' }], false)).toBe(true)
  })

  it('shows for a down service', () => {
    expect(shouldShowFallback([{ id: 'chatgpt', status: 'down' }], false)).toBe(true)
  })

  it('shows when at least one service in the group is non-operational', () => {
    expect(shouldShowFallback([
      { id: 'claudeai', status: 'operational' },
      { id: 'chatgpt', status: 'degraded' },
    ], false)).toBe(true)
  })

  it('hides when every service is operational (isolated model issue)', () => {
    expect(shouldShowFallback([{ id: 'elevenlabs', status: 'operational' }], false)).toBe(false)
  })

  it('hides when all analyses are recovered', () => {
    expect(shouldShowFallback([{ id: 'chatgpt', status: 'down' }], true)).toBe(false)
  })

  it('hides when every affected service is excluded from fallback', () => {
    // characterai is in EXCLUDE_FALLBACK — no meaningful alternative to recommend.
    expect(shouldShowFallback([{ id: 'characterai', status: 'down' }], false)).toBe(false)
  })

  it('shows when a non-excluded service is affected alongside an excluded one', () => {
    expect(shouldShowFallback([
      { id: 'characterai', status: 'down' },
      { id: 'chatgpt', status: 'down' },
    ], false)).toBe(true)
  })

  it('returns false for empty or invalid input', () => {
    expect(shouldShowFallback([], false)).toBe(false)
    expect(shouldShowFallback(null, false)).toBe(false)
  })
})

describe('region-switch fallback suppression (#641)', () => {
  // #973 — these cases used openai as the "region-switchable" vehicle, which was the bug: openai
  // is region-AWARE (we can see which region broke) but not region-SWITCHABLE (the caller cannot
  // pick a region). Pinecone is genuinely switchable, so it now carries the positive cases, and
  // openai carries the new negative one.
  const regionInc = { id: 'pc-r', title: 'errors', status: 'investigating', componentNames: ['AWS us-east-1'] }

  describe('hasRegionSwitch', () => {
    it('is true for a region-specific outage on a region-switchable service', () => {
      expect(hasRegionSwitch({ id: 'pinecone', incidents: [regionInc] })).toBe(true)
    })
    it('is false for a non-region-aware service (no SERVICE_REGIONS entry)', () => {
      expect(hasRegionSwitch({ id: 'mistral', incidents: [{ id: 'm', title: 'errors', status: 'investigating' }] })).toBe(false)
    })
    it('is false for a region-AWARE but non-switchable service (#973)', () => {
      // openai has a SERVICE_REGIONS map but is absent from REGION_SWITCHABLE → recommendedRegion
      // is null → no region link, and the cross-service fallback is NOT suppressed.
      const oaiInc = { id: 'oai-r', title: 'errors', status: 'investigating', componentNames: ['us-east-1'] }
      expect(hasRegionSwitch({ id: 'openai', incidents: [oaiInc] })).toBe(false)
    })
    it('is false when there is no ongoing incident (pinecone is not always-show)', () => {
      expect(hasRegionSwitch({ id: 'pinecone', incidents: [] })).toBe(false)
    })
    it('stays true when a global incident coexists (web predicate intentionally omits hasGlobalIncident)', () => {
      // Documents the intentional asymmetry vs the Worker's buildRegionHint (which additionally
      // guards hasGlobalIncident). The web surfaces render the region link + suppress the fallback
      // here; the Worker keeps the fallback. Pinning so the decision doesn't silently drift.
      const globalInc = { id: 'pc-g', title: 'Major outage', status: 'investigating' }
      expect(hasRegionSwitch({ id: 'pinecone', incidents: [regionInc, globalInc] })).toBe(true)
    })
  })

  describe('getGroupedFallbacksExcludingRegionSwitchable', () => {
    const op = (id, category, provider, aiwatchScore) => ({ id, category, provider, aiwatchScore, status: 'operational', incidents: [] })

    it('excludes a region-switchable service but KEEPS a non-region service\'s fallback (per-service)', () => {
      const pinecone = { id: 'pinecone', category: 'api', provider: 'Pinecone', status: 'degraded', incidents: [regionInc] }
      const cursor = { id: 'cursor', category: 'agent', provider: 'Cursor', status: 'degraded', incidents: [] }
      // turbopuffer is pinecone's Tier-8 sibling (#857) — without it pinecone has no api fallback
      // at all, and the contrast assertion below could not tell suppression from absence.
      const services = [pinecone, cursor, op('turbopuffer', 'api', 'turbopuffer', 92), op('claude', 'api', 'Anthropic', 95), op('codex', 'agent', 'OpenAI', 88), op('windsurf', 'agent', 'Windsurf', 85)]

      const cats = getGroupedFallbacksExcludingRegionSwitchable([pinecone, cursor], services).map(g => g.category)
      expect(cats).toContain('agent')     // cursor (no region map) keeps its fallback
      expect(cats).not.toContain('api')   // pinecone (region-switchable) excluded → no api group
      // Contrast: without the exclusion the api group WOULD appear (proves it's the suppression, not absence)
      expect(getGroupedFallbacks([pinecone, cursor], services).map(g => g.category)).toContain('api')
    })

    it('KEEPS the fallback for a region-aware but non-switchable service (#973)', () => {
      // The regression this issue fixed: openai's unusable region link suppressed the one action
      // the reader could actually take. With no region switch, the api fallback group must appear.
      const oaiInc = { id: 'oai-r', title: 'errors', status: 'investigating', componentNames: ['us-east-1'] }
      const openai = { id: 'openai', category: 'api', provider: 'OpenAI', status: 'degraded', incidents: [oaiInc] }
      const services = [openai, op('claude', 'api', 'Anthropic', 95), op('gemini', 'api', 'Google', 90)]

      const cats = getGroupedFallbacksExcludingRegionSwitchable([openai], services).map(g => g.category)
      expect(cats).toContain('api')
    })

    it('returns [] for a non-array input', () => {
      expect(getGroupedFallbacksExcludingRegionSwitchable(null, [])).toEqual([])
    })
  })
})

describe('#859 specialized sub-tier same-tier cap (SPA mirror of worker isSpecializedSubTier)', () => {
  const svc = (id, name, status = 'operational', aiwatchScore = 90) =>
    ({ id, name, category: 'api', status, aiwatchScore })

  it('isSpecializedSubTier: 1-3 false, 4-8 true, agents/apps false', () => {
    expect([1, 2, 3].some(isSpecializedSubTier)).toBe(false)
    expect([4, 5, 6, 7, 8].every(isSpecializedSubTier)).toBe(true)
    expect(isSpecializedSubTier(11)).toBe(false)
    expect(isSpecializedSubTier(21)).toBe(false)
  })

  it('image (Stability) down → only its image sibling, not an observability service', () => {
    const services = [
      svc('stability', 'Stability AI', 'down'),
      svc('bfl', 'Black Forest Labs (FLUX)', 'operational', 84),
      svc('langfuse', 'Langfuse', 'operational', 99),
    ]
    const result = getFallbacks(services[0], services)
    expect(result.map(r => r.name)).toEqual(['Black Forest Labs (FLUX)'])
  })

  it('LLM (T2) still gets cross-tier fill (unchanged)', () => {
    const services = [
      svc('together', 'Together AI', 'down'),
      svc('claude', 'Claude API', 'operational', 95),
      svc('openrouter', 'OpenRouter', 'operational', 80),
    ]
    const result = getFallbacks(services[0], services)
    expect(result.map(r => r.name)).toEqual(['Claude API', 'OpenRouter'])
  })
})


describe('#1119 — frontend mirror: a ROUTED outage crosses the category boundary, a non-routed one never does', () => {
  // Dashboard parity for the worker rule (worker/src/__tests__/fallback.test.ts). The live case:
  // ChatGPT (app) degraded ONLY on "Image Generation" → the image tier lives in `api`, so the
  // unconditional category filter emptied the pool and the Analyze modal / ActionBanner showed nothing.
  const op = (id, category, name, score) => ({ id, category, name, status: 'operational', aiwatchScore: score, incidents: [] })
  const pool = [
    op('claudeai', 'app', 'claude.ai', 69),
    op('stability', 'api', 'Stability AI', 70),
    op('bfl', 'api', 'Black Forest Labs (FLUX)', 65),
    op('claude', 'api', 'Claude API', 95),
    op('gemini', 'api', 'Gemini API', 90),
    op('cursor', 'agent', 'Cursor', 88),
  ]
  // ChatGPT's component names as its status page published them on 2026-07-22 (8 of the 12 ids
  // services.ts configures were present in the live payload).
  const CHATGPT_COMPONENTS = ['Conversations', 'Connectors/Apps', 'Search', 'GPTs', 'Image Generation', 'Login', 'Agent', 'Codex in ChatGPT Desktop']
  const chatgpt = (degradedNames) => ({
    id: 'chatgpt', category: 'app', name: 'ChatGPT', status: 'degraded', aiwatchScore: 57, incidents: [],
    components: CHATGPT_COMPONENTS.map(name => ({ name, status: degradedNames.includes(name) ? 'degraded' : 'operational' })),
  })

  it('Image-Generation-only outage reaches the api Image tier, and only that tier', () => {
    const src = chatgpt(['Image Generation'])
    const ids = getFallbacks(src, [src, ...pool]).map(f => f.id)
    expect(ids).toEqual(['stability', 'bfl'])
    expect(ids).not.toContain('claude')   // higher Score, wrong capability
    expect(ids).not.toContain('cursor')
    expect(ids).not.toContain('claudeai')
  })

  it('the routed pool does NOT admit the capability PROVIDER (no "ChatGPT image is down → try OpenAI API")', () => {
    const src = chatgpt(['Image Generation'])
    const withOpenai = [src, ...pool.filter(s => s.id !== 'bfl'), op('openai', 'api', 'OpenAI API', 99)]
    expect(getFallbacks(src, withOpenai).map(f => f.id)).toEqual(['stability'])
  })

  it('facet C still widens for a DEDICATED image source (Stability down → FLUX, then OpenAI)', () => {
    const src = { id: 'stability', category: 'api', name: 'Stability AI', status: 'down', aiwatchScore: 70, incidents: [] }
    const services = [src, op('bfl', 'api', 'Black Forest Labs (FLUX)', 65), op('openai', 'api', 'OpenAI API', 99)]
    expect(getFallbacks(src, services).map(f => f.id)).toEqual(['bfl', 'openai'])
  })

  it('the routed group is labelled by capability (modal + ActionBanner render this)', () => {
    const src = chatgpt(['Image Generation'])
    const groups = getGroupedFallbacks([src], [src, ...pool])
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBe('Image generation')
    expect(groups[0].capability).toBe('image')
    expect(groups[0].items.map(i => i.id)).toEqual(['stability', 'bfl'])
    // The group still carries the SOURCE's category — it is only a React key component, never displayed.
    expect(groups[0].category).toBe('app')
  })

  it('two sources in DIFFERENT categories routing to the same capability yield ONE group, not two', () => {
    // openai (api) and chatgpt (app) share a status page and route together on one image incident.
    // Keying by `category:tierLabel` produced two groups of identical content — rendered twice in the
    // banner and the modal, and perGroup collapsed 2→1 so FLUX silently disappeared.
    const cg = chatgpt(['Image Generation'])
    const oa = {
      id: 'openai', category: 'api', name: 'OpenAI API', status: 'degraded', aiwatchScore: 99, incidents: [],
      components: [{ name: 'Chat Completions', status: 'operational' }, { name: 'Images', status: 'degraded' }],
    }
    const groups = getGroupedFallbacks([oa, cg], [cg, oa, ...pool])
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBe('Image generation')
    expect(groups[0].items.map(i => i.id)).toEqual(['stability', 'bfl'])
  })

  it('a routed anchor and a PLAIN outage of the same tier stay SEPARATE — their pools differ', () => {
    // This surface is the one that reaches the shape: Overview passes the WHOLE affected board. Merging
    // them by capability or by specialized tier looks tidier and saves a perGroup slot, but the pools
    // are not the same — facet C admits `openai` for a plain Stability outage while the routed branch
    // excludes it — so a merged group would answer the routed anchor with OpenAI, decided by array
    // order. Both orders asserted so a future "let's merge these" edit fails loudly.
    const cg = chatgpt(['Image Generation'])
    const stabilityDown = { id: 'stability', category: 'api', name: 'Stability AI', status: 'down', aiwatchScore: 70, incidents: [] }
    const services = [cg, stabilityDown, op('bfl', 'api', 'Black Forest Labs (FLUX)', 65), op('openai', 'api', 'OpenAI API', 99), ...pool.filter(s => s.id !== 'stability' && s.id !== 'bfl')]
    for (const order of [[cg, stabilityDown], [stabilityDown, cg]]) {
      const groups = getGroupedFallbacks(order, services)
      expect(groups).toHaveLength(2)
      expect(groups.find(g => g.capability === 'image').items.map(i => i.id)).toEqual(['bfl'])
      expect(groups.find(g => g.capability === undefined).items.map(i => i.id)).toEqual(['bfl'])
    }
    expect(getFallbacks(stabilityDown, services).map(f => f.id)).toContain('openai')
    expect(getFallbacks(cg, services).map(f => f.id)).not.toContain('openai')
  })

  it('an AGENT-category source routes too — documented as intended, not an oversight', () => {
    // Mirror of the worker test: unreachable today (no agent publishes a non-llm component name), but
    // the rule permits it and the code comment says so — pin the stated intent.
    const cursor = {
      id: 'cursor', category: 'agent', name: 'Cursor', status: 'degraded', aiwatchScore: 88, incidents: [],
      components: [{ name: 'Cursor IDE', status: 'operational' }, { name: 'Audio', status: 'degraded' }],
    }
    const voice = [op('elevenlabs', 'api', 'ElevenLabs', 80), op('deepgram', 'api', 'Deepgram', 75)]
    expect(getFallbacks(cursor, [cursor, ...voice, ...pool]).map(f => f.id)).toEqual(['elevenlabs', 'deepgram'])
  })

  it('an EXCLUDE_FALLBACK service is never a candidate, and a routed pool does not fire tierFor\'s warn for one', () => {
    // Two things in one shape, both tied to the guard ORDERING: the id-only guards must run before any
    // tier lookup. Six EXCLUDE_FALLBACK members are deliberately absent from API_TIER, so a tier lookup
    // that sees them turns `tierFor`'s warn-once — the #402/#403 "someone forgot a tier entry"
    // breadcrumb — into standing false alarms. The membership half is behavioural; the warn half is
    // log-only, so only a spy can pin it.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const src = chatgpt(['Image Generation'])
      const untiered = ['replicate', 'huggingface', 'fal', 'voyageai', 'modal', 'twelvelabs']
        .map((id, i) => op(id, 'api', `Untiered ${id}`, 90 + i))
      const ids = getFallbacks(src, [src, ...untiered, ...pool]).map(f => f.id)
      for (const id of untiered) expect(ids).not.toContain(id)
      expect(warn.mock.calls.filter(c => String(c[0]).includes('no API_TIER'))).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })

  it('a PRIMARY-surface outage stays in-category (claude.ai), no api leakage', () => {
    const src = chatgpt(['Conversations'])
    expect(getFallbacks(src, [src, ...pool]).map(f => f.id)).toEqual(['claudeai'])
  })

  it('a non-routed LLM source keeps CROSS-TIER fill (separates "relax when routed" from "relax always")', () => {
    // API_TIER maps category↔tier ~1:1 today, so a non-routed APP source can't tell the tier pin apart
    // from the category filter. This case can: mistral is tier 2, its peers are tier 1.
    const src = { id: 'mistral', category: 'api', name: 'Mistral API', status: 'degraded', aiwatchScore: 76, incidents: [] }
    expect(getFallbacks(src, [src, ...pool]).map(f => f.id)).toEqual(['claude', 'gemini'])
  })

  it('a SUPPRESSED route emits nothing', () => {
    // NB unlike the worker mirror, this file cannot pin WHICH mechanism suppresses: the SPA copy has no
    // routed-empty warn, so `routed > 0` vs `routed !== null` is behaviourally indistinguishable here.
    // That spelling is pinned worker-side (its suppress test asserts no warn fires); keep the two
    // spellings in lockstep by hand.
    const src = {
      ...chatgpt([]),
      components: [{ name: 'Conversations', status: 'operational' }, { name: 'Realtime', status: 'degraded' }],
    }
    expect(getFallbacks(src, [src, ...pool])).toEqual([])
  })

  it('DEFENSE — even with the invariant VIOLATED, the routed branch still pins candidates to one tier', () => {
    // Mirror of the worker DEFENSE test: the SPA getFallbacks is a full independent copy feeding the
    // ActionBanner and the Analyze modal, so it needs its own coverage here. This is the only test that
    // exercises the pin with a CAPABILITY_TIER value outside [4,10] — the shape where `sameTierOnly` is
    // false and the branch pin is the only thing left. Restore relies on a SYNCHRONOUS body.
    const src = {
      id: 'chatgpt', category: 'app', name: 'ChatGPT', status: 'degraded', aiwatchScore: 57, incidents: [],
      components: [{ name: 'Conversations', status: 'operational' }, { name: 'Widget', status: 'degraded' }],
    }
    const capCount = COMPONENT_CAPABILITY.length
    COMPONENT_CAPABILITY.push([/widget/i, 'widget'])
    CAPABILITY_TIER.widget = API_TIER.cursor // 11 — agent tier, outside the specialized range
    try {
      expect(getFallbacks(src, [src, ...pool]).map(f => f.id)).toEqual(['cursor'])
    } finally {
      delete CAPABILITY_TIER.widget
      COMPONENT_CAPABILITY.splice(capCount)
    }
  })

  it('INVARIANT — no app/agent service can be a routing destination, by all three legs', () => {
    for (const [cap, tier] of Object.entries(CAPABILITY_TIER)) {
      expect(isSpecializedSubTier(tier), `CAPABILITY_TIER.${cap} = ${tier} is outside the specialized sub-tier range`).toBe(true)
    }
    const routable = new Set(Object.values(CAPABILITY_TIER))
    // Leg 2 identifies app/agent services by their sidebar BUCKET, not by `tier === 11 || 21` — the
    // tier-proxy form can only fail when leg 1 already has, so it could never catch the thing it names.
    const appAgentIds = [...SERVICE_CATEGORIES.apps.ids, ...SERVICE_CATEGORIES.agents.ids]
    for (const id of appAgentIds) {
      expect(routable.has(API_TIER[id]), `${id} is an app/agent service in routable tier ${API_TIER[id]}`).toBe(false)
    }
    // Leg 3 by identity too: an id missing from API_TIER yields undefined and would slip a tier check.
    const appAgentSet = new Set(appAgentIds)
    for (const [cap, ids] of Object.entries(CAPABILITY_PROVIDERS)) {
      for (const id of ids) {
        expect(appAgentSet.has(id), `CAPABILITY_PROVIDERS.${cap} lists app/agent service "${id}"`).toBe(false)
      }
    }
  })
})
