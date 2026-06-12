import { describe, it, expect, vi } from 'vitest'
import { normalizeStatus } from '../parsers/statuspage'
import { filterIncidents, SERVICES, worstStatus, resolveSvcStatus, resolveSvcComponents, pickBreakdownComponents } from '../services'
import type { Incident, ServiceConfig } from '../types'
import { type KVLike } from '../utils'

/**
 * Tests for the svcStatus determination logic in services.ts.
 * Extracted as pure functions to validate the status fallback behavior
 * when statusComponent/statusComponentId is missing or not found.
 */

interface StatusConfig {
  statusComponent?: string
  statusComponentId?: string
  statusComponentIds?: string[]
  displayComponentIds?: string[]
  displayAllComponents?: boolean
  componentDenylist?: string[]
  componentSurfaces?: string[]
}

interface SummaryData {
  status: { indicator: string }
  components?: Array<{ id: string; name: string; status: string }>
}

interface FilteredIncident {
  status: string
}

// Tests call the production resolver directly (no test mirror) so a future change
// to status-resolution logic cannot pass the tests by drifting from runtime.
const determineSvcStatus = (config: StatusConfig, summary: SummaryData, filtered: FilteredIncident[]): string =>
  resolveSvcStatus(config, summary, filtered)

describe('svcStatus determination', () => {
  describe('no component configured (e.g., OpenAI API after migration)', () => {
    const config: StatusConfig = {} // no statusComponent or statusComponentId

    it('BUG REPRO: old logic returned degraded for ChatGPT-only incident', () => {
      // Before fix: no component → return overall directly → degraded (cross-contamination)
      const summary: SummaryData = { status: { indicator: 'minor' } }
      const filtered: FilteredIncident[] = [] // ChatGPT incident excluded by incidentExclude

      // Old logic: `if (!config.statusComponent && !config.statusComponentId) return overall`
      // → normalizeStatus('minor') = 'degraded' ← BUG: OpenAI API incorrectly degraded
      const oldLogicResult = normalizeStatus(summary.status.indicator)
      expect(oldLogicResult).toBe('degraded') // confirms the bug existed

      // New logic: no matching incidents → operational
      expect(determineSvcStatus(config, summary, filtered)).toBe('operational') // fix works
    })

    it('returns operational when overall is minor but no matching incidents', () => {
      // ChatGPT-only incident makes overall "minor", but OpenAI API has no matching incidents after filtering
      const summary: SummaryData = { status: { indicator: 'minor' } }
      const filtered: FilteredIncident[] = [] // all incidents excluded by incidentExclude

      expect(determineSvcStatus(config, summary, filtered)).toBe('operational')
    })

    it('returns degraded when overall is minor and has matching unresolved incidents', () => {
      const summary: SummaryData = { status: { indicator: 'minor' } }
      const filtered: FilteredIncident[] = [{ status: 'investigating' }]

      expect(determineSvcStatus(config, summary, filtered)).toBe('degraded')
    })

    it('returns down when overall is major and has matching unresolved incidents', () => {
      const summary: SummaryData = { status: { indicator: 'major' } }
      const filtered: FilteredIncident[] = [{ status: 'identified' }]

      expect(determineSvcStatus(config, summary, filtered)).toBe('down')
    })

    it('returns operational when overall is operational', () => {
      const summary: SummaryData = { status: { indicator: 'none' } }
      const filtered: FilteredIncident[] = []

      expect(determineSvcStatus(config, summary, filtered)).toBe('operational')
    })

    it('returns operational when overall is major but all incidents are resolved', () => {
      // Edge case: overall still shows major (stale) but all incidents are resolved
      const summary: SummaryData = { status: { indicator: 'major' } }
      const filtered: FilteredIncident[] = [{ status: 'resolved' }]

      expect(determineSvcStatus(config, summary, filtered)).toBe('operational')
    })
  })

  describe('with statusComponentId configured', () => {
    const config: StatusConfig = { statusComponentId: 'comp-api-123' }

    it('uses component status when component exists', () => {
      const summary: SummaryData = {
        status: { indicator: 'minor' }, // overall degraded
        components: [{ id: 'comp-api-123', name: 'API', status: 'operational' }],
      }
      expect(determineSvcStatus(config, summary, [])).toBe('operational')
    })

    it('falls back to overall when component not found', () => {
      const summary: SummaryData = {
        status: { indicator: 'minor' },
        components: [{ id: 'other-comp', name: 'Other', status: 'operational' }],
      }
      // Component not found → falls back to overall (minor → degraded)
      expect(determineSvcStatus(config, summary, [])).toBe('degraded')
    })

    it('uses component degraded status even when overall is operational', () => {
      const summary: SummaryData = {
        status: { indicator: 'none' },
        components: [{ id: 'comp-api-123', name: 'API', status: 'degraded_performance' }],
      }
      expect(determineSvcStatus(config, summary, [])).toBe('degraded')
    })
  })

  describe('with statusComponent (name-based) configured', () => {
    const config: StatusConfig = { statusComponent: 'Claude API' }

    it('matches component by name prefix', () => {
      const summary: SummaryData = {
        status: { indicator: 'minor' },
        components: [{ id: 'x', name: 'Claude API (Production)', status: 'operational' }],
      }
      expect(determineSvcStatus(config, summary, [])).toBe('operational')
    })

    it('falls back to overall when no component name matches', () => {
      const summary: SummaryData = {
        status: { indicator: 'minor' },
        components: [{ id: 'x', name: 'Other Service', status: 'operational' }],
      }
      expect(determineSvcStatus(config, summary, [])).toBe('degraded')
    })
  })

  describe('with statusComponentIds (multi-component, worst-of) — #379', () => {
    // Models the cursor case: IDE primary + Cloud Agents + Automations
    const config: StatusConfig = {
      statusComponentId: 'ide',
      statusComponentIds: ['ide', 'cloud-agents', 'automations'],
    }

    it('returns operational when all tracked components are operational', () => {
      const summary: SummaryData = {
        status: { indicator: 'none' },
        components: [
          { id: 'ide', name: 'IDE', status: 'operational' },
          { id: 'cloud-agents', name: 'Cloud Agents', status: 'operational' },
          { id: 'automations', name: 'Automations', status: 'operational' },
          { id: 'marketplace', name: 'Marketplace', status: 'operational' },
        ],
      }
      expect(determineSvcStatus(config, summary, [])).toBe('operational')
    })

    it('flips to degraded when a non-primary component is partial_outage (the bug)', () => {
      // Live cursor case 2026-05-04 23:32 UTC — IDE OK but Cloud Agents/Automations down.
      // Pre-#379 single-statusComponentId logic returned operational; now must be degraded.
      const summary: SummaryData = {
        status: { indicator: 'minor' },
        components: [
          { id: 'ide', name: 'IDE', status: 'operational' },
          { id: 'cloud-agents', name: 'Cloud Agents', status: 'partial_outage' },
          { id: 'automations', name: 'Automations', status: 'partial_outage' },
        ],
      }
      expect(determineSvcStatus(config, summary, [])).toBe('degraded')
    })

    it('returns down when any tracked component is major_outage (worst wins)', () => {
      const summary: SummaryData = {
        status: { indicator: 'minor' },
        components: [
          { id: 'ide', name: 'IDE', status: 'partial_outage' },
          { id: 'cloud-agents', name: 'Cloud Agents', status: 'major_outage' },
          { id: 'automations', name: 'Automations', status: 'operational' },
        ],
      }
      expect(determineSvcStatus(config, summary, [])).toBe('down')
    })

    it('ignores untracked components (e.g. Marketplace status does not affect badge)', () => {
      const summary: SummaryData = {
        status: { indicator: 'minor' },
        components: [
          { id: 'ide', name: 'IDE', status: 'operational' },
          { id: 'cloud-agents', name: 'Cloud Agents', status: 'operational' },
          { id: 'automations', name: 'Automations', status: 'operational' },
          { id: 'marketplace', name: 'Marketplace', status: 'major_outage' }, // not tracked
        ],
      }
      expect(determineSvcStatus(config, summary, [])).toBe('operational')
    })

    it('falls back to overall indicator when none of the tracked ids resolve', () => {
      // Configured ids drifted (page restructured) — nothing matches; fall back to overall.
      // Component-miss alert path picks this up separately so operators can reconcile.
      const summary: SummaryData = {
        status: { indicator: 'minor' },
        components: [{ id: 'unknown-1', name: 'Renamed', status: 'operational' }],
      }
      expect(determineSvcStatus(config, summary, [])).toBe('degraded')
    })

    it('partial id resolution still computes worst-of across the resolved subset', () => {
      // Two of three ids found — worst-of those two is the result.
      const summary: SummaryData = {
        status: { indicator: 'minor' },
        components: [
          { id: 'ide', name: 'IDE', status: 'operational' },
          { id: 'cloud-agents', name: 'Cloud Agents', status: 'partial_outage' },
          // 'automations' missing — drifted away
        ],
      }
      expect(determineSvcStatus(config, summary, [])).toBe('degraded')
    })

    it('ignores empty statusComponentIds and falls back to single statusComponentId', () => {
      const cfg: StatusConfig = { statusComponentId: 'ide', statusComponentIds: [] }
      const summary: SummaryData = {
        status: { indicator: 'minor' },
        components: [{ id: 'ide', name: 'IDE', status: 'operational' }],
      }
      expect(determineSvcStatus(cfg, summary, [])).toBe('operational')
    })
  })
})

