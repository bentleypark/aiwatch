import { describe, it, expect } from 'vitest'
import archive202608 from './fixtures/archive-2026-08-census-fields.json'
import {
  BUILD_DAY_FIELD_GROUPS, mergeRebuiltArchive, buildMonthlyArchive, archiveContentCensus, censusRegressions,
  type MonthlyArchive, type ArchiveScoreInput,
} from '../monthly-archive'
import { SERVICES } from '../services'

const asArchive = (services: Record<string, Record<string, unknown>>): MonthlyArchive =>
  ({ period: '2026-08', generatedAt: '2026-09-01T00:00:00Z', daysCollected: 31, services }) as unknown as MonthlyArchive

describe('mergeRebuiltArchive — the real 2026-08 rebuild loss (#1504)', () => {
  const prior = archive202608 as unknown as MonthlyArchive
  const rebuilt = structuredClone(prior) as unknown as { services: Record<string, Record<string, unknown>> }
  rebuilt.services.replicate.officialUptime = null
  delete rebuilt.services.replicate.uptimeSource
  for (const id of ['replicate', 'mistral', 'perplexity', 'windsurf']) delete rebuilt.services[id].components

  const { archive, carried } = mergeRebuiltArchive(prior, rebuilt as unknown as MonthlyArchive)

  it('restores exactly the six emptied fields from the stored month', () => {
    expect(archive).toEqual(prior)
  })

  it('names every carried group, and the merged archive no longer regresses the census', () => {
    const byService = <T extends { service: string }>(c: T[]) => [...c].sort((x, y) => x.service.localeCompare(y.service))
    expect(byService(carried)).toEqual(byService([
      { service: 'replicate', fields: ['officialUptime', 'uptimeSource', 'score', 'grade', 'scoreConfidence'] },
      { service: 'replicate', fields: ['components'] },
      { service: 'mistral', fields: ['components'] },
      { service: 'perplexity', fields: ['components'] },
      { service: 'windsurf', fields: ['components'] },
    ]))
    expect(censusRegressions(archiveContentCensus(prior)!, archiveContentCensus(archive)!)).toEqual([])
  })
})

