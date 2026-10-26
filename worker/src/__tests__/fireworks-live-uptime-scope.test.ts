import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchService, incidentIoUptimeScopeFor, SERVICES } from '../services'
import { pageHtml, summary, fakeKv, type Entry } from './helpers/incident-io-page'

const fireworks = SERVICES.find((s) => s.id === 'fireworks')!
const ANCHOR = fireworks.incidentIoComponentId as string

async function run(entries: Entry[], outage?: { id: string; hours: number }) {
  const { kv, puts } = fakeKv()
  vi.stubGlobal('fetch', vi.fn(async () => new Response('<html></html>', { status: 200 })))
  const svc = await fetchService(
    fireworks,
    { summary: summary(entries, 'Fireworks AI') as never, incidents: null, uptimeHtml: pageHtml(entries, outage) } as never,
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
