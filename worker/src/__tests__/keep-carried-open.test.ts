import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchService, attachRecordedIncidentHistory, filterByComponentStatus, SERVICES } from '../services'
import { buildIncidentAlerts } from '../alerts'
import { accumulateMonthlyIncidents, type MonthlyIncidents, type MonthlyIncidentEntry } from '../monthly-archive'
import type { Incident, ServiceConfig, ServiceStatus } from '../types'

const cfg = (id: string): ServiceConfig => {
  const c = SERVICES.find((s) => s.id === id)
  if (!c) throw new Error(`missing SERVICES config: ${id}`)
  return c
}

// #1922 — status.twelvelabs.io as served on 2026-11-05 (same shape as the #1920 fixture): `rykft5zs0sng`
// still `identified`, its components back to `operational`, alerted while they were degraded.
const component = (id: string, name: string, groupId: string | null, group = false) => ({
  id, name, status: 'operational', created_at: '2026-07-01T00:00:00.000Z', updated_at: '2026-11-05T02:46:45.000Z',
  position: 1, description: null, showcase: true, start_date: null, group_id: groupId, page_id: '5j9dmpdjtybc', group,
  only_show_if_degraded: false,
})
const COMPONENTS = [
  component('mvv53x91b74m', 'APIs', null, true),
  component('28vf3d4r3tjg', 'Jockey', null, true),
  component('jnvb5r3v74q1', 'Video Indexing Task API - Marengo3.0', 'mvv53x91b74m'),
  component('hr353rqqmwmk', 'Embed API - Marengo3.0 - Async', 'mvv53x91b74m'),
  component('p1hx7t867896', 'Analyze API', 'mvv53x91b74m'),
]
const OPEN = {
  id: 'rykft5zs0sng', name: 'Slower processing for Marengo 3.0 and Marengo 3.5', status: 'identified', impact: 'minor',
  created_at: '2026-11-04T17:41:30.842-08:00', updated_at: '2026-11-04T18:46:45.411-08:00', started_at: '2026-11-04T17:41:30.827-08:00',
  monitoring_at: null, resolved_at: null, shortlink: 'https://stspg.io/6rl9bj4qw74c', page_id: '5j9dmpdjtybc',
  components: COMPONENTS.filter((c) => c.id === 'jnvb5r3v74q1' || c.id === 'hr353rqqmwmk'),
  incident_updates: [{
    id: 'q7hy9z7r8cv4', status: 'identified', body: 'Since November 4, Marengo 3.0 video indexing and embedding have been slower than usual.',
    incident_id: 'rykft5zs0sng', created_at: '2026-11-04T17:41:30.998-08:00', updated_at: '2026-11-04T17:41:30.998-08:00', display_at: '2026-11-04T17:41:30.998-08:00',
    affected_components: [
      { code: 'jnvb5r3v74q1', name: 'APIs - Video Indexing Task API - Marengo3.0', old_status: 'operational', new_status: 'degraded_performance' },
      { code: 'hr353rqqmwmk', name: 'APIs - Embed API - Marengo3.0 - Async', old_status: 'operational', new_status: 'degraded_performance' },
    ],
  }],
}
const OLDER_RESOLVED = {
  id: 'bq8z4lpz46gk', name: 'Some API features are experiencing issues', status: 'resolved', impact: 'minor',
  created_at: '2026-11-04T02:57:00.079-08:00', updated_at: '2026-11-04T02:57:01.093-08:00', started_at: '2026-11-04T02:57:00.079-08:00',
  monitoring_at: null, resolved_at: '2026-11-04T02:57:01.093-08:00', shortlink: 'https://stspg.io/x', page_id: '5j9dmpdjtybc',
  components: COMPONENTS.filter((c) => c.id === 'p1hx7t867896'),
  incident_updates: [{
    id: 'u1', status: 'resolved', body: 'Resolved.', incident_id: 'bq8z4lpz46gk',
    created_at: '2026-11-04T02:57:01.093-08:00', updated_at: '2026-11-04T02:57:01.093-08:00', display_at: '2026-11-04T02:57:01.093-08:00',
    affected_components: [{ code: 'p1hx7t867896', name: 'APIs - Analyze API', old_status: 'degraded_performance', new_status: 'operational' }],
  }],
}

const PLAYGROUND = component('29c68cnyd14l', 'Playground', null)
const PLAYGROUND_OPEN = {
  ...OPEN, id: 'pg0open00001', name: 'Playground uploads slow', components: [PLAYGROUND],
  incident_updates: [{ ...OPEN.incident_updates[0], id: 'pgu1', incident_id: 'pg0open00001',
    affected_components: [{ code: '29c68cnyd14l', name: 'Playground', old_status: 'operational', new_status: 'degraded_performance' }] }],
}

