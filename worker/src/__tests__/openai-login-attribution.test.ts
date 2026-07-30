import { describe, it, expect, vi, afterEach } from 'vitest'
import { filterIncidents, canIdBypass, incidentTagsOwnBadge, fetchService, SERVICES } from '../services'
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

  it('a `fedramp`-titled advisory is admitted to chatgpt by ANY badged id — Login since #693, Compliance API since #1010', () => {
    // The exclude yields to `incidentTagsOwnBadge`, which intersects the WHOLE badge list, so the axis
    // is per-id and not per-domain.
    const COMPLIANCE = '01JNKS9D9S72PMP1938PVFFQN4'
    const title =
      'Codex, workspace analytics, conversation search, searching for custom GPTs, ChatGPT user invites, ' +
      'and Compliance Log Platform download endpoint not working in FedRAMP workspaces'
    expect(cfg('chatgpt').statusComponentIds ?? []).toContain(COMPLIANCE)
    expect(cfg('chatgpt').statusComponentIds ?? []).toContain(CHATGPT_LOGIN)
    expect(filterIncidents([apiIncident('FED3', title, [FEDRAMP, COMPLIANCE])], cfg('chatgpt'))).toHaveLength(1)
    expect(filterIncidents([apiIncident('FED6', title, [FEDRAMP, CHATGPT_LOGIN])], cfg('chatgpt'))).toHaveLength(1)
    // FedRAMP-only tag → still dropped, so the two admissions above are the ids' doing, not the title's.
    expect(filterIncidents([apiIncident('FED4', title, [FEDRAMP])], cfg('chatgpt'))).toHaveLength(0)
    // codex badges neither id, so it is unaffected either way.
    expect(filterIncidents([apiIncident('FED5', title, [FEDRAMP, COMPLIANCE])], cfg('codex'))).toHaveLength(0)
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

// A real openai API-group component, in openai.statusComponentIds — the "main" API component. Used to
// tag a model-named incident onto openai's badge group, the way OpenAI tagged `gpt-4o-mini high error
// rate` onto every API-group component on 2026-07-16.
const OPENAI_API_MAIN = '01JMXBRMFE6N2NNT7DG6XZQ6PW' // openai.statusComponentId + statusComponentIds[0]

describe('incidentTagsOwnBadge — the shared id-axis primitive (#1032/#1038)', () => {
  it('true only when componentIds intersect the badge group of a canIdBypass service', () => {
    expect(incidentTagsOwnBadge(apiIncident('X', 't', [OPENAI_API_MAIN]), cfg('openai'))).toBe(true)
    expect(incidentTagsOwnBadge(apiIncident('X', 't', [SORA]), cfg('openai'))).toBe(true)
  })

  it('false when the tags name only a SIBLING product group (the #1032 collision)', () => {
    expect(incidentTagsOwnBadge(apiIncident('X', 't', [CHATGPT_LOGIN]), cfg('openai'))).toBe(false)
    // API-group Login belongs to openai, NOT chatgpt — the whole reason names cannot decide this.
    expect(incidentTagsOwnBadge(apiIncident('X', 't', [API_LOGIN]), cfg('chatgpt'))).toBe(false)
  })

  it('false for a service outside canIdBypass even if the id would intersect', () => {
    // elevenlabs has an exclude but no badge group → not canIdBypass → the primitive can never fire.
    expect(canIdBypass(cfg('elevenlabs'))).toBe(false)
    expect(incidentTagsOwnBadge(apiIncident('X', 't', [OPENAI_API_MAIN]), cfg('elevenlabs'))).toBe(false)
  })

  it('false when the incident carries no componentIds (fail-closed, no invention)', () => {
    expect(incidentTagsOwnBadge(apiIncident('X', 't'), cfg('openai'))).toBe(false)
  })
})

// Part A — the LIVE defect: a genuine OpenAI API incident dropped by an `incidentKeywords` title-token
// miss. `gpt-4o-mini high error rate` carries no `'api'`/region token and (incident.io #1004) no
// componentNames, yet OpenAI tagged it onto every API-group component. Pre-fix it was dropped here while
// `uptime30d` (read from the same `component_impacts`) fell — the internal contradiction #1038 names.
describe('filterIncidents — id-positive keyword-augment (#1038 Part A)', () => {
  const gpt4oMini = (componentIds?: string[]) =>
    apiIncident('01KMODEL4OMINI0000000000', 'gpt-4o-mini high error rate', componentIds)

  it('premise: the title carries NONE of openai\'s incidentKeywords, so only the id path can keep it', () => {
    const title = 'gpt-4o-mini high error rate'
    expect(cfg('openai').incidentKeywords?.some((kw) => title.includes(kw.toLowerCase()))).toBe(false)
    // …and it matches no incidentExclude token either, so it reaches the keyword branch (not the bypass).
    expect(cfg('openai').incidentExclude?.some((kw) => title.includes(kw.toLowerCase()))).toBe(false)
  })

  it('openai KEEPS it once OpenAI tags it onto an API-group component it badges', () => {
    expect(filterIncidents([gpt4oMini([OPENAI_API_MAIN])], cfg('openai')).map((i) => i.id))
      .toEqual(['01KMODEL4OMINI0000000000'])
  })

  it('openai DROPS it untagged — no id evidence ⇒ the title-token miss stands (fail-closed)', () => {
    // This is the exact before-state: the incident the keyword filter drops while uptime30d falls.
    expect(filterIncidents([gpt4oMini()], cfg('openai'))).toHaveLength(0)
  })

  it('openai DROPS it when tagged only onto a SIBLING (ChatGPT) component — no over-include', () => {
    // The provider tagging a ChatGPT-group component is NOT the provider claiming it affects the API.
    expect(filterIncidents([gpt4oMini([CHATGPT_LOGIN])], cfg('openai'))).toHaveLength(0)
  })

  it('chatgpt + codex: the same augment keeps a model-named incident tagged onto THEIR badge group', () => {
    // The fix is gated on canIdBypass, so it applies uniformly to all three — a model-named incident
    // with no service-specific keyword still surfaces once the provider tags it onto that service.
    const chatBadge = cfg('chatgpt').statusComponentIds![0]
    const codexBadge = cfg('codex').statusComponentIds![0]
    expect(filterIncidents([gpt4oMini([chatBadge])], cfg('chatgpt'))).toHaveLength(1)
    expect(filterIncidents([apiIncident('CDX1', 'gpt-4o-mini high error rate', [codexBadge])], cfg('codex'))).toHaveLength(1)
  })

  it('a keyword-matching incident is unaffected — the augment only ADDS, never removes', () => {
    // Title carries 'api' → kept by the keyword branch as before, with or without tags.
    const apiTitled = apiIncident('API1', 'Elevated API errors', [])
    expect(filterIncidents([apiTitled], cfg('openai')).map((i) => i.id)).toEqual(['API1'])
  })
})

// The blast-radius replay the #1038 checklist requires: classify the keyword-miss incidents the live
// page exposed on 2026-07-16 by drop reason, before/after. Of the 4 keyword-misses the issue tallied,
// exactly ONE is a real miss — `gpt-4o-mini high error rate`, tagged onto every API-group component.
// This pins that the id-augment admits EXACTLY that one and leaves the other three dropped, so the fix
// does not over-include (the concern the issue's Scope/risk note flags for Score movement).
describe('#1038 Part A blast-radius replay — the 2026-07-16 keyword-misses, classified', () => {
  // The four incidents the issue's table lists, with the drop reason each SHOULD keep after the fix.
  // FIDELITY NOTES — the tags are PROXIES chosen to preserve the tested property, not literal copies:
  //   • SUBS: the real incident tags 'GPTs, Agent, ChatGPT Atlas, Conversations, …' (no 'Login'). We use
  //     [CHATGPT_LOGIN] as a stand-in ChatGPT-group id — what matters is ∩ openai badge = ∅, which it is.
  //   • GPT4OMINI: the real tag set is all 12 API components; [OPENAI_API_MAIN, SORA] is a faithful subset
  //     (non-empty intersection is the property, so 2 openai-badge ids suffice).
  //   • `apiIncident` hardcodes impact:'minor' for all four (the issue lists WEBSITE/MODELSEL as none).
  //     IMMATERIAL here — `filterIncidents` never reads `impact` — but do NOT extend this replay to
  //     `filterByComponentStatus` (which DOES branch on impact) without fixing the impact values first.
  const cases = [
    // [id, title, componentIds, shouldKeep, why]
    ['WEBSITE', 'OpenAI website and Help Center content may be unavailable', undefined, false, 'website content, not the API — untagged'],
    ['MODELSEL', 'Users are experiencing elevated errors when selecting models', undefined, false, 'untagged ⇒ unattributable, fail-closed'],
    ['SUBS', 'Small Number of Users Have Incorrectly Cancelled Subscription', [CHATGPT_LOGIN], false, 'all ChatGPT-group — a billing issue, ∩ openai badge empty'],
    ['GPT4OMINI', 'gpt-4o-mini high error rate', [OPENAI_API_MAIN, SORA], true, 'tagged onto openai API-group components — the real miss'],
  ] as const

  it.each(cases)('%s → keep=%s (via %s)', (id, title, componentIds, shouldKeep) => {
    const kept = filterIncidents([apiIncident(id, title, componentIds as string[] | undefined)], cfg('openai'))
    expect(kept.map((i) => i.id)).toEqual(shouldKeep ? [id] : [])
  })

  it('net effect: exactly ONE of the four is newly admitted — no over-include', () => {
    const incidents = cases.map(([id, title, componentIds]) => apiIncident(id, title, componentIds as string[] | undefined))
    const kept = filterIncidents(incidents, cfg('openai')).map((i) => i.id)
    expect(kept).toEqual(['GPT4OMINI'])
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
    // this fails loudly instead. #1104's active-keep is gated on the SAME predicate, so relaxing this
    // test disables that fix too, not just #1032's bypass. Scope note: this asserts the PREDICATE, not the call sites that consume
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
