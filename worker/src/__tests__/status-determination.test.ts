import { describe, it, expect, vi } from 'vitest'
import { normalizeStatus } from '../parsers/statuspage'
import { filterIncidents, SERVICES, worstStatus, resolveSvcStatus, resolveSvcComponents, pickBreakdownComponents, classifyStatusPageFailure, coverageDaysFrom, MIN_COVERAGE_DAYS, existedInMonth } from '../services'
import type { Incident, ServiceConfig } from '../types'
import { type KVLike } from '../utils'

describe('classifyStatusPageFailure (#689)', () => {
  it('treats a 4xx as a dead source (page deactivated/gone — NOT a service degradation)', () => {
    for (const s of [400, 401, 403, 404, 410, 451]) {
      expect(classifyStatusPageFailure(s), `HTTP ${s}`).toBe('dead-source')
    }
  })
  it('treats a 5xx / network-error (0) as transient → keeps the degrade path', () => {
    for (const s of [500, 502, 503, 504, 0]) {
      expect(classifyStatusPageFailure(s), `HTTP ${s}`).toBe('transient')
    }
  })
})

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
  componentGroups?: Record<string, string>
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

  describe('"Codex in ChatGPT Desktop" is a ChatGPT component, not a Codex one (#1008)', () => {
    // 01KMKFAMWKQ81YWSE1Z18R6VHR "Codex in ChatGPT Desktop" is officially in the ChatGPT group
    // (Codex surfaced inside the ChatGPT desktop app). It was mis-attributed to codex, so a
    // ChatGPT-only incident flipped it to partial_outage and dragged the Codex badge to degraded.
    const CODEX_IN_CHATGPT_DESKTOP = '01KMKFAMWKQ81YWSE1Z18R6VHR'
    const codex = SERVICES.find((s) => s.id === 'codex')!
    const chatgpt = SERVICES.find((s) => s.id === 'chatgpt')!

    it('is absent from BOTH of codex\'s component arrays', () => {
      expect(codex.statusComponentIds).not.toContain(CODEX_IN_CHATGPT_DESKTOP)
      expect(codex.displayComponentIds).not.toContain(CODEX_IN_CHATGPT_DESKTOP)
      // Only the four real Codex-product surfaces remain, badge scope == displayed group.
      expect(codex.statusComponentIds).toEqual([
        '01KMP3KP5MGE23B80K1EK4S8PV', // Codex API
        '01KMKFAMWKNQ84Z1766MV08ZDE', // CLI
        '01KMP3KP5M8X0EBTVW6KN327EE', // VS Code extension
        '01JVCV8YSWZFRSM1G5CVP253SK', // Codex Web
      ])
      expect(new Set(codex.displayComponentIds)).toEqual(new Set(codex.statusComponentIds))
    })

    it('is present in BOTH of chatgpt\'s component arrays (correct attribution)', () => {
      expect(chatgpt.statusComponentIds).toContain(CODEX_IN_CHATGPT_DESKTOP)
      expect(chatgpt.displayComponentIds).toContain(CODEX_IN_CHATGPT_DESKTOP)
    })

    it('codex stays operational when only "Codex in ChatGPT Desktop" is partial (its ids are unaffected)', () => {
      // Live 2026-07-15 shape: "Elevated errors affecting ChatGPT" partial-outages the ChatGPT-side
      // components incl. Codex-in-ChatGPT-Desktop, while the Codex product surfaces are operational.
      // indicator:'none' is deliberate — so chatgpt's degraded can ONLY come from the moved
      // component matching in its worst-of, not the overall-indicator fallback (step 4). If the id
      // were still (wrongly) absent from chatgpt, its worst-of would match nothing here and fall
      // back to the 'none' indicator → operational, failing the assertion.
      const summary: SummaryData = {
        status: { indicator: 'none' },
        components: [
          { id: '01KMP3KP5MGE23B80K1EK4S8PV', name: 'Codex API', status: 'operational' },
          { id: '01KMKFAMWKNQ84Z1766MV08ZDE', name: 'CLI', status: 'operational' },
          { id: '01KMP3KP5M8X0EBTVW6KN327EE', name: 'VS Code extension', status: 'operational' },
          { id: '01JVCV8YSWZFRSM1G5CVP253SK', name: 'Codex Web', status: 'operational' },
          { id: CODEX_IN_CHATGPT_DESKTOP, name: 'Codex in ChatGPT Desktop', status: 'partial_outage' },
        ],
      }
      expect(determineSvcStatus(codex as unknown as StatusConfig, summary, [])).toBe('operational')
      // ChatGPT, which now owns the component, correctly reflects the same partial as degraded.
      expect(determineSvcStatus(chatgpt as unknown as StatusConfig, summary, [])).toBe('degraded')
    })

    it('codex still degrades when a genuine Codex-product surface is impaired', () => {
      const summary: SummaryData = {
        status: { indicator: 'minor' },
        components: [
          { id: '01KMP3KP5MGE23B80K1EK4S8PV', name: 'Codex API', status: 'partial_outage' },
          { id: '01KMKFAMWKNQ84Z1766MV08ZDE', name: 'CLI', status: 'operational' },
          { id: '01KMP3KP5M8X0EBTVW6KN327EE', name: 'VS Code extension', status: 'operational' },
          { id: '01JVCV8YSWZFRSM1G5CVP253SK', name: 'Codex Web', status: 'operational' },
        ],
      }
      expect(determineSvcStatus(codex as unknown as StatusConfig, summary, [])).toBe('degraded')
    })
  })

  describe('with displayAllComponents dynamic worst-of (#992) — Cerebras shape', () => {
    // Cerebras: displayAllComponents + statusComponentId (uptime primary), NO statusComponentIds.
    const config: StatusConfig = { displayAllComponents: true, statusComponentId: 'dev' }

    it('worst-ofs EVERY shown component, so a brand-new/untracked model degrades the badge', () => {
      const summary: SummaryData = {
        status: { indicator: 'none' },
        components: [
          { id: 'dev', name: 'Developer Console', status: 'operational' },
          { id: 'm1', name: 'GPT-OSS-120B', status: 'operational' },
          { id: 'newmodel', name: 'Gemma4-31B-Multimodal', status: 'partial_outage' }, // in no allowlist
        ],
      }
      expect(determineSvcStatus(config, summary, [])).toBe('degraded')
    })

    it('down wins across components', () => {
      const summary: SummaryData = {
        status: { indicator: 'none' },
        components: [
          { id: 'dev', name: 'Developer Console', status: 'operational' },
          { id: 'm1', name: 'GPT-OSS-120B', status: 'major_outage' },
        ],
      }
      expect(determineSvcStatus(config, summary, [])).toBe('down')
    })

    it('all operational → operational', () => {
      const summary: SummaryData = {
        status: { indicator: 'none' },
        components: [
          { id: 'dev', name: 'Developer Console', status: 'operational' },
          { id: 'm1', name: 'GPT-OSS-120B', status: 'operational' },
        ],
      }
      expect(determineSvcStatus(config, summary, [])).toBe('operational')
    })

    it('does NOT pin the badge to the single statusComponentId component (the branch-3 hazard)', () => {
      // Developer Console (the uptime primary) is operational, but a model is down. If the single-
      // component branch ran, the badge would read operational — the exact regression #992 avoids.
      const summary: SummaryData = {
        status: { indicator: 'none' },
        components: [
          { id: 'dev', name: 'Developer Console', status: 'operational' },
          { id: 'm1', name: 'GPT-OSS-120B', status: 'major_outage' },
        ],
      }
      expect(determineSvcStatus(config, summary, [])).toBe('down')
    })

    it('componentDenylist components cannot degrade the badge', () => {
      const cfg: StatusConfig = { displayAllComponents: true, componentDenylist: ['Docs'] }
      const summary: SummaryData = {
        status: { indicator: 'none' },
        components: [
          { id: 'a', name: 'API', status: 'operational' },
          { id: 'docs', name: 'Docs', status: 'major_outage' },
        ],
      }
      expect(determineSvcStatus(cfg, summary, [])).toBe('operational')
    })

    it('BFL keeps its curated statusComponentIds worst-of even WITH displayAllComponents (branch order: #379 before #992)', () => {
      // BFL has both flags: the badge must stay scoped to statusComponentIds, so an untracked
      // component (e.g. Image Generation Services) cannot flip it — the dynamic branch must NOT win.
      const cfg: StatusConfig = { displayAllComponents: true, statusComponentIds: ['a'], componentDenylist: [] }
      const summary: SummaryData = {
        status: { indicator: 'none' },
        components: [
          { id: 'a', name: 'API', status: 'operational' },
          { id: 'b', name: 'Untracked', status: 'major_outage' },
        ],
      }
      expect(determineSvcStatus(cfg, summary, [])).toBe('operational')
    })

    it('a no-id displayAllComponents service (cohere/groq) stays on the OVERALL indicator, not the dynamic worst-of (branch-1 precedence — a Playground blip must not flip the API badge)', () => {
      const cfg: StatusConfig = { displayAllComponents: true, componentDenylist: ['Docs', 'Website'] }
      const summary: SummaryData = {
        status: { indicator: 'none' },
        components: [
          { id: 'a', name: 'API', status: 'operational' },
          { id: 'b', name: 'Playground', status: 'major_outage' }, // would degrade IF worst-of applied
        ],
      }
      expect(determineSvcStatus(cfg, summary, [])).toBe('operational') // overall 'none' wins
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

  it('tags displayComponentIds with componentGroups labels; unmapped ids stay ungrouped', () => {
    const cfg: StatusConfig = {
      displayComponentIds: ['http', 'stream', 'h100', 'registry'],
      componentGroups: { http: 'API', stream: 'API', h100: 'Inference and Training' },
    }
    const summary: SummaryData = {
      status: { indicator: 'minor' },
      components: [
        { id: 'http', name: 'HTTP API', status: 'operational' },
        { id: 'stream', name: 'Streaming API', status: 'operational' },
        { id: 'h100', name: 'H100 Hardware', status: 'degraded_performance' },
        { id: 'registry', name: 'Registry', status: 'operational' },
      ],
    }
    const out = resolveSvcComponents(cfg, summary)
    expect(out.map((c) => [c.id, c.group])).toEqual([
      ['http', 'API'],
      ['stream', 'API'],
      ['h100', 'Inference and Training'],
      ['registry', undefined], // unmapped → top-level surface row
    ])
    expect(out.find((c) => c.id === 'h100')?.status).toBe('degraded')
  })
})

describe('displayComponentIds config sanity (#606)', () => {
  // Exact curated counts — guards against a careless edit truncating the list
  // (the doc comments enumerate the excluded components, so the count is intentional).
  // replicate: API(HTTP/Streaming) + Inference and Training(5 hardware) + Website(Playground)
  //            + 2 ungrouped surfaces (Registry/Official Models) + Support(Billing/Support Tickets) = 12
  const EXPECTED_COUNT: Record<string, number> = { elevenlabs: 7, replicate: 12 }

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

  it('every componentGroups key is a member of that service\'s displayComponentIds (no typo\'d/orphan ULID)', () => {
    // A componentGroups key not present in displayComponentIds is dead config: it would silently fail
    // to tag any rendered component (the component stays an ungrouped surface row), so a mistyped ULID
    // would never group + never error. This pins the map to the curated id list.
    for (const svc of SERVICES) {
      if (!svc.componentGroups) continue
      const ids = new Set(svc.displayComponentIds ?? svc.statusComponentIds ?? [])
      for (const key of Object.keys(svc.componentGroups)) {
        expect(ids.has(key), `${svc.id}: componentGroups key ${key} not in displayComponentIds`).toBe(true)
      }
    }
  })

  it('replicate componentGroups maps the official-page groups onto the right components', () => {
    const replicate = SERVICES.find((s) => s.id === 'replicate')!
    expect(replicate.componentGroupsInline, 'replicate uses array-order interleave').toBe(true)
    // The 2 ungrouped surfaces (Registry, Official Models) are the only displayComponentIds entries
    // absent from componentGroups; the other 10 carry an official group label.
    const grouped = new Set(Object.keys(replicate.componentGroups!))
    const ungrouped = replicate.displayComponentIds!.filter((id) => !grouped.has(id))
    expect(ungrouped).toEqual(['01JXJT0JC265GZN0BAJ446XBD2', '01JS0AB43BGQC1H06HKGPHP1F2']) // Registry, Official Models
    // The 5 hardware ids all carry the "Inference and Training" label.
    const hardware = ['01JRG9WZ84ABEY9ZJBB72CJBS8', '01JRGA5ZQKJX2NMG45VCFP9Y9C', '01JRGA5ZQKF3SW674WMFD92PAC', '01JS0A88GKRF5DNW74REX185D3', '01JS0A88GKZAMP8BD3W9BCCBWX']
    for (const id of hardware) expect(replicate.componentGroups![id]).toBe('Inference and Training')
    // The official group SET matches the page (API / Inference and Training / Website / Support).
    expect(new Set(Object.values(replicate.componentGroups!))).toEqual(
      new Set(['API', 'Inference and Training', 'Website', 'Support']),
    )
  })

  it('#685 — surfaces a degraded ElevenCreative in the elevenlabs breakdown (no more all-green-while-badge-degraded)', () => {
    const elevenlabs = SERVICES.find((s) => s.id === 'elevenlabs')!
    const CREATIVE = '01JJM5RKYAEWNM3XYRHXM8FJQ3'
    expect(elevenlabs.displayComponentIds, 'ElevenCreative must be curated in (the #685 fix)').toContain(CREATIVE)
    // Summary where every curated component is operational EXCEPT ElevenCreative (degraded) — the exact
    // shape that previously rendered all-green while the badge (overall indicator) read degraded.
    const summary = {
      status: { indicator: 'minor' },
      components: elevenlabs.displayComponentIds!.map((id) => ({
        id,
        name: id === CREATIVE ? 'ElevenCreative' : `Surface ${id.slice(-4)}`,
        status: id === CREATIVE ? 'degraded_performance' : 'operational',
      })),
    }
    const out = resolveSvcComponents(elevenlabs, summary)
    expect(out).toHaveLength(7)
    const creative = out.find((c) => c.id === CREATIVE)
    expect(creative, 'ElevenCreative now appears in the breakdown').toBeDefined()
    expect(creative!.name).toBe('ElevenCreative')
    expect(creative!.status).toBe('degraded') // degraded_performance normalized → 'degraded'
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
  // #1008: "Codex in ChatGPT Desktop" moved from codex (5→4) to its official ChatGPT group (11→12).
  const SHARED_PAGE_COUNT: Record<string, number> = { openai: 12, chatgpt: 12, codex: 4 }

  // #693 follow-up — openai/chatgpt/codex now SCOPE the badge to their official-group components
  // via a worst-of statusComponentIds (was: no statusComponentIds → overall page indicator). This
  // stops a non-API component (FedRAMP/Ads Manager) from flipping the OpenAI API badge, and gives a
  // 30-day calendar (calendarDays keys off statusComponentId). The curated group == displayComponentIds.
  const SHARED_PAGE_PRIMARY: Record<string, string> = {
    openai: '01JMXBRMFE6N2NNT7DG6XZQ6PW',   // Chat Completions
    chatgpt: '01JMXBNJXGV1T5GT2M9XA83XNG',  // Conversations
    codex: '01KMP3KP5MGE23B80K1EK4S8PV',    // Codex API
  }
  it('openai/chatgpt/codex scope the badge to their official-group worst-of statusComponentIds (#693 follow-up)', () => {
    for (const [id, count] of Object.entries(SHARED_PAGE_COUNT)) {
      const svc = SERVICES.find((s) => s.id === id)!
      expect(svc.displayComponentIds!.length, id).toBe(count)
      expect(new Set(svc.displayComponentIds).size, id).toBe(count)
      // Badge now follows the curated group (worst-of), not the overall indicator.
      expect(svc.statusComponentIds, id).toBeDefined()
      expect(svc.statusComponentIds!.length, id).toBe(count)
      expect(new Set(svc.statusComponentIds).size, id).toBe(count)
      // Same id set as the breakdown (badge scope == displayed group).
      expect(new Set(svc.statusComponentIds), id).toEqual(new Set(svc.displayComponentIds))
      // primary statusComponentId = incidentIoComponentId (uptime/calendar/component-miss anchor),
      // listed first in statusComponentIds (#379 convention).
      expect(svc.statusComponentId, id).toBe(SHARED_PAGE_PRIMARY[id])
      expect(svc.statusComponentIds![0], id).toBe(SHARED_PAGE_PRIMARY[id])
    }
  })

  it('openai + codex source the breakdown from components.json (summary.json omits their primary)', () => {
    // The APIs Login / Chat Completions / Embeddings / Moderations are components.json-only, so openai
    // must set componentsUrl. #783: OpenAI later dropped "Codex API" (codex's PRIMARY statusComponentId)
    // from summary.json too, so codex now needs componentsUrl as well (without it the statusComponentId
    // miss-check false-fired the migration alert every cycle). chatgpt stays summary.json-complete —
    // its primary "Conversations" is present in summary.json.
    expect(SERVICES.find((s) => s.id === 'openai')!.componentsUrl).toBe('https://status.openai.com/api/v2/components.json')
    expect(SERVICES.find((s) => s.id === 'codex')!.componentsUrl).toBe('https://status.openai.com/api/v2/components.json')
    expect(SERVICES.find((s) => s.id === 'chatgpt')!.componentsUrl).toBeUndefined()
  })

  it('#800 — characterai is flagged statusSourceDeactivated (its Statuspage is a known 401 deactivation)', () => {
    // The production wiring of the #800 recurring-alert suppression. A silent drop of this flag would
    // resume the daily #500 + weekly #689 dead-source alerts for an acknowledged dead source, so pin it.
    expect(SERVICES.find((s) => s.id === 'characterai')!.statusSourceDeactivated).toBe(true)
  })

  describe('coverageDaysFrom (#802)', () => {
    const NOW = '2026-06-26T00:00:00.000Z'
    it('returns null for an absent addedAt (established service → full coverage)', () => {
      expect(coverageDaysFrom(undefined, NOW)).toBe(null)
    })
    it('returns floored whole days since addedAt', () => {
      expect(coverageDaysFrom('2026-06-24', NOW)).toBe(2)
      expect(coverageDaysFrom('2026-05-27', NOW)).toBe(30) // exactly at the boundary
    })
    it('never negative (a future addedAt clamps to 0)', () => {
      expect(coverageDaysFrom('2026-07-01', NOW)).toBe(0)
    })
    it('returns null on an unparseable date (fail-open — no coverage gate)', () => {
      expect(coverageDaysFrom('not-a-date', NOW)).toBe(null)
    })
    it('MIN_COVERAGE_DAYS is 30', () => {
      expect(MIN_COVERAGE_DAYS).toBe(30)
    })
  })

  describe('existedInMonth (#909 — post-month roster leak)', () => {
    const JUNE_END = '2026-06-30'
    it('keeps an established service (no addedAt)', () => {
      expect(existedInMonth(undefined, JUNE_END)).toBe(true)
    })
    it('drops a service added AFTER the month (turbopuffer / Twelve Labs case)', () => {
      expect(existedInMonth('2026-07-01', JUNE_END)).toBe(false)
      expect(existedInMonth('2026-07-02', JUNE_END)).toBe(false)
    })
    it('keeps a genuine mid-month add (partial coverage — ranking gate handles it)', () => {
      expect(existedInMonth('2026-06-15', JUNE_END)).toBe(true)
    })
    it('keeps a service added on the month-end day (boundary inclusive)', () => {
      expect(existedInMonth('2026-06-30', JUNE_END)).toBe(true)
    })
    it('tolerates an ISO datetime addedAt (compares the date prefix)', () => {
      expect(existedInMonth('2026-07-01T12:00:00.000Z', JUNE_END)).toBe(false)
      expect(existedInMonth('2026-06-30T23:59:00.000Z', JUNE_END)).toBe(true)
    })
    it('fails OPEN on a malformed addedAt (keeps — never silently drops a real service)', () => {
      expect(existedInMonth('garbage', JUNE_END)).toBe(true)
      expect(existedInMonth('2026-6-1', JUNE_END)).toBe(true) // non-zero-padded → not ISO shape → kept
    })
  })

  it('#802 — every service carrying addedAt uses an ISO YYYY-MM-DD date (drives coverageDays)', () => {
    // addedAt is stamped on recently-added services; absent on established ones. Any present value must
    // be a valid ISO date so coverageDaysFrom doesn't fail-open and silently drop the ranking gate.
    const ISO = /^\d{4}-\d{2}-\d{2}$/
    for (const s of SERVICES) {
      if (s.addedAt != null) {
        expect(ISO.test(s.addedAt), `${s.id} addedAt`).toBe(true)
        expect(Number.isNaN(Date.parse(s.addedAt)), `${s.id} addedAt parseable`).toBe(false)
      }
    }
  })

  it('LEAK GUARD: the 3 shared-page services have DISJOINT component ids (no sibling-service leak)', () => {
    const lists = ['openai', 'chatgpt', 'codex'].map((id) => SERVICES.find((s) => s.id === id)!.displayComponentIds!)
    const all = lists.flat()
    // Every id assigned to exactly one service → flat length === unique count.
    expect(new Set(all).size).toBe(all.length)
    expect(all.length).toBe(12 + 12 + 4) // #1008: moved "Codex in ChatGPT Desktop" codex(5→4) → chatgpt(11→12)
  })

  // #606 — single-owner statuspages: a curated displayComponentIds breakdown + the existing
  // single statusComponentId badge (so the badge is unchanged; statusComponentIds plural absent).
  const SINGLE_OWNER_COUNT: Record<string, number> = { assemblyai: 6, deepgram: 9, characterai: 5, junie: 2, voyageai: 2, pinecone: 6, twelvelabs: 10 }

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
    // Agent is ChatGPT (not API) per the official grouping.
    expect(has('chatgpt', '01JSG1XMJ9RVJJQ0E85NVSJ2AZ'), 'Agent → chatgpt').toBe(true)
    // Sora + the API Login are OpenAI API.
    expect(has('openai', '01K9G527YRPY1EFRMHTKB5BKT5'), 'Sora → openai').toBe(true)
    expect(has('openai', '01JSM5RTJWHRWDTS6Q604VEW3B'), 'API Login → openai').toBe(true)
    // #693 follow-up — FedRAMP / Ads Manager / Compliance API are non-API Platform surfaces, now in
    // NO monitored service's breakdown (orphaned by design, so they never flip openai/chatgpt).
    expect(has('openai', '01KKAD7C71MCCH3FTREMJH4AAS'), 'FedRAMP NOT in openai').toBe(false)
    expect(has('openai', '01KTQBYVARFJ5KMCSECM06VKCF'), 'Ads Manager NOT in openai').toBe(false)
    expect(has('chatgpt', '01JNKS9D9S72PMP1938PVFFQN4'), 'Compliance API NOT in chatgpt').toBe(false)
    // #1008 — "Codex in ChatGPT Desktop" is a ChatGPT-group surface (Codex inside the ChatGPT
    // desktop app), NOT a Codex-product component. It was mis-attributed to codex; now under chatgpt.
    expect(has('chatgpt', '01KMKFAMWKQ81YWSE1Z18R6VHR'), 'Codex in ChatGPT Desktop → chatgpt').toBe(true)
    expect(has('codex', '01KMKFAMWKQ81YWSE1Z18R6VHR'), 'Codex in ChatGPT Desktop NOT in codex').toBe(false)
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

  it('cerebras runs DYNAMIC (displayAllComponents), not a stale allowlist — churny per-model page (#992)', () => {
    // Was a 5-id statusComponentIds allowlist (#391/#379); the lineup churned (2 ids went dead + a new
    // Gemma4-31B-Multimodal appeared untracked), so it's now displayAllComponents like cohere/groq: the
    // breakdown lists every live component and the #992 dynamic worst-of drives the badge, so a model
    // added/retired needs no config edit. statusComponentId stays the uptime/calendar/miss primary.
    const cb = SERVICES.find((s) => s.id === 'cerebras')!
    expect(cb.statusComponentId).toBe('83h1cchw4vs4') // Developer Console — primary for uptime parsing
    expect(cb.displayAllComponents).toBe(true)
    expect(cb.componentSurfaces).toContain('Developer Console')
    expect(cb.statusComponentIds).toBeUndefined() // allowlist dropped
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

  it('config scopes the badge to its consumer components via statusComponentIds; incidentKeywords stays the sole incident filter (#292 → #693 follow-up)', () => {
    // #693 follow-up: chatgpt now scopes its BADGE to its own consumer components (Conversations,
    // Search, Voice mode, …) via a worst-of statusComponentIds. This REPLACES the old #292
    // cross-contamination protection (no statusComponentId → overall-indicator path + the "no relevant
    // incident → operational" guard) with a STRONGER one: the badge follows chatgpt's OWN components,
    // so an OpenAI-API page-level state (e.g. FedRAMP degraded) can't flip it — the API components
    // aren't in chatgpt's set. incidentKeywords is the positive filter; incidentExclude carries ONLY
    // the #990 environment-scope veto ('fedramp'), which runs before the keyword match.
    expect(chatgptConfig).toBeDefined()
    expect(chatgptConfig.statusComponentId).toBe('01JMXBNJXGV1T5GT2M9XA83XNG') // Conversations (primary)
    expect(chatgptConfig.statusComponentIds).toBeDefined()
    expect(chatgptConfig.statusComponent).toBeUndefined()
    expect(chatgptConfig.incidentExclude).toEqual(['fedramp']) // #990 environment-scope veto only
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
    // #693 follow-up: codex now scopes its badge to its own surfaces (Codex API/CLI/VS Code/Web/App)
    // via a worst-of statusComponentIds, replacing the old overall-indicator + cross-contamination
    // guard (#294) with direct component-scoping. incidentKeywords is the positive filter;
    // incidentExclude carries ONLY the #990 environment-scope veto ('fedramp').
    expect(codexConfig.statusComponentId).toBe('01KMP3KP5MGE23B80K1EK4S8PV') // Codex API (primary)
    expect(codexConfig.statusComponentIds).toBeDefined()
    expect(codexConfig.statusComponent).toBeUndefined()
    expect(codexConfig.incidentExclude).toEqual(['fedramp']) // #990 environment-scope veto only
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

// #693 follow-up — the badge-scoping fix: a non-API component (FedRAMP/Ads Manager) must NOT flip the
// OpenAI API badge, while a real API component still does. This is the behavior the original bug
// violated (FedRAMP "degraded performance" drove openai to degraded via the overall indicator).
describe('OpenAI API badge scoping (#693 follow-up) — non-API components do not flip the badge', () => {
  const openai = SERVICES.find((s) => s.id === 'openai')!
  const FEDRAMP = '01KKAD7C71MCCH3FTREMJH4AAS'
  const CHAT_COMPLETIONS = '01JMXBRMFE6N2NNT7DG6XZQ6PW'

  // Overall page indicator is intentionally BAD (e.g. driven by the FedRAMP incident); the worst-of
  // statusComponentIds path must ignore it and the FedRAMP component (neither is in the curated group).
  const summaryWith = (overrides: Record<string, string>): SummaryData => ({
    status: { indicator: 'major' },
    components: [
      ...openai.statusComponentIds!.map((id) => ({ id, name: id, status: overrides[id] ?? 'operational' })),
      { id: FEDRAMP, name: 'FedRAMP', status: overrides[FEDRAMP] ?? 'operational' },
    ],
  })

  it('FedRAMP down + overall indicator "major" → openai stays operational (FedRAMP not in statusComponentIds)', () => {
    expect(determineSvcStatus(openai, summaryWith({ [FEDRAMP]: 'major_outage' }), [])).toBe('operational')
  })

  it('a real API component (Chat Completions) down → openai is down (worst-of the curated group)', () => {
    expect(determineSvcStatus(openai, summaryWith({ [CHAT_COMPLETIONS]: 'major_outage' }), [])).toBe('down')
  })

  it('a real API component degraded → openai degraded', () => {
    expect(determineSvcStatus(openai, summaryWith({ [CHAT_COMPLETIONS]: 'degraded_performance' }), [])).toBe('degraded')
  })
})
