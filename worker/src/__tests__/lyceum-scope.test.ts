import { describe, it, expect, vi, afterEach } from 'vitest'
import { SERVICES, filterIncidents, fetchService, instatusUptimeScope } from '../services'
import { parseInstatusUptime, parseInstatusReportedUptime, __resetInstatusUptimeWarnings } from '../parsers/instatus'
import { PROBE_TARGETS } from '../probe'
import { EXCLUDE_FALLBACK, API_TIER } from '../fallback'
import type { Incident } from '../types'

// #1979 — Lyceum's Instatus page lists six components. The card counts the three of the inference API
// (Model Inference, Serverless Inference API, API Gateway); Dashboard, Website and Docs are not counted.
// Incidents and uptime cover the same three, or the card shows an incident next to an unaffected uptime.

const lyceum = SERVICES.find((s) => s.id === 'lyceum')!
const [MODEL_ID, SERVERLESS_ID, GATEWAY_ID] = lyceum.displayComponentIds!
const DASHBOARD_ID = 'cmrjfsikc01bz0ko2od2kcwjd'
const WEBSITE_ID = 'cmrjfsisu019613mptlqu6l81'
const NAMES: Record<string, string> = {
  [MODEL_ID]: 'Model Inference',
  [SERVERLESS_ID]: 'Serverless Inference API',
  [GATEWAY_ID]: 'API Gateway',
  [DASHBOARD_ID]: 'Dashboard',
  [WEBSITE_ID]: 'Website',
}

describe('#1979 lyceum config — incidents and uptime are one decision', () => {
  it('counts the three inference components by exact name, with no keyword scoping', () => {
    expect(lyceum.incidentComponents).toEqual(['Model Inference', 'Serverless Inference API', 'API Gateway'])
    expect(lyceum.incidentKeywords).toBeUndefined()
    expect(lyceum.displayComponentIds!.map((id) => NAMES[id])).toEqual(lyceum.incidentComponents)
  })

  it('keyword scoping on `api` would drop a Model Inference incident (why the allowlist is exact names)', () => {
    const keywordScoped = { ...lyceum, incidentComponents: undefined, incidentKeywords: ['api'] }
    const modelInference = inc({ title: 'Model inference degraded', componentNames: ['Model Inference'] })
    expect(filterIncidents([modelInference], keywordScoped)).toEqual([])
    expect(filterIncidents([modelInference], lyceum)).toHaveLength(1)
  })

  it('reads uptime over the displayed set, with a single component only as the fallback', () => {
    expect(lyceum.uptimeOverDisplayComponents).toBe(true)
    expect(lyceum.statusComponent).toBe('Model Inference')
  })

  it('parses the Instatus page it reads uptime and components from', () => {
    expect(lyceum.statusUrl).toBe('https://caspar.instatus.com')
    expect(lyceum.instatusUrl).toBe('https://caspar.instatus.com')
  })

  it('stays out of fallback with no tier (#1028: unmeasured, a model-hosting platform stays excluded)', () => {
    expect(EXCLUDE_FALLBACK).toContain('lyceum')
    expect(API_TIER['lyceum']).toBeUndefined()
  })

  it('is probed at the API\'s own 401 path', () => {
    expect(PROBE_TARGETS.find((t) => t.id === 'lyceum')?.url).toBe('https://api.lyceum.technology/openai/v1/models')
  })

  it('every service that opts into the wide uptime scope holds the whole contract', () => {
    const optedIn = SERVICES.filter((s) => s.uptimeOverDisplayComponents)
    expect(optedIn.map((s) => s.id)).toEqual(['lyceum'])
    for (const s of optedIn) {
      expect(s.instatusUrl, `${s.id}: the flag is read only in the Instatus branch`).toBeTruthy()
      expect(s.displayComponentIds?.length, `${s.id}: nothing to widen the scope to`).toBeGreaterThan(0)
      expect(s.incidentKeywords, `${s.id}: wide uptime + keyword-narrowed incidents is the half-fix`).toBeUndefined()
    }
  })

  it('does not sweep fal along: it stays a single-component API card', () => {
    const fal = SERVICES.find((x) => x.id === 'fal')!
    expect(fal.uptimeOverDisplayComponents).toBeUndefined()
    expect(fal.incidentKeywords).toEqual(['api'])
    expect(fal.statusComponent).toBe('API')
  })

  it('the Instatus roster is fal and lyceum', () => {
    expect(SERVICES.filter((s) => s.instatusUrl).map((s) => s.id)).toEqual(['fal', 'lyceum'])
  })
})

