import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { fetchService, SERVICES, canIdBypass, filterByComponentStatus } from '../services'
import { buildIncidentIoProxyHtml } from '../parsers/incident-io-proxy'
import type { ServiceConfig } from '../types'

const el = SERVICES.find((s) => s.id === 'elevenlabs') as ServiceConfig
const SCOPE = el.statusComponentIds as string[]
const PRIMARY = el.incidentIoComponentId as string
const DAY = 86_400_000
const NOW = new Date('2026-10-22T02:00:00Z')

// The page as captured from /proxy on 2026-10-22 (#1752). The impact list is replaced per test, so what
// moves uptime is the outage a test places and not whatever happened to be in the capture.
const fx = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/elevenlabs-proxy-2026-10-22/${name}.json`, import.meta.url)), 'utf8'))

interface PageOpts { outageOn?: string | null; activeOn?: string; activeId?: string; activeName?: string; incidents?: unknown[]; renameIds?: (id: string) => string }

/** The rendered page. Outage clocks are RELATIVE to the frozen `NOW`, inside the 5.5-day history the
 *  recreated page has. `activeOn` opens an incident on that component, the way the page reports one. */
const pageHtml = (o: PageOpts = {}) => {
  const start = NOW.getTime() - 3 * DAY
  const imp = fx('component_impacts')
  imp.component_impacts = o.outageOn
    ? [{
        component_id: o.outageOn,
        start_at: new Date(start).toISOString(),
        end_at: new Date(start + 12 * 3_600_000).toISOString(),
        status: 'full_outage',
        status_page_incident_id: 'inc-1',
        id: 'imp-1',
      }]
    : []
  const feed = fx('incidents')
  feed.incidents = o.incidents ?? (o.activeOn
    ? [{
        ...feed.incidents[0],
        id: o.activeId ?? 'act-1', name: o.activeName ?? 'Elevated error rates', status: 'investigating',
        affected_components: [{ component_id: o.activeOn, status: 'partial_outage', current_status: 'partial_outage' }],
        component_impacts: [],
      }]
    : [])
  let raw = JSON.stringify([fx('summary'), imp, feed])
  if (o.renameIds) raw = raw.replace(/01M52[0-9A-Z]{21}/g, (id) => o.renameIds!(id))
  const [summary, impacts, rawFeed] = JSON.parse(raw)
  return buildIncidentIoProxyHtml(summary, impacts, rawFeed)!
}

/** What the compat API serves for this page today. The rebuild from the page must not depend on it. */
const compat = { status: { indicator: 'none', description: 'All Systems Operational' }, components: [], incidents: [] }

/** Drives the REAL `fetchService`, so the scope expression under test is the production one rather than
 *  a copy of it in the test. */
const svcFor = async (o: PageOpts = {}, kv?: unknown, store: unknown = {}) =>
  fetchService(el, { summary: compat, incidents: { incidents: [] }, uptimeHtml: pageHtml(o) } as never, kv as never, store as never)

const uptimeFor = async (outageOn: string | null) => (await svcFor({ outageOn })).uptime30d

describe('#1434 — ElevenLabs uptime covers every component its card shows', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

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
      const svc = await svcFor({ activeOn: id })
      expect(svc.status).not.toBe('operational')
    })
  }

  it('the Status Calendar spans 30 days, matching the uptime and Score windows', async () => {
    const svc = await svcFor()
    expect(svc.calendarDays).toBe(30)
  })

  it('the impact calendar is scoped to the same components — a separate call site from uptime', async () => {
    const svc = await svcFor({ outageOn: SCOPE[1] })
    expect(Object.keys(svc.dailyImpact ?? {})).not.toHaveLength(0)
  })

  it('LIMITATION — an active incident that names no non-operational component is dropped while the badge reads operational', async () => {
    // Component status is derived from an active incident's affected_components, so an active incident
    // with none (the live feed has two such "ElevenReader" incidents) leaves every component operational
    // and `filterByComponentStatus` drops it. Pinned so it is a known limit rather than a rediscovery.
    const base = fx('incidents').incidents[0]
    for (const affected of [[], [{ component_id: SCOPE[0], status: 'partial_outage', current_status: 'operational' }]]) {
      const svc = await svcFor({ incidents: [{ ...base, id: 'act-2', status: 'investigating', affected_components: affected, component_impacts: [] }] })
      expect(svc.status).toBe('operational')
      expect(svc.incidents.some((i) => i.status !== 'resolved')).toBe(false)
    }
  })

  it('an active incident tagged only outside the badge group is dropped, silently', () => {
    const OFF_SCOPE = '01M52EGBQ24XDEGJTJW1JZW9F3' // UI — on the page, outside the scope
    expect(SCOPE).not.toContain(OFF_SCOPE)
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
    // `activeId` matches the impact record's `status_page_incident_id`, which is the join that tags it.
    const svc = await svcFor({ outageOn: SCOPE[1], activeOn: SCOPE[1], activeId: 'inc-1', activeName: 'Webpage outage' })
    expect(svc.incidents.map((i) => i.id)).toContain('inc-1')
  })

  it('a rotated-away primary raises the #135 miss counter through fetchService', async () => {
    // Membership in COMPONENT_ID_SERVICES is not enough: the detection inside fetchService is what
    // writes the counter the Discord alert reads.
    const store: Record<string, unknown> = {}
    await svcFor({ renameIds: (id) => id.replace('01M52', '01M5Z') }, undefined, store)
    expect(JSON.stringify(store)).toContain('componentMiss')
  })

  it('a rotated-away secondary raises the #1179 partial-resolve record', async () => {
    const kv = { store: {} as Record<string, string>, get: vi.fn(async () => null), put: vi.fn(async function (this: void, k: string, v: string) { (kv.store)[k] = v }), delete: vi.fn(async () => {}), list: vi.fn(async () => ({ keys: [] })) }
    // primary resolves, every secondary is gone → anyResolved && missing.length > 0
    await svcFor({ renameIds: (id) => (id === PRIMARY ? id : id.replace('01M52', '01M5Z')) }, kv)
    expect(Object.keys(kv.store).some((k) => k.includes('partial'))).toBe(true)
  })
})
