// #375 — archive supplement for the Incidents filter. These tests pin the
// live-wins-on-collision contract and the period→months mapping. (#587 retired the
// "7d/30d are live-only" gate — short-window RSS services like Azure/Bedrock surface
// only ~5d of live incidents, so every period now fetches the months its window spans.)

import { describe, it, expect } from 'vitest'
import {
  archiveMonthsForPeriod,
  archiveIncidentToLive,
  mergeArchiveIntoMap,
  archiveSupplementForService,
  isWithinPeriod,
  MAX_ARCHIVE_MONTHS,
} from '../archiveMerge'

describe('archiveMonthsForPeriod', () => {
  it('fetches the window-spanning months for 7d/30d too (#587 — short-window services need backfill)', () => {
    const now = new Date('2026-05-09T12:00:00Z')
    expect(archiveMonthsForPeriod(7, now)).toEqual(['2026-05'])             // current month only
    expect(archiveMonthsForPeriod(30, now)).toEqual(['2026-04', '2026-05']) // prev + current
  })

  it('returns empty only when there is no period (0/null = live-only, no fetch)', () => {
    const now = new Date('2026-05-09T12:00:00Z')
    expect(archiveMonthsForPeriod(0, now)).toEqual([])
    expect(archiveMonthsForPeriod(null, now)).toEqual([])
  })

  it('returns prev 3 months + current for 90d on 2026-05-09 (#587)', () => {
    const now = new Date('2026-05-09T12:00:00Z')
    expect(archiveMonthsForPeriod(90, now)).toEqual(['2026-02', '2026-03', '2026-04', '2026-05'])
  })

  it('crosses year boundary correctly (90d on 2026-02-15 → Nov/Dec/Jan/Feb)', () => {
    const now = new Date('2026-02-15T12:00:00Z')
    expect(archiveMonthsForPeriod(90, now)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02'])
  })

  it('INCLUDES the current month (#587 — partial archive backfills rolled-out incidents)', () => {
    const now = new Date('2026-05-09T12:00:00Z')
    const months = archiveMonthsForPeriod(90, now)
    expect(months).toContain('2026-05')
    expect(months[months.length - 1]).toBe('2026-05') // current month is last
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

  it('formats a resolved entry\'s durationMin into a duration string (not the "Ongoing" placeholder)', () => {
    expect(archiveIncidentToLive(archIncident, service).duration).toBe('1h 30m') // 90 min
    expect(archiveIncidentToLive({ ...archIncident, durationMin: 9 }, service).duration).toBe('9m')
  })

  it('attaches fromArchive: true so the consumer can disable timeline-dependent UI', () => {
    const live = archiveIncidentToLive(archIncident, service)
    expect(live.fromArchive).toBe(true)
    expect(live.timeline).toEqual([])
  })

  it('handles archive entries that never resolved (resolvedAt === null) — duration stays undefined → "Ongoing"', () => {
    const live = archiveIncidentToLive({ ...archIncident, resolvedAt: null, finalStatus: 'investigating' }, service)
    expect(live.resolvedAt).toBeNull()
    expect(live.duration).toBeUndefined()
    expect(live.status).toBe('investigating') // carried through; the locale key renders it as "In Progress"
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

  it('#587 current-month partial archive: a live + partial-archive incident sharing one raw id renders once (live wins)', () => {
    // The invariant that makes "include the current month" safe: an active current-month incident is
    // in BOTH live /api/status AND the partial archive (synthesized from incidents:monthly). They
    // share the raw upstream id, so the merge must collapse them to one card with live's fields.
    const liveMap = new Map([
      ['aws-bedrock-1', {
        id: 'bedrock:aws-bedrock-1', title: 'Service impact: Fable 5 and Mythos 5 Access',
        status: 'ongoing', startedAt: '2026-06-13T01:26:00Z',
        timeline: [{ stage: 'investigating', at: '2026-06-13T01:26:00Z' }],
        serviceId: 'bedrock', serviceName: 'Amazon Bedrock', affectedNames: ['Amazon Bedrock'], fromArchive: undefined,
      }],
    ])
    // Shaped exactly as buildPartialIncidentArchive emits (partial: true, services[id].incidentList).
    const partial = { period: '2026-06', partial: true, services: {
      bedrock: { incidentList: [{ id: 'aws-bedrock-1', title: 'Service impact: Fable 5 and Mythos 5 Access', startedAt: '2026-06-13T01:26:00Z', resolvedAt: null, durationMin: 0, finalStatus: 'investigating' }] },
    } }
    const svcs = [{ id: 'bedrock', name: 'Amazon Bedrock' }]
    mergeArchiveIntoMap(liveMap, { '2026-06': partial }, svcs)
    expect(liveMap.size).toBe(1) // no duplicate card
    const entry = liveMap.get('aws-bedrock-1')
    expect(entry.status).toBe('ongoing')           // live timeline/status wins
    expect(entry.timeline).toHaveLength(1)
    expect(entry.affectedNames).toEqual(['Amazon Bedrock'])
  })

  it('#587 skips frozen investigating/identified archive entries but surfaces resolved + monitoring', () => {
    // investigating/identified have no STATUS_BADGE_CLASS → green-fallback "In Progress" phantom if a
    // frozen archive-only entry rendered. resolved (green) + monitoring (amber, impact ended) have a
    // defined badge + real duration → surfaced. A truly-active incident is shown by live instead.
    const liveMap = new Map()
    const archives = { '2026-06': { services: { modal: { incidentList: [
      { id: 'frozen-1', title: 'Web endpoints is down', startedAt: '2026-06-13T01:00:00Z', resolvedAt: null, durationMin: 0, finalStatus: 'investigating' },
      { id: 'frozen-2', title: 'cause identified', startedAt: '2026-06-12T01:00:00Z', resolvedAt: null, durationMin: 0, finalStatus: 'identified' },
      { id: 'monitor-1', title: 'mitigation deployed', startedAt: '2026-06-11T01:00:00Z', resolvedAt: '2026-06-11T01:30:00Z', durationMin: 30, finalStatus: 'monitoring' },
      { id: 'done-1', title: 'Image builds recovered', startedAt: '2026-06-10T01:00:00Z', resolvedAt: '2026-06-10T02:00:00Z', durationMin: 60, finalStatus: 'resolved' },
    ] } } } }
    mergeArchiveIntoMap(liveMap, archives, [{ id: 'modal', name: 'Modal' }])
    expect(liveMap.has('frozen-1')).toBe(false) // investigating → skipped
    expect(liveMap.has('frozen-2')).toBe(false) // identified → skipped
    expect(liveMap.has('monitor-1')).toBe(true) // monitoring → surfaced (amber badge, real duration)
    expect(liveMap.get('monitor-1').duration).toBe('30m')
    expect(liveMap.has('done-1')).toBe(true)    // resolved → surfaced
    expect(liveMap.get('done-1').duration).toBe('1h 0m')
  })

  it('#587 a NON-resolved archive entry that COLLIDES with a live incident still merges affectedNames (collision check precedes the skip)', () => {
    // The skip runs AFTER the live-collision check, so a still-active incident present in BOTH live
    // and the partial archive (under different services sharing one id) accumulates the archive's
    // service name onto the live card rather than being dropped.
    const liveMap = new Map([
      ['shared-x', { id: 'claude:shared-x', title: 'live', status: 'ongoing', startedAt: '2026-06-13T00:00:00Z', timeline: [], serviceId: 'claude', serviceName: 'Claude API', affectedNames: ['Claude API'], fromArchive: undefined }],
    ])
    const archives = { '2026-06': { services: { claudeai: { incidentList: [
      { id: 'shared-x', title: 'archive snapshot', startedAt: '2026-06-13T00:00:00Z', resolvedAt: null, durationMin: 0, finalStatus: 'investigating' },
    ] } } } }
    mergeArchiveIntoMap(liveMap, archives, services)
    expect(liveMap.size).toBe(1)
    expect(liveMap.get('shared-x').affectedNames).toEqual(['Claude API', 'claude.ai'])
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

  it('skips an estimate-only filtered service (#375 — Bedrock/Azure: archive entry has no incidentList)', () => {
    // Symmetric to the no-filter mode's estimate-only test: a user selecting an estimate-only service
    // in the 90d Incidents view must get nothing from the archive. These services carry no incidents,
    // so their archive entry omits incidentList — current (live-only) behavior stays unchanged.
    const svcs = [...services, { id: 'bedrock', name: 'Amazon Bedrock' }]
    const liveCompositeIds = new Set()
    const archives = {
      '2026-04': { services: { bedrock: { uptime: null, score: 92 /* estimate-only — no incidentList */ } } },
    }
    expect(archiveSupplementForService(liveCompositeIds, 'bedrock', archives, svcs)).toEqual([])
    expect(liveCompositeIds.size).toBe(0) // nothing added to the dedup set either
  })

  it('does not throw when an archive month is null (404 path)', () => {
    const liveCompositeIds = new Set()
    const archives = { '2026-04': null }
    expect(() => archiveSupplementForService(liveCompositeIds, 'mistral', archives, services)).not.toThrow()
  })
})

describe('isWithinPeriod (#587 — age out stale archive ongoing)', () => {
  const cutoff = new Date('2026-06-10T00:00:00Z').getTime() // 90d lower bound
  const old = '2026-03-01T00:00:00Z'   // before cutoff
  const fresh = '2026-06-12T00:00:00Z' // after cutoff

  it('shows everything when there is no cutoff (period = null/0)', () => {
    expect(isWithinPeriod({ status: 'resolved', startedAt: old, fromArchive: true }, null)).toBe(true)
    expect(isWithinPeriod({ status: 'ongoing', startedAt: old, fromArchive: true }, 0)).toBe(true)
  })

  it('always shows a LIVE ongoing incident even when older than the cutoff', () => {
    expect(isWithinPeriod({ status: 'ongoing', startedAt: old, fromArchive: undefined }, cutoff)).toBe(true)
  })

  it('AGES OUT an archive-sourced non-resolved incident older than the cutoff (the #587 fix)', () => {
    expect(isWithinPeriod({ status: 'ongoing', startedAt: old, fromArchive: true }, cutoff)).toBe(false)
  })

  it('keeps an archive non-resolved incident that is still within the window', () => {
    expect(isWithinPeriod({ status: 'ongoing', startedAt: fresh, fromArchive: true }, cutoff)).toBe(true)
  })

  it('ages out resolved incidents by startedAt regardless of source (unchanged)', () => {
    expect(isWithinPeriod({ status: 'resolved', startedAt: old, fromArchive: true }, cutoff)).toBe(false)
    expect(isWithinPeriod({ status: 'resolved', startedAt: old, fromArchive: undefined }, cutoff)).toBe(false)
    expect(isWithinPeriod({ status: 'resolved', startedAt: fresh, fromArchive: false }, cutoff)).toBe(true)
  })
})