function inc(overrides: Partial<Incident> = {}): Incident {
  return {
    id: 'cmw9e788f0dsq0wmzoupnv3kk',
    title: "We've identified an issue affecting logins and the API",
    status: 'resolved',
    impact: 'major',
    componentNames: ['Dashboard', 'API Gateway'],
    startedAt: '2026-11-12T10:00:00.000Z',
    resolvedAt: '2026-11-12T11:00:00.000Z',
    duration: '1h',
    timeline: [],
    ...overrides,
  }
}

describe('#1979 filterIncidents — only the three counted components', () => {
  const kept = (componentNames: string[]) => filterIncidents([inc({ componentNames })], lyceum).length === 1

  it.each(['Model Inference', 'Serverless Inference API', 'API Gateway'])('keeps a %s incident', (name) => {
    expect(kept([name])).toBe(true)
  })

  it('keeps an incident that spans a counted and an uncounted component', () => {
    expect(kept(['Dashboard', 'API Gateway'])).toBe(true)
  })

  it.each(['Dashboard', 'Website', 'Docs'])('drops a %s-only incident', (name) => {
    expect(kept([name])).toBe(false)
  })

  it('drops an untagged incident (it names no counted component)', () => {
    expect(kept([])).toBe(false)
  })
})

describe('#1979 instatusUptimeScope', () => {
  const page = Object.entries(NAMES).map(([id, name]) => ({ id, name }))

  afterEach(() => vi.restoreAllMocks())

  it('without the flag, the single statusComponent', () => {
    expect(instatusUptimeScope({ id: 'x', statusComponent: 'API' }, page)).toBe('API')
  })

  it('with the flag, the names of the configured ids found on the page, in config order', () => {
    expect(instatusUptimeScope(lyceum, page)).toEqual(['Model Inference', 'Serverless Inference API', 'API Gateway'])
  })

  it('an id missing from the page is left out of the scope', () => {
    expect(instatusUptimeScope(lyceum, page.filter((c) => c.id !== SERVERLESS_ID))).toEqual(['Model Inference', 'API Gateway'])
  })

  it('no id resolving falls back to statusComponent and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(instatusUptimeScope(lyceum, [])).toBe('Model Inference')
    expect(warn.mock.calls.flat().join(' ')).toContain('falling back to statusComponent')
  })

  it('the flag with no displayComponentIds warns and keeps statusComponent', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(instatusUptimeScope({ id: 'x', statusComponent: 'API', uptimeOverDisplayComponents: true }, page)).toBe('API')
    expect(warn.mock.calls.flat().join(' ')).toContain('has no displayComponentIds')
  })
})

