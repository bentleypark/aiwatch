import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchService, incidentIoUptimeScopeFor, SERVICES } from '../services'

const DAY = 86_400_000
const esc = (o: unknown) => JSON.stringify(o).replace(/"/g, '\\"')
const fireworks = SERVICES.find((s) => s.id === 'fireworks')!
const ANCHOR = fireworks.incidentIoComponentId as string
const OLD = '2026-06-01T00:00:00Z'

type Entry = { id: string; since?: string | null; published?: string }

function pageHtml(entries: Entry[], outage?: { id: string; hours: number }): string {
  const start = Date.now() - 5 * DAY
  const impacts = outage
    ? [{
        component_id: outage.id,
        start_at: new Date(start).toISOString(),
        end_at: new Date(start + outage.hours * 3_600_000).toISOString(),
        status: 'full_outage',
        status_page_incident_id: 'inc-1',
      }]
    : []
  const uptimes = entries.map((e) => ({
    component_id: e.id,
    data_available_since: e.since === undefined ? OLD : (e.since ?? '$undefined'),
    status_page_component_group_id: '$undefined',
    uptime: e.published ?? '100.00',
  }))
  return `<script>self.__next_f.push([1,"\\"component_impacts\\":${esc(impacts)},\\"component_uptimes\\":${esc(uptimes)}"])</script>`
}

const summary = (entries: Entry[]) => ({
  page: { id: 'p1', name: 'Fireworks AI', updated_at: new Date().toISOString() },
  status: { indicator: 'none', description: 'All Systems Operational' },
  components: entries.map((e) => ({ id: e.id, name: e.id, status: 'operational' })),
  incidents: [],
})

function fakeKv() {
  const puts: string[] = []
  const kv = { get: async () => null, put: async (key: string) => { puts.push(key) }, delete: async () => {} }
  return { kv, puts }
}

async function run(entries: Entry[], outage?: { id: string; hours: number }) {
  const { kv, puts } = fakeKv()
  vi.stubGlobal('fetch', vi.fn(async () => new Response('<html></html>', { status: 200 })))
  const svc = await fetchService(
    fireworks,
    { summary: summary(entries) as never, incidents: null, uptimeHtml: pageHtml(entries, outage) } as never,
    kv as never,
    {},
  )
  return { svc, puts }
}

afterEach(() => vi.unstubAllGlobals())

describe('#1709 Fireworks uptime is the worst-of the page\'s own components', () => {
  it('counts a component the config has never heard of', async () => {
    const { svc } = await run([{ id: ANCHOR }, { id: 'BRAND-NEW-MODEL' }], { id: 'BRAND-NEW-MODEL', hours: 24 })
    expect(svc.uptime30d).toBe(96.66)
    expect(svc.uptimeSource).toBe('official')
  })

  it('stops counting a component the provider removed, with no partial-resolve record', async () => {
    const before = await run([{ id: ANCHOR }, { id: 'RETIRING' }], { id: 'RETIRING', hours: 24 })
    expect(before.svc.uptime30d).toBe(96.66)

    const after = await run([{ id: ANCHOR }])
    expect(after.svc.uptime30d).toBe(100)
    expect(after.puts.filter((k) => k.startsWith('component-partial:'))).toEqual([])
  })

  it('does not count, or report as missing, a component with no history yet', async () => {
    const { svc, puts } = await run([{ id: ANCHOR }, { id: 'EMPTY', since: null }], { id: 'EMPTY', hours: 24 })
    expect(svc.uptime30d).toBe(100)
    expect(puts.filter((k) => k.startsWith('component-partial:'))).toEqual([])
  })

  it('withholds the provider-attributed figure: no single component stands for a page-wide scope', async () => {
    const { svc } = await run([{ id: ANCHOR, published: '99.95' }, { id: 'OTHER', published: '99.50' }])
    expect(svc.uptimeReported).toBeUndefined()
  })

  it('puts an outage on a non-anchor component into the impact calendar', async () => {
    const { svc } = await run([{ id: ANCHOR }, { id: 'OTHER' }], { id: 'OTHER', hours: 24 })
    expect(Object.keys(svc.dailyImpact ?? {}).length).toBeGreaterThan(0)
  })

  it('withholds uptime on a page that lists no components, instead of publishing 100', async () => {
    const { svc } = await run([])
    expect(svc.uptime30d).toBeNull()
  })

  it('keeps the id-list scope for every service that does not set the flag', () => {
    const turbopuffer = SERVICES.find((s) => s.id === 'turbopuffer')!
    expect(incidentIoUptimeScopeFor(turbopuffer, pageHtml([{ id: 'UNLISTED' }]))).toEqual(turbopuffer.incidentIoComponentId)
  })
})