const fetchTwelveLabs = (extra: unknown[] = []) => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const incidents = [OPEN, ...extra, OLDER_RESOLVED]
  return fetchService(cfg('twelvelabs'), {
    summary: { status: { indicator: 'none', description: 'All Systems Operational' }, components: [...COMPONENTS, PLAYGROUND], incidents: [] } as never,
    incidents: { incidents } as never,
  } as never, undefined, {})
}


const accumulator = (resolvedAt: string | null, finalStatus: MonthlyIncidentEntry['finalStatus'] = resolvedAt ? 'resolved' : 'identified', ids = ['rykft5zs0sng']): MonthlyIncidents => {
  const rows = ids.map((id) => ({
    id, title: OPEN.name, startedAt: '2026-11-05T01:41:30.842Z', durationMin: resolvedAt ? 60 : 0,
    finalStatus, resolvedAt, impact: 'minor',
  }) as MonthlyIncidentEntry)
  return {
    lastUpdated: '2026-11-05T01:50:00.000Z',
    services: {
      twelvelabs: { count: rows.length, totalMinutes: 0, longestMinutes: 0, dates: ['2026-11-05'], incidentIds: ids, durations: Object.fromEntries(ids.map((id) => [id, 0])), incidents: rows },
    },
  } as MonthlyIncidents
}

const kvWith = (acc: MonthlyIncidents | null) => ({
  get: vi.fn(async (key: string) => (key === 'incidents:monthly:2026-11' && acc ? JSON.stringify(acc) : null)),
}) as unknown as KVNamespace

const NOW = new Date('2026-11-05T06:00:00.000Z')

