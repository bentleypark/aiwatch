import { describe, it, expect, vi } from 'vitest'
import { normalizeStatus } from '../parsers/statuspage'
import { filterIncidents, SERVICES } from '../services'
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
}

interface SummaryData {
  status: { indicator: string }
  components?: Array<{ id: string; name: string; status: string }>
}

interface FilteredIncident {
  status: string
}

/**
 * Mirrors the svcStatus determination logic from services.ts lines 219-234
 */
function determineSvcStatus(
  config: StatusConfig,
  summaryData: SummaryData,
  filtered: FilteredIncident[],
): string {
  const overall = normalizeStatus(summaryData.status?.indicator ?? 'none')
  if (!config.statusComponent && !config.statusComponentId) {
    if (overall !== 'operational' && filtered.filter((i) => i.status !== 'resolved').length === 0) {
      return 'operational'
    }
    return overall
  }
  const comp = config.statusComponent
    ? summaryData.components?.find((c) => c.name.startsWith(config.statusComponent!))
    : summaryData.components?.find((c) => c.id === config.statusComponentId!)
  return comp ? normalizeStatus(comp.status) : overall
}

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
