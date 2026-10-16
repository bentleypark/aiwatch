import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fetchService, fetchAllServices, referenceIncidentsOf, holdReferenceClassification, CACHE_KEY, SERVICES } from '../services'
import { TEST_TIMEOUT_MS, mockKV } from './helpers/unreadable-source'
import { prunePhantomIncidents, type MonthlyIncidents } from '../monthly-archive'
import type { Incident, ServiceConfig, ServiceStatus } from '../types'

// #1669 — real ids/names from status.claude.com (`feedback_faithful_fixtures`).
const CLAUDEAI = 'rwppv331jlwc'
const CONSOLE = '0qbwn08sd68x'
const CLAUDE_API = 'k8w3r06qmzrp'
const CLAUDE_CODE = 'yyzkbfz2thpt'
const NAME: Record<string, string> = {
  [CLAUDEAI]: 'claude.ai',
  [CONSOLE]: 'Claude Console (platform.claude.com)',
  [CLAUDE_API]: 'Claude API (api.anthropic.com)',
  [CLAUDE_CODE]: 'Claude Code',
}
const COMPONENTS = Object.entries(NAME).map(([id, name]) => ({ id, name, status: 'operational' }))

const cfg = (id: string): ServiceConfig => {
  const c = SERVICES.find((s) => s.id === id)
  if (!c) throw new Error(`missing SERVICES config: ${id}`)
  return c
}

const tagged = (ids: string[]) => ids.map((id) => ({ id, name: NAME[id], status: 'degraded_performance' }))

/** `978mjkgw6mh7` as status.claude.com served it on 2026-10-12 (updates trimmed to the latest). */
const consoleOnly = () => ({
  id: '978mjkgw6mh7',
  name: 'Elevated errors on platform.claude.com',
  status: 'monitoring',
  impact: 'major',
  created_at: '2026-10-07T13:25:04.163Z',
  resolved_at: null,
  components: tagged([CONSOLE]),
  incident_updates: [{
    status: 'monitoring', created_at: '2026-10-07T21:44:41.466Z',
    body: "We've mitigated the errors loading usage data on platform.claude.com and in the Admin API usage report.",
    affected_components: [{ code: CONSOLE, name: NAME[CONSOLE], old_status: 'partial_outage', new_status: 'degraded_performance' }],
  }],
})

/** 2026-10-01 "Delayed credits on the Claude Platform" — tagged Console AND Claude API. */
const consoleAndApi = () => ({
  ...consoleOnly(),
  id: 'consoleapi0001',
  name: 'Delayed credits on the Claude Platform',
  impact: 'minor',
  components: tagged([CONSOLE, CLAUDE_API]),
})

afterEach(() => { vi.restoreAllMocks() })

const fetchWith = (id: string, incidents: unknown[], componentStatus: Record<string, string> = {}) => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
  const summary = {
    status: { indicator: 'minor', description: 'Partially Degraded Service' },
    components: COMPONENTS.map((c) => ({ ...c, status: componentStatus[c.id] ?? c.status })),
    incidents: [],
  }
  return fetchService(cfg(id), { summary: summary as never, incidents: { incidents } as never } as never, undefined, {})
}