describe('worstStatus helper (#379)', () => {
  it('returns operational for empty input (no components matched)', () => {
    expect(worstStatus([])).toBe('operational')
  })
  it('returns operational when all are operational', () => {
    expect(worstStatus(['operational', 'operational'])).toBe('operational')
  })
  it('promotes to degraded when any is degraded', () => {
    expect(worstStatus(['operational', 'degraded', 'operational'])).toBe('degraded')
  })
  it('promotes to down when any is down (overrides degraded)', () => {
    expect(worstStatus(['operational', 'degraded', 'down'])).toBe('down')
  })
  it('handles single-element list', () => {
    expect(worstStatus(['degraded'])).toBe('degraded')
  })
})

describe('resolveSvcComponents — per-component snapshot (#604)', () => {
  const config: StatusConfig = {
    statusComponentId: 'ide',
    statusComponentIds: ['ide', 'cloud-agents', 'automations'],
  }

  it('returns the matched subset in configured order, normalized', () => {
    const summary: SummaryData = {
      status: { indicator: 'minor' },
      components: [
        { id: 'cloud-agents', name: 'Cloud Agents', status: 'partial_outage' }, // page order differs
        { id: 'ide', name: 'IDE', status: 'operational' },
        { id: 'automations', name: 'Automations', status: 'major_outage' },
        { id: 'marketplace', name: 'Marketplace', status: 'operational' }, // untracked — excluded
      ],
    }
    expect(resolveSvcComponents(config, summary)).toEqual([
      { id: 'ide', name: 'IDE', status: 'operational' },
      { id: 'cloud-agents', name: 'Cloud Agents', status: 'degraded' },
      { id: 'automations', name: 'Automations', status: 'down' },
    ])
  })

  it('omits ids that drifted out of the page but keeps the rest (still ≥2)', () => {
    const summary: SummaryData = {
      status: { indicator: 'minor' },
      components: [
        { id: 'ide', name: 'IDE', status: 'operational' },
        { id: 'cloud-agents', name: 'Cloud Agents', status: 'partial_outage' },
        // 'automations' missing
      ],
    }
    expect(resolveSvcComponents(config, summary)).toEqual([
      { id: 'ide', name: 'IDE', status: 'operational' },
      { id: 'cloud-agents', name: 'Cloud Agents', status: 'degraded' },
    ])
  })

  it('self-gates to [] when drift leaves only ONE matched id (a 1-row breakdown is redundant with the badge)', () => {
    // 3 ids configured, but only 'ide' survives on the page → the ≥2 display gate suppresses the field.
    const summary: SummaryData = {
      status: { indicator: 'minor' },
      components: [{ id: 'ide', name: 'IDE', status: 'operational' }],
    }
    expect(resolveSvcComponents(config, summary)).toEqual([])
  })

  it('returns [] for single-component services (no statusComponentIds) — redundant with the badge', () => {
    const single: StatusConfig = { statusComponentId: 'api' }
    const summary: SummaryData = {
      status: { indicator: 'none' },
      components: [{ id: 'api', name: 'API', status: 'operational' }],
    }
    expect(resolveSvcComponents(single, summary)).toEqual([])
  })

  it('returns [] when statusComponentIds is empty', () => {
    const summary: SummaryData = {
      status: { indicator: 'none' },
      components: [{ id: 'ide', name: 'IDE', status: 'operational' }],
    }
    expect(resolveSvcComponents({ statusComponentIds: [] }, summary)).toEqual([])
  })

  it('returns [] when the page exposes no components array', () => {
    expect(resolveSvcComponents(config, { status: { indicator: 'none' } })).toEqual([])
  })

  it('returns [] when none of the configured ids resolve (full drift)', () => {
    const summary: SummaryData = {
      status: { indicator: 'minor' },
      components: [{ id: 'renamed-1', name: 'Renamed', status: 'operational' }],
    }
    expect(resolveSvcComponents(config, summary)).toEqual([])
  })

  // #606 — display-only list, decoupled from the badge (no statusComponentIds)
  it('drives the breakdown from displayComponentIds when statusComponentIds is absent', () => {
    const displayOnly: StatusConfig = { displayComponentIds: ['tts', 'stt'] }
    const summary: SummaryData = {
      status: { indicator: 'none' },
      components: [
        { id: 'tts', name: 'Text to Speech', status: 'operational' },
        { id: 'stt', name: 'Speech to Text', status: 'partial_outage' },
        { id: 'ui', name: 'UI', status: 'major_outage' }, // not in the curated list — excluded
      ],
    }
    expect(resolveSvcComponents(displayOnly, summary)).toEqual([
      { id: 'tts', name: 'Text to Speech', status: 'operational' },
      { id: 'stt', name: 'Speech to Text', status: 'degraded' },
    ])
  })

  it('self-gates the displayComponentIds path to [] when only ONE resolves (≥2 gate is source-agnostic)', () => {
    const displayOnly: StatusConfig = { displayComponentIds: ['tts', 'stt'] }
    const summary: SummaryData = {
      status: { indicator: 'none' },
      components: [{ id: 'tts', name: 'Text to Speech', status: 'operational' }], // 'stt' drifted out
    }
    expect(resolveSvcComponents(displayOnly, summary)).toEqual([])
  })

  // #606 Category A — dynamic "all except denylist" mode (cohere/groq)
  it('displayAllComponents drops the denylist and tags non-surface components with group:Models', () => {
    const dyn: StatusConfig = { displayAllComponents: true, componentDenylist: ['Docs', 'Website'], componentSurfaces: ['API'] }
    const summary: SummaryData = {
      status: { indicator: 'none' },
      components: [
        { id: 'd', name: 'Docs', status: 'operational' },          // denied
        { id: 'w', name: 'website', status: 'operational' },        // denied (case-insensitive)
        { id: 'm1', name: 'llama-3.3-70b', status: 'major_outage' }, // normalizes → down
        { id: 'm2', name: 'whisper-large-v3', status: 'partial_outage' }, // → degraded
        { id: 'api', name: 'API', status: 'operational' },          // surface → ungrouped
      ],
    }
    expect(resolveSvcComponents(dyn, summary)).toEqual([
      { id: 'm1', name: 'llama-3.3-70b', status: 'down', group: 'Models' },
      { id: 'm2', name: 'whisper-large-v3', status: 'degraded', group: 'Models' },
      { id: 'api', name: 'API', status: 'operational' }, // no group — individual surface row
    ])
  })

  it('groups every surviving component when componentSurfaces is absent', () => {
    const dyn: StatusConfig = { displayAllComponents: true, componentDenylist: [] }
    const summary: SummaryData = {
      status: { indicator: 'none' },
      components: [
        { id: 'm1', name: 'model-a', status: 'operational' },
        { id: 'm2', name: 'model-b', status: 'operational' },
      ],
    }
    expect(resolveSvcComponents(dyn, summary).every((c) => c.group === 'Models')).toBe(true)
  })

  it('displayAllComponents takes precedence over displayComponentIds / statusComponentIds', () => {
    const dyn: StatusConfig = { displayAllComponents: true, componentDenylist: [], statusComponentIds: ['a'], displayComponentIds: ['b'] }
    const summary: SummaryData = {
      status: { indicator: 'none' },
      components: [
        { id: 'a', name: 'A', status: 'operational' },
        { id: 'b', name: 'B', status: 'operational' },
      ],
    }
    // Dynamic mode wins → both components returned (not just the allowlisted one).
    expect(resolveSvcComponents(dyn, summary).map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('displayAllComponents still self-gates to [] when <2 survive the denylist', () => {
    const dyn: StatusConfig = { displayAllComponents: true, componentDenylist: ['Docs', 'Website'] }
    const summary: SummaryData = {
      status: { indicator: 'none' },
      components: [
        { id: 'd', name: 'Docs', status: 'operational' },
        { id: 'api', name: 'API', status: 'operational' }, // only 1 survives → []
      ],
    }
    expect(resolveSvcComponents(dyn, summary)).toEqual([])
  })

  it('prefers displayComponentIds over statusComponentIds when both are set', () => {
    const both: StatusConfig = { statusComponentIds: ['a', 'b'], displayComponentIds: ['c', 'd'] }
    const summary: SummaryData = {
      status: { indicator: 'none' },
      components: [
        { id: 'a', name: 'A', status: 'operational' },
        { id: 'b', name: 'B', status: 'operational' },
        { id: 'c', name: 'C', status: 'operational' },
        { id: 'd', name: 'D', status: 'operational' },
      ],
    }
    expect(resolveSvcComponents(both, summary).map((c) => c.id)).toEqual(['c', 'd'])
  })
})

describe('displayComponentIds config sanity (#606)', () => {
  // Exact curated counts — guards against a careless edit truncating the list
  // (the doc comments enumerate the excluded components, so the count is intentional).
  const EXPECTED_COUNT: Record<string, number> = { elevenlabs: 6, replicate: 5 }

  it('elevenlabs + replicate carry the exact curated displayComponentIds count and NO statusComponentIds (badge unchanged)', () => {
    for (const [id, count] of Object.entries(EXPECTED_COUNT)) {
      const svc = SERVICES.find((s) => s.id === id)!
      expect(svc.displayComponentIds, id).toBeDefined()
      expect(svc.displayComponentIds!.length, id).toBe(count)
      // No duplicate ids in the curated list.
      expect(new Set(svc.displayComponentIds).size, id).toBe(count)
      // Display-only: must not feed the worst-of badge (#606 decoupling), so no statusComponentIds.
      expect(svc.statusComponentIds, id).toBeUndefined()
    }
  })

  it('cohere + groq use dynamic displayAllComponents with the Docs/Website denylist, surface lists, and NO badge ids', () => {
    const EXPECTED_SURFACES: Record<string, string[]> = {
      groq: ['API'],
      cohere: ['Coral', 'Infrastructure', 'Playground', 'embeddings'],
    }
    for (const id of ['cohere', 'groq']) {
      const svc = SERVICES.find((s) => s.id === id)!
      expect(svc.displayAllComponents, id).toBe(true)
      expect(svc.componentDenylist, id).toEqual(['Docs', 'Website'])
      expect(svc.componentSurfaces, id).toEqual(EXPECTED_SURFACES[id])
      // Dynamic mode is display-only and must not configure id-list breakdowns or feed the badge.
      expect(svc.displayComponentIds, id).toBeUndefined()
      expect(svc.statusComponentIds, id).toBeUndefined()
    }
  })

  // #606 Category B — shared status.openai.com page split across 3 services by the official groups.
  const SHARED_PAGE_COUNT: Record<string, number> = { openai: 14, chatgpt: 12, codex: 5 }

  it('openai/chatgpt/codex carry their official-group displayComponentIds count and NO statusComponentIds', () => {
    for (const [id, count] of Object.entries(SHARED_PAGE_COUNT)) {
      const svc = SERVICES.find((s) => s.id === id)!
      expect(svc.displayComponentIds, id).toBeDefined()
      expect(svc.displayComponentIds!.length, id).toBe(count)
      expect(new Set(svc.displayComponentIds).size, id).toBe(count)
      expect(svc.statusComponentIds, id).toBeUndefined()
    }
  })

  it('openai sources the breakdown from components.json (summary.json omits 6 of its 14 ids)', () => {
    // The APIs Login / Chat Completions / Embeddings / Moderations + Platform FedRAMP / Ads Manager
    // are components.json-only, so openai must set componentsUrl; chatgpt/codex are summary.json-complete.
    expect(SERVICES.find((s) => s.id === 'openai')!.componentsUrl).toBe('https://status.openai.com/api/v2/components.json')
    expect(SERVICES.find((s) => s.id === 'chatgpt')!.componentsUrl).toBeUndefined()
    expect(SERVICES.find((s) => s.id === 'codex')!.componentsUrl).toBeUndefined()
  })

  it('LEAK GUARD: the 3 shared-page services have DISJOINT component ids (no sibling-service leak)', () => {
    const lists = ['openai', 'chatgpt', 'codex'].map((id) => SERVICES.find((s) => s.id === id)!.displayComponentIds!)
    const all = lists.flat()
    // Every id assigned to exactly one service → flat length === unique count.
    expect(new Set(all).size).toBe(all.length)
    expect(all.length).toBe(14 + 12 + 5)
  })

  // #606 — single-owner statuspages: a curated displayComponentIds breakdown + the existing
  // single statusComponentId badge (so the badge is unchanged; statusComponentIds plural absent).
  const SINGLE_OWNER_COUNT: Record<string, number> = { assemblyai: 6, deepgram: 8, characterai: 5, junie: 2, voyageai: 2, pinecone: 6 }

  it('single-owner services carry the curated displayComponentIds count, keep their badge statusComponentId, and have no worst-of statusComponentIds', () => {
    for (const [id, count] of Object.entries(SINGLE_OWNER_COUNT)) {
      const svc = SERVICES.find((s) => s.id === id)!
      expect(svc.displayComponentIds, id).toBeDefined()
      expect(svc.displayComponentIds!.length, id).toBe(count)
      expect(new Set(svc.displayComponentIds).size, id).toBe(count)
      // Badge unchanged: still a single statusComponentId, never the worst-of statusComponentIds.
      expect(svc.statusComponentId, id).toBeDefined()
      expect(svc.statusComponentIds, id).toBeUndefined()
    }
  })

  it('the 5 BetterStack services exclude the Website section from their breakdown (#606 Cat C1)', () => {
    // parseBetterStackComponents reads componentDenylist; without it the marketing "Website" row leaks.
    for (const id of ['together', 'fireworks', 'huggingface', 'modal', 'luma']) {
      const svc = SERVICES.find((s) => s.id === id)!
      expect(svc.betterStackUrl, id).toBeDefined()
      expect(svc.componentDenylist, id).toEqual(['Website'])
    }
  })

  it('pins the non-obvious official-group assignments (the ones the comments justify)', () => {
    const has = (id: string, compId: string) => SERVICES.find((s) => s.id === id)!.displayComponentIds!.includes(compId)
    // Compliance API + Agent are ChatGPT (not API) per the official grouping.
    expect(has('chatgpt', '01JNKS9D9S72PMP1938PVFFQN4'), 'Compliance API → chatgpt').toBe(true)
    expect(has('chatgpt', '01JSG1XMJ9RVJJQ0E85NVSJ2AZ'), 'Agent → chatgpt').toBe(true)
    // Sora + the API Login + the Platform FedRAMP/Ads Manager are OpenAI API.
    expect(has('openai', '01K9G527YRPY1EFRMHTKB5BKT5'), 'Sora → openai').toBe(true)
    expect(has('openai', '01JSM5RTJWHRWDTS6Q604VEW3B'), 'API Login → openai').toBe(true)
    expect(has('openai', '01KKAD7C71MCCH3FTREMJH4AAS'), 'FedRAMP → openai').toBe(true)
    expect(has('openai', '01KTQBYVARFJ5KMCSECM06VKCF'), 'Ads Manager → openai').toBe(true)
    // App is Codex.
    expect(has('codex', '01KMKFAMWKQ81YWSE1Z18R6VHR'), 'App → codex').toBe(true)
    // The two Logins are distinct ids (ChatGPT login vs API login) — both present, no collision.
    expect(has('chatgpt', '01JMXBNJXG1S2D9V65P1ZZTD94'), 'ChatGPT Login → chatgpt').toBe(true)
  })
})

describe('pickBreakdownComponents (#606 Cat B)', () => {
  const summary = [{ id: 'a', name: 'A', status: 'operational' }]
  const fetched = [{ id: 'a', name: 'A', status: 'operational' }, { id: 'b', name: 'B', status: 'operational' }]

  it('uses the fetched components.json list when it is a non-empty array (superset wins)', () => {
    expect(pickBreakdownComponents(summary, fetched)).toBe(fetched)
  })

  it('falls back to summary.json components when the fetch yields no array', () => {
    expect(pickBreakdownComponents(summary, undefined)).toBe(summary)
    expect(pickBreakdownComponents(summary, null)).toBe(summary)
    expect(pickBreakdownComponents(summary, { components: 'oops' })).toBe(summary)
  })

  it('falls back to summary.json when the fetched array is empty (avoids blanking the breakdown)', () => {
    expect(pickBreakdownComponents(summary, [])).toBe(summary)
  })
})

describe('SERVICES multi-component config sanity (#379)', () => {
  it('cursor tracks IDE primary + Cloud Agents + Automations + CLI', () => {
    const cursor = SERVICES.find((s) => s.id === 'cursor')!
    expect(cursor.statusComponentId).toBe('rflc60xp5jp2') // IDE — primary for uptime parsing
    expect(cursor.statusComponentIds).toEqual([
      'rflc60xp5jp2', // IDE
      'mwv1g9sc7kdh', // Cloud Agents
      'k0trcq273dr6', // Automations
      'vsny1qv7v86c', // CLI
    ])
  })

  it('claudecode intentionally stays single-component (dependency tracking would clash with incidentKeywords filter)', () => {
    // Pre-merge review caught that adding Claude API as a second tracked component
    // would flip the badge to degraded for API-only incidents that don't match
    // claudecode's `incidentKeywords` (['claude code', 'across surfaces']) — leaving
    // a degraded card with no visible incident. Claude API outages remain visible
    // on the separate `claude` (Claude API) card. See #379 review.
    const cc = SERVICES.find((s) => s.id === 'claudecode')!
    expect(cc.statusComponentId).toBe('yyzkbfz2thpt') // Claude Code (only)
    expect(cc.statusComponentIds).toBeUndefined()
  })

  it('copilot tracks Copilot + Copilot AI Model Providers', () => {
    const cp = SERVICES.find((s) => s.id === 'copilot')!
    expect(cp.statusComponentId).toBe('pjmpxvq2cmr2')
    expect(cp.statusComponentIds).toEqual(['pjmpxvq2cmr2', 'cnnb39dkkk82'])
  })

  it('windsurf tracks Cascade + Windsurf Tab', () => {
    const ws = SERVICES.find((s) => s.id === 'windsurf')!
    expect(ws.statusComponentId).toBe('r5wf1ykd7y1m')
    expect(ws.statusComponentIds).toEqual(['r5wf1ykd7y1m', '8q19cygxvshj'])
  })

  it('cerebras tracks all 5 model/console components, Developer Console primary (#391)', () => {
    // First `category: 'api'` service to use worst-of multi-component (#379). The
    // per-model components mean a single model degrading marks Cerebras degraded —
    // "simplifying" this back to single-component would silently re-introduce the
    // model-specific-outage under-reporting the seo-content insight/FAQ promise users.
    const cb = SERVICES.find((s) => s.id === 'cerebras')!
    expect(cb.statusComponentId).toBe('83h1cchw4vs4') // Developer Console — primary for uptime parsing
    expect(cb.statusComponentIds).toEqual([
      '83h1cchw4vs4', // Developer Console
      '7xvps6c9lqwc', // Llama3.1-8B
      'bhqw2gr7r710', // Qwen-3-235B-Instruct-2507
      'hgfykfsb36gn', // GPT-OSS-120B
      '8ygyx5vydlm2', // ZAI-GLM-4.7
    ])
  })

  it('primary statusComponentId always appears as the first entry of statusComponentIds', () => {
    // Convention: primary first so a reader can scan the array and immediately see
    // which component drives uptime%/calendar/miss tracking. Derive the list from
    // SERVICES so every present and future multi-component service is covered without
    // a hand-maintained literal — accidental reordering during config edits is caught.
    const multiComponent = SERVICES.filter((s) => s.statusComponentIds && s.statusComponentId)
    expect(multiComponent.length).toBeGreaterThan(0)
    for (const svc of multiComponent) {
      expect(svc.statusComponentIds![0]).toBe(svc.statusComponentId)
    }
  })
})

/**
 * Tests for the component miss tracking logic in services.ts (#135).
 * Mirrors the tracking block at lines 236-246.
 */
function mockKV(store: Record<string, string> = {}): KVLike {
  return {
    get: vi.fn(async (key: string) => store[key] ?? null),
    put: vi.fn(async (key: string, value: string) => { store[key] = value }),
    delete: vi.fn(async (key: string) => { delete store[key] }),
  }
}

interface ComponentTrackingConfig {
  id: string
  statusComponentId?: string
}

/**
 * Mirrors the component miss tracking logic from services.ts
 */
async function trackComponentMissLogic(
  config: ComponentTrackingConfig,
  components: Array<{ id: string; name: string }> | undefined,
  kv: KVLike,
): Promise<'tracked' | 'reset' | 'skipped'> {
  if (!config.statusComponentId || !components) return 'skipped'
  const { trackComponentMiss, resetComponentMiss } = await import('../utils')
  const compFound = components.some((c) => c.id === config.statusComponentId)
  if (!compFound) {
    await trackComponentMiss(kv, config.id)
    return 'tracked'
  } else {
    await resetComponentMiss(kv, config.id)
    return 'reset'
  }
}

/**
 * Regression tests for #292: ChatGPT has no umbrella component on
 * status.openai.com, so its config omits statusComponentId / incidentIoComponentId
 * and status is resolved from the overall page indicator + incidentKeywords filter
 * alone. Covers both directions (keyword match → degraded/down, unmatched overall
 * → operational via cross-contamination guard) so a future status-page change that
 * silently breaks this path is caught.
 */
describe('ChatGPT without statusComponentId (#292)', () => {
  function mockIncident(overrides: Partial<Incident> = {}): Incident {
    return {
      id: 'inc-1',
      title: 'Test incident',
      status: 'investigating',
      impact: 'major',
      startedAt: '2026-04-20T10:00:00Z',
      resolvedAt: null,
      duration: null,
      timeline: [],
      ...overrides,
    }
  }

  const chatgptConfig = SERVICES.find((s) => s.id === 'chatgpt') as ServiceConfig

  it('config carries no statusComponentId / statusComponent / incidentExclude — cross-contamination guard depends on this (#292)', () => {
    // The "no relevant unresolved incidents → operational" guard at the !statusComponent &&
    // !statusComponentId branch in fetchService is what protects chatgpt from inheriting
    // OpenAI API page-level non-operational states. Re-adding either of those fields would
    // bypass that guard. incidentKeywords must remain the sole filter for incident
    // selection, with no overriding incidentExclude list.
    expect(chatgptConfig).toBeDefined()
    expect(chatgptConfig.statusComponentId).toBeUndefined()
    expect(chatgptConfig.statusComponent).toBeUndefined()
    expect(chatgptConfig.incidentExclude).toBeUndefined()
    expect(chatgptConfig.incidentKeywords).toContain('chatgpt')
    expect(chatgptConfig.incidentKeywords).toContain('conversation')
  })

  it('config has incidentIoComponentId + incidentIoGroupId for uptime sourcing (#367)', () => {
    // Separate code path from the cross-contamination guard above: the dashboard
    // uptime number comes from parseIncidentIoUptime, which needs an incident.io
    // group/component to read from. Without these, chatgpt.uptime30d was null.
    // The guard above checks statusComponent / statusComponentId only, so adding
    // incidentIoComponentId here does NOT defeat #292.
    expect(chatgptConfig.incidentIoComponentId).toBe('01JMXBNJXGV1T5GT2M9XA83XNG')  // Conversations
    expect(chatgptConfig.incidentIoGroupId).toBe('01K5H8S53SY1KMS4GQMNMZXTR1')      // ChatGPT group
  })

  it('keyword-matched ChatGPT incident → degraded', () => {
    const incidents = [
      mockIncident({ id: 'chat-1', title: 'Elevated conversation errors' }),
    ]
    const filtered = filterIncidents(incidents, chatgptConfig)
    expect(filtered).toHaveLength(1)

    const summary: SummaryData = { status: { indicator: 'minor' } }
    expect(determineSvcStatus({}, summary, filtered)).toBe('degraded')
  })

  it('OpenAI API-only incident with overall=minor → operational (cross-contamination guard)', () => {
    // Overall page shows "minor" because an OpenAI API incident is active, but
    // the incident title has no ChatGPT keyword → keyword filter drops it →
    // the "no component + no matching incidents → operational" guard kicks in.
    const incidents = [
      mockIncident({ id: 'api-1', title: 'Elevated latency on /v1/responses' }),
    ]
    const filtered = filterIncidents(incidents, chatgptConfig)
    expect(filtered).toHaveLength(0) // keyword filter drops non-ChatGPT incident

    const summary: SummaryData = { status: { indicator: 'minor' } }
    expect(determineSvcStatus({}, summary, filtered)).toBe('operational')
  })

  it('major overall + ChatGPT-matched unresolved incident → down', () => {
    const incidents = [
      mockIncident({ id: 'chat-2', title: 'ChatGPT login failures', status: 'identified' }),
    ]
    const filtered = filterIncidents(incidents, chatgptConfig)
    expect(filtered).toHaveLength(1)

    const summary: SummaryData = { status: { indicator: 'major' } }
    expect(determineSvcStatus({}, summary, filtered)).toBe('down')
  })

  it('stale "minor" overall + all ChatGPT incidents resolved → operational', () => {
    const incidents = [
      mockIncident({ id: 'chat-old', title: 'ChatGPT conversation errors', status: 'resolved' }),
    ]
    const filtered = filterIncidents(incidents, chatgptConfig)
    expect(filtered).toHaveLength(1)

    const summary: SummaryData = { status: { indicator: 'minor' } }
    // Overall stale but no unresolved keyword-matched incident → operational
    expect(determineSvcStatus({}, summary, filtered)).toBe('operational')
  })

  it('overall operational → operational regardless of filter output', () => {
    const summary: SummaryData = { status: { indicator: 'none' } }
    expect(determineSvcStatus({}, summary, [])).toBe('operational')
  })
})

/**
 * Regression tests for #294: OpenAI Codex is a coding agent monitored via
 * status.openai.com with the same no-umbrella-component structure as ChatGPT.
 * Keywords cover all 4 surface components (Codex Web/API, CLI, VS Code ext)
 * via title OR componentNames match. Cross-contamination from OpenAI API /
 * ChatGPT incidents is blocked by the guard in fetchService.
 */
describe('OpenAI Codex without statusComponentId (#294)', () => {
  function mockIncident(overrides: Partial<Incident> = {}): Incident {
    return {
      id: 'cdx-1',
      title: 'Test incident',
      status: 'investigating',
      impact: 'major',
      startedAt: '2026-04-20T10:00:00Z',
      resolvedAt: null,
      duration: null,
      timeline: [],
      ...overrides,
    }
  }

  const codexConfig = SERVICES.find((s) => s.id === 'codex') as ServiceConfig

  it('config: agent category, Codex API component ID for uptime, keyword coverage for all 4 surfaces', () => {
    expect(codexConfig).toBeDefined()
    expect(codexConfig.category).toBe('agent')
    expect(codexConfig.provider).toBe('OpenAI')
    // statusComponentId stays absent — status determination still uses the
    // overall indicator + cross-contamination guard (#294).
    expect(codexConfig.statusComponentId).toBeUndefined()
    expect(codexConfig.statusComponent).toBeUndefined()
    expect(codexConfig.incidentExclude).toBeUndefined()
    // incidentIoComponentId = Codex API (#301) — kept as fallback if the group
    // lookup ever fails. incidentIoGroupId = Codex group (#367) — primary uptime
    // source, matching what OpenAI publishes on status.openai.com (Codex
    // group aggregate ≈ 99.98%, vs the single Codex API component which read
    // 100% and disagreed with the published number).
    expect(codexConfig.incidentIoComponentId).toBe('01KMP3KP5MGE23B80K1EK4S8PV')
    expect(codexConfig.incidentIoGroupId).toBe('01KMKF9EBTCD8BN9PG8DJZXRSQ')
    expect(codexConfig.incidentKeywords).toContain('codex')
    expect(codexConfig.incidentKeywords).toContain('cli')
    expect(codexConfig.incidentKeywords).toContain('vs code')
  })

  it('Codex-titled incident → degraded', () => {
    const incidents = [
      mockIncident({ id: 'cdx-load', title: 'Users unable to load ChatGPT and Codex' }),
    ]
    const filtered = filterIncidents(incidents, codexConfig)
    expect(filtered).toHaveLength(1)

    const summary: SummaryData = { status: { indicator: 'minor' } }
    expect(determineSvcStatus({}, summary, filtered)).toBe('degraded')
  })

  it('CLI-only component incident with no keyword in title → matched via componentNames', () => {
    const incidents = [
      mockIncident({ id: 'cli-inc', title: 'Authentication failing', componentNames: ['CLI'] }),
    ]
    const filtered = filterIncidents(incidents, codexConfig)
    expect(filtered).toHaveLength(1) // matched via componentNames

    const summary: SummaryData = { status: { indicator: 'minor' } }
    expect(determineSvcStatus({}, summary, filtered)).toBe('degraded')
  })

  it('VS Code extension-only incident → matched', () => {
    const incidents = [
      mockIncident({ id: 'vsc-inc', title: 'Extension not loading', componentNames: ['VS Code extension'] }),
    ]
    expect(filterIncidents(incidents, codexConfig)).toHaveLength(1)
  })

  it('OpenAI API-only incident with overall=minor → operational (cross-contamination guard)', () => {
    const incidents = [
      mockIncident({ id: 'api-inc', title: 'Elevated latency on /v1/responses', componentNames: ['Responses'] }),
    ]
    const filtered = filterIncidents(incidents, codexConfig)
    expect(filtered).toHaveLength(0)

    const summary: SummaryData = { status: { indicator: 'minor' } }
    expect(determineSvcStatus({}, summary, filtered)).toBe('operational')
  })

  it('ChatGPT-only incident with overall=minor → operational (not leaked into Codex)', () => {
    const incidents = [
      mockIncident({ id: 'chat-inc', title: 'ChatGPT conversation errors', componentNames: ['Feed'] }),
    ]
    const filtered = filterIncidents(incidents, codexConfig)
    // 'codex' keyword doesn't match 'chatgpt', no overlap with 'cli'/'vs code'
    expect(filtered).toHaveLength(0)

    const summary: SummaryData = { status: { indicator: 'minor' } }
    expect(determineSvcStatus({}, summary, filtered)).toBe('operational')
  })

  it('major overall + Codex-matched unresolved incident → down', () => {
    const incidents = [
      mockIncident({ id: 'cdx-major', title: 'Codex Web completely down', status: 'identified' }),
    ]
    const filtered = filterIncidents(incidents, codexConfig)
    const summary: SummaryData = { status: { indicator: 'major' } }
    expect(determineSvcStatus({}, summary, filtered)).toBe('down')
  })
})

describe('component miss tracking (#135)', () => {
  it('tracks miss when statusComponentId is configured but not found', async () => {
    const kv = mockKV()
    const result = await trackComponentMissLogic(
      { id: 'openai', statusComponentId: 'comp-api-123' },
      [{ id: 'other-comp', name: 'Other' }],
      kv,
    )
    expect(result).toBe('tracked')
    expect(kv.put).toHaveBeenCalledWith('component-missing:openai', '1', { expirationTtl: 1800 })
  })

  it('resets miss counter when component is found', async () => {
    const kv = mockKV({ 'component-missing:openai': '2' })
    const result = await trackComponentMissLogic(
      { id: 'openai', statusComponentId: 'comp-api-123' },
      [{ id: 'comp-api-123', name: 'API' }],
      kv,
    )
    expect(result).toBe('reset')
    expect(kv.delete).toHaveBeenCalled()
  })

  it('skips tracking when no statusComponentId configured', async () => {
    const kv = mockKV()
    const result = await trackComponentMissLogic(
      { id: 'openai' },
      [{ id: 'comp-api-123', name: 'API' }],
      kv,
    )
    expect(result).toBe('skipped')
    expect(kv.put).not.toHaveBeenCalled()
    expect(kv.delete).not.toHaveBeenCalled()
  })

  it('skips tracking when components array is undefined', async () => {
    const kv = mockKV()
    const result = await trackComponentMissLogic(
      { id: 'openai', statusComponentId: 'comp-api-123' },
      undefined,
      kv,
    )
    expect(result).toBe('skipped')
  })
})
