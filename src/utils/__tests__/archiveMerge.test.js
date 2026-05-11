// #375 — archive supplement for the 90d Incidents filter.
// These tests pin the live-wins-on-collision contract and the period-gating —
// 7d/30d must not trigger archive fetches (their windows are smaller than the
// upstream cap of every service we care about).

import { describe, it, expect } from 'vitest'
import {
  archiveMonthsForPeriod,
  archiveIncidentToLive,
  mergeArchiveIntoMap,
  archiveSupplementForService,
  MAX_ARCHIVE_MONTHS,
} from '../archiveMerge'

describe('archiveMonthsForPeriod', () => {
  it('returns empty for short windows that live data already covers', () => {
    const now = new Date('2026-05-09T12:00:00Z')
    expect(archiveMonthsForPeriod(7, now)).toEqual([])
    expect(archiveMonthsForPeriod(30, now)).toEqual([])
  })

  it('returns prev 3 months for 90d on 2026-05-09', () => {
    const now = new Date('2026-05-09T12:00:00Z')
    expect(archiveMonthsForPeriod(90, now)).toEqual(['2026-02', '2026-03', '2026-04'])
  })

  it('crosses year boundary correctly (90d on 2026-02-15 → Nov/Dec/Jan)', () => {
    const now = new Date('2026-02-15T12:00:00Z')
    expect(archiveMonthsForPeriod(90, now)).toEqual(['2025-11', '2025-12', '2026-01'])
  })

  it('excludes the current month from the fetch list (live covers it)', () => {
    const now = new Date('2026-05-09T12:00:00Z')
    const months = archiveMonthsForPeriod(90, now)
    expect(months).not.toContain('2026-05')
  })

  it(`caps at MAX_ARCHIVE_MONTHS (${MAX_ARCHIVE_MONTHS}) for ultra-long windows`, () => {
    const now = new Date('2026-12-15T12:00:00Z')
    // 365d would otherwise span 12 months — cap protects us from accidental config drift
    const months = archiveMonthsForPeriod(365, now)
    expect(months.length).toBeLessThanOrEqual(MAX_ARCHIVE_MONTHS)
  })
})

describe('archiveIncidentToLive', () => {
  const archIncident = {
    id: '01ABC',
    title: 'Mistral La Plateforme degraded',
    startedAt: '2026-04-12T10:00:00Z',
    resolvedAt: '2026-04-12T11:30:00Z',
    durationMin: 90,
    finalStatus: 'resolved',
  }
  const service = { id: 'mistral', name: 'Mistral API' }

  it('preserves identity fields and uses the archive\'s finalStatus', () => {
    const live = archiveIncidentToLive(archIncident, service)
    expect(live.id).toBe('01ABC')
    expect(live.title).toBe('Mistral La Plateforme degraded')
    expect(live.status).toBe('resolved')
    expect(live.startedAt).toBe('2026-04-12T10:00:00Z')
    expect(live.resolvedAt).toBe('2026-04-12T11:30:00Z')
    expect(live.serviceId).toBe('mistral')
    expect(live.serviceName).toBe('Mistral API')
  })

  it('attaches fromArchive: true so the consumer can disable timeline-dependent UI', () => {
    const live = archiveIncidentToLive(archIncident, service)
    expect(live.fromArchive).toBe(true)
    expect(live.timeline).toEqual([])
  })

  it('handles archive entries that never resolved (resolvedAt === null)', () => {
    const live = archiveIncidentToLive({ ...archIncident, resolvedAt: null, finalStatus: 'monitoring' }, service)
    expect(live.resolvedAt).toBeNull()
    expect(live.status).toBe('monitoring')
  })
})

