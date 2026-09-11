import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseCloudflareStatusSummary } from '../parsers/cloudflare-status'
import { fetchService, mergeRetainedIncidentHistory, retainMigratedIncidentHistory, SERVICES } from '../services'
import { calculateAIWatchScore } from '../score'
import { PROBE_TARGETS } from '../probe'
import type { ServiceStatus } from '../types'

const REPLICATE = 'fvgfcmy66tdr'
const replicate = SERVICES.find((service) => service.id === 'replicate')!

function summary(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    result: {
      components: [{ id: REPLICATE, name: 'Replicate', status: 'operational' }],
      active_incidents: [],
      ...overrides,
    },
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('#1384 Cloudflare Status v3 parser', () => {
  it('uses the declared component status and only active incidents explicitly attached to it', () => {
    const parsed = parseCloudflareStatusSummary(summary({
      components: [{ id: REPLICATE, name: 'Replicate', status: 'degraded_performance' }],
      active_incidents: [
        {
          id: 'ours', name: 'Replicate API errors', status: 'identified', impact: 'major',
          created_at: '2026-09-10T01:00:00.000Z', starts_at: '2026-09-10T01:00:00.000Z',
          components: [{ id: REPLICATE, name: 'Replicate' }],
          last_update: { status: 'identified', message: 'Investigating', created_at: '2026-09-10T01:05:00.000Z' },
        },
        {
          // This is the real migration trap: a global Cloudflare incident can mention Replicate in
          // prose while carrying no Replicate component. It must never land on this service card.
          id: 'not-ours', name: 'Replicate elevated error rate', status: 'identified', impact: 'minor',
          created_at: '2026-09-10T01:00:00.000Z', components: [],
        },
      ],
    }), [REPLICATE])

    expect(parsed).toMatchObject({ ok: true })
    if (!parsed.ok) return
    expect(parsed.summary.status).toBe('degraded')
    expect(parsed.summary.incidents).toHaveLength(1)
    expect(parsed.summary.incidents[0]).toMatchObject({
      id: 'cloudflare:ours', title: 'Replicate API errors', impact: 'major',
      componentIds: [REPLICATE], componentNames: ['Replicate'],
    })
  })

  it('rejects a success envelope when the configured component disappears', () => {
    expect(parseCloudflareStatusSummary(summary({ components: [] }), [REPLICATE]))
      .toEqual({ ok: false, reason: 'cloudflare-component-missing' })
  })

  it('rejects an unknown component vocabulary instead of treating it as operational', () => {
    expect(parseCloudflareStatusSummary(summary({
      components: [{ id: REPLICATE, name: 'Replicate', status: 'new-unrecognized-state' }],
    }), [REPLICATE])).toEqual({ ok: false, reason: 'cloudflare-component-status-unreadable' })
  })
})

describe('#1384 Cloudflare Status v3 Worker wiring', () => {
  it('publishes current component health without manufacturing uptime', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(summary({
      components: [{ id: REPLICATE, name: 'Replicate', status: 'under_maintenance' }],
    })), { status: 200 })))

    const service = await fetchService(replicate, undefined, undefined, {})
    expect(service.status).toBe('degraded')
    expect(service.incidents).toEqual([])
    expect(service.uptime30d).toBeNull()
    expect(service.incidentSourceStale).toBeUndefined()
  })

  it('keeps Replicate scoreable from its existing direct-probe summary after the source migration', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(summary()), { status: 200 })))

    const service = await fetchService(replicate, undefined, undefined, {})
    expect(PROBE_TARGETS.some((target) => target.id === 'replicate')).toBe(true)
    const score = calculateAIWatchScore(service, 30, {
      // Existing production summary observed during the migration verification.
      // The source move must not reset this valid direct-probe history.
      kind: 'available', summary: { p50: 307, p95: 503, cvCombined: 0.52, validDays: 7 },
    })

    expect(score).toMatchObject({ score: 80, confidence: 'medium' })
    expect(score.metrics.uptimePct).toBeNull()
  })

  it('retains recent pre-migration incidents for the live score and is-down consumers', () => {
    const legacy = {
      id: 'legacy-replicate-incident', title: 'Limited H100 capacity', startedAt: '2026-08-20T00:00:00.000Z',
      resolvedAt: '2026-08-20T01:30:00.000Z', durationMin: 90, finalStatus: 'resolved' as const, impact: 'major' as const,
    }
    const tooOld = { ...legacy, id: 'too-old', startedAt: '2026-08-01T00:00:00.000Z' }
    const live = [{
      id: 'cloudflare:active', title: 'Current Replicate incident', status: 'investigating' as const, impact: 'minor' as const,
      startedAt: '2026-09-10T00:00:00.000Z', resolvedAt: null, duration: null, timeline: [],
    }]

    const incidents = mergeRetainedIncidentHistory(live, [legacy, tooOld], '2026-08-12T00:00:00.000Z')

    expect(incidents.map((incident) => incident.id)).toEqual(['cloudflare:active', 'legacy-replicate-incident'])
    expect(incidents.find((incident) => incident.id === legacy.id)).toMatchObject({ duration: '1h 30m', status: 'resolved' })
    const score = calculateAIWatchScore({
      id: 'replicate', name: 'Replicate', provider: 'Replicate', category: 'api', status: 'operational', latency: null,
      uptime30d: null, lastChecked: '2026-09-11T00:00:00.000Z', incidents,
    }, 30, { kind: 'available', summary: { p50: 307, p95: 503, cvCombined: 0.52, validDays: 7 } }, {
      startISO: '2026-08-12T00:00:00.000Z', endISO: '2026-09-12T00:00:00.000Z',
    })
    expect(score.metrics.affectedDays30d).toBe(2)
    expect(score.breakdown.incidents).toBeLessThan(25)
    expect(score.breakdown.recovery).toBeLessThan(15)
  })

  it('loads the prior archive plus current accumulator during Replicate’s finite migration bridge', async () => {
    const prior = {
      period: '2026-08', services: { replicate: { incidentList: [{
        id: 'august', title: 'August outage', startedAt: '2026-08-20T00:00:00.000Z', resolvedAt: null,
        durationMin: 0, finalStatus: 'monitoring', impact: 'minor',
      }] } },
    }
    const current = { lastUpdated: '2026-09-11T00:00:00.000Z', services: { replicate: { incidents: [{
      id: 'september', title: 'September outage', startedAt: '2026-09-05T00:00:00.000Z', resolvedAt: null,
      durationMin: 0, finalStatus: 'investigating', impact: 'major',
    }] } } }
    const kv = { get: vi.fn(async (key: string) => {
      if (key === 'archive:monthly:2026-08') return JSON.stringify(prior)
      if (key === 'incidents:monthly:2026-09') return JSON.stringify(current)
      return null
    }) }
    const services: ServiceStatus[] = [{
      id: 'replicate', name: 'Replicate', provider: 'Replicate', category: 'api' as const, status: 'operational' as const,
      latency: null, uptime30d: null, lastChecked: '2026-09-11T00:00:00.000Z', incidents: [],
    }]

    await retainMigratedIncidentHistory(services, kv as unknown as KVNamespace, new Date('2026-09-11T00:00:00.000Z'))

    expect(kv.get).toHaveBeenCalledWith('archive:monthly:2026-08')
    expect(kv.get).toHaveBeenCalledWith('incidents:monthly:2026-09')
    expect(services[0].incidents.map((incident) => incident.id)).toEqual(['september', 'august'])
  })

  it('marks an unreadable v3 response stale after the shared failure threshold', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true, result: {} }), { status: 200 })))
    const tracking = {}
    await fetchService(replicate, undefined, undefined, tracking)
    await fetchService(replicate, undefined, undefined, tracking)
    const service = await fetchService(replicate, undefined, undefined, tracking)

    expect(service).toMatchObject({ status: 'unknown', sourceUnknown: true, incidentSourceStale: true })
    expect(service.uptime30d).toBeNull()
  })
})