describe('#1979 parseInstatusUptime — a multi-component scope is the worst of its components', () => {
  // Midday, so `todayWeightedOutageSec` measures a non-empty window.
  const NOW = Date.parse('2026-11-13T12:00:00Z')
  const DAY = 86_400_000
  const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString()
  const compDef = (id: string, name: string) =>
    `\\"id\\":\\"${id}\\",\\"name\\":{\\"default\\":\\"${name}\\"},\\"nameHtml\\":{\\"default\\":\\"\\u003cp\\u003e${name}\\u003c/p\\u003e\\"},\\"group\\":null,\\"children\\":[],`
  const outage = (fromDaysAgo: number, hours: number, status: string) => {
    const from = iso(fromDaysAgo)
    const to = new Date(Date.parse(from) + hours * 3_600_000).toISOString()
    return `{\\"from\\":\\"${from}\\",\\"to\\":\\"${to}\\",\\"status\\":\\"${status}\\"}`
  }
  const wrap = (escaped: string) => `<script>self.__next_f.push([1,"${escaped}"])</script>`
  const html = () => wrap(
    compDef('cidmodel', 'Model Inference') + compDef('cidserverless', 'Serverless Inference API') + compDef('cidgateway', 'API Gateway') +
    '\\"componentsUptime\\":{' +
      `\\"cidmodel\\":{\\"outages\\":[${outage(9, 2, 'MAJOROUTAGE')}],\\"uptime\\":\\"99.9\\"},` +
      '\\"cidserverless\\":{\\"outages\\":[],\\"uptime\\":\\"100\\"},' +
      `\\"cidgateway\\":{\\"outages\\":[${outage(5, 24, 'MAJOROUTAGE')}],\\"uptime\\":\\"96.8\\"}}`,
  )
  const SCOPE = ['Model Inference', 'Serverless Inference API', 'API Gateway']

  it('returns the worst component, not the first', () => {
    const gateway = parseInstatusUptime(html(), 'API Gateway', NOW)!
    const model = parseInstatusUptime(html(), 'Model Inference', NOW)!
    const many = parseInstatusUptime(html(), SCOPE, NOW)!
    expect(model.pct).toBeGreaterThan(gateway.pct)
    expect(many.pct).toBe(gateway.pct)
  })

  it('moves when only the LAST component has an outage (the first-component read would not)', () => {
    expect(parseInstatusUptime(html(), 'Model Inference', NOW)!.pct).toBeGreaterThan(parseInstatusUptime(html(), SCOPE, NOW)!.pct)
  })

  it('worst-of\'s todayWeightedOutageSec independently of pct', () => {
    const todayHtml = wrap(
      compDef('cidmodel', 'Model Inference') + compDef('cidgateway', 'API Gateway') +
      '\\"componentsUptime\\":{' +
        `\\"cidmodel\\":{\\"outages\\":[${outage(0.25, 1, 'MAJOROUTAGE')}],\\"uptime\\":\\"100\\"},` +
        `\\"cidgateway\\":{\\"outages\\":[${outage(20, 24, 'MAJOROUTAGE')}],\\"uptime\\":\\"96.8\\"}}`,
    )
    const many = parseInstatusUptime(todayHtml, ['Model Inference', 'API Gateway'], NOW)!
    expect(many.pct).toBe(parseInstatusUptime(todayHtml, 'API Gateway', NOW)!.pct)
    expect(many.todayWeightedOutageSec).toBe(parseInstatusUptime(todayHtml, 'Model Inference', NOW)!.todayWeightedOutageSec)
    expect(many.todayWeightedOutageSec).toBeGreaterThan(0)
  })

  it('a member with no uptime figure is skipped, and the partial scope warns', () => {
    __resetInstatusUptimeWarnings()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(parseInstatusUptime(html(), ['Serverless Inference API', 'Renamed Away'], NOW)?.pct).toBe(100)
      expect(warn.mock.calls.flat().join(' ')).toContain('PARTIAL uptime scope')
    } finally {
      warn.mockRestore()
    }
  })

  it('an all-unresolvable scope is null, not a fabricated 100', () => {
    expect(parseInstatusUptime(html(), ['Renamed Away'], NOW)).toBeNull()
  })

  it('the published-% disclosure stays single-component', () => {
    expect(parseInstatusReportedUptime(html(), 'Serverless Inference API')).toBe(100)
    expect(parseInstatusReportedUptime(html(), 'API Gateway')).toBe(96.8)
  })
})

// ── Wiring: the real lyceum config through the real fetchService path ──

/** The six-component Lyceum payload shape. Clocks are relative to `Date.now()`: `fetchService` passes no
 *  clock down, so a fixed date would age out of the trailing 30 days and fail an unrelated PR later.
 */