describe('#1669 fetchService — a Console-only incident on the claude card', () => {
  it('lands in referenceIncidents and not in incidents', async () => {
    const svc = await fetchWith('claude', [consoleOnly()], { [CONSOLE]: 'degraded_performance' })
    expect(svc.incidents.map((i) => i.id)).not.toContain('978mjkgw6mh7')
    expect(svc.referenceIncidents?.map((i) => i.id)).toEqual(['978mjkgw6mh7'])
  })

  it('leaves the badge on the Claude API component', async () => {
    const svc = await fetchWith('claude', [consoleOnly()], { [CONSOLE]: 'degraded_performance' })
    expect(svc.status).toBe('operational')
  })

  it('an incident also tagged to Claude API stays a counted incident', async () => {
    const svc = await fetchWith('claude', [consoleAndApi()], { [CONSOLE]: 'degraded_performance', [CLAUDE_API]: 'degraded_performance' })
    expect(svc.incidents.map((i) => i.id)).toContain('consoleapi0001')
    expect(svc.referenceIncidents).toBeUndefined()
  })

  it('keeps the #1090 warn when Claude API is degraded and the only open incident is Console-only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await fetchWith('claude', [consoleOnly()], { [CONSOLE]: 'degraded_performance', [CLAUDE_API]: 'degraded_performance' })
    expect(warn.mock.calls.some((c) => String(c[0]).includes('#1090'))).toBe(true)
  })

  it('is never counted, even on a card whose component scoping would keep it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
    const summary = {
      status: { indicator: 'minor', description: 'Partially Degraded Service' },
      components: COMPONENTS.map((c) => ({ ...c, status: c.id === CLAUDE_API || c.id === CONSOLE ? 'degraded_performance' : c.status })),
      incidents: [],
    }
    const unscoped = { ...cfg('claude'), scopeIncidentsToComponent: false }
    const svc = await fetchService(unscoped, { summary: summary as never, incidents: { incidents: [consoleOnly()] } as never } as never, undefined, {})
    expect(svc.incidents.map((i) => i.id)).not.toContain('978mjkgw6mh7')
    expect(svc.referenceIncidents?.map((i) => i.id)).toEqual(['978mjkgw6mh7'])
  })

  it('a card without referenceComponentIds gets no referenceIncidents', async () => {
    const svc = await fetchWith('claudeai', [consoleOnly()], { [CONSOLE]: 'degraded_performance' })
    expect(svc.referenceIncidents).toBeUndefined()
  })
})

// #1672 — turbopuffer's incidents.json carries no component tags; the page HTML's `component_impacts` does.
// Real ids/titles from status.turbopuffer.com (2026-10-12).
const TP_DASHBOARD = '01K0Q5QSJV9KAZMEMMQ0NCHD9E'
const TP_US_CENTRAL1 = '01K0Q1X4P70458SR04MTQ2CA7F'
const TP_COMPONENTS = [
  { id: TP_DASHBOARD, name: 'Dashboard', status: 'operational' },
  { id: TP_US_CENTRAL1, name: 'gcp-us-central1', status: 'operational' },
]
const impact = (incidentId: string, componentId: string) =>
  `{\\"component_id\\":\\"${componentId}\\",\\"end_at\\":\\"2026-09-05T18:52:40Z\\",\\"id\\":\\"IMP${componentId.slice(-4)}\\",` +
  `\\"start_at\\":\\"2026-09-05T18:40:07Z\\",\\"status\\":\\"full_outage\\",\\"status_page_incident_id\\":\\"${incidentId}\\"}`
const tpHtml = (impacts: string[]) =>
  `<script>self.__next_f.push([1,"a:{\\"component_impacts\\":[${impacts.join(',')}],\\"component_uptimes\\":[],\\"incident_links\\":[]}"])</script>`
const tpIncident = (id: string, name: string, created_at: string, status = 'resolved') => ({
  id, name, status, impact: 'critical', created_at, resolved_at: status === 'resolved' ? created_at : null, components: [], incident_updates: [],
})
const DASH = tpIncident('01M1SDXV1KRRFS61H6HMXPVA0P', 'Dashboard outage', '2026-09-05T18:40:07Z')
const REGION = tpIncident('01M4E9WY42QC3C94YS5ZVVBETY', 'Elevated rate of 5xx in gcp-us-central1', '2026-10-08T17:45:10Z')
const JOINED = tpHtml([impact(DASH.id, TP_DASHBOARD), impact(REGION.id, TP_US_CENTRAL1)])
const UNJOINED = '<html></html>'

const fetchTurbopuffer = (html: string, incidents: unknown[] = [DASH, REGION]) => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
  const summary = { status: { indicator: 'none', description: 'All Systems Operational' }, components: TP_COMPONENTS, incidents: [] }
  return fetchService(cfg('turbopuffer'), {
    summary: summary as never,
    incidents: { incidents } as never,
    uptimeHtml: html,
  } as never, undefined, {})
}

