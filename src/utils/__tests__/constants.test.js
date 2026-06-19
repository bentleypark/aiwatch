// #403 — pin the frontend `tierFor` / `tierLabelFor` warn-once behavior.
// Mirrors worker/src/__tests__/fallback.test.ts; the parallel implementation is intentional
// because the worker can't import frontend code at runtime.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { tierFor, tierLabelFor, API_TIER, TIER_LABEL, getFallbacks, getGroupedFallbacks, getGroupedFallbacksExcludingRegionSwitchable, hasRegionSwitch, shouldShowFallback, hasActiveIncident, SERVICE_CATEGORIES, ALL_SERVICE_IDS, categoryRankOf } from '../constants'

// #646 — the Overview renders one section per SERVICE_CATEGORIES bucket (llm/agents/voice/inference/
// video/apps, #658). Its render has a defensive "other" catch-all for any service no bucket claims,
// but that path should stay empty: the six buckets must PARTITION ALL_SERVICE_IDS exactly. This pins
// the real failure mode (a new service added to ALL_SERVICE_IDS but forgotten in SERVICE_CATEGORIES →
// it falls into "other") at the source, so it surfaces in unit tests rather than as a stray "Services"
// section in the UI.
describe('SERVICE_CATEGORIES partitions ALL_SERVICE_IDS (#646 Overview sections)', () => {
  const SECTION_KEYS = ['llm', 'agents', 'voice', 'inference', 'video', 'apps'] // #658 — + voice + video, dev-audience order
  const sectionIds = SECTION_KEYS.flatMap((k) => SERVICE_CATEGORIES[k].ids)

  it("'all' is the meta-bucket with no id list", () => {
    expect(SERVICE_CATEGORIES.all.ids).toBeNull()
  })

  it('the six section buckets are disjoint (no service in two categories)', () => {
    expect(sectionIds.length).toBe(new Set(sectionIds).size)
  })

  it('the six section buckets cover every service in ALL_SERVICE_IDS (no leftover, no extra)', () => {
    expect([...sectionIds].sort()).toEqual([...ALL_SERVICE_IDS].sort())
  })
})

// #676 — the sidebar service list sorts by categoryRankOf so it mirrors the filter chips + Overview
// sections (LLM → Agents → Voice → Inference → Video → Apps; Agents before Apps, Apps last).
describe('categoryRankOf (#676 sidebar/list category order)', () => {
  const SECTION_KEYS = ['llm', 'agents', 'voice', 'inference', 'video', 'apps']

  it('ranks each bucket by its #658 canonical position (llm=0 … apps=5)', () => {
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
  const regionInc = { id: 'oai-r', title: 'errors', status: 'investigating', componentNames: ['us-east-1'] }

  describe('hasRegionSwitch', () => {
    it('is true for a region-specific outage on a region-aware service', () => {
      expect(hasRegionSwitch({ id: 'openai', incidents: [regionInc] })).toBe(true)
    })
    it('is false for a non-region-aware service (no SERVICE_REGIONS entry)', () => {
      expect(hasRegionSwitch({ id: 'mistral', incidents: [{ id: 'm', title: 'errors', status: 'investigating' }] })).toBe(false)
    })
    it('is false when there is no ongoing incident (openai is not always-show)', () => {
      expect(hasRegionSwitch({ id: 'openai', incidents: [] })).toBe(false)
    })
    it('stays true when a global incident coexists (web predicate intentionally omits hasGlobalIncident)', () => {
      // Documents the intentional asymmetry vs the Worker's buildRegionHint (which additionally
      // guards hasGlobalIncident). The web surfaces render the region link + suppress the fallback
      // here; the Worker keeps the fallback. Pinning so the decision doesn't silently drift.
      const globalInc = { id: 'oai-g', title: 'Major outage', status: 'investigating' }
      expect(hasRegionSwitch({ id: 'openai', incidents: [regionInc, globalInc] })).toBe(true)
    })
  })

  describe('getGroupedFallbacksExcludingRegionSwitchable', () => {
    const op = (id, category, provider, aiwatchScore) => ({ id, category, provider, aiwatchScore, status: 'operational', incidents: [] })

    it('excludes a region-switchable service but KEEPS a non-region service\'s fallback (per-service)', () => {
      const openai = { id: 'openai', category: 'api', provider: 'OpenAI', status: 'degraded', incidents: [regionInc] }
      const cursor = { id: 'cursor', category: 'agent', provider: 'Cursor', status: 'degraded', incidents: [] }
      const services = [openai, cursor, op('claude', 'api', 'Anthropic', 95), op('codex', 'agent', 'OpenAI', 88), op('windsurf', 'agent', 'Windsurf', 85)]

      const cats = getGroupedFallbacksExcludingRegionSwitchable([openai, cursor], services).map(g => g.category)
      expect(cats).toContain('agent')     // cursor (no region map) keeps its fallback
      expect(cats).not.toContain('api')   // openai (region-switchable) excluded → no api group
      // Contrast: without the exclusion the api group WOULD appear (proves it's the suppression, not absence)
      expect(getGroupedFallbacks([openai, cursor], services).map(g => g.category)).toContain('api')
    })

    it('returns [] for a non-array input', () => {
      expect(getGroupedFallbacksExcludingRegionSwitchable(null, [])).toEqual([])
    })
  })
})