function lyceumHtml({ hit = GATEWAY_ID, ongoing = false }: { hit?: string; ongoing?: boolean } = {}) {
  const start = Date.now() - 5 * 86_400_000
  const from = new Date(start).toISOString()
  const to = new Date(start + 24 * 3_600_000).toISOString()
  const component = (id: string, name: string, status: string) =>
    `{\\"id\\":\\"${id}\\",\\"name\\":{\\"default\\":\\"${name}\\"},\\"nameHtml\\":{\\"default\\":\\"\\u003cp\\u003e${name}\\u003c/p\\u003e\\"},` +
    `\\"isCollapsed\\":false,\\"order\\":1,\\"showUptime\\":true,\\"status\\":\\"${status}\\",\\"isParent\\":false,\\"group\\":null,\\"children\\":[]}`
  const ids = Object.keys(NAMES)
  const components = '\\"components\\":[' + ids.map((id) => component(id, NAMES[id], id === hit && ongoing ? 'MAJOROUTAGE' : 'OPERATIONAL')).join(',') + ']'
  const entry = (id: string) => id === hit
    ? `\\"${id}\\":{\\"outages\\":[{\\"from\\":\\"${from}\\",\\"to\\":\\"${to}\\",\\"status\\":\\"MAJOROUTAGE\\"}],\\"uptime\\":\\"96.8\\"}`
    : `\\"${id}\\":{\\"outages\\":[],\\"uptime\\":\\"100\\"}`
  const uptime = '\\"componentsUptime\\":{' + ids.map(entry).join(',') + '}'
  const title = `${NAMES[hit]} degraded`
  const notice =
    `\\"cmw9e788f0dsq0wmzoupnv3kk\\":{\\"id\\":\\"cmw9e788f0dsq0wmzoupnv3kk\\",\\"name\\":{\\"en\\":\\"${title}\\",\\"default\\":\\"${title}\\"},` +
    `\\"impact\\":\\"MAJOROUTAGE\\",\\"started\\":\\"${from}\\",\\"resolved\\":${ongoing ? 'null' : `\\"${to}\\"`},` +
    `\\"status\\":\\"${ongoing ? 'INVESTIGATING' : 'RESOLVED'}\\",\\"components\\":[{\\"id\\":\\"${hit}\\"}]}`
  return `<script>self.__next_f.push([1,"x:${components}:${uptime}:notices\\":{${notice}},\\"metrics\\":{}"])</script>`
}

afterEach(() => vi.unstubAllGlobals())

describe('#1979 wiring — an outage on a counted component reaches incidents, uptime and the badge', () => {
  const stub = (opts?: Parameters<typeof lyceumHtml>[0]) =>
    vi.stubGlobal('fetch', vi.fn(async () => new Response(lyceumHtml(opts), { status: 200 })))

  it('publishes the API Gateway incident', async () => {
    stub()
    const svc = await fetchService(lyceum, undefined, undefined, {})
    expect(svc.incidents.map((i) => i.title)).toContain('API Gateway degraded')
  })

  it('uptime30d follows the worst component instead of Model Inference alone', async () => {
    stub()
    const svc = await fetchService(lyceum, undefined, undefined, {})
    expect(svc.uptime30d).toBeLessThan(100)
    expect(svc.uptimeSource).toBe('official')
  })

  it('withholds the provider-attributed uptimeReported on a multi-component scope', async () => {
    stub()
    const svc = await fetchService(lyceum, undefined, undefined, {})
    expect(svc.uptimeReported).toBeUndefined()
    expect(svc.uptimeReportedDays).toBeUndefined()
  })

  it('an ongoing incident on a counted component degrades the badge', async () => {
    stub({ ongoing: true })
    const svc = await fetchService(lyceum, undefined, undefined, {})
    expect(svc.status).toBe('degraded')
  })

  it('an ongoing incident on the Dashboard changes neither the badge nor the incident list', async () => {
    stub({ hit: DASHBOARD_ID, ongoing: true })
    const svc = await fetchService(lyceum, undefined, undefined, {})
    expect(svc.incidents).toEqual([])
    expect(svc.status).toBe('operational')
    expect(svc.uptime30d).toBe(100)
  })

  it('a resolved-only page stays operational', async () => {
    stub()
    expect((await fetchService(lyceum, undefined, undefined, {})).status).toBe('operational')
  })

  it('falls back to statusComponent and warns when no configured id resolves', async () => {
    // Replacement ids stay cuid-shaped (lowercase alphanumeric), the charset the component map matches.
    const rotated = lyceumHtml()
      .replaceAll(MODEL_ID, 'rotatedmodel001').replaceAll(SERVERLESS_ID, 'rotatedserverless002').replaceAll(GATEWAY_ID, 'rotatedgateway003')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(rotated, { status: 200 })))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const svc = await fetchService(lyceum, undefined, undefined, {})
      expect(warn.mock.calls.flat().join(' ')).toContain('falling back to statusComponent')
      expect(svc.uptime30d).toBe(100)
    } finally {
      warn.mockRestore()
    }
  })

  it('renders the three counted components in the breakdown, not Dashboard, Website or Docs', async () => {
    stub()
    const svc = await fetchService(lyceum, undefined, undefined, {})
    expect(svc.components?.map((c) => c.name)).toEqual(['Model Inference', 'Serverless Inference API', 'API Gateway'])
  })
})
