import { describe, it, expect, vi, afterEach } from 'vitest'
import { filterIncidents, canIdBypass, fetchService, SERVICES } from '../services'
import { attachIncidentIoComponentIds } from '../parsers/incident-io'
import { buildIncidentAlerts } from '../alerts'
import type { Incident, ServiceConfig } from '../types'

// #1032 — status.openai.com carries TWO components both literally named "Login": one in the APIs group
// (openai's badge) and one in the ChatGPT group (chatgpt's badge). On 2026-07-16 OpenAI opened
// "Elevated Error Rates For SSO Login" and tagged BOTH. openai's badge went `degraded` off its own
// API-group Login, but openai's 'login' title exclude vetoed the incident → a degraded card with an
// empty incident list. Names cannot fix this (both are 'Login'); only the component IDS disambiguate.
//
// Real ULIDs from status.openai.com — the test is worthless with invented ids, since the whole defect
// is that two ids share one name.
const API_LOGIN = '01JSM5RTJWHRWDTS6Q604VEW3B' // "Login", APIs group      → openai.statusComponentIds
const CHATGPT_LOGIN = '01JMXBNJXG1S2D9V65P1ZZTD94' // "Login", ChatGPT group → chatgpt.statusComponentIds
const SORA = '01K9G527YRPY1EFRMHTKB5BKT5' // "Sora"    → openai.statusComponentIds AND displayComponentIds
const FEDRAMP = '01KKAD7C71MCCH3FTREMJH4AAS' // "FedRAMP" → in NO service's statusComponentIds

/** Uses the REAL SERVICES config so a future edit to the excludes/badge groups fails loudly here. */
const cfg = (id: string): ServiceConfig => {
  const c = SERVICES.find((s) => s.id === id)
  if (!c) throw new Error(`missing SERVICES config: ${id}`)
  return c
}

/** An incident exactly as the incident.io v2 API yields it: componentNames ALWAYS absent (#1004). */
const apiIncident = (id: string, title: string, componentIds?: string[]): Incident => ({
  id,
  title,
  status: 'identified',
  impact: 'minor',
  startedAt: '2026-07-16T08:36:46Z',
  duration: null,
  timeline: [],
  ...(componentIds ? { componentIds } : {}),
})

const impact = (incidentId: string, componentId: string) =>
  `{\\"component_id\\":\\"${componentId}\\",\\"end_at\\":\\"$undefined\\",\\"id\\":\\"IMP${componentId.slice(-4)}\\",` +
  `\\"start_at\\":\\"2026-07-16T08:36:46Z\\",\\"status\\":\\"degraded_performance\\",\\"status_page_incident_id\\":\\"${incidentId}\\"}`

const pageHtml = (impacts: string[]) =>
  `<script>self.__next_f.push([1,"a:{\\"component_impacts\\":[${impacts.join(',')}],` +
  `\\"component_uptimes\\":[],\\"incident_links\\":[]}"])</script>`

describe('the config contradiction #1032 fixes (pins the premise)', () => {
  it('the two "Login" components live in DIFFERENT services badge groups — so a name can never disambiguate', () => {
    expect(cfg('openai').statusComponentIds).toContain(API_LOGIN)
    expect(cfg('openai').statusComponentIds).not.toContain(CHATGPT_LOGIN)
    expect(cfg('chatgpt').statusComponentIds).toContain(CHATGPT_LOGIN)
    expect(cfg('chatgpt').statusComponentIds).not.toContain(API_LOGIN)
  })

  it('openai excludes "login" by title yet its badge is driven by the API-group Login component', () => {
    // Exactly the contradiction: the same component both drives the badge and silences the incident.
    expect(cfg('openai').incidentExclude).toContain('login')
    expect(cfg('openai').statusComponentIds).toContain(API_LOGIN)
  })

  it('openai has no statusComponent NAME, so the #359 name-keyed bypass cannot fire for it', () => {
    expect(cfg('openai').statusComponent).toBeUndefined()
  })

  it('the FedRAMP component belongs to NO service badge group (the #990 bypass firewall)', () => {
    for (const id of ['openai', 'chatgpt', 'codex']) {
      expect(cfg(id).statusComponentIds ?? []).not.toContain(FEDRAMP)
    }
  })
})