describe('#1922 keep a carried, still-open incident after its component recovers', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('the operational component gate hands the dropped twelvelabs incident to the post-fetch step', async () => {
    const svc = await fetchTwelveLabs()
    expect(svc.incidents.map((i) => i.id)).not.toContain('rykft5zs0sng')
    expect(svc.componentGateDropped?.map((i) => i.id)).toEqual(['rykft5zs0sng'])
  })

  it('puts it back on the card when this month\'s record holds it open', async () => {
    const svc = await fetchTwelveLabs()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await attachRecordedIncidentHistory([svc], kvWith(accumulator(null)), NOW)
    const kept = svc.incidents.find((i) => i.id === 'rykft5zs0sng')
    expect(kept?.status).toBe('identified')
    expect(kept?.keptAfterComponentRecovery).toBe(true)
    expect(kept?.startedAt).toBe('2026-11-05T01:41:30.842Z')
    expect(svc.incidents.map((i) => i.id)).toEqual(['rykft5zs0sng', 'bq8z4lpz46gk'])
    expect(svc.componentGateDropped).toBeUndefined()
  })

  it('keeps an incident we never carried off the card (#228: judged not ours from its first cycle)', async () => {
    const svc = await fetchTwelveLabs()
    await attachRecordedIncidentHistory([svc], kvWith(null), NOW)
    expect(svc.incidents.map((i) => i.id)).not.toContain('rykft5zs0sng')
    expect(svc.componentGateDropped).toBeUndefined()
  })

  it('does not reopen it on the card from a record that already holds it resolved', async () => {
    const svc = await fetchTwelveLabs()
    await attachRecordedIncidentHistory([svc], kvWith(accumulator('2026-11-05T02:41:30.842Z')), NOW)
    expect(svc.incidents.map((i) => i.id)).not.toContain('rykft5zs0sng')
  })

  it('reads the row\'s status, not its end time: a row still marked open keeps the incident even with a stray resolvedAt', async () => {
    const svc = await fetchTwelveLabs()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await attachRecordedIncidentHistory([svc], kvWith(accumulator('2026-11-05T02:41:30.842Z', 'identified')), NOW)
    expect(svc.incidents.map((i) => i.id)).toContain('rykft5zs0sng')
  })

  it('does not put a reference-component incident onto the card', async () => {
    const svc = await fetchTwelveLabs([PLAYGROUND_OPEN])
    vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(svc.referenceIncidents?.map((i) => i.id)).toContain('pg0open00001')
    await attachRecordedIncidentHistory([svc], kvWith(accumulator(null, 'identified', ['rykft5zs0sng', 'pg0open00001'])), NOW)
    expect(svc.incidents.map((i) => i.id)).toEqual(['rykft5zs0sng', 'bq8z4lpz46gk'])
  })

  it('drops the transient field when there is no KV to read', async () => {
    const svc = await fetchTwelveLabs()
    await attachRecordedIncidentHistory([svc], undefined, NOW)
    expect(svc.componentGateDropped).toBeUndefined()
    expect(svc.incidents.map((i) => i.id)).not.toContain('rykft5zs0sng')
  })

  it('records the keep on the accumulator row, and the mark survives the incident resolving', async () => {
    const svc = await fetchTwelveLabs()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await attachRecordedIncidentHistory([svc], kvWith(accumulator(null)), NOW)
    const marked = accumulateMonthlyIncidents(accumulator(null), [svc], '2026-11', [])
    expect(marked.services.twelvelabs.incidents?.find((e) => e.id === 'rykft5zs0sng')?.keptAfterComponentRecovery).toBe(true)

    const resolved: ServiceStatus = {
      ...svc,
      incidents: svc.incidents.map((i) => i.id === 'rykft5zs0sng'
        ? { ...i, status: 'resolved' as const, resolvedAt: '2026-11-05T05:00:00.000Z', duration: '3h 18m', keptAfterComponentRecovery: undefined }
        : i),
    }
    const after = accumulateMonthlyIncidents(marked, [resolved], '2026-11', [])
    const row = after.services.twelvelabs.incidents?.find((e) => e.id === 'rykft5zs0sng')
    expect(row?.finalStatus).toBe('resolved')
    expect(row?.keptAfterComponentRecovery).toBe(true)
  })

  it('a fresh accumulator row carries the mark too', async () => {
    const svc = await fetchTwelveLabs()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await attachRecordedIncidentHistory([svc], kvWith(accumulator(null)), NOW)
    const fresh = accumulateMonthlyIncidents(null, [svc], '2026-11', [])
    expect(fresh.services.twelvelabs.incidents?.find((e) => e.id === 'rykft5zs0sng')?.keptAfterComponentRecovery).toBe(true)
  })

  it('an id-scoped service hands over only an incident its id axis could not judge (no componentIds joined)', () => {
    const inc = { id: 'x1', title: 'Sibling outage', status: 'identified', impact: 'minor', startedAt: '2026-11-05T01:00:00.000Z', componentIds: ['sibling'] } as Incident
    const base = { id: 't', statusComponentId: 'ours', statusComponentIds: ['ours'] } as ServiceConfig
    const comps = [{ id: 'ours', name: 'Ours' }, { id: 'sibling', name: 'Sibling' }]
    const plain: Incident[] = []
    expect(filterByComponentStatus([inc], 'operational', base, comps, (i) => plain.push(i))).toEqual([])
    expect(plain.map((i) => i.id)).toEqual(['x1'])
    const idScoped: Incident[] = []
    expect(filterByComponentStatus([inc], 'operational', { ...base, incidentIoComponentId: 'ours', incidentExclude: ['zzz'] }, comps, (i) => idScoped.push(i))).toEqual([])
    expect(idScoped).toEqual([])
    const unjoined: Incident[] = []
    const { componentIds: _ids, ...noJoin } = inc
    filterByComponentStatus([noJoin as Incident], 'operational', { ...base, incidentIoComponentId: 'ours', incidentExclude: ['zzz'] }, comps, (i) => unjoined.push(i))
    expect(unjoined.map((i) => i.id)).toEqual(['x1'])
  })

  it('does not keep on last month\'s record alone, which this month\'s accumulator could not mark', async () => {
    const svc = await fetchTwelveLabs()
    const kv = { get: vi.fn(async (key: string) => (key === 'incidents:monthly:2026-11' ? JSON.stringify(accumulator(null)) : null)) } as unknown as KVNamespace
    await attachRecordedIncidentHistory([svc], kv, new Date('2026-12-02T06:00:00.000Z'))
    expect(svc.incidents.map((i) => i.id)).not.toContain('rykft5zs0sng')
  })

  it('a kept incident gets the same title tagging as the rest of the card', async () => {
    const svc = await fetchTwelveLabs([{ ...OPEN, id: 'am0open00001', name: 'Some API features are experiencing issues',
      incident_updates: [{ ...OPEN.incident_updates[0], id: 'amu1', incident_id: 'am0open00001' }] }])
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await attachRecordedIncidentHistory([svc], kvWith(accumulator(null, 'identified', ['rykft5zs0sng', 'am0open00001'])), NOW)
    expect(svc.incidents.find((i) => i.id === 'am0open00001')?.autoMonitor).toBe(true)
  })

  it('a kept incident opens no new alert: one first seen at monitoring while operational stays unalerted, as on main', async () => {
    const svc = await fetchTwelveLabs()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await attachRecordedIncidentHistory([svc], kvWith(accumulator(null, 'monitoring')), NOW)
    expect(svc.incidents.map((i) => i.id)).toContain('rykft5zs0sng')
    const alerts = buildIncidentAlerts([svc] as never, new Map(), NOW.getTime())
    expect(alerts.filter((a) => JSON.stringify(a).includes('rykft5zs0sng'))).toEqual([])
  })
})
