import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchService, SERVICES } from '../services'
import { prunePhantomIncidents, accumulateMonthlyIncidents, PHANTOM_PRUNE_AFTER_MISSED_RUNS, type MonthlyIncidents, type MonthlyIncidentEntry } from '../monthly-archive'
import type { ServiceConfig, ServiceStatus } from '../types'

const cfg = (id: string): ServiceConfig => {
  const c = SERVICES.find((s) => s.id === id)
  if (!c) throw new Error(`missing SERVICES config: ${id}`)
  return c
}

// #1920 — status.twelvelabs.io as served on 2026-11-05: `rykft5zs0sng` still `identified`, both of its
// components back to `operational`. Announced as withdrawn at 02:05Z while it stayed on the page.
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

const fetchTwelveLabs = () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const incidents = [OPEN, OLDER_RESOLVED]
  return fetchService(cfg('twelvelabs'), {
    summary: { status: { indicator: 'none', description: 'All Systems Operational' }, components: COMPONENTS, incidents: [] } as never,
    incidents: { incidents } as never,
  } as never, undefined, {})
}

const accumulatorWithOpenRow = (): MonthlyIncidents => {
  const row: MonthlyIncidentEntry = {
    id: 'rykft5zs0sng', title: OPEN.name, startedAt: '2026-11-05T01:41:30.842Z', durationMin: 0, finalStatus: 'identified',
    resolvedAt: null, impact: 'minor',
  } as MonthlyIncidentEntry
  return {
    lastUpdated: '2026-11-05T01:50:00.000Z',
    services: {
      twelvelabs: { count: 1, totalMinutes: 0, longestMinutes: 0, dates: ['2026-11-05'], incidentIds: [row.id], durations: { [row.id]: 0 }, incidents: [row] },
    },
  } as MonthlyIncidents
}

const runPrune = (svc: ServiceStatus): MonthlyIncidents => {
  let data = accumulatorWithOpenRow()
  for (let i = 0; i < PHANTOM_PRUNE_AFTER_MISSED_RUNS + 2; i++) data = prunePhantomIncidents(data, [svc], [])
  return data
}

describe('#1920 an incident our filters keep off the card is still on the provider page', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('the open incident is off the card, and its id is carried as still upstream', async () => {
    const svc = await fetchTwelveLabs()
    expect([...svc.incidents, ...(svc.referenceIncidents ?? [])].map((i) => i.id)).not.toContain('rykft5zs0sng')
    expect(svc.upstreamOnlyIncidentIds).toEqual(['rykft5zs0sng'])
  })

  it('the phantom prune keeps the accumulator row, however many cycles pass', async () => {
    const svc = await fetchTwelveLabs()
    expect(runPrune(svc).services.twelvelabs.incidents!.map((e) => e.id)).toEqual(['rykft5zs0sng'])
  })

  it('control: the same cycle without the carried ids prunes the row', async () => {
    const { upstreamOnlyIncidentIds: _dropped, ...withoutIds } = await fetchTwelveLabs()
    expect(runPrune(withoutIds as ServiceStatus).services.twelvelabs.incidents).toEqual([])
  })
})

describe('#1920 a shared-page incident re-tagged away from the card, then resolved upstream', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  const comp = (id: string, name: string, status: string) => ({
    id, name, status, created_at: '2026-07-01T00:00:00Z', updated_at: '2026-11-05T00:00:00Z', position: 1, description: null,
    showcase: true, start_date: null, group_id: null, page_id: 'p', group: false, only_show_if_degraded: false,
  })
  const inc = (id: string, status: string, comps: unknown[], start: string, resolved: string | null) => ({
    id, name: id === 'X1' ? 'Elevated errors on requests' : 'Older thing', status, impact: 'minor', created_at: start, updated_at: start,
    started_at: start, monitoring_at: null, resolved_at: resolved, shortlink: `https://stspg.io/${id}`, page_id: 'p', components: comps,
    incident_updates: [{ id: `u${id}${status}`, status, body: 'x', incident_id: id, created_at: start, updated_at: start, display_at: start, affected_components: [] }],
  })
  const fetchClaude = (apiStatus: string, x1: (api: unknown, code: unknown) => unknown) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const API = comp('k8w3r06qmzrp', 'Claude API', apiStatus)
    const CODE = comp('yyzkbfz2thpt', 'Claude Code', 'degraded_performance')
    const older = inc('older1', 'resolved', [API], '2026-11-03T00:00:00Z', '2026-11-03T01:00:00Z')
    return fetchService(cfg('claude'), {
      summary: { status: { indicator: 'minor', description: 'x' }, components: [API, CODE], incidents: [] } as never,
      incidents: { incidents: [x1(API, CODE), older] } as never,
    } as never, undefined, {})
  }

  it('does not leave the row open once the provider resolves it', async () => {
    const c1 = await fetchClaude('degraded_performance', () => inc('X1', 'investigating', [], '2026-11-05T00:00:00Z', null))
    expect(c1.incidents.map((i) => i.id)).toContain('X1')
    let data = accumulateMonthlyIncidents(null, [c1], '2026-11', [])
    const c3 = await fetchClaude('operational', (_api, code) => inc('X1', 'resolved', [code], '2026-11-05T00:00:00Z', '2026-11-05T03:00:00Z'))
    expect([...c3.incidents, ...(c3.referenceIncidents ?? [])].map((i) => i.id)).not.toContain('X1')
    for (let i = 0; i < PHANTOM_PRUNE_AFTER_MISSED_RUNS + 2; i++) data = prunePhantomIncidents(data, [c3], [])
    data = accumulateMonthlyIncidents(data, [c3], '2026-11', [])
    const open = (data.services.claude?.incidents ?? []).filter((e) => e.finalStatus !== 'resolved').map((e) => e.id)
    expect(open).toEqual([])
  })
})