describe('filterIncidents — id-keyed exclude-bypass (#1032)', () => {
  const sso = (componentIds?: string[]) =>
    apiIncident('01KXN14DD3EYYJ6PJ9M736WDSV', 'Elevated Error Rates For SSO Login', componentIds)

  it('openai: KEEPS the SSO Login incident once OpenAI tags it onto the API-group Login (the bug)', () => {
    const kept = filterIncidents([sso([CHATGPT_LOGIN, API_LOGIN])], cfg('openai'))
    expect(kept.map((i) => i.id)).toEqual(['01KXN14DD3EYYJ6PJ9M736WDSV'])
  })

  it('openai: still DROPS it when the tags name only the ChatGPT Login (bypass is scoped, not a blanket off-switch)', () => {
    // The test that separates "fixed" from "broke the exclude": a ChatGPT-only login incident must
    // still be vetoed on openai even though it now carries component tags.
    expect(filterIncidents([sso([CHATGPT_LOGIN])], cfg('openai'))).toHaveLength(0)
  })

  it('openai: still DROPS it when untagged — no HTML ⇒ no bypass ⇒ today behaviour (fail-closed)', () => {
    expect(filterIncidents([sso()], cfg('openai'))).toHaveLength(0)
  })

  it('chatgpt: keeps it as before, via the login keyword (unchanged)', () => {
    expect(filterIncidents([sso([CHATGPT_LOGIN, API_LOGIN])], cfg('chatgpt'))).toHaveLength(1)
  })

  it('openai: KEEPS a Sora API incident tagged onto the Sora component it already badges', () => {
    // Same defect class as Login: 'sora' is excluded by title while the Sora component sits in
    // openai's statusComponentIds AND displayComponentIds, so it already moves the badge.
    const sora = apiIncident('SORA1', 'Elevated Errors for Sora API', [SORA])
    expect(filterIncidents([sora], cfg('openai')).map((i) => i.id)).toEqual(['SORA1'])
  })

  it('#990 non-regression: the FedRAMP kitchen-sink advisory stays dropped on chatgpt + codex even when tagged', () => {
    const kitchenSink = apiIncident(
      'FED1',
      'Codex, workspace analytics, conversation search, searching for custom GPTs, ChatGPT user invites, ' +
        'and Compliance Log Platform download endpoint not working in FedRAMP workspaces',
      [FEDRAMP],
    )
    expect(filterIncidents([kitchenSink], cfg('chatgpt'))).toHaveLength(0)
    expect(filterIncidents([kitchenSink], cfg('codex'))).toHaveLength(0)
  })

  it('#693 non-regression: an EXCLUDE-matching FedRAMP title tagged onto openai badge components still surfaces', () => {
    // NOT the plain "FedRAMP workspaces and API orgs…" title — that matches none of openai's excludes,
    // so it never enters the bypass branch and would pass with the bypass present, absent, or wrong
    // (a vacuous guard; the real #693 case is covered in filter-incidents.test.ts). This variant carries
    // a 'login' exclude hit AND badge-group tags, so it exercises the branch #1032 actually added.
    const fedrampApi = apiIncident('FED2', 'FedRAMP login errors for API orgs', [API_LOGIN])
    expect(filterIncidents([fedrampApi], cfg('openai')).map((i) => i.id)).toEqual(['FED2'])
  })

  it('a service with an exclude but no badge group (elevenlabs) is unreachable by the bypass', () => {
    expect(cfg('elevenlabs').statusComponentIds).toBeUndefined()
    const webpage = apiIncident('EL1', 'Webpage outage', [API_LOGIN])
    expect(filterIncidents([webpage], cfg('elevenlabs'))).toHaveLength(0)
  })
})

