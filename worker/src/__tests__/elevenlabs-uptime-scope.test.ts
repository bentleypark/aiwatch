import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchService, SERVICES, canIdBypass, filterByComponentStatus } from '../services'
import type { ServiceConfig } from '../types'

const el = SERVICES.find((s) => s.id === 'elevenlabs') as ServiceConfig
const SCOPE = el.statusComponentIds as string[]
const PRIMARY = el.incidentIoComponentId as string
const DAY = 86_400_000

const esc = (v: unknown) => JSON.stringify(JSON.stringify(v)).slice(1, -1)

/** The page-root RSC chunk in the shape `computeIncidentIoUptime` reads. Outage clocks are RELATIVE to
 *  `Date.now()` so the fixture cannot drift out of the trailing window weeks after merge. */
const ioPageHtml = (outageOn: string | null) => {
  const start = Date.now() - 5 * DAY
  const impacts = outageOn
    ? [{
        component_id: outageOn,
        start_at: new Date(start).toISOString(),
        end_at: new Date(start + 12 * 3_600_000).toISOString(),
        status: 'full_outage',
        status_page_incident_id: 'inc-1',
      }]
    : []
  const uptimes = SCOPE.map((id) => ({
    component_id: id,
    data_available_since: '2025-01-01T00:00:00Z',
    status_page_component_group_id: '$undefined',
    uptime: '$undefined',
  }))
  return `<script>self.__next_f.push([1,"\\"component_impacts\\":${esc(impacts)},\\"component_uptimes\\":${esc(uptimes)}"])</script>`
}

/** The page indicator stays `none` even when a component is degraded — that combination is what
 *  discriminates a component-scoped badge from one that reads the page's own indicator. */
const summaryFor = (opts: { degradedId?: string; incidents?: unknown[] } = {}) => ({
  status: { indicator: 'none', description: 'All Systems Operational' },
  components: SCOPE.map((id) => ({
    id, name: id, status: id === opts.degradedId ? 'partial_outage' : 'operational',
  })),
  incidents: opts.incidents ?? [],
})

const activeIncident = () => ({
  id: 'act-1', name: 'Elevated error rates', status: 'investigating', impact: 'minor',
  created_at: new Date(Date.now() - 3_600_000).toISOString(),
  started_at: new Date(Date.now() - 3_600_000).toISOString(),
  updated_at: new Date().toISOString(), resolved_at: null, monitoring_at: null,
  components: [], incident_updates: [],
})

/** Drives the REAL `fetchService`, so the scope expression under test is the production one rather than
 *  a copy of it in the test. */
const svcFor = async (outageOn: string | null, opts: { degradedId?: string; incidents?: unknown[] } = {}) => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  return fetchService(el, {
    summary: summaryFor(opts),
    incidents: { incidents: opts.incidents ?? [] },
    latency: 100,
    uptimeHtml: ioPageHtml(outageOn),
  } as never, undefined, {} as never)
}

const uptimeFor = async (outageOn: string | null) => (await svcFor(outageOn)).uptime30d

