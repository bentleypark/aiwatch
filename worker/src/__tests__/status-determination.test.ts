import { describe, it, expect, vi } from 'vitest'
import { normalizeStatus } from '../parsers/statuspage'
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