describe('attachIncidentIoComponentIds (#1032)', () => {
  it('tags the ids the JSON API omits, from the page component_impacts', () => {
    const html = pageHtml([impact('INC1', CHATGPT_LOGIN), impact('INC1', API_LOGIN)])
    const out = attachIncidentIoComponentIds([apiIncident('INC1', 'SSO Login errors')], html)
    expect(out[0].componentIds).toEqual([CHATGPT_LOGIN, API_LOGIN])
  })

  it('NEVER writes componentNames — the shape-A invariant #970/includeUntaggedIncidents depend on', () => {
    // componentNames staying empty is a SIGNAL elsewhere (filterByComponentStatus #970 drops untagged
    // impact:none incidents; includeUntaggedIncidents force-adds untagged ones). Writing it here would
    // silently flip behaviour on langsmith/langfuse, which have no stake in #1032.
    const html = pageHtml([impact('INC1', API_LOGIN)])
    const out = attachIncidentIoComponentIds([apiIncident('INC1', 'x')], html)
    expect(out[0].componentNames).toBeUndefined()
  })

  it('leaves an incident the page has no impact for untagged (no invention)', () => {
    const out = attachIncidentIoComponentIds([apiIncident('INC9', 'Unmapped')], pageHtml([impact('INC1', API_LOGIN)]))
    expect(out[0].componentIds).toBeUndefined()
  })

  it('returns the same array reference when the page carries no impacts (fail-closed, no allocation)', () => {
    const incidents = [apiIncident('INC1', 'x')]
    expect(attachIncidentIoComponentIds(incidents, '<html>nothing</html>')).toBe(incidents)
  })

  it('keeps an id we do not configure — the reader intersects, so it simply never matches', () => {
    const out = attachIncidentIoComponentIds([apiIncident('INC1', 'x')], pageHtml([impact('INC1', FEDRAMP)]))
    expect(out[0].componentIds).toEqual([FEDRAMP])
    expect(filterIncidents(out, cfg('chatgpt'))).toHaveLength(0)
  })
})

// The pure functions above are pinned; the WIRING that invokes them is where #1032 can silently
// evaporate. Both mutations below kept all 2867 tests green before these tests existed, and both
// restore the exact bug (degraded card, empty incident list) with CI fully green — the fail-closed
// design makes the failure a silence, not an error.
describe('#1032 wiring — the mutations that would silently delete the fix', () => {
  it('canIdBypass selects EXACTLY openai/chatgpt/codex from the real SERVICES (config lockstep)', () => {
    // Pins the reachable-set claim the code comment + status-determination.md both make: a config edit
    // that drops openai's statusComponentIds, or refactors incidentExclude, silently empties the fix —
    // this fails loudly instead. Scope note: this asserts the PREDICATE, not the call sites that consume
    // it, so it cannot catch a gate that stops calling it (see the re-fetch test in the fetchService
    // describe for that).
    expect(SERVICES.filter(canIdBypass).map((s) => s.id)).toEqual(['openai', 'chatgpt', 'codex'])
  })

  it('canIdBypass excludes services that lack any one of the three preconditions', () => {
    // exclude but no badge group → unreachable (elevenlabs); badge group but no exclude → unreachable.
    expect(SERVICES.filter((s) => s.incidentExclude?.length && !canIdBypass(s)).map((s) => s.id))
      .toEqual(['claude', 'mistral', 'xai', 'elevenlabs'])
  })

  it('the #1004 names path and the #1032 ids path never both fire for one service', () => {
    // If they ever did, componentNames/componentIds would diverge in length with no positional
    // relationship (the names path DROPS unknown ids, the ids path KEEPS them) — the "two parallel
    // fields invite confusion" trap. True today by config accident, so pin it.
    const tagsNeedHtml = (s: ServiceConfig) => !!(s.incidentComponents && s.incidentIoComponentId)
    expect(SERVICES.filter((s) => tagsNeedHtml(s) && canIdBypass(s))).toEqual([])
  })

  it('end-to-end HTML → attach → filter: the SSO incident survives ONLY when tagged first (#940)', () => {
    // Kills the "move attachIncidentIoComponentIds after filterIncidents" mutation. #940's lesson is
    // that a transform must be proven THROUGH the real filter, not asserted in isolation — the SSO case
    // above is handed pre-tagged componentIds, so it cannot catch a reordering. Here the ids are earned
    // from the page HTML exactly as production earns them.
    const fromApi = [apiIncident('01KXN14DD3EYYJ6PJ9M736WDSV', 'Elevated Error Rates For SSO Login')]
    const html = pageHtml([
      impact('01KXN14DD3EYYJ6PJ9M736WDSV', CHATGPT_LOGIN),
      impact('01KXN14DD3EYYJ6PJ9M736WDSV', API_LOGIN),
    ])
    // Correct order — attach BEFORE filter → openai keeps it.
    expect(filterIncidents(attachIncidentIoComponentIds(fromApi, html), cfg('openai'))).toHaveLength(1)
    // The bug being fixed: untagged (i.e. filter ran first, or no HTML) → openai drops it.
    expect(filterIncidents(fromApi, cfg('openai'))).toHaveLength(0)
  })
})

