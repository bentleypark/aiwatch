import { describe, it, expect, vi, afterEach } from 'vitest'
import { applyTitleMap, filterIncidents, tagAutoMonitorIncidents, isAutoMonitorIncident, fetchService, SERVICES } from '../services'
import { shouldHoldNewIncident, FLAP_HOLD_MS } from '../alerts'
import type { Incident, ServiceConfig } from '../types'

// #989 — Kimi: a non-English (Chinese) Atlassian status source whose auto-monitor opens a fresh `critical`
// incident per model-error blip. #1731 — one page, two cards: `kimi` (API) and `kimiapp` (consumer app).

const kimi = SERVICES.find((s) => s.id === 'kimi')!
const kimiapp = SERVICES.find((s) => s.id === 'kimiapp')!

function mkInc(overrides: Partial<Incident> = {}): Incident {
  return {
    id: 'km-1',
    title: 'Agentic 模型错误报警',
    status: 'resolved',
    impact: 'critical',
    startedAt: '2026-07-12T10:00:00.000Z',
    resolvedAt: '2026-07-12T10:04:00.000Z',
    duration: '4m',
    timeline: [],
    ...overrides,
  }
}

describe('kimi config shape (#989/#1731)', () => {
  it('splits status.moonshot.cn: kimi = the SaaS group (api), kimiapp = the Kimi group (app)', () => {
    expect(kimi.category).toBe('api')
    expect(kimiapp.category).toBe('app')
    expect(kimi.addedAt).toBeTruthy()
    expect(kimiapp.addedAt).toBeTruthy()
    expect(kimi.incidentComponentsKeepUntagged).toBeUndefined()
    expect(kimiapp.incidentComponentsKeepUntagged).toBe(true)
    const api = new Set(kimi.incidentComponents!.map((n) => n.toLowerCase()))
    expect(kimiapp.incidentComponents!.filter((n) => api.has(n.toLowerCase()))).toEqual([])
  })

  // status.moonshot.cn components.json, 2026-10-19 (id, name, group header id).
  const PAGE = [
    ['8psr5dfdld0s', 'Open API', '87jpctq5cp71'], ['pjrph68g94yr', 'Open Platform Portal', '87jpctq5cp71'],
    ['sttxgsd2bps7', 'Website', '01l1n50g13g6'], ['ckrtmmv96r2z', 'Sign In / Sign Up', '01l1n50g13g6'],
    ['x3z9ydzr6ywk', 'File uploads', '01l1n50g13g6'], ['smbb3z35s0jl', 'Search', '01l1n50g13g6'],
    ['rf64wcbxt3r2', 'API Service', '01l1n50g13g6'], ['x0zsqgy57b75', 'Model', '01l1n50g13g6'],
    ['8rkd3yj051gl', 'Vision Model', '01l1n50g13g6'], ['lk7q3z0fcylp', 'Thinking Model', '01l1n50g13g6'],
    ['p1j9ttb7jwhp', 'Text Model', '01l1n50g13g6'], ['wmn9wzv84k1v', 'Research Model', '01l1n50g13g6'],
    ['z2zfp65lvb2z', 'K2 Model', '01l1n50g13g6'],
  ] as const
  const GROUP_HEADERS = ['87jpctq5cp71', '01l1n50g13g6', 'cyrtlddz0q8c'] // SaaS, Kimi, Kimi Code
  const nameOf = new Map<string, string>(PAGE.map(([id, name]) => [id, name]))

  it('each card names exactly its group members, and its ids are those same components', () => {
    const members = (group: string) => PAGE.filter(([, , g]) => g === group)
    expect([...kimi.incidentComponents!, ...kimi.referenceComponentIds!.map((id) => nameOf.get(id))]).toEqual(members('87jpctq5cp71').map(([, n]) => n))
    expect([kimi.statusComponentId, ...kimi.referenceComponentIds!]).toEqual(members('87jpctq5cp71').map(([id]) => id))
    expect(kimiapp.incidentComponents).toEqual(members('01l1n50g13g6').map(([, n]) => n))
    expect(kimiapp.statusComponentIds!.map((id) => nameOf.get(id))).toEqual(kimiapp.incidentComponents)
  })

  it('kimiapp keeps the sibling card and every group header out of its roster audit', () => {
    const expected = [kimi.statusComponentId!, ...kimi.referenceComponentIds!, ...GROUP_HEADERS]
    expect([...kimiapp.rosterAuditExclude!].sort()).toEqual(expected.sort())
  })

  it('kimi badges Open API and carries Open Platform Portal as reference (#1821); kimiapp badges the worst-of its group', () => {
    expect(kimi.statusComponentId).toBe('8psr5dfdld0s')
    expect(kimi.statusComponentIds).toBeUndefined()
    expect(kimi.displayComponentIds).toBeUndefined()
    expect(kimi.referenceComponentIds).toEqual(['pjrph68g94yr'])
    expect(kimiapp.statusComponentIds).toHaveLength(kimiapp.incidentComponents!.length)
    expect(kimiapp.statusComponentIds).toContain(kimiapp.statusComponentId)
    expect(kimiapp.displayComponentIds).toEqual(kimiapp.statusComponentIds)
    expect(kimiapp.statusComponentIds).not.toContain('8psr5dfdld0s')
  })

  it('kimiapp folds the six model components under "Models"', () => {
    const groups = kimiapp.componentGroups!
    expect(Object.values(groups).filter((g) => g === 'Models')).toHaveLength(6)
    expect(Object.keys(groups).every((id) => kimiapp.displayComponentIds!.includes(id))).toBe(true)
  })

  it('the machine alarm is tagged on kimiapp only; neither card sets holdShortIncidents (inert for critical)', () => {
    expect(kimiapp.autoMonitorTitles?.length).toBeGreaterThan(0)
    expect(kimi.autoMonitorTitles).toBeUndefined()
    expect(kimi.titleMap).toBe(kimiapp.titleMap)
    for (const c of [kimi, kimiapp]) {
      expect(c.holdShortIncidents).toBeUndefined()
      expect(c.flapSuppression).toBeUndefined()
    }
  })
})