describe('#1672 fetchService — turbopuffer Dashboard incidents identified from the page HTML', () => {
  it('a Dashboard-only incident is carried as a reference incident, not counted', async () => {
    const svc = await fetchTurbopuffer(JOINED)
    expect(svc.incidents.map((i) => i.id)).not.toContain(DASH.id)
    expect(svc.referenceIncidents?.map((i) => i.id)).toEqual([DASH.id])
  })

  it('a region incident stays counted', async () => {
    const svc = await fetchTurbopuffer(JOINED)
    expect(svc.incidents.map((i) => i.id)).toContain(REGION.id)
  })

  it('with no joinable HTML, nothing is reclassified — and the warn says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const svc = await fetchTurbopuffer(UNJOINED)
    expect(svc.incidents.map((i) => i.id)).toContain(DASH.id)
    expect(svc.referenceIncidents).toBeUndefined()
    expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('component_impacts'))).toEqual([
      expect.stringContaining('referenceComponentIds cannot be identified this cycle'),
    ])
  })
})

// #1669 review rounds 1-2: an incident moving between `incidents` and `referenceIncidents` from one cycle to
// the next was pruned as a phantom (#975) and left its alert thread open. Each case runs real consecutive cycles.
describe('#1672 holdReferenceClassification — an incident keeps the side it was first put on', () => {
  const EMPTY = [{ id: 'turbopuffer', status: 'operational', incidents: [] }] as unknown as ServiceStatus[]
  const cycle = async (html: string, prev: ServiceStatus[] | null, incidents?: unknown[]) => {
    const svc = await fetchTurbopuffer(html, incidents)
    holdReferenceClassification([svc], prev)
    return svc
  }

  it('first seen on a non-joining cycle: stays counted when the HTML joins next cycle', async () => {
    const first = await cycle(UNJOINED, null)
    const second = await cycle(JOINED, [first])
    expect(second.incidents.map((i) => i.id)).toContain(DASH.id)
    expect(second.referenceIncidents).toBeUndefined()
  })

  it('identified as reference: stays reference on a non-joining cycle', async () => {
    const first = await cycle(JOINED, EMPTY)
    const second = await cycle(UNJOINED, [first])
    expect(second.incidents.map((i) => i.id)).not.toContain(DASH.id)
    expect(second.referenceIncidents?.map((i) => i.id)).toEqual([DASH.id])
  })

  it('a reference incident later tagged to a counted component becomes counted', async () => {
    const first = await cycle(JOINED, EMPTY)
    const both = tpHtml([impact(DASH.id, TP_DASHBOARD), impact(DASH.id, TP_US_CENTRAL1), impact(REGION.id, TP_US_CENTRAL1)])
    const second = await cycle(both, [first])
    expect(second.incidents.map((i) => i.id)).toContain(DASH.id)
    expect(second.referenceIncidents).toBeUndefined()
  })

  it('a cycle that could not read the source does not erase the hold', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const open = tpIncident('dash-open', 'Dashboard outage', new Date().toISOString(), 'investigating')
    const html = tpHtml([impact('dash-open', TP_DASHBOARD), impact(REGION.id, TP_US_CENTRAL1)])
    const first = await cycle(UNJOINED, null, [open, REGION])
    vi.stubGlobal('fetch', vi.fn(async () => new Response('err', { status: 503 })))
    const failed = await fetchService(cfg('turbopuffer'), undefined as never, undefined, {})
    holdReferenceClassification([failed], [first])
    const third = await cycle(html, [failed], [open, REGION])
    expect(third.incidents.map((i) => i.id)).toContain('dash-open')
    expect(third.referenceIncidents).toBeUndefined()
  })

  it('a reference incident stays reference across an unreadable cycle followed by a non-joining one', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const first = await cycle(JOINED, EMPTY)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('err', { status: 503 })))
    const failed = await fetchService(cfg('turbopuffer'), undefined as never, undefined, {})
    holdReferenceClassification([failed], [first])
    const third = await cycle(UNJOINED, [failed])
    expect(third.incidents.map((i) => i.id)).not.toContain(DASH.id)
    expect(third.referenceIncidents?.map((i) => i.id)).toEqual([DASH.id])
  })

  it('does not apply to claude, whose tags come with every incidents.json read', async () => {
    const before = await fetchWith('claude', [consoleAndApi()], { [CONSOLE]: 'degraded_performance', [CLAUDE_API]: 'degraded_performance' })
    const retagged = await fetchWith('claude', [{ ...consoleAndApi(), components: tagged([CONSOLE]) }], { [CONSOLE]: 'degraded_performance' })
    holdReferenceClassification([retagged], [before])
    expect(retagged.incidents.map((i) => i.id)).not.toContain('consoleapi0001')
    expect(retagged.referenceIncidents?.map((i) => i.id)).toEqual(['consoleapi0001'])
  })

  it('an incident moved back to counted keeps incidents newest-first', async () => {
    const open = tpIncident('dash-open', 'Dashboard outage', new Date().toISOString(), 'investigating')
    const first = await cycle(UNJOINED, EMPTY, [open, REGION])
    const html = tpHtml([impact('dash-open', TP_DASHBOARD), impact(REGION.id, TP_US_CENTRAL1)])
    const second = await cycle(html, [first], [REGION, open])
    expect(second.incidents.map((i) => i.id)).toEqual(['dash-open', REGION.id])
  })

  it('with no readable snapshot, the merged incidents are newest-first', async () => {
    const open = tpIncident('dash-open', 'Dashboard outage', new Date().toISOString(), 'investigating')
    const html = tpHtml([impact('dash-open', TP_DASHBOARD), impact(REGION.id, TP_US_CENTRAL1)])
    const svc = await cycle(html, null, [REGION, open])
    expect(svc.incidents.map((i) => i.id)).toEqual(['dash-open', REGION.id])
  })

  it('caps each side of the ledger', async () => {
    const many = Array.from({ length: 250 }, (_, n) => `old-${n}`)
    const prev = [{ id: 'turbopuffer', status: 'operational', incidents: [], referenceLedger: { counted: many, reference: many } }] as unknown as ServiceStatus[]
    const svc = await cycle(JOINED, prev)
    expect(svc.referenceLedger?.counted.length).toBe(200)
    expect(svc.referenceLedger?.reference.length).toBe(200)
    expect(svc.referenceLedger?.counted[0]).toBe(REGION.id)
    expect(svc.referenceLedger?.reference[0]).toBe(DASH.id)
  })

  it('when the snapshot cannot be read, a Dashboard incident is counted, and stays counted', async () => {
    const unread = await cycle(JOINED, null)
    expect(unread.incidents.map((i) => i.id)).toContain(DASH.id)
    expect(unread.referenceIncidents).toBeUndefined()
    const next = await cycle(JOINED, [unread])
    expect(next.incidents.map((i) => i.id)).toContain(DASH.id)
    expect(next.referenceIncidents).toBeUndefined()
  })

  it('the #975 phantom prune keeps the row of an incident counted on a non-joining cycle', async () => {
    const open = tpIncident('dash-open', 'Dashboard outage', new Date().toISOString(), 'investigating')
    const html = tpHtml([impact('dash-open', TP_DASHBOARD), impact(REGION.id, TP_US_CENTRAL1)])
    let prev = [await cycle(UNJOINED, null, [open, REGION])]
    let data = {
      lastUpdated: '',
      services: {
        turbopuffer: {
          count: 1, totalMinutes: 0, longestMinutes: 0, dates: [open.created_at.slice(0, 10)], incidentIds: ['dash-open'], durations: { 'dash-open': 0 },
          incidents: [{ id: 'dash-open', title: 'Dashboard outage', startedAt: open.created_at, resolvedAt: null, durationMin: 0, finalStatus: 'investigating', impact: 'critical' }],
        },
      },
    } as unknown as MonthlyIncidents
    for (let n = 0; n < 3; n++) {
      prev = [await cycle(html, prev, [open, REGION])]
      data = prunePhantomIncidents(data, prev, [])
    }
    expect(data.services.turbopuffer.incidentIds).toEqual(['dash-open'])
  })
})