// Composing the pure functions by hand (above) proves the ORDER is correct when someone calls them in
// that order — it cannot prove fetchService actually does. Discarding `incidents = tagged` at the call
// site, or dropping `idsNeedHtml` from the fetch gate, leaves every test above green while the openai
// card silently reverts to the bug. So drive the REAL fetchService, the same way #983 does for its tag
// (`auto-monitor-tag.test.ts`) after #940 taught that a transform must be proven on the real path.
describe('fetchService applies the id-tag on the real call path (#1032)', () => {
  afterEach(() => { vi.restoreAllMocks() })

  const loginComponent = (id: string) => ({ id, name: 'Login', status: 'degraded_performance' })
  // status.openai.com as incident.io really serves it: components:[] on the incident (#1004), and the
  // incident→component mapping only in the page HTML.
  const summary = {
    status: { indicator: 'minor', description: 'Partial System Degradation' },
    components: [loginComponent(API_LOGIN), loginComponent(CHATGPT_LOGIN)],
    incidents: [{
      id: '01KXN14DD3EYYJ6PJ9M736WDSV',
      name: 'Elevated Error Rates For SSO Login',
      status: 'identified',
      impact: 'minor',
      created_at: '2026-07-16T08:36:46Z',
      started_at: '2026-07-16T08:36:46Z',
      updated_at: '2026-07-16T08:36:46Z',
      incident_updates: [{ status: 'identified', body: 'We have identified elevated errors.', created_at: '2026-07-16T08:36:46Z' }],
      components: [],
    }],
  }
  const html = pageHtml([
    impact('01KXN14DD3EYYJ6PJ9M736WDSV', CHATGPT_LOGIN),
    impact('01KXN14DD3EYYJ6PJ9M736WDSV', API_LOGIN),
  ])

  const fetchOpenai = (uptimeHtml?: string) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
    return fetchService(cfg('openai'), { summary: summary as never, incidents: null, latency: 120, uptimeHtml } as never)
  }

  it('openai surfaces the SSO Login incident — the exact #1032 bug, end to end', async () => {
    const svc = await fetchOpenai(html)
    expect(svc.incidents.map((i) => i.title)).toContain('Elevated Error Rates For SSO Login')
  })

  it('an empty re-fetch body leaves it dropped — fail-closed on the real path, not a silent half-fix', async () => {
    // Precise about what this covers: `fetchOpenai(undefined)` DOES enter the re-fetch, and the uniform
    // stub answers it with an empty 200 → `uptimeHtml = ''` → falsy → no attach. So this is "the
    // re-fetch came back empty", not "no HTML was fetched". The gate itself is covered below.
    const svc = await fetchOpenai(undefined)
    expect(svc.incidents.map((i) => i.title)).not.toContain('Elevated Error Rates For SSO Login')
  })

  it('re-fetches the page HTML when the prefetch supplied none — pins the idsNeedHtml gate itself', async () => {
    // The one test that reaches the `(tagsNeedHtml || idsNeedHtml)` gate: drop `|| idsNeedHtml` and
    // openai stops re-fetching, nothing is tagged, and the bypass dies — every other test here stays
    // green because the uniform empty stub cannot tell "gate ran" from "gate skipped". Narrow blast
    // radius in production (the prefetch normally supplies uptimeHtml, so this governs only the
    // prefetch-failure path) but it fails CLOSED and silently, which is exactly what needs a pin.
    vi.stubGlobal('fetch', vi.fn(async (u: unknown) =>
      new Response(String(u).includes('status.openai.com') && !String(u).includes('/api/') ? html : '', { status: 200 })))
    const svc = await fetchService(cfg('openai'), { summary: summary as never, incidents: null, latency: 1, uptimeHtml: undefined } as never)
    expect(svc.incidents.map((i) => i.title)).toContain('Elevated Error Rates For SSO Login')
  })

  it('the surfaced incident carries componentIds and NOT componentNames (invariant on the real path)', async () => {
    const svc = await fetchOpenai(html)
    const inc = svc.incidents.find((i) => i.id === '01KXN14DD3EYYJ6PJ9M736WDSV')!
    expect(inc.componentIds).toEqual([CHATGPT_LOGIN, API_LOGIN])
    expect(inc.componentNames ?? []).toEqual([])
  })

  it('warns loudly when the impacts array is populated but NOTHING joins (the drift a reference check misses)', async () => {
    // The likeliest upstream drift is `status_page_incident_id` diverging from the v2 API's incident id
    // (#940's id-scheme lesson), NOT the impacts array vanishing — that array also feeds the 30/90-day
    // calendar, so it stays populated from history. Here it is full but keyed to a stale incident id:
    // the map is non-empty, `.map()` allocates a fresh array, and a `tagged === incidents` reference
    // check would stay SILENT while the bypass quietly stops firing. Pin the content check instead.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const staleKeyed = pageHtml([impact('OLD-ID-SCHEME-99', API_LOGIN), impact('OLD-ID-SCHEME-98', CHATGPT_LOGIN)])
    const svc = await fetchOpenai(staleKeyed)
    expect(svc.incidents.map((i) => i.title)).not.toContain('Elevated Error Rates For SSO Login') // bypass didn't fire
    expect(warn.mock.calls.flat().join(' ')).toContain('the #1032 exclude-bypass cannot fire this cycle')
  })

  it('does NOT warn on the healthy path (the alarm must stay quiet in normal operation)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await fetchOpenai(html)
    expect(warn.mock.calls.flat().join(' ')).not.toContain('#1032 exclude-bypass cannot fire')
  })
})

