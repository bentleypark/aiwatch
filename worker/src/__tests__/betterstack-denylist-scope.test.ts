// #1829 — `componentDenylist` hid a resource from the breakdown while uptime, the status ratio, the
// partial count and the calendar still read it. Together's `Website` section (Website, Playground) was
// 100% for 90 days, so averaging it in raised Together's published uptime by up to 0.07 points.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchService, SERVICES } from '../services'
import { withoutDeniedBetterStackResources, type BetterStackIndex } from '../parsers/betterstack'

const helicone = SERVICES.find((s) => s.id === 'helicone')!

const DAYS = Array.from({ length: 30 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`)
/** 30 operational days, except `downDay`, down for `downSec`. */
function history(downDay?: string, downSec = 0) {
  return DAYS.map((day) => day === downDay
    ? { day, status: 'downtime', downtime_duration: downSec, maintenance_duration: 0 }
    : { day, status: 'operational', downtime_duration: 0, maintenance_duration: 0 })
}

/** Two API monitors, operational, and a `Website` resource down for 12 h on 10-15 — the only thing
 *  wrong on the page, so every reader that still counts it publishes a difference. */
function page(): BetterStackIndex {
  return {
    data: { attributes: { aggregate_state: 'downtime', timezone: 'UTC' } },
    included: [
      { type: 'status_page_section', id: '1', attributes: { name: 'API' } },
      { type: 'status_page_section', id: '2', attributes: { name: 'Marketing' } },
      { type: 'status_page_resource', id: '10', attributes: { public_name: 'US API', status: 'operational', availability: 1, status_page_section_id: '1', status_history: history() } },
      { type: 'status_page_resource', id: '11', attributes: { public_name: 'EU API', status: 'operational', availability: 1, status_page_section_id: '1', status_history: history() } },
      { type: 'status_page_resource', id: '12', attributes: { public_name: 'Website', status: 'downtime', availability: 0.9, status_page_section_id: '2', status_history: history('2026-10-15', 43_200) } },
    ],
  } as BetterStackIndex
}

const EMPTY_FEED = '<?xml version="1.0"?><rss version="2.0"><channel><title>Incidents</title></channel></rss>'

function stubFetch(body: BetterStackIndex) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (url.endsWith('/index.json')) return new Response(JSON.stringify(body), { status: 200 })
    if (url.endsWith('/feed')) return new Response(EMPTY_FEED, { status: 200 })
    return new Response('<html>ok</html>', { status: 200 })
  }))
}

beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-31T00:00:00Z')) })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('#1829 — withoutDeniedBetterStackResources', () => {
  const names = (d: BetterStackIndex) => (d.included ?? []).filter((r) => r.type === 'status_page_resource').map((r) => r.attributes?.public_name ?? null)

  it('drops a resource named in the denylist, case-insensitively, and keeps the sections', () => {
    const out = withoutDeniedBetterStackResources(page(), ['website'])
    expect(names(out)).toEqual(['US API', 'EU API'])
    expect(out.included?.filter((r) => r.type === 'status_page_section')).toHaveLength(2)
  })

  it('drops every resource of a denied section (Together: Playground sits in the Website section)', () => {
    expect(names(withoutDeniedBetterStackResources(page(), ['Marketing']))).toEqual(['US API', 'EU API'])
  })

  it('keeps a nameless resource and returns the page itself for no denylist', () => {
    const p = page()
    p.included!.push({ type: 'status_page_resource', id: '13', attributes: { status: 'operational', status_history: history() } })
    expect(names(withoutDeniedBetterStackResources(p, ['Website']))).toEqual(['US API', 'EU API', null])
    expect(withoutDeniedBetterStackResources(p, undefined)).toBe(p)
    expect(withoutDeniedBetterStackResources(p, [])).toBe(p)
  })
})

describe('#1829 — fetchService reads the denied resource nowhere', () => {
  it('publishes uptime, status, partial count and calendar from the API monitors only', async () => {
    expect(helicone.componentDenylist).toContain('Website')
    stubFetch(page())
    const svc = await fetchService(helicone, undefined, undefined, {})

    // Two clean monitors: 100. Counting Website (1 − 43200/(30·86400) = 98.33) averaged 99.44.
    expect(svc.uptime30d).toBe(100)
    // Website alone is down: 1 of 3 resources (33%) read `down`/`degraded`; 0 of 2 is operational.
    expect(svc.status).toBe('operational')
    expect(svc.partialCount).toBeUndefined()
    expect(svc.dailyImpact?.['2026-10-15']).toBeUndefined()
    expect(svc.components?.map((c) => c.name) ?? []).not.toContain('Website')
    // The provider's displayed availability stays page-wide, Website included: (100 + 100 + 90) / 3.
    expect(svc.uptimeReported).toBe(96.67)
  })

  it('discloses the API monitors\' short window even when Website has a full one (#1835)', async () => {
    const p = page()
    for (const r of p.included!) {
      if (r.type !== 'status_page_resource' || r.attributes?.public_name === 'Website') continue
      r.attributes!.status_history = r.attributes!.status_history!.map((d, i) => i < 29 ? { ...d, status: 'not_monitored' } : d)
    }
    stubFetch(p)
    const svc = await fetchService(helicone, undefined, undefined, {})
    expect(svc.uptimeWindowDays).toBe(1)
  })
})