describe('mergeArchiveIntoMap (no service filter — raw-id dedup mode)', () => {
  const services = [
    { id: 'claude', name: 'Claude API' },
    { id: 'claudeai', name: 'claude.ai' },
    { id: 'mistral', name: 'Mistral API' },
  ]

  function liveMapWith(...entries) {
    return new Map(entries.map((e) => [e.id, { ...e, affectedNames: [...(e.affectedNames || [e.serviceName])] }]))
  }

  it('appends archive-only incidents to the map keyed by raw id', () => {
    const liveMap = liveMapWith()
    const archives = {
      '2026-04': {
        services: {
          mistral: {
            incidentList: [{ id: 'arch-1', title: 'old outage', startedAt: '2026-04-01T00:00:00Z', resolvedAt: '2026-04-01T01:00:00Z', durationMin: 60, finalStatus: 'resolved' }],
          },
        },
      },
    }
    mergeArchiveIntoMap(liveMap, archives, services)
    const entry = liveMap.get('arch-1')
    expect(entry).toBeDefined()
    expect(entry.title).toBe('old outage')
    expect(entry.fromArchive).toBe(true)
    expect(entry.serviceId).toBe('mistral')
    expect(entry.affectedNames).toEqual(['Mistral API'])
  })

  it('does not overwrite live entries — affectedNames accumulates instead', () => {
    // The live entry is a placeholder for "what Incidents.jsx already produced".
    const liveMap = new Map([
      ['shared-1', {
        id: 'claude:shared-1', // composite id as Incidents.jsx writes it
        title: 'live title',
        status: 'ongoing',
        startedAt: '2026-04-30T00:00:00Z',
        timeline: [{ stage: 'investigating', at: '2026-04-30T00:00:00Z' }],
        serviceId: 'claude',
        serviceName: 'Claude API',
        affectedNames: ['Claude API'],
        fromArchive: undefined, // live
      }],
    ])
    const archives = {
      '2026-04': {
        services: {
          claudeai: {
            incidentList: [{ id: 'shared-1', title: 'archive title (stale)', startedAt: '2026-04-30T00:00:00Z', resolvedAt: null, durationMin: 0, finalStatus: 'monitoring' }],
          },
        },
      },
    }
    mergeArchiveIntoMap(liveMap, archives, services)
    const entry = liveMap.get('shared-1')
    // Live wins on title + status + timeline
    expect(entry.title).toBe('live title')
    expect(entry.status).toBe('ongoing')
    expect(entry.timeline).toHaveLength(1)
    // But the archive's service is added to affectedNames
    expect(entry.affectedNames).toEqual(['Claude API', 'claude.ai'])
  })

  it('skips services that have been renamed/removed (archive serviceId not in live list)', () => {
    const liveMap = new Map()
    const archives = {
      '2026-04': {
        services: {
          'unknown-service': {
            incidentList: [{ id: 'orphan-1', title: 'orphan', startedAt: '2026-04-01T00:00:00Z', resolvedAt: null, durationMin: 0, finalStatus: 'resolved' }],
          },
        },
      },
    }
    mergeArchiveIntoMap(liveMap, archives, services)
    expect(liveMap.size).toBe(0)
  })

  it('skips estimate-only services that have no incidentList field', () => {
    // bedrock / azureopenai / pinecone — archive entry exists but incidentList is absent.
    const liveMap = new Map()
    const archives = {
      '2026-04': {
        services: {
          mistral: { /* no incidentList */ uptime: 99.5, score: 88 },
          bedrock: { uptime: null, score: 92 }, // estimate-only — explicitly no incidents
        },
      },
    }
    mergeArchiveIntoMap(liveMap, archives, services)
    expect(liveMap.size).toBe(0)
  })

  it('handles empty incidentList arrays without erroring', () => {
    const liveMap = new Map()
    const archives = { '2026-04': { services: { mistral: { incidentList: [] } } } }
    mergeArchiveIntoMap(liveMap, archives, services)
    expect(liveMap.size).toBe(0)
  })

  it('handles missing archives gracefully (e.g. one of three months 404\'d)', () => {
    const liveMap = new Map()
    const archives = {
      '2026-02': null, // 404 from useMonthlyArchives surfaces as null
      '2026-03': { services: { mistral: { incidentList: [{ id: 'arch-3', title: 'march', startedAt: '2026-03-15T00:00:00Z', resolvedAt: null, durationMin: 0, finalStatus: 'resolved' }] } } },
      '2026-04': undefined,
    }
    expect(() => mergeArchiveIntoMap(liveMap, archives, services)).not.toThrow()
    expect(liveMap.size).toBe(1)
    expect(liveMap.get('arch-3')).toBeDefined()
  })
})

describe('archiveSupplementForService (service filter mode)', () => {
  const services = [
    { id: 'mistral', name: 'Mistral API' },
    { id: 'together', name: 'Together AI' },
  ]

  it('returns only the filtered service, with composite ids assigned', () => {
    const liveCompositeIds = new Set(['mistral:live-only-1'])
    const archives = {
      '2026-04': {
        services: {
          mistral: {
            incidentList: [
              { id: 'arch-m-1', title: 'mistral old', startedAt: '2026-04-01T00:00:00Z', resolvedAt: '2026-04-01T01:00:00Z', durationMin: 60, finalStatus: 'resolved' },
            ],
          },
          together: {
            incidentList: [
              { id: 'arch-t-1', title: 'together old', startedAt: '2026-04-02T00:00:00Z', resolvedAt: '2026-04-02T01:00:00Z', durationMin: 60, finalStatus: 'resolved' },
            ],
          },
        },
      },
    }
    const result = archiveSupplementForService(liveCompositeIds, 'mistral', archives, services)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('mistral:arch-m-1')
    expect(result[0].title).toBe('mistral old')
    // The Set must have been updated so a subsequent month doesn't double-add the same id
    expect(liveCompositeIds.has('mistral:arch-m-1')).toBe(true)
  })

  it('skips archive entries whose composite id matches a live one', () => {
    const liveCompositeIds = new Set(['mistral:dup-1'])
    const archives = {
      '2026-04': { services: { mistral: { incidentList: [{ id: 'dup-1', title: 'dup', startedAt: '2026-04-01T00:00:00Z', resolvedAt: null, durationMin: 0, finalStatus: 'resolved' }] } } },
    }
    const result = archiveSupplementForService(liveCompositeIds, 'mistral', archives, services)
    expect(result).toHaveLength(0)
  })

  it('returns empty when filtered service has no archive entry', () => {
    const liveCompositeIds = new Set()
    const archives = { '2026-04': { services: { together: { incidentList: [{ id: 't', title: 't', startedAt: '2026-04-01T00:00:00Z', resolvedAt: null, durationMin: 0, finalStatus: 'resolved' }] } } } }
    expect(archiveSupplementForService(liveCompositeIds, 'mistral', archives, services)).toEqual([])
  })

  it('does not throw when an archive month is null (404 path)', () => {
    const liveCompositeIds = new Set()
    const archives = { '2026-04': null }
    expect(() => archiveSupplementForService(liveCompositeIds, 'mistral', archives, services)).not.toThrow()
  })
})
