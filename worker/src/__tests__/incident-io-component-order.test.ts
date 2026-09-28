import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fetchService, SERVICES } from '../services'
import { parseIncidentIoComponentOrder, sortByPageOrder } from '../parsers/incident-io'

// status.fireworks.ai captured 2026-09-28: only the RSC chunk that carries `structure`.
const PAGE = readFileSync(join(__dirname, '..', 'parsers', '__tests__', 'fixtures', 'fireworks-page-2026-09-28.html'), 'utf8')

// components.json on the same day, in the order it serves them.
const API_ORDER: Array<[string, string]> = [
  ['01M2JY35857CPRZTJ3KQ2WS4Z4', 'GLM 5.3 Flash US'],
  ['01M2JY3585ZHHE7A9JDG6PR7B3', 'Minimax M3 US'],
  ['01KYQSPPP8VB3N85P4Y2A01RSR', 'Kimi K3'],
  ['01KVEMYTCCD5S0RQWPBQZ431PE', 'GLM 5.2'],
  ['01M2JY3585G7CDGZGT5111H7JQ', 'GLM 5.3 US'],
  ['01KVEMZE3M15ZV46ZEB7X88H61', 'MiniMax M3'],
  ['01M2JY3585D3XN71ARM3AP8VA8', 'Inkling'],
  ['01KTM9PHXTQ0YX1ZM3TRVACTK8', 'GPT-OSS 120B'],
  ['01KYQT4MDWSVEMPWCVPC90ZSA8', 'Kimi K3 US'],
  ['01M0VEYRP3Q4KM0RDEFG6EBBZC', 'Nemotron 3 Ultra'],
  ['01KYQSPPP80JDA3M7X73DNKHHD', 'Kimi K3 Fast'],
  ['01M0VEYRP3YY99KM87D9CNZ7MG', 'Nemotron 3.5 Lightning'],
  ['01M03TGQ7XTQ8HAKZ8MDQ44HH5', 'Qwen 3.8 Max'],
  ['01M1DFY7G1ZJQNNZWX0Y0APVX6', 'GLM 5.3 '],
  ['01M2JZVTP49S02KF06H66DCNXC', 'GLM 5.3 Fast'],
  ['01M1DFY7G1JXWQQQ852G0PAQCP', 'GLM 5.3 Flash'],
  ['01M29PF3FR517GWQBY4BHZMV8A', 'Deepseek V4.1 Flash'],
]

// The order status.fireworks.ai rendered in a browser on 2026-09-28.
const RENDERED = [
  'GLM 5.3 Flash', 'GLM 5.3 Flash US', 'GLM 5.3 ', 'GLM 5.3 Fast', 'GLM 5.3 US', 'GLM 5.2',
  'Kimi K3 US', 'Kimi K3 Fast', 'Kimi K3', 'Qwen 3.8 Max', 'Deepseek V4.1 Flash',
  'Nemotron 3 Ultra', 'Nemotron 3.5 Lightning', 'Minimax M3 US', 'MiniMax M3', 'Inkling', 'GPT-OSS 120B',
]

const nameOf = new Map(API_ORDER)
const rsc = (structure: unknown) => `<script>self.__next_f.push([1,"${JSON.stringify({ structure }).replace(/"/g, '\\"')}"])</script>`

describe('parseIncidentIoComponentOrder', () => {
  it('reads the rendered order from the captured page', () => {
    expect(parseIncidentIoComponentOrder(PAGE).map((id) => nameOf.get(id))).toEqual(RENDERED)
  })

  it('expands a group in place between standalone components', () => {
    const html = rsc({ items: [
      { component: { component_id: 'A' }, group: '$undefined' },
      { component: '$undefined', group: { components: [{ component_id: 'B' }, { component_id: 'C' }] } },
      { component: { component_id: 'D' }, group: '$undefined' },
    ] })
    expect(parseIncidentIoComponentOrder(html)).toEqual(['A', 'B', 'C', 'D'])
  })

  it('returns [] for a page with no structure', () => {
    expect(parseIncidentIoComponentOrder('<html><body>no rsc</body></html>')).toEqual([])
  })
})

describe('sortByPageOrder', () => {
  const items = ['x', 'b', 'y', 'a'].map((id) => ({ id }))

  it('puts listed ids in page order and unlisted ones after, in their original order', () => {
    expect(sortByPageOrder(items, ['a', 'b']).map((c) => c.id)).toEqual(['a', 'b', 'x', 'y'])
  })

  it('leaves the list untouched when there is no page order', () => {
    expect(sortByPageOrder(items, []).map((c) => c.id)).toEqual(['x', 'b', 'y', 'a'])
  })
})

describe('fetchService orders a displayAllComponents incident.io breakdown by the page', () => {
  const FIREWORKS = SERVICES.find((s) => s.id === 'fireworks')!
  const components = API_ORDER.map(([id, name]) => ({ id, name, status: 'operational' }))
  const summary = { status: { indicator: 'none', description: 'All Systems Operational' }, components, incidents: [] }
  const prefetched = (uptimeHtml?: string) => ({
    summary: summary as never, incidents: null, latency: 100, componentsFetch: { ok: true as const, components }, uptimeHtml,
  })

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })))
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('follows the rendered order when the page HTML is present', async () => {
    const svc = await fetchService(FIREWORKS, prefetched(PAGE), undefined, {})
    expect(svc.components?.map((c) => c.name)).toEqual(RENDERED)
  })

  it('keeps the components.json order when the page HTML is unavailable', async () => {
    const svc = await fetchService(FIREWORKS, prefetched(undefined), undefined, {})
    expect(svc.components?.map((c) => c.name)).toEqual(API_ORDER.map(([, name]) => name))
  })
})
