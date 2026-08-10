import { describe, it, expect, vi, afterEach } from 'vitest'
import { isAutoMonitorIncident, tagAutoMonitorIncidents, filterIncidents, fetchService, SERVICES } from '../services'
import type { Incident, ServiceConfig } from '../types'

// #983 — the source-of-truth tag. Everything downstream (alert hold/suppression, SPA + is-down
// grouping) reads `Incident.autoMonitor` instead of guessing editorial intent from `impact`.

const twelvelabs = SERVICES.find((s) => s.id === 'twelvelabs')!

function mkInc(overrides: Partial<Incident> = {}): Incident {
  return {
    id: 'tl-1',
    title: 'Some API features are experiencing issues',
    status: 'resolved',
    impact: 'major',
    startedAt: '2026-07-09T15:04:18.959-07:00',
    resolvedAt: '2026-07-09T15:15:19.428-07:00',
    duration: '11m',
    timeline: [],
    componentNames: ['Analyze API - Pegasus1.5 (Segment Based Metadata)'],
    ...overrides,
  }
}

describe('isAutoMonitorIncident (#983)', () => {
  it('matches the configured machine-emitted title', () => {
    expect(isAutoMonitorIncident(mkInc(), twelvelabs)).toBe(true)
  })

  it('tolerates surrounding whitespace and a trailing period', () => {
    expect(isAutoMonitorIncident(mkInc({ title: '  Some API features are experiencing issues.  ' }), twelvelabs)).toBe(true)
  })

  it('does NOT match the provider real, human-written incidents', () => {
    for (const title of ['Search API failure', 'API server failure', 'Analyze Disruption']) {
      expect(isAutoMonitorIncident(mkInc({ title }), twelvelabs)).toBe(false)
    }
  })

  it('is opt-in: a service with no autoMonitorTitles never tags', () => {
    const noConfig = { id: 'x', name: 'X' } as unknown as ServiceConfig
    expect(isAutoMonitorIncident(mkInc(), noConfig)).toBe(false)
    expect(isAutoMonitorIncident(mkInc(), { ...twelvelabs, autoMonitorTitles: [] })).toBe(false)
  })
})

describe('tagAutoMonitorIncidents (#983)', () => {
  it('stamps autoMonitor on matching incidents only', () => {
    const out = tagAutoMonitorIncidents([mkInc(), mkInc({ id: 'tl-2', title: 'Search API failure' })], twelvelabs)
    expect(out[0].autoMonitor).toBe(true)
    expect(out[1].autoMonitor).toBeUndefined()
  })

  it('tags the whole real 2026-07-09 burst, across both impact levels', () => {
    const burst = [
      mkInc({ id: 'kqk7gdf0h84l', impact: 'minor' }),
      mkInc({ id: 'qyc0cyhlqctg', impact: 'major' }),
      mkInc({ id: 'qkkqnhkfs69j', impact: 'major' }),
      mkInc({ id: '7wk40blkybtq', impact: 'major' }),
    ]
    expect(tagAutoMonitorIncidents(burst, twelvelabs).every((i) => i.autoMonitor === true)).toBe(true)
  })

  it('never mutates the title — an incidentKeywords token must survive into filterIncidents (#940 review Critical)', () => {
    const config: ServiceConfig = { ...twelvelabs, incidentKeywords: ['api'] }
    const tagged = tagAutoMonitorIncidents([mkInc()], config)
    expect(tagged[0].title).toBe('Some API features are experiencing issues')
    // The tagged incident must still pass the real keyword filter — the failure mode #940 shipped
    // and had to fix: a transform that rewrites the title drops the incident wholesale, silently
    // flipping the service back to `operational`.
    expect(filterIncidents(tagged, config).map((i) => i.id)).toEqual(['tl-1'])
  })

  it('returns the SAME array reference when nothing matched (no allocation for untagged services)', () => {
    const input = [mkInc({ title: 'Search API failure' })]
    expect(tagAutoMonitorIncidents(input, twelvelabs)).toBe(input)
    const other = SERVICES.find((s) => s.id === 'claude')!
    const claudeInput = [mkInc()]
    expect(tagAutoMonitorIncidents(claudeInput, other)).toBe(claudeInput)
  })

  it('does not mutate the input incidents', () => {
    const original = mkInc()
    tagAutoMonitorIncidents([original], twelvelabs)
    expect(original.autoMonitor).toBeUndefined()
  })

  it('handles an empty incident list', () => {
    expect(tagAutoMonitorIncidents([], twelvelabs)).toEqual([])
  })
})

