// #1741 — /uptime_showcase pads every requested component to a fixed 90 days, the pre-creation ones as
// `outages: {}`, so a figure computed from those days counts them as clean. bfl's API EU (created
// 2026-09-28) came out at 99.98 against the 99.95 status.bfl.ml publishes for it; the provider's own
// `values[].ninety` is the number the page shows, so that is what `uptimeReported` carries.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { computeUptimeData, parseUptimeShowcase } from '../parsers/statuspage'
import { fetchAllServices, uptimeScopeOf, SERVICES } from '../services'
import { TEST_TIMEOUT_MS, mockKV, HEALTHY_SUMMARY } from './helpers/unreadable-source'
import { lazyPage } from './helpers/lazy-status-page'

const PAGE = 'https://status.bfl.ml'
const API_EU = 'cw5sckn8002d'
const BFL = SERVICES.find((s) => s.id === 'bfl')!
const SCOPE = uptimeScopeOf(BFL)

// 90 days ending today; API EU carries one 3789s partial 10 days ago, every other day is `{}`.
function timelines() {
  const end = Date.parse(`${new Date().toISOString().split('T')[0]}T00:00:00Z`)
  const days = (withOutage: boolean) => Array.from({ length: 90 }, (_, i) => ({
    date: new Date(end - (89 - i) * 86_400_000).toISOString().split('T')[0],
    outages: withOutage && i === 79 ? { p: 3789 } : {},
  }))
  return Object.fromEntries(SCOPE.map((id) => [id, { component: { code: id }, days: days(id === API_EU) }]))
}
// What status.bfl.ml served for these components on 2026-10-26.
const values = SCOPE.map((id) => ({ component: id, thirty: id === API_EU ? 99.95 : 100, sixty: id === API_EU ? 99.95 : 100, ninety: id === API_EU ? 99.95 : 100 }))

describe('uptimeReported is the provider\'s own 90-day figure (#1741)', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('a young padded component reports the published 99.95, not the 99.98 its padded days compute to', () => {
    const computed = computeUptimeData(parseUptimeShowcase({ timelines: timelines() }), SCOPE, 30, Date.now())
    expect(computed.uptimeReported).toBe(99.98)
    const r = computeUptimeData(parseUptimeShowcase({ timelines: timelines(), values }), SCOPE, 30, Date.now())
    expect(r.uptimePercent).toBe(99.95)
    expect(r.uptimeReported).toBe(99.95)
    expect(r.uptimeReportedDays).toBe(90)
  })

  it('a multi-component scope takes the lowest published figure; a component without one falls back to its days', () => {
    const partial = values.filter((v) => v.component !== API_EU)
    const r = computeUptimeData(parseUptimeShowcase({ timelines: timelines(), values: partial }), SCOPE, 30, Date.now())
    expect(r.uptimeReported).toBe(99.98)
  })

  it('ignores a malformed or unmatched value', () => {
    const bad = [{ component: API_EU, ninety: '99.95' }, { component: 'nope', ninety: 1 }, { component: 'constructor', ninety: 1 }, null, { ninety: 2 }]
    const parsed = parseUptimeShowcase({ timelines: timelines(), values: bad })
    expect(Object.keys(parsed!).sort()).toEqual([...SCOPE].sort())
    expect(computeUptimeData(parsed, SCOPE, 30, Date.now()).uptimeReported).toBe(99.98)
  })

  it('a `values` that is not an array leaves the timelines as they are', () => {
    const parsed = parseUptimeShowcase({ timelines: timelines(), values: { component: API_EU, ninety: 1 } })
    expect(computeUptimeData(parsed, SCOPE, 30, Date.now()).uptimeReported).toBe(99.98)
  })

  it('fetchAllServices publishes our 30-day figure and no compare figure for bfl, because the two agree', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url.includes('/uptime_showcase')) return json({ timelines: timelines(), values })
      if (url.startsWith(`${PAGE}/api/v2/summary.json`)) {
        return json({
          status: { indicator: 'none', description: 'All Systems Operational' },
          components: SCOPE.map((id) => ({ id, name: id, status: 'operational', group: false, group_id: null, position: 1 })),
          incidents: [], scheduled_maintenances: [],
        })
      }
      if (url.startsWith(`${PAGE}/api/v2/incidents.json`)) return json({ incidents: [] })
      if (url === PAGE || url === `${PAGE}/`) return new Response(lazyPage(SCOPE), { status: 200, headers: { 'Content-Type': 'text/html' } })
      return json(HEALTHY_SUMMARY)
    }))
    const { raw } = await fetchAllServices(mockKV() as unknown as KVNamespace, [])
    const bfl = raw.find((s) => s.id === 'bfl')
    expect(bfl?.uptime30d).toBe(99.95)
    expect(bfl?.uptimeSource).toBe('official')
    expect(bfl?.uptimeReported).toBeUndefined()
    expect(bfl?.uptimeReportedDays).toBeUndefined()
  }, TEST_TIMEOUT_MS)
})