describe('applyTitleMap (#989)', () => {
  it('rewrites a mapped title to English', () => {
    expect(applyTitleMap([mkInc()], kimi)[0].title).toBe('Agentic model error alert')
    expect(applyTitleMap([mkInc({ title: '搜索请求出现大量报错' })], kimi)[0].title).toBe('Elevated search request error rate')
  })

  it('matches case- and whitespace-insensitively — every autoMonitorTitles variant translates (#989 review)', () => {
    // The recognition set must be at least as wide as the `autoMonitorTitles` regex (/i + \s*), else a
    // tagged variant leaks untranslated. Uppercase, extra spaces, and no-space all map to the English.
    for (const variant of ['AGENTIC 模型错误报警', 'Agentic  模型错误报警', 'agentic模型错误报警', '  aGeNtIc模型错误报警 ']) {
      expect(applyTitleMap([mkInc({ title: variant })], kimi)[0].title, variant).toBe('Agentic model error alert')
    }
  })

  it('the known machine-alarm variants are both tagged AND translated (no tagged-but-untranslated leak)', () => {
    // Pin the two sets together: a title the tagger stamps `autoMonitor` MUST translate, or Chinese
    // leaks to Discord/dashboard. Drive real machine variants through the map and assert no CJK remains.
    for (const t of ['Agentic 模型错误报警', 'agentic模型错误报警']) {
      expect(isAutoMonitorIncident(mkInc({ title: t }), kimiapp)).toBe(true)          // tagger matches
      expect(/[㐀-鿿]/.test(applyTitleMap([mkInc({ title: t })], kimi)[0].title)).toBe(false) // …and it translated
    }
  })

  it('the availability-low alarm is tagged AND translated, in every spacing/casing variant', () => {
    for (const t of ['API 服务可用性低', 'API服务可用性低', 'api 服务可用性低']) {
      expect(isAutoMonitorIncident(mkInc({ title: t }), kimiapp), t).toBe(true)
      expect(applyTitleMap([mkInc({ title: t })], kimi)[0].title, t).toBe('API service availability low')
    }
  })

  it('the Google sign-in incident is translated but stays untagged (a human-written singleton)', () => {
    for (const t of ['google登录异常', 'Google登录异常']) {
      expect(applyTitleMap([mkInc({ title: t })], kimi)[0].title, t).toBe('Google login failure')
      expect(isAutoMonitorIncident(mkInc({ title: t }), kimiapp), t).toBe(false)
    }
  })

  it('a human-written API incident is NOT swept up by the availability-low pattern', () => {
    for (const t of ['开放平台 API 服务异常', 'API 服务可用性低于预期说明', 'Kimi API 服务可用性低']) {
      expect(isAutoMonitorIncident(mkInc({ title: t }), kimiapp), t).toBe(false)
    }
  })

  it('passes an UNMAPPED title through unchanged — never drops it', () => {
    const out = applyTitleMap([mkInc({ title: 'A brand-new human-written incident' })], kimi)
    expect(out).toHaveLength(1)
    expect(out[0].title).toBe('A brand-new human-written incident')
  })

  it('is identity for a service with no titleMap (same reference)', () => {
    const noMap = { id: 'x', name: 'X' } as unknown as ServiceConfig
    const arr = [mkInc()]
    expect(applyTitleMap(arr, noMap)).toBe(arr)
  })

  it('every titleMap key is already normalized enough to be reachable (no stray-whitespace dead key)', () => {
    // A config key authored with leading/trailing/oddly-collapsed whitespace would still be reachable
    // via the normalized lookup, but a key that differs from its own trim is an authoring smell.
    for (const key of Object.keys(kimi.titleMap!)) {
      expect(key, `titleMap key "${key}" has stray edge whitespace`).toBe(key.trim())
    }
  })

  it('warns on an UNMAPPED CJK title — even a real (non-autoMonitor) gateway incident (#989 review)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // A genuine Chinese incident the map lacks, NOT machine-tagged — the class most worth surfacing.
    applyTitleMap([mkInc({ title: '网络连接超时', autoMonitor: undefined, impact: 'major' })], kimi)
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0][0]).toContain('not in titleMap')
    warn.mockRestore()
  })

  it('does NOT warn when an unmapped title is plain ASCII (a human English incident)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    applyTitleMap([mkInc({ title: 'A brand-new English incident' })], kimi)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('filterIncidents → applyTitleMap ordering (#989 / #940 guard)', () => {
  // Kimi itself has no incidentExclude, so it cannot exercise the ordering (filterIncidents is a
  // pass-through for it). A SYNTHETIC config with BOTH a titleMap and an incidentExclude whose token
  // lives in the CHINESE original but NOT the English mapping makes the order observable: the two
  // orders give DIFFERENT results, so a swap is caught.
  const cfg = {
    id: 'synthetic', name: 'S',
    titleMap: { '维护通知': 'Maintenance notice', '正常事件': 'Normal event' },
    incidentExclude: ['维护'], // token lives in '维护通知' (Chinese) but not its English mapping
  } as unknown as ServiceConfig

  it('order matters: filter-first drops the excluded incident; map-first would wrongly keep it', () => {
    const inc = mkInc({ id: 'x', title: '维护通知' })
    // CORRECT (production order): filter on the original → the 维护 token drops it.
    expect(applyTitleMap(filterIncidents([inc], cfg), cfg)).toHaveLength(0)
    // WRONG (swapped): map first → English 'Maintenance notice' no longer contains 维护 → survives.
    expect(filterIncidents(applyTitleMap([inc], cfg), cfg).map((i) => i.id)).toEqual(['x'])
  })

  it('a non-excluded incident survives the filter and is then translated', () => {
    const out = applyTitleMap(
      filterIncidents([mkInc({ id: 'drop', title: '维护通知' }), mkInc({ id: 'keep', title: '正常事件' })], cfg),
      cfg,
    )
    expect(out.map((i) => i.id)).toEqual(['keep']) // '维护通知' dropped on the original token
    expect(out[0].title).toBe('Normal event')      // survivor translated by the map
  })
})

