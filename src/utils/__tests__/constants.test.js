// #403 — pin the frontend `tierFor` / `tierLabelFor` warn-once behavior.
// Mirrors worker/src/__tests__/fallback.test.ts; the parallel implementation is intentional
// because the worker can't import frontend code at runtime.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { tierFor, tierLabelFor, API_TIER, TIER_LABEL, getGroupedFallbacks, shouldShowFallback } from '../constants'

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
    expect(tierLabelFor(11)).toBe('CLI Agent')
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

  it('excludes candidates sharing a provider with any affected service', () => {
    // OpenAI runs both an affected (chatgpt as affected) and a candidate (codex) — codex must drop.
    const affectedOpenAI = [{ ...op('chatgpt', 'app', 'OpenAI', 80), status: 'down' }, affected[1]]
    const groups = getGroupedFallbacks(affectedOpenAI, all)
    const agentGroup = groups.find(g => g.category === 'agent')
    expect(agentGroup?.items.map(i => i.id) ?? []).not.toContain('codex')
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