// #1032 makes "openai and chatgpt both hold the same incident id" newly possible. That configuration
// rides existing cross-service machinery (alert grouping by incidentId, AI-analysis sibling copy,
// AnalysisModal's #315 two-pass bucket) — so it must merge, not duplicate.
describe('#1032 — a shared incident must MERGE across openai + chatgpt, not double-fire', () => {
  const svc = (id: string, name: string) => ({
    id, name, provider: 'OpenAI', category: id === 'openai' ? 'api' : 'app', status: 'degraded',
    latency: null, uptime30d: 99.9, lastChecked: '2026-07-16T09:00:00Z',
    incidents: [apiIncident('01KXN14DD3EYYJ6PJ9M736WDSV', 'Elevated Error Rates For SSO Login', [API_LOGIN, CHATGPT_LOGIN])],
    aiwatchScore: 90, scoreGrade: 'A',
  })

  it('fires ONE merged Discord alert naming both surfaces, not one per service', () => {
    const alerts = buildIncidentAlerts(
      [svc('openai', 'OpenAI API'), svc('chatgpt', 'ChatGPT')] as never,
      new Map(), Date.parse('2026-07-16T09:30:00Z'),
    )
    expect(alerts).toHaveLength(1)
    expect(alerts[0].key).toBe('alerted:new:01KXN14DD3EYYJ6PJ9M736WDSV')
    expect(alerts[0].svcIds).toEqual(['openai', 'chatgpt'])
    expect(alerts[0].title).toContain('OpenAI API, ChatGPT')
  })
})