describe('#1672 fetchAllServices applies the hold against the cached snapshot', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('a Dashboard incident counted in the snapshot stays counted when this cycle joins it', async () => {
    const TP = 'https://status.turbopuffer.com'
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url.startsWith(`${TP}/api/v2/summary.json`)) return json({ status: { indicator: 'none' }, components: TP_COMPONENTS, incidents: [] })
      if (url.startsWith(`${TP}/api/v2/incidents.json`)) return json({ incidents: [DASH, REGION] })
      if (url === TP || url === `${TP}/`) return new Response(JOINED, { status: 200, headers: { 'Content-Type': 'text/html' } })
      return json({ status: { indicator: 'none' }, components: [], incidents: [] })
    }))
    const snapshot = { services: [{ id: 'turbopuffer', status: 'operational', incidents: [{ id: DASH.id, title: DASH.name, status: 'resolved', startedAt: DASH.created_at }] }] }
    const { raw } = await fetchAllServices(mockKV({ [CACHE_KEY]: JSON.stringify(snapshot) }) as unknown as KVNamespace, [])
    const tp = raw.find((s) => s.id === 'turbopuffer')!
    expect(tp.incidents.map((i) => i.id)).toContain(DASH.id)
    expect(tp.referenceIncidents).toBeUndefined()
  }, TEST_TIMEOUT_MS)

  it('a Dashboard incident the snapshot holds as reference stays reference when this cycle cannot join it', async () => {
    const TP = 'https://status.turbopuffer.com'
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url.startsWith(`${TP}/api/v2/summary.json`)) return json({ status: { indicator: 'none' }, components: TP_COMPONENTS, incidents: [] })
      if (url.startsWith(`${TP}/api/v2/incidents.json`)) return json({ incidents: [DASH, REGION] })
      if (url === TP || url === `${TP}/`) return new Response(UNJOINED, { status: 200, headers: { 'Content-Type': 'text/html' } })
      return json({ status: { indicator: 'none' }, components: [], incidents: [] })
    }))
    const snapshot = { services: [{ id: 'turbopuffer', status: 'operational', incidents: [], referenceLedger: { counted: [], reference: [DASH.id] } }] }
    const { raw } = await fetchAllServices(mockKV({ [CACHE_KEY]: JSON.stringify(snapshot) }) as unknown as KVNamespace, [])
    const tp = raw.find((s) => s.id === 'turbopuffer')!
    expect(tp.incidents.map((i) => i.id)).not.toContain(DASH.id)
    expect(tp.referenceIncidents?.map((i) => i.id)).toEqual([DASH.id])
  }, TEST_TIMEOUT_MS)
})