describe('#1434 — ElevenLabs uptime covers every component its card shows', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('the fixture is not vacuous: the badge scope spans more than the component uptime used to read', () => {
    expect(SCOPE.length).toBeGreaterThan(1)
    expect(SCOPE).toContain(PRIMARY)
  })

  for (const id of SCOPE) {
    it(`a full outage on ${id} alone moves uptime30d`, async () => {
      const pct = await uptimeFor(id)
      expect(pct).not.toBeNull()
      expect(pct!).toBeLessThan(100)
    })
  }

  it('an all-clear page reads exactly 100 — the negative control', async () => {
    expect(await uptimeFor(null)).toBe(100)
  })

  for (const id of SCOPE) {
    it(`a degraded ${id} moves the badge while the page indicator still reads none`, async () => {
      const svc = await svcFor(null, { degradedId: id, incidents: [activeIncident()] })
      expect(svc.status).not.toBe('operational')
    })
  }

  it('the Status Calendar spans 30 days, matching the uptime and Score windows', async () => {
    const svc = await svcFor(null)
    expect(svc.calendarDays).toBe(30)
  })

  it('the impact calendar is scoped to the same components — a separate call site from uptime', async () => {
    const svc = await svcFor(SCOPE[1])
    expect(Object.keys(svc.dailyImpact ?? {})).not.toHaveLength(0)
  })

  it('LIMITATION — an active incident is dropped while every component reads operational', async () => {
    // A consequence of gaining a badge group, pinned so it is a known limit rather than a rediscovery:
    // `filterByComponentStatus` early-returned for this service before #1434 and does not now.
    const svc = await svcFor(null, { incidents: [activeIncident()] })
    expect(svc.status).toBe('operational')
    expect(svc.incidents.some((i) => i.status !== 'resolved')).toBe(false)
  })

  it('an active incident tagged only outside the badge group is dropped, silently', () => {
    const OFF_SCOPE = '01JY3H5SJJN08K456SBNE0Y947' // UI — on the page, outside the seven
    const comps = SCOPE.map((id) => ({ id, name: id, status: 'operational' }))
    const inc = [{
      id: 'UIONLY', title: 'UI degraded', status: 'investigating', impact: 'minor',
      startedAt: new Date().toISOString(), duration: null, timeline: [],
      componentIds: [OFF_SCOPE], componentNames: [],
    }]
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(filterByComponentStatus(inc as never, 'operational', el, comps as never)).toHaveLength(0)
    expect(warn).not.toHaveBeenCalled()
  })

  it('an active incident tagged on a non-primary badge component is KEPT', () => {
    // The other side of the drop rule: widening the badge group is what lets the #1104 id-keep hold an
    // active incident the provider tagged onto a component beyond the primary.
    const comps = SCOPE.map((id) => ({ id, name: id, status: 'operational' }))
    const inc = [{
      id: 'NP', title: 'STT errors', status: 'investigating', impact: 'minor',
      startedAt: new Date().toISOString(), duration: null, timeline: [],
      componentIds: [SCOPE[3]], componentNames: [],
    }]
    expect(filterByComponentStatus(inc as never, 'operational', el, comps as never)).toHaveLength(1)
  })

  it('the badge group puts the service inside the #1032 id-bypass, fetch side included', async () => {
    // `incidentExclude: ['webpage']` is now overridable by provider tagging — but only while the FETCH
    // side still tags. Driving fetchService covers both ends; asserting the reader alone would pass
    // with `attachIncidentIoComponentIds` switched off, the drift canIdBypass's docblock names.
    expect(canIdBypass(el)).toBe(true)
    const webpage = {
      id: 'inc-1', name: 'Webpage outage', status: 'investigating', impact: 'minor',
      created_at: new Date(Date.now() - 3_600_000).toISOString(),
      started_at: new Date(Date.now() - 3_600_000).toISOString(),
      updated_at: new Date().toISOString(), resolved_at: null, monitoring_at: null,
      components: [], incident_updates: [],
    }
    const svc = await svcFor(SCOPE[1], { degradedId: SCOPE[1], incidents: [webpage] })
    expect(svc.incidents.map((i) => i.id)).toContain('inc-1')
  })

  it('a rotated-away primary raises the #135 miss counter through fetchService', async () => {
    // Membership in COMPONENT_ID_SERVICES is not enough: the detection inside fetchService is what
    // writes the counter the Discord alert reads.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store: Record<string, unknown> = {}
    await fetchService(el, {
      summary: {
        status: { indicator: 'none', description: 'All Systems Operational' },
        components: [{ id: 'rotated-away', name: 'Renamed', status: 'operational' }],
        incidents: [],
      },
      incidents: { incidents: [] },
      latency: 100,
      uptimeHtml: ioPageHtml(null),
    } as never, undefined, store as never)
    expect(JSON.stringify(store)).toContain('componentMiss')
  })

  it('a rotated-away secondary raises the #1179 partial-resolve record', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const kv = { store: {} as Record<string, string>, get: vi.fn(async () => null), put: vi.fn(async function (this: void, k: string, v: string) { (kv.store)[k] = v }), delete: vi.fn(async () => {}), list: vi.fn(async () => ({ keys: [], list_complete: true })) }
    await fetchService(el, {
      summary: {
        status: { indicator: 'none', description: 'All Systems Operational' },
        // primary resolves, every secondary is gone → anyResolved && missing.length > 0
        components: [{ id: PRIMARY, name: 'Text to Speech', status: 'operational' }],
        incidents: [],
      },
      incidents: { incidents: [] },
      latency: 100,
      uptimeHtml: ioPageHtml(null),
    } as never, kv as never, {} as never)
    expect(Object.keys(kv.store).some((k) => k.includes('partial'))).toBe(true)
  })

})