describe('autoMonitorTitles config safety across SERVICES (#983)', () => {
  it('every configured pattern is anchored at both ends', () => {
    for (const svc of SERVICES) {
      for (const re of svc.autoMonitorTitles ?? []) {
        expect(re.source.startsWith('^'), `${svc.id}: ${re} must start with ^`).toBe(true)
        expect(re.source.endsWith('$'), `${svc.id}: ${re} must end with $`).toBe(true)
      }
    }
  })

  it('no pattern is stateful (a /g regex would alternate true/false across .test calls)', () => {
    for (const svc of SERVICES) {
      for (const re of svc.autoMonitorTitles ?? []) {
        expect(re.global, `${svc.id}: ${re} must not use the g flag`).toBe(false)
        expect(re.sticky, `${svc.id}: ${re} must not use the y flag`).toBe(false)
      }
    }
  })
})

// The tag is only useful if the PRODUCTION call path applies it. `tagAutoMonitorIncidents` being
// green proves nothing on its own — this repo has twice shipped a bug where the exported, unit-tested
// helper was not the function the entry point called (#966), and once where a transform that ran
// BEFORE `filterIncidents` silently dropped the incident (#940). So drive the real `fetchService`,
// in the real order (parse → filterIncidents → includeUntaggedIncidents → tag), and assert the tag
// reaches the ServiceStatus that /api/status serializes.
describe('fetchService applies the tag on the real call path (#983)', () => {
  afterEach(() => { vi.restoreAllMocks() })

  const component = { id: 'mvv53x91b74m', name: 'Analyze API - Pegasus1.5 (Segment Based Metadata)', status: 'operational' }

  const statuspageIncident = (id: string, impact: string, started: string, resolved: string) => ({
    id,
    name: 'Some API features are experiencing issues',
    status: 'resolved',
    impact,
    created_at: started,
    started_at: started,
    resolved_at: resolved,
    updated_at: resolved,
    incident_updates: [{ status: 'resolved', body: 'All affected API features have recovered.', created_at: resolved }],
    components: [component],
  })

  // The real 2026-07-09 burst as Statuspage served it.
  const summary = {
    status: { indicator: 'none', description: 'All Systems Operational' },
    components: [component],
    incidents: [
      statuspageIncident('kqk7gdf0h84l', 'minor', '2026-07-09T15:24:41.241Z', '2026-07-09T15:29:42.993Z'),
      statuspageIncident('qyc0cyhlqctg', 'major', '2026-07-09T18:13:26.312Z', '2026-07-09T18:27:20.411Z'),
      statuspageIncident('qkkqnhkfs69j', 'major', '2026-07-09T21:07:01.069Z', '2026-07-09T21:22:55.005Z'),
      statuspageIncident('7wk40blkybtq', 'major', '2026-07-09T22:04:18.959Z', '2026-07-09T22:15:19.428Z'),
      // A REAL, human-written incident on the same page — must come back untagged.
      { ...statuspageIncident('real-1', 'major', '2026-07-09T12:00:00.000Z', '2026-07-09T12:40:00.000Z'), name: 'Search API failure' },
    ],
  }

  const fetchTwelveLabs = () => {
    const config = SERVICES.find((s) => s.id === 'twelvelabs')!
    // Any incidental fetch (uptime HTML) resolves to something harmless — the incident path is
    // fully served from `prefetched`, which is exactly how fetchAllServices calls it.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
    return fetchService(config, { summary: summary as never, incidents: null, latency: 120 }, undefined, {})
  }

  it('stamps autoMonitor on every machine-emitted incident that survives filterIncidents', async () => {
    const svc = await fetchTwelveLabs()
    const machine = svc.incidents.filter((i) => i.title === 'Some API features are experiencing issues')
    expect(machine).toHaveLength(4)
    expect(machine.every((i) => i.autoMonitor === true)).toBe(true)
  })

  it('leaves the human-written incident on the same page untagged', async () => {
    const svc = await fetchTwelveLabs()
    const real = svc.incidents.find((i) => i.id === 'real-1')
    expect(real).toBeDefined()
    expect(real!.autoMonitor).toBeUndefined()
  })

  it('does not drop any incident — the tag never rewrites the title past filterIncidents (#940)', async () => {
    const svc = await fetchTwelveLabs()
    expect(svc.incidents.map((i) => i.id).sort()).toEqual(
      ['7wk40blkybtq', 'kqk7gdf0h84l', 'qkkqnhkfs69j', 'qyc0cyhlqctg', 'real-1'],
    )
    expect(svc.incidents.every((i) => i.title.length > 0)).toBe(true)
  })

  it('preserves each incident own impact — grouping/holding must not flatten the data', async () => {
    const svc = await fetchTwelveLabs()
    const impacts = svc.incidents.filter((i) => i.autoMonitor).map((i) => i.impact).sort()
    expect(impacts).toEqual(['major', 'major', 'major', 'minor'])
  })

  it('a service with no autoMonitorTitles comes back entirely untagged', async () => {
    const claude = SERVICES.find((s) => s.id === 'claude')!
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
    const svc = await fetchService(claude, { summary: summary as never, incidents: null, latency: 120 }, undefined, {})
    expect(svc.incidents.every((i) => i.autoMonitor === undefined)).toBe(true)
  })
})