describe('autoMonitor tagging of the machine alarm (#989)', () => {
  it('tags BOTH casing/spacing variants of the Agentic alarm, but not a human singleton', () => {
    const tagged = tagAutoMonitorIncidents(
      [
        mkInc({ id: 'a', title: 'Agentic 模型错误报警' }),   // spaced, capital A
        mkInc({ id: 'b', title: 'agentic模型错误报警' }),     // no space, lowercase
        mkInc({ id: 'c', title: '短信登录异常' }),             // SMS-login singleton — NOT a machine alarm
      ],
      kimiapp,
    )
    expect(tagged[0].autoMonitor).toBe(true)
    expect(tagged[1].autoMonitor).toBe(true)
    expect(tagged[2].autoMonitor).toBeUndefined()
  })
})

// The pure helpers above are the "tested twin"; the REAL /api/status path is fetchService, which
// runs tag THEN titleMap. This drives that path end-to-end — the guard that caught the live bug where
// titleMap ran before tagging, leaving the Chinese autoMonitorTitles patterns to match already-English
// titles (tag silently never applied → grouping + Score-exclusion both broke). (#989 / #966 / #940)
describe('fetchService applies tag AND titleMap in the right order (#989 — real call path)', () => {
  afterEach(() => { vi.restoreAllMocks() })

  const spInc = (id: string, name: string, components: string[] = []) => ({
    id, name, status: 'resolved', impact: 'critical',
    created_at: '2026-07-12T10:00:00.000Z', started_at: '2026-07-12T10:00:00.000Z',
    resolved_at: '2026-07-12T10:04:00.000Z', updated_at: '2026-07-12T10:04:00.000Z',
    incident_updates: [{ status: 'resolved', body: 'Error rate returned to normal.', created_at: '2026-07-12T10:04:00.000Z' }],
    components: components.map((n) => ({ id: `c-${n}`, name: n })),
  })

  // Real titles + component tags from status.moonshot.cn incidents.json (2026-10-19), plus the untagged
  // Agentic alarm (verified 2026-07-18, #989) and an SMS-login incident (a #989 titleMap title).
  const pageIncidents = [
    spInc('a1', 'Agentic 模型错误报警'),
    spInc('a2', 'agentic模型错误报警'),
    spInc('h1', '短信登录异常', ['Sign In / Sign Up']),
    spInc('f1', 'kimi fs服务异常', ['File uploads']),
    spInc('o1', '开放平台 API 服务异常', ['Open API']),
  ]
  const fetchCard = (config: ServiceConfig) => {
    const summary = {
      status: { indicator: 'none', description: 'All Systems Operational' },
      components: [
        { id: '8psr5dfdld0s', name: 'Open API', status: 'operational' },
        { id: 'sttxgsd2bps7', name: 'Website', status: 'operational' },
        { id: 'smbb3z35s0jl', name: 'Search', status: 'operational' },
      ],
      incidents: pageIncidents,
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
    return fetchService(config, { summary: summary as never, incidents: null }, undefined, {})
  }
  const fetchKimi = () => fetchCard(kimiapp)

  it('each page incident lands on exactly one card: Open API on kimi, the rest (untagged included) on kimiapp', async () => {
    const api = (await fetchCard(kimi)).incidents.map((i) => i.id).sort()
    const app = (await fetchCard(kimiapp)).incidents.map((i) => i.id).sort()
    expect(api).toEqual(['o1'])
    expect(app).toEqual(['a1', 'a2', 'f1', 'h1'])
  })

  it('tags the machine alarm as autoMonitor=true AND renders its title in English', async () => {
    const svc = await fetchKimi()
    const machine = svc.incidents.filter((i) => i.title === 'Agentic model error alert')
    expect(machine).toHaveLength(2)                                   // both Chinese variants → one English title
    expect(machine.every((i) => i.autoMonitor === true)).toBe(true)  // ← the assertion the order bug failed
  })

  it('leaves the human singleton untagged, still title-mapped to English', async () => {
    const svc = await fetchKimi()
    const human = svc.incidents.find((i) => i.title === 'SMS login failure')
    expect(human).toBeDefined()
    expect(human!.autoMonitor).toBeUndefined()
  })

  it('leaks NO Chinese text into any served title (titleMap actually ran)', async () => {
    const svc = await fetchKimi()
    expect(svc.incidents).toHaveLength(4)
    expect(svc.incidents.every((i) => !/[一-鿿]/.test(i.title))).toBe(true)
    expect((await fetchCard(kimi)).incidents.map((i) => i.title)).toEqual(['Open Platform API service disruption'])
  })
})

// #1821 — Open Platform Portal is the console (platform.kimi.com: login, API keys, workbench), not the API.
describe('kimi carries an Open Platform Portal-only incident as reference (#1821)', () => {
  afterEach(() => { vi.restoreAllMocks() })

  const inc = (id: string, components: [string, string][]) => ({
    id, name: '开放平台控制台异常', status: 'resolved', impact: 'minor',
    created_at: '2026-10-19T10:00:00.000Z', started_at: '2026-10-19T10:00:00.000Z',
    resolved_at: '2026-10-19T10:30:00.000Z', updated_at: '2026-10-19T10:30:00.000Z',
    incident_updates: [{ status: 'resolved', body: 'Resolved.', created_at: '2026-10-19T10:30:00.000Z' }],
    components: components.map(([cid, name]) => ({ id: cid, name })),
  })
  const PORTAL: [string, string] = ['pjrph68g94yr', 'Open Platform Portal']
  const OPEN_API: [string, string] = ['8psr5dfdld0s', 'Open API']
  const fetchCard = (config: ServiceConfig, portalStatus: string) => {
    const summary = {
      status: { indicator: 'minor', description: 'Minor Service Outage' },
      components: [
        { id: OPEN_API[0], name: OPEN_API[1], status: 'operational' },
        { id: PORTAL[0], name: PORTAL[1], status: portalStatus },
      ],
      incidents: [inc('p1', [PORTAL]), inc('b1', [PORTAL, OPEN_API])],
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
    return fetchService(config, { summary: summary as never, incidents: null }, undefined, {})
  }

  it('the Portal-only incident is reference on kimi; one also tagged Open API stays counted', async () => {
    const svc = await fetchCard(kimi, 'operational')
    expect(svc.incidents.map((i) => i.id)).toEqual(['b1'])
    expect(svc.referenceIncidents?.map((i) => i.id)).toEqual(['p1'])
  })

  it('a Portal outage leaves the kimi badge on Open API', async () => {
    expect((await fetchCard(kimi, 'major_outage')).status).toBe('operational')
  })

  it('kimiapp counts neither', async () => {
    expect((await fetchCard(kimiapp, 'operational')).incidents).toEqual([])
  })
})

// #1731 — Moonshot files every auto-monitor alarm as `critical`. On `kimiapp` the search alarm's
// component is in the badge group, so a live one reaches the card; before the flag it alerted on first
// sight every time (reproduced with this same fixture at Search = major_outage / partial_outage /
// degraded_performance).
describe('kimiapp holds Moonshot\'s critical auto-monitor alarms (#1731)', () => {
  afterEach(() => { vi.restoreAllMocks() })

  const T0 = Date.parse('2026-10-19T10:00:00.000Z')
  const live = (name: string, components: string[]) => ({
    id: 'live-1', name, status: 'investigating', impact: 'critical',
    created_at: '2026-10-19T10:00:00.000Z', started_at: '2026-10-19T10:00:00.000Z', resolved_at: null, updated_at: '2026-10-19T10:00:00.000Z',
    incident_updates: [{ status: 'investigating', body: '搜索请求报错率超过20%，持续超过1分钟', created_at: '2026-10-19T10:00:00.000Z' }],
    components: components.map((n) => ({ id: `c-${n}`, name: n })),
  })
  const onCard = async (name: string) => {
    const summary = {
      status: { indicator: 'critical', description: 'Partial outage' },
      components: [
        { id: 'sttxgsd2bps7', name: 'Website', status: 'operational' },
        { id: 'smbb3z35s0jl', name: 'Search', status: 'partial_outage' },
      ],
      incidents: [live(name, ['Search'])],
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
    const svc = await fetchService(kimiapp, { summary: summary as never, incidents: null }, undefined, {})
    expect(svc.status).toBe('degraded')
    return svc.incidents.find((i) => i.id === 'live-1')!
  }
  const heldAt = (inc: Incident, firstSeenMs: number | null, nowMs: number, config: ServiceConfig = kimiapp) =>
    shouldHoldNewIncident(config.id, config, inc, { alreadyAlerted: false, firstSeenMs, nowMs })

  it('the live search alarm is tagged, held on first sight and inside FLAP_HOLD_MS, then alerts', async () => {
    const inc = await onCard('搜索请求出现大量报错')
    expect(inc.autoMonitor).toBe(true)
    expect(heldAt(inc, null, T0)).toBe(true)
    expect(heldAt(inc, T0, T0 + FLAP_HOLD_MS - 1)).toBe(true)
    expect(heldAt(inc, T0, T0 + FLAP_HOLD_MS)).toBe(false)
  })

  it('the file-service alarm is tagged too', () => {
    expect(isAutoMonitorIncident({ title: 'kimi fs服务异常' }, kimiapp)).toBe(true)
  })

  it('a human-written critical incident on kimiapp still alerts on first sight', async () => {
    const inc = await onCard('Kimi 服务全面中断')
    expect(inc.autoMonitor).toBeUndefined()
    expect(heldAt(inc, null, T0)).toBe(false)
  })

  it('without the flag, a tagged critical alarm still alerts on first sight', async () => {
    const inc = await onCard('搜索请求出现大量报错')
    const { autoMonitorCriticalHoldable: _, ...noFlag } = kimiapp
    expect(heldAt(inc, null, T0, noFlag as ServiceConfig)).toBe(false)
  })
})

// #2046 — live 2026-11-19: sz25kxdwy6rs (17:25:13 CST) and 73z033sjrlnd (18:25:14 CST), both open,
// `critical`, component `API Service`.
describe('kimiapp tags the open availability-low alarm so repeats can group (#2046)', () => {
  afterEach(() => { vi.restoreAllMocks() })

  const T0 = Date.parse('2026-11-19T09:25:14.000Z')
  const alarm = (id: string, createdAt: string) => ({
    id, name: 'API 服务可用性低', status: 'investigating', impact: 'critical',
    created_at: createdAt, started_at: createdAt, resolved_at: null, updated_at: createdAt,
    incident_updates: [{ status: 'investigating', body: 'API 服务可用性低，可能会影响您的使用体验', created_at: createdAt }],
    components: [{ id: 'rf64wcbxt3r2', name: 'API Service' }],
  })
  const fetchOpenAlarms = async () => {
    const summary = {
      status: { indicator: 'critical', description: 'Partial outage' },
      components: [
        { id: 'sttxgsd2bps7', name: 'Website', status: 'operational' },
        { id: 'rf64wcbxt3r2', name: 'API Service', status: 'major_outage' },
      ],
      incidents: [
        alarm('sz25kxdwy6rs', '2026-11-19T17:25:13.773+08:00'),
        alarm('73z033sjrlnd', '2026-11-19T18:25:14.424+08:00'),
      ],
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
    return fetchService(kimiapp, { summary: summary as never, incidents: null }, undefined, {})
  }

  it('both open incidents land on kimiapp, tagged and in English', async () => {
    const svc = await fetchOpenAlarms()
    expect(svc.incidents.map((i) => i.id).sort()).toEqual(['73z033sjrlnd', 'sz25kxdwy6rs'])
    expect(svc.incidents.every((i) => i.autoMonitor === true)).toBe(true)
    expect(svc.incidents.every((i) => i.title === 'API service availability low')).toBe(true)
  })

  it('neither lands on the kimi API card', async () => {
    const summary = {
      status: { indicator: 'critical', description: 'Partial outage' },
      components: [{ id: '8psr5dfdld0s', name: 'Open API', status: 'operational' }],
      incidents: [alarm('sz25kxdwy6rs', '2026-11-19T17:25:13.773+08:00')],
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
    expect((await fetchService(kimi, { summary: summary as never, incidents: null }, undefined, {})).incidents).toEqual([])
  })

  it('the alert hold is bounded: held inside FLAP_HOLD_MS, fires once the incident has been seen that long', async () => {
    const inc = (await fetchOpenAlarms()).incidents[0]
    const held = (firstSeenMs: number | null, nowMs: number) =>
      shouldHoldNewIncident(kimiapp.id, kimiapp, inc, { alreadyAlerted: false, firstSeenMs, nowMs })
    expect(held(null, T0)).toBe(true)
    expect(held(T0, T0 + FLAP_HOLD_MS - 1)).toBe(true)
    expect(held(T0, T0 + FLAP_HOLD_MS)).toBe(false)
  })
})
