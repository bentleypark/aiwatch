import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fetchService, resolveSvcComponents, SERVICES, MODEL_GROUP } from '../services'
import { parseIncidentIoPageStructure, applyIncidentIoPageStructure } from '../parsers/incident-io'

// status.fireworks.ai captured 2026-09-28: only the RSC chunk that carries `structure`.
const fixture = (name: string) => readFileSync(join(__dirname, '..', 'parsers', '__tests__', 'fixtures', name), 'utf8')
const PAGE = fixture('fireworks-page-2026-09-28.html')

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

describe('parseIncidentIoPageStructure', () => {
  it('reads the rendered order and the group name from the captured fireworks page', () => {
    const structure = parseIncidentIoPageStructure(PAGE)
    expect(structure.map((i) => i.group)).toEqual(['Serverless'])
    expect(structure[0].ids.map((id) => nameOf.get(id))).toEqual(RENDERED)
  })

  // #1528 — groq publishes three groups between two standalone rows (2026-09-29).
  it('reads groups and standalone rows from the captured groq page', () => {
    const structure = parseIncidentIoPageStructure(fixture('groq-page-2026-09-29.html'))
    expect(structure.map((i) => [i.group, i.ids.length])).toEqual([
      [null, 1], ['Production', 7], ['Production Systems', 2], ['Preview Models', 9], [null, 1],
    ])
    expect(structure[0].ids).toEqual(['01K053E2FAKWKEYHXEV7WAHJBM'])
  })

  // #1528 — cohere's Endpoints group is the same pair its curated componentGroups maps by hand.
  it('reads the cohere Endpoints group members from the captured page', () => {
    const structure = parseIncidentIoPageStructure(fixture('cohere-page-2026-09-29.html'))
    expect(structure.map((i) => i.group)).toEqual(['Endpoints', 'Models', null, null, null, null])
    const cohere = SERVICES.find((s) => s.id === 'cohere')!
    expect(structure[0].ids.sort()).toEqual(Object.keys(cohere.componentGroups!).sort())
  })

  it('returns [] for a page with no structure', () => {
    expect(parseIncidentIoPageStructure('<html><body>no rsc</body></html>')).toEqual([])
  })
})

describe('applyIncidentIoPageStructure', () => {
  const comp = (id: string) => ({ id, name: id.toUpperCase(), status: 'operational' })

  it('emits page order with a header per group, members tagged, unlisted components last', () => {
    const out = applyIncidentIoPageStructure(
      ['x', 'c', 'a', 'b', 'd'].map(comp),
      [{ group: null, ids: ['a'] }, { group: 'G', ids: ['c', 'b', 'gone'] }, { group: null, ids: ['d'] }],
    )
    expect(out.map((c) => [c.id, c.group ?? false, c.group_id ?? null])).toEqual([
      ['a', false, null], ['page-group-1', true, null], ['c', false, 'page-group-1'], ['b', false, 'page-group-1'],
      ['d', false, null], ['x', false, null],
    ])
    expect(out.find((c) => c.group)!.name).toBe('G')
  })

  it('breakdown follows the page even against the compat API position', () => {
    const components = ['api', 'm1', 'new', 'm2', 'b', 'm3'].map((id, position) => ({ ...comp(id), position }))
    const out = applyIncidentIoPageStructure(components, [
      { group: null, ids: ['api'] }, { group: 'G1', ids: ['m1', 'm2'] }, { group: null, ids: ['b'] }, { group: 'G2', ids: ['m3'] },
    ])
    const resolved = resolveSvcComponents({ displayAllComponents: true }, { components: out })
    expect(resolved.map((c) => [c.id, c.group ?? null])).toEqual([
      ['api', null], ['m1', 'G1'], ['m2', 'G1'], ['b', null], ['m3', 'G2'], ['new', null],
    ])
  })

  it('leaves the list untouched when there is no page structure', () => {
    const items = ['x', 'b'].map(comp)
    expect(applyIncidentIoPageStructure(items, [])).toBe(items)
  })
})

describe('fetchService follows the page structure in a displayAllComponents incident.io breakdown', () => {
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

  it('follows the rendered order and the page group when the page HTML is present', async () => {
    const svc = await fetchService(FIREWORKS, prefetched(PAGE), undefined, {})
    expect(svc.components?.map((c) => c.name)).toEqual(RENDERED)
    expect(new Set(svc.components?.map((c) => c.group))).toEqual(new Set(['Serverless']))
  })

  it('keeps the components.json order when the page HTML is unavailable', async () => {
    const svc = await fetchService(FIREWORKS, prefetched(undefined), undefined, {})
    expect(svc.components?.map((c) => c.name)).toEqual(API_ORDER.map(([, name]) => name))
    expect(new Set(svc.components?.map((c) => c.group))).toEqual(new Set([MODEL_GROUP]))
  })
})

describe('fetchService: groq breakdown follows the page groups (#1528)', () => {
  const GROQ = SERVICES.find((s) => s.id === 'groq')!
  const GROQ_PAGE = fixture('groq-page-2026-09-29.html')
  const structure = parseIncidentIoPageStructure(GROQ_PAGE)
  const ids = structure.flatMap((i) => i.ids)
  // API order (and the compat API's own `position`) reversed so the page order has to come from the structure; names only matter for the
  // two standalone rows (API is a componentSurfaces entry, Website is denylisted).
  const nameFor = (id: string) => (id === ids[0] ? 'API' : id === ids[ids.length - 1] ? 'Website' : id)
  const components = [...ids].reverse().map((id, i) => ({ id, name: nameFor(id), status: 'operational', position: i + 1 }))
  const summary = { status: { indicator: 'none', description: 'All Systems Operational' }, components, incidents: [] }
  const prefetched = { summary: summary as never, incidents: null, latency: 100, componentsFetch: { ok: true as const, components }, uptimeHtml: GROQ_PAGE }

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })))
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('keeps API as a row and the three page groups apart, in page order', async () => {
    const svc = await fetchService(GROQ, prefetched, undefined, {})
    const runs: Array<[string | null, number]> = []
    for (const c of svc.components ?? []) {
      const g = c.group ?? null
      if (runs.length && runs[runs.length - 1][0] === g) runs[runs.length - 1][1]++
      else runs.push([g, 1])
    }
    expect(runs).toEqual([[null, 1], ['Production', 7], ['Production Systems', 2], ['Preview Models', 9]])
    expect(svc.components?.[0].name).toBe('API')
  })
})