describe('#1669 referenceIncidentsOf', () => {
  const inc = (componentNames: string[] | undefined, componentIds?: string[]): Incident => ({
    id: 'x', title: 't', status: 'investigating', impact: 'major', startedAt: '2026-10-07T13:25:04.163Z',
    duration: null, timeline: [],
    ...(componentNames ? { componentNames } : {}),
    ...(componentIds ? { componentIds } : {}),
  } as Incident)
  const claude = cfg('claude')

  it('an untagged incident is never a reference incident', () => {
    expect(referenceIncidentsOf([inc(undefined), inc([])], claude, COMPONENTS)).toEqual([])
  })

  it('matches the page name case-insensitively', () => {
    expect(referenceIncidentsOf([inc([NAME[CONSOLE].toUpperCase()])], claude, COMPONENTS)).toHaveLength(1)
  })

  it('a componentIds tag outside the reference set disqualifies it', () => {
    expect(referenceIncidentsOf([inc([NAME[CONSOLE]], [CONSOLE, CLAUDE_API])], claude, COMPONENTS)).toEqual([])
  })

  it('a reference id the page no longer lists matches nothing', () => {
    expect(referenceIncidentsOf([inc([NAME[CONSOLE]])], claude, COMPONENTS.filter((c) => c.id !== CONSOLE))).toEqual([])
  })
})

// The decision #1669 rests on: nothing COUNTS a reference incident. Counting readers read `incidents`;
// this pins that no worker module but the producer (services.ts), its type (types.ts), operator
// suppression and the #1698 presence primitive reads the new field.
describe('#1669 referenceIncidents has no counting reader in the worker', () => {
  it('is referenced only by services.ts, types.ts, suppression.ts and incident-presence.ts', () => {
    const dir = join(__dirname, '..')
    const readers = readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts') && !f.includes('__tests__'))
      .filter((f) => readFileSync(join(dir, f), 'utf8').includes('referenceIncidents'))
      .sort()
    expect(readers).toEqual(['incident-presence.ts', 'services.ts', 'suppression.ts', 'types.ts'])
  })

  it('#1698 pageIncidents is imported only by the "still on the page?" consumers', () => {
    const dir = join(__dirname, '..')
    const importers = readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts') && !f.includes('__tests__'))
      .filter((f) => readFileSync(join(dir, f), 'utf8').includes("from './incident-presence'"))
      .sort()
    expect(importers).toEqual(['alerted-gone.ts', 'alerts.ts', 'index.ts', 'monthly-archive.ts', 'rss.ts', 'withdrawn.ts'])
  })
})