describe('mergeRebuiltArchive — what replaces and what is kept', () => {
  it('a rebuilt value replaces the stored one', () => {
    const { archive, carried } = mergeRebuiltArchive(
      asArchive({ x: { officialUptime: 99.85, uptimeSource: 'official' } }),
      asArchive({ x: { officialUptime: 99.9, uptimeSource: 'platform_avg' } }),
    )
    expect(archive.services.x).toMatchObject({ officialUptime: 99.9, uptimeSource: 'platform_avg' })
    expect(carried).toEqual([])
  })

  it('carries a group whole, so a stored value is never paired with a rebuilt sibling', () => {
    const { archive } = mergeRebuiltArchive(
      asArchive({ x: { score: 45, grade: 'fair', scoreConfidence: 'high' } }),
      asArchive({ x: { score: null, grade: null, scoreConfidence: 'low' } }),
    )
    expect(archive.services.x).toMatchObject({ score: 45, grade: 'fair', scoreConfidence: 'high' })
  })

  it('carries the stored score with a carried official uptime, never pairing it with a rebuilt one', () => {
    const { archive } = mergeRebuiltArchive(
      asArchive({ x: { officialUptime: 99.85, uptimeSource: 'official', score: 45, grade: 'fair', scoreConfidence: 'high' } }),
      asArchive({ x: { officialUptime: null, score: 61, grade: 'good', scoreConfidence: 'medium' } }),
    )
    expect(archive.services.x).toEqual({ officialUptime: 99.85, uptimeSource: 'official', score: 45, grade: 'fair', scoreConfidence: 'high' })
  })

  it('keeps a stored score with the official uptime it did not consume rather than pairing it with a rebuilt one', () => {
    const { archive } = mergeRebuiltArchive(
      asArchive({ x: { officialUptime: null, score: 70, grade: 'good', scoreConfidence: 'medium' } }),
      asArchive({ x: { officialUptime: 99.85, score: null, grade: null } }),
    )
    expect(archive.services.x).toEqual({ officialUptime: null, score: 70, grade: 'good', scoreConfidence: 'medium' })
  })

  it('keeps a stored official uptime with the absent score it was archived beside', () => {
    const { archive, carried } = mergeRebuiltArchive(
      asArchive({ x: { officialUptime: 99.9, score: null, grade: null } }),
      asArchive({ x: { officialUptime: null, score: 70, grade: 'good', scoreConfidence: 'medium' } }),
    )
    expect(archive.services.x).toEqual({ officialUptime: 99.9, score: null, grade: null })
    expect(carried).toEqual([{ service: 'x', fields: ['officialUptime', 'uptimeSource', 'score', 'grade', 'scoreConfidence'] }])
  })

  it('treats a stored service entry that is not an object as nothing to carry', () => {
    const next = { officialUptime: null }
    const { archive } = mergeRebuiltArchive(asArchive({ x: null as unknown as Record<string, unknown> }), asArchive({ x: next }))
    expect(archive.services.x).toBe(next)
  })

  it('drops a rebuilt sibling the stored group did not have', () => {
    const { archive } = mergeRebuiltArchive(
      asArchive({ x: { score: 45, grade: 'fair' } }),
      asArchive({ x: { score: null, grade: null, scoreConfidence: 'low' } }),
    )
    expect(archive.services.x).not.toHaveProperty('scoreConfidence')
  })

  it('replaces incident aggregates even when the rebuild empties them — a suppressed month must lose its downtime', () => {
    const { archive, carried } = mergeRebuiltArchive(
      asArchive({ x: { incidents: 1, totalDowntimeMin: 120, avgResolutionMin: 120, longestIncidentMin: 120, incidentList: [{ id: 'i1' }] } }),
      asArchive({ x: { incidents: 0, totalDowntimeMin: null, avgResolutionMin: null, longestIncidentMin: null } }),
    )
    expect(archive.services.x).toEqual({ incidents: 0, totalDowntimeMin: null, avgResolutionMin: null, longestIncidentMin: null })
    expect(carried).toEqual([])
  })

  it('leaves a service the stored archive did not hold untouched', () => {
    const next = { officialUptime: null }
    const { archive } = mergeRebuiltArchive(asArchive({}), asArchive({ x: next }))
    expect(archive.services.x).toBe(next)
  })
})

describe('BUILD_DAY_FIELD_GROUPS', () => {
  it('the fields that move with scoreData and component config are the groups, and nothing else', async () => {
    const cfg = SERVICES.find((s) => s.id === 'mistral')!
    const ids = cfg.displayComponentIds!
    const store: Record<string, string> = {}
    for (const d of ['2026-08-30', '2026-08-31']) {
      store[`history:${d}`] = JSON.stringify({
        mistral: {
          ok: 280, total: 288, officialUptime: 99.5,
          components: { [ids[0]]: { ok: 280, total: 288, name: 'A' }, [ids[1]]: { ok: 288, total: 288, name: 'B' } },
        },
      })
    }
    const kv = {
      get: async (k: string) => store[k] ?? null,
      put: async () => {}, delete: async () => {},
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    } as unknown as KVNamespace

    const monthDay: ArchiveScoreInput = { id: 'mistral', aiwatchScore: 80, scoreGrade: 'good', scoreConfidence: 'high', uptimeSource: 'official', incidentSourceStale: true }
    const today: ArchiveScoreInput = { id: 'mistral', aiwatchScore: null, scoreGrade: null, scoreConfidence: 'medium', incidentSourceStale: false }

    const a = await buildMonthlyArchive(kv, 2026, 8, [monthDay], undefined, [], [])
    const saved = cfg.displayComponentIds
    cfg.displayComponentIds = ['not-a-component-id']
    let b: MonthlyArchive
    try {
      b = await buildMonthlyArchive(kv, 2026, 8, [today], undefined, [], [])
    } finally {
      cfg.displayComponentIds = saved
    }

    const before = a.services.mistral as unknown as Record<string, unknown>
    const after = b.services.mistral as unknown as Record<string, unknown>
    const moved = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
      .sort()
    expect(moved).toEqual([...new Set(BUILD_DAY_FIELD_GROUPS.flat())].sort())
  })
})
