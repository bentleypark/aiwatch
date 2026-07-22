import { describe, it, expect, vi, afterEach } from 'vitest'
import { parseIncidents, resolveComponentNames, type StatuspageResponse } from '../parsers/statuspage'
import { filterIncidents, filterByComponentStatus, includeUntaggedIncidents, fetchService, canIdBypass, __resetMissingJoinWarnThrottle, SERVICES } from '../services'
import type { ServiceConfig } from '../types'

// #1047 — Anthropic UNLINKED every component from `kqbd7wm6hnnr` ("Elevated errors for multiple
// models") as they resolved it: the record now carries `components: []`, while the update history
// still names the 4 it degraded. The title carries no `incidentKeywords` token for claudeai/claudecode,
// so `componentNames` is their ONLY attribution path — and it went empty exactly at resolution.
//
// Real ids/codes from status.claude.com — an invented code would prove nothing about the real page,
// and `feedback_faithful_fixtures` (#1021) is explicit that a fixture must mirror the real shape.
const CLAUDEAI = 'rwppv331jlwc'
const CLAUDE_API = 'k8w3r06qmzrp'
const CLAUDE_CODE = 'yyzkbfz2thpt'
const CLAUDE_COWORK = 'bpp5gb3hpjcl'

const NAME: Record<string, string> = {
  [CLAUDEAI]: 'claude.ai',
  [CLAUDE_API]: 'Claude API (api.anthropic.com)',
  [CLAUDE_CODE]: 'Claude Code',
  [CLAUDE_COWORK]: 'Claude Cowork',
}

/** Uses the REAL SERVICES config, so a config edit that invalidates these premises fails loudly here. */
const cfg = (id: string): ServiceConfig => {
  const c = SERVICES.find((s) => s.id === id)
  if (!c) throw new Error(`missing SERVICES config: ${id}`)
  return c
}

const affected = (ids: string[], to: string, from = 'operational') =>
  ids.map((id) => ({ code: id, name: NAME[id], old_status: from, new_status: to }))

const ALL_FOUR = [CLAUDEAI, CLAUDE_API, CLAUDE_CODE, CLAUDE_COWORK]

/** `kqbd7wm6hnnr` as status.claude.com serves it TODAY — checked against the live payload, not
 *  approximated: 6 updates (not a trimmed 3), the real `.760Z` created_at, and `affected_components`
 *  literally `null` on the resolve update (9 updates on that page are null, NOT `[]`). The null is the
 *  whole point of copying it faithfully: it is the value the fix's own `?? []` has to survive, and a
 *  tidied `[]` fixture would never exercise it (#1021 `feedback_faithful_fixtures`). */
const unlinkedAtResolve = (): NonNullable<StatuspageResponse['incidents']>[number] => ({
  id: 'kqbd7wm6hnnr',
  name: 'Elevated errors for multiple models',
  status: 'resolved',
  impact: 'major',
  created_at: '2026-07-16T18:36:58.760Z',
  resolved_at: '2026-07-16T22:53:12.373Z',
  components: [],
  incident_updates: [
    // Newest first, exactly as the API orders them.
    { status: 'resolved', created_at: '2026-07-16T22:53:12.373Z', body: 'This issue has been resolved.', affected_components: null },
    {
      status: 'monitoring', created_at: '2026-07-16T22:01:31.220Z', body: 'Success rates have recovered.',
      affected_components: affected(ALL_FOUR, 'operational', 'partial_outage'),
    },
    {
      status: 'identified', created_at: '2026-07-16T20:58:44.870Z', body: 'We are seeing recovery on most models.',
      affected_components: affected(ALL_FOUR, 'partial_outage', 'partial_outage'),
    },
    {
      status: 'identified', created_at: '2026-07-16T20:07:56.187Z', body: 'We are continuing to work to resolve the issue.',
      affected_components: affected(ALL_FOUR, 'partial_outage', 'partial_outage'),
    },
    {
      status: 'identified', created_at: '2026-07-16T19:14:08.780Z', body: 'We have identified the cause.',
      affected_components: affected(ALL_FOUR, 'partial_outage', 'partial_outage'),
    },
    {
      status: 'investigating', created_at: '2026-07-16T18:36:58.889Z', body: 'We are investigating elevated errors.',
      affected_components: affected(ALL_FOUR, 'partial_outage'),
    },
  ],
})

const parseOne = (inc: NonNullable<StatuspageResponse['incidents']>[number]) =>
  parseIncidents({ status: { indicator: 'none', description: 'ok' }, incidents: [inc] })

const ANTHROPIC_COMPONENTS = Object.entries(NAME).map(([id, name]) => ({ id, name, status: 'operational' }))

describe('#1047 resolveComponentNames', () => {
  it('recovers the names from the update history when the provider unlinked them at resolve', () => {
    expect(resolveComponentNames(unlinkedAtResolve())).toEqual([
      'claude.ai', 'Claude API (api.anthropic.com)', 'Claude Code', 'Claude Cowork',
    ])
  })

  it('the live list wins outright when present — empty-only, never a union (also the partial-unlink case)', () => {
    // SYNTHETIC by necessity: partial unlink is documented as unobserved, and no real incident pairs a
    // live list with a disjoint history. Deliberately NOT pinned to a real incident id — dressing a
    // fabricated record in `vjfp60ngq2zj`'s id would make it read as something we saw on the page.
    // 'Billing' is likewise invented (status.claude.com has no such component); it stands in for any
    // name a union would wrongly absorb.
    const names = resolveComponentNames({
      id: 'synthetic-partial-unlink', name: 'Synthetic: live list present, history names another component',
      status: 'resolved', impact: 'minor', created_at: '2026-07-15T00:00:00Z', resolved_at: '2026-07-15T04:33:00Z',
      components: [{ name: 'claude.ai' }, { name: 'Claude Code' }],
      incident_updates: [{
        status: 'resolved', created_at: '2026-07-15T04:33:00Z', body: 'Resolved.',
        affected_components: [{ code: 'synthetic0', name: 'Billing', new_status: 'operational' }],
      }],
    })
    expect(names).toEqual(['claude.ai', 'Claude Code'])
  })

  it('dedupes across updates and returns them oldest-first', () => {
    const names = resolveComponentNames({
      id: 'x', name: 'x', status: 'resolved', impact: 'minor',
      created_at: '2026-07-16T00:00:00Z', resolved_at: '2026-07-16T01:00:00Z',
      components: [],
      incident_updates: [
        {
          status: 'identified', created_at: '2026-07-16T00:30:00Z', body: 'b',
          affected_components: [
            { code: 'b', name: 'Second', new_status: 'partial_outage' },
            { code: 'a', name: 'First', new_status: 'partial_outage' },
          ],
        },
        {
          status: 'investigating', created_at: '2026-07-16T00:00:00Z', body: 'a',
          affected_components: [{ code: 'a', name: 'First', new_status: 'partial_outage' }],
        },
      ],
    })
    expect(names).toEqual(['First', 'Second'])
  })

  it('recovers a component the history only ever names as operational (fails toward keeping the tag)', () => {
    // Deliberate: the alternative loses attribution outright when the resolve update is the only one
    // carrying components. Pins the documented `new_status`-is-ignored residual.
    expect(resolveComponentNames({
      id: 'x', name: 'x', status: 'resolved', impact: 'minor',
      created_at: '2026-07-16T00:00:00Z', resolved_at: '2026-07-16T01:00:00Z',
      components: [],
      incident_updates: [{
        status: 'resolved', created_at: '2026-07-16T01:00:00Z', body: 'Resolved.',
        affected_components: affected([CLAUDE_CODE], 'operational', 'partial_outage'),
      }],
    })).toEqual(['Claude Code'])
  })

  it('never throws on a shape change — missing updates, missing/null affected_components', () => {
    const base = { id: 'x', name: 'x', status: 'resolved', impact: 'minor', created_at: '2026-07-16T00:00:00Z', resolved_at: null }
    expect(resolveComponentNames({ ...base, components: [] })).toEqual([])
    expect(resolveComponentNames({ ...base })).toEqual([])
    expect(resolveComponentNames({
      ...base, components: [],
      incident_updates: [{ status: 'investigating', created_at: '2026-07-16T00:00:00Z', body: 'b' }],
    })).toEqual([])
    // `null`, the value status.claude.com actually sends — not the `[]` a tidied fixture would assume.
    expect(resolveComponentNames({
      ...base, components: [],
      incident_updates: [{ status: 'resolved', created_at: '2026-07-16T01:00:00Z', body: 'b', affected_components: null }],
    })).toEqual([])
    // ...and a null update must not shadow a sibling that DOES carry components (the real shape).
    expect(resolveComponentNames({
      ...base, components: [],
      incident_updates: [
        { status: 'resolved', created_at: '2026-07-16T01:00:00Z', body: 'b', affected_components: null },
        { status: 'investigating', created_at: '2026-07-16T00:00:00Z', body: 'a', affected_components: affected([CLAUDE_CODE], 'partial_outage') },
      ],
    })).toEqual(['Claude Code'])
  })
})

describe('#1047 attribution survives resolution — filterIncidents', () => {
  it.each(['claudeai', 'claudecode'])('the keyword-scoped sibling %s keeps the resolved incident', (id) => {
    const config = cfg(id)
    // Guard the premise: attribution here can ONLY come from componentNames, never the title.
    const title = 'elevated errors for multiple models'
    expect(config.incidentKeywords?.some((kw) => title.includes(kw.toLowerCase()))).toBe(false)
    expect(filterIncidents(parseOne(unlinkedAtResolve()), config).map((i) => i.id)).toEqual(['kqbd7wm6hnnr'])
  })
})

// The stage the fix's own docstring flags as the danger, and the one the alert set is actually
// derived from. `filterIncidents` keeping an incident means nothing if this drops it (services.ts
// runs filterIncidents at the parse and filterByComponentStatus later on the same list).
describe('#1047 filterByComponentStatus — the emptiness-keyed branches this reclassifies', () => {
  // Two assertions doing different jobs, deliberately. The FIRST holds pre- and post-fix (pre: untagged
  // → #934's fail-open keeps it; post: the recovered names prefix-match 'Claude API') — a regression
  // pin against recovery ever COSTING claude the incident, the one way this could hurt the service that
  // was never broken. The SECOND is fix-dependent: it pins that the keep is now a VERDICT rather than
  // the fail-open guess it used to be.
  it('claude keeps the incident — and now for the right reason, not the #934 fail-open', () => {
    const kept = filterByComponentStatus(parseOne(unlinkedAtResolve()), 'operational', cfg('claude'), ANTHROPIC_COMPONENTS)
    expect(kept.map((i) => i.id)).toEqual(['kqbd7wm6hnnr'])
    expect(kept[0].componentNames).toContain('Claude API (api.anthropic.com)')
  })

  it('claude DROPS a Claude-Code-only unlinked incident — #934 fail-open is gone, by design', () => {
    // Pre-#1047 this incident was untagged at resolve, so `scopeIncidentsToComponent`'s
    // `names.length === 0 → keep` fail-open cross-attributed it to Claude API — the exact #934 bug.
    // Recovery makes it judgeable, so it now drops. A flip in the DROP direction (the #970 silent-loss
    // class), so it is pinned rather than left to be discovered in a Discord alert.
    const codeOnly = {
      ...unlinkedAtResolve(),
      id: 'codeonly1',
      name: 'Claude Tag seeing elevated GitHub operation failures',
      incident_updates: [{
        status: 'resolved', created_at: '2026-07-16T22:53:12.373Z', body: 'Resolved.',
        affected_components: affected([CLAUDE_CODE], 'partial_outage'),
      }],
    }
    expect(filterByComponentStatus(parseOne(codeOnly), 'operational', cfg('claude'), ANTHROPIC_COMPONENTS)).toEqual([])
    // ...and it still reaches claudecode, which is whose incident it is.
    expect(filterIncidents(parseOne(codeOnly), cfg('claudecode')).map((i) => i.id)).toEqual(['codeonly1'])
  })

  it('an ACTIVE impact:none incident is now judged on badge-group membership, not dropped as untagged', () => {
    // #970's untagged branch used to drop this with a warn. Recovery makes it judgeable → kept.
    //
    // PROPHYLACTIC, and the fixture is synthetic for a reason: this state has NEVER been observed.
    // Every one of the 22 incidents recovery touches on live data is `resolved` — necessarily, since
    // the unlink happens AT resolution — and #970's branch is gated on `status !== 'resolved' &&
    // !== 'monitoring'`, so it cannot see them. It stays reachable in principle (an incident whose
    // components were never linked can be active), which is why it is pinned rather than ignored.
    // Do NOT read this test as evidence of a live behaviour change; there is none.
    const activeNone = {
      ...unlinkedAtResolve(),
      id: 'activenone1',
      status: 'investigating',
      impact: 'none',
      resolved_at: null,
      incident_updates: [{
        status: 'investigating', created_at: '2026-07-16T18:36:58.889Z', body: 'Investigating.',
        affected_components: affected([CLAUDE_API], 'operational'),
      }],
    }
    const parsed = parseOne(activeNone)
    expect(parsed[0].impact).toBeNull() // premise: 'none' → null, which is what #970 keys on
    expect(filterByComponentStatus(parsed, 'operational', cfg('claude'), ANTHROPIC_COMPONENTS).map((i) => i.id))
      .toEqual(['activenone1'])
  })
})

describe('#1047 includeUntaggedIncidents — the other emptiness-keyed valve', () => {
  it('an ACTIVE unlinked incident naming only a foreign component is no longer re-added untagged', () => {
    // PROPHYLACTIC, like the #970 pin above: gated on `status !== 'resolved'` (services.ts), and every
    // incident recovery touches on live data is resolved, so this has no live instance. Reachable in
    // principle via an incident whose components were NEVER linked.
    //
    // Pre-fix the valve saw `componentNames: []` and re-added this Cowork-only incident to claude.ai's
    // card as an "explanation" for its degraded badge — a leak. Recovery makes it judgeable, so
    // filterIncidents drops it (Cowork matches no claudeai keyword) AND the valve now skips it.
    const coworkOnly = {
      ...unlinkedAtResolve(),
      id: 'coworkonly1',
      name: 'Elevated errors for multiple models',
      status: 'investigating',
      resolved_at: null,
      incident_updates: [{
        status: 'investigating', created_at: '2026-07-16T18:36:58.889Z', body: 'Investigating.',
        affected_components: affected([CLAUDE_COWORK], 'partial_outage'),
      }],
    }
    const all = parseOne(coworkOnly)
    const filtered = filterIncidents(all, cfg('claudeai'))
    expect(filtered).toEqual([]) // Cowork is not a claudeai keyword
    // claude.ai's own component is degraded, which is what opens the valve at all.
    const degraded = ANTHROPIC_COMPONENTS.map((c) => c.id === CLAUDEAI ? { ...c, status: 'partial_outage' } : c)
    expect(includeUntaggedIncidents(filtered, all, cfg('claudeai'), degraded, 'minor')).toEqual([])
  })
})

describe('#1047 fetchService — the REAL production call path', () => {
  afterEach(() => { vi.restoreAllMocks() })

  // Not a hand-assembled ServiceStatus: `services.ts:1088` warns that a pure test can stay green while
  // the tag never reaches /api/status (the #966/#940 "tested twin" trap). Drive the real entry point.
  const fetchClaude = (id: string) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
    const summary = {
      status: { indicator: 'none', description: 'All Systems Operational' },
      components: ANTHROPIC_COMPONENTS,
      incidents: [],
    }
    return fetchService(cfg(id), {
      summary: summary as never,
      incidents: { incidents: [unlinkedAtResolve()] } as never,
      latency: 120,
    } as never)
  }

  // The two services #1047 actually restores. Both FAIL without the fix on this path — which is the
  // point of driving `fetchService` rather than asserting on a hand-built ServiceStatus.
  it.each(['claudeai', 'claudecode'])(
    '%s surfaces the resolved incident end to end — the #1047 bug, on the path /api/status uses',
    async (id) => {
      const svc = await fetchClaude(id)
      expect(svc.incidents.map((i) => i.id)).toContain('kqbd7wm6hnnr')
    },
  )

  it('claude surfaced it all along — pins that the fix does not take it away', async () => {
    // Passes pre-fix too (see the filterByComponentStatus pin above). Named honestly: it guards a
    // regression, it does not demonstrate #1047.
    const svc = await fetchClaude('claude')
    expect(svc.incidents.map((i) => i.id)).toContain('kqbd7wm6hnnr')
  })
})

describe('#1090 fetchService — sibling-component incident while OUR component is degraded', () => {
  afterEach(() => { vi.restoreAllMocks() })

  // The precondition of the #1090 defect (our own component degraded) is unreachable in every other
  // fetchService block in this suite — they all build `indicator: 'none'` with operational components.
  // The pure filterByComponentStatus tests in filter-incidents.test.ts would stay green if the filtered
  // list stopped reaching `ServiceStatus.incidents`, which is the #966/#940 tested-twin trap.
  const FABLE5 = 'tnypgb2jbqnq'
  const OPUS = 'opus45xyz'

  // Real 2026-07-20 shape: a Claude-Code-only incident alongside an unrelated one that DOES tag Claude
  // API — which is what put the Claude API component into degraded_performance in the first place.
  const fable5Incident = {
    id: FABLE5,
    name: 'Fable 5 requiring usage credits on Max plans',
    status: 'monitoring',
    impact: 'minor',
    created_at: '2026-07-20T07:35:29.166Z',
    updated_at: '2026-07-20T07:35:29.254Z',
    resolved_at: null,
    incident_updates: [{
      status: 'monitoring', created_at: '2026-07-20T07:35:29.254Z', body: 'Applied a fix.',
      affected_components: affected([CLAUDE_CODE], 'operational'),
    }],
  }
  const opusIncident = {
    id: OPUS,
    name: 'Elevated error rates for Opus 4.5',
    status: 'investigating',
    impact: 'minor',
    created_at: '2026-07-20T07:03:46.113Z',
    updated_at: '2026-07-20T07:03:46.234Z',
    resolved_at: null,
    incident_updates: [{
      status: 'investigating', created_at: '2026-07-20T07:03:46.234Z', body: 'Investigating.',
      affected_components: affected([CLAUDE_API, CLAUDE_CODE], 'degraded_performance'),
    }],
  }

  const fetchDuringDegradation = (id: string) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
    const summary = {
      status: { indicator: 'minor', description: 'Partially Degraded Service' },
      // Claude API degraded by the Opus incident; Claude Code back to operational (the real state).
      components: ANTHROPIC_COMPONENTS.map((c) =>
        c.id === CLAUDE_API ? { ...c, status: 'degraded_performance' } : c),
      incidents: [],
    }
    return fetchService(cfg(id), {
      summary: summary as never,
      incidents: { incidents: [fable5Incident, opusIncident] } as never,
      latency: 120,
    } as never)
  }

  it('claude does NOT carry the Claude-Code-only incident — on the path /api/status uses', async () => {
    const svc = await fetchDuringDegradation('claude')
    expect(svc.incidents.map((i) => i.id)).not.toContain(FABLE5)
  })

  it('claude still carries the incident that names Claude API (no over-drop)', async () => {
    const svc = await fetchDuringDegradation('claude')
    expect(svc.incidents.map((i) => i.id)).toContain(OPUS)
  })

  it('claudecode, the actual owner, keeps it', async () => {
    const svc = await fetchDuringDegradation('claudecode')
    expect(svc.incidents.map((i) => i.id)).toContain(FABLE5)
  })
})

// ── #1104 — an open incident whose impact on OUR component has ended ────────────────────────────
// Observed 2026-07-21 on openai: `Images` (a badge component) ran partial_outage 12:25→13:31Z on an
// incident still `identified` at 14:16Z. Once the component recovered, the operational gate dropped
// the incident — after we had alerted on it at 12:33Z — so the alert's link showed "Operational" with
// nothing to explain it. The provider's own component tag is the evidence that it WAS ours.
describe('#1104 filterByComponentStatus — an open incident tagged onto our badge component survives our recovery', () => {
  afterEach(() => { vi.restoreAllMocks() })

  // Real ULIDs from status.openai.com — an invented id would prove nothing, since the whole rule is an
  // id intersection against the REAL badge group (`feedback_faithful_fixtures`, and the #1032 lesson
  // that a fabricated config leaves the fix dead in production while the tests stay green).
  const IMAGES = '01JMXBRMFE4MAP2BHSJNZ787WX' // "Images", APIs group  → openai.statusComponentIds
  const CHATGPT_LOGIN = '01JMXBNJXG1S2D9V65P1ZZTD94' // "Login", ChatGPT group → NOT openai's
  const INC = '01KY23YCPJ9M5BFFT6ZHKQE9MP'
  const TITLE = 'Image generation unavailable in ChatGPT'

  const COMPONENTS = [
    { id: IMAGES, name: 'Images' },
    { id: CHATGPT_LOGIN, name: 'Login' },
  ]
  /** `componentIds` OMITTED when there is no join — `attachIncidentIoComponentIds` never writes `[]`,
   *  so `[]` would be a state production cannot produce. */
  const openIncident = (componentIds?: string[]) => ([{
    id: INC,
    title: TITLE,
    status: 'identified',
    impact: 'major',
    componentNames: [],
    ...(componentIds ? { componentIds } : {}),
  }] as unknown as Parameters<typeof filterByComponentStatus>[0])

  it('premise: the fixture ids really do / do not belong to openai badge group, and the keep is reachable', () => {
    // Every assertion below is meaningless if these drift — so they fail HERE, not silently downstream.
    expect(cfg('openai').statusComponentIds).toContain(IMAGES)
    expect(cfg('openai').statusComponentIds).not.toContain(CHATGPT_LOGIN)
    expect(canIdBypass(cfg('openai'))).toBe(true)
  })

  it('KEEPS it while we read operational — the impact window closed, the incident did not', () => {
    const kept = filterByComponentStatus(openIncident([IMAGES]), 'operational', cfg('openai'), COMPONENTS)
    expect(kept).toHaveLength(1)
  })

  it('does NOT over-include: a tag on a component outside our badge group is still dropped', () => {
    // The whole point of keying on ids — this is a ChatGPT-group component, and openai must not
    // inherit it just because the two share a status page.
    expect(filterByComponentStatus(openIncident([CHATGPT_LOGIN]), 'operational', cfg('openai'), COMPONENTS)).toEqual([])
  })

  it('a tagged non-match drops SILENTLY — a provider verdict is not a guess', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    filterByComponentStatus(openIncident([CHATGPT_LOGIN]), 'operational', cfg('openai'), COMPONENTS)
    // Warning here would fire on every ChatGPT incident against openai, every cycle — they share a page.
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('#1104'))).toHaveLength(0)
  })

  it('a MISSING id-join drops but WARNS — evidence absent is not evidence against (#970/#983)', () => {
    // The throttle is module state: without this reset the assertion silently reads 0 if any earlier
    // test drove the same (service, incident) through the drop — and 0 reads as "the warn stopped".
    __resetMissingJoinWarnThrottle()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(filterByComponentStatus(openIncident(), 'operational', cfg('openai'), COMPONENTS)).toEqual([])
    // The one direction that separates this from the bug it fixes: the keep silently not firing.
    const lines = () => warn.mock.calls.filter((c) => String(c[0]).includes('#1104') && String(c[0]).includes(INC))
    expect(lines()).toHaveLength(1)
    // …and only once per (service, incident, hour): this gate runs on EVERY /api/status request, so an
    // un-throttled line would be ~1440/day per polling tab for one stuck incident.
    filterByComponentStatus(openIncident(), 'operational', cfg('openai'), COMPONENTS)
    expect(lines()).toHaveLength(1)
    // But a join that comes back and breaks again is a NEW event: the keep path clears the throttle, so
    // the second drop is not swallowed. Without that, drop → keep → drop goes silent on the drop that
    // actually removes an already-alerted incident from the card.
    expect(filterByComponentStatus(openIncident([IMAGES]), 'operational', cfg('openai'), COMPONENTS)).toHaveLength(1)
    filterByComponentStatus(openIncident(), 'operational', cfg('openai'), COMPONENTS)
    expect(lines()).toHaveLength(2)
  })

  it('the keep AND the warn are gated on canIdBypass — a service outside that set is untouched', () => {
    // Both guards default to "pass", so they need a mutation aimed at THEMSELVES. `claude` reaches this
    // gate (apiUrl + statusComponentId) but is Atlassian — no `incidentIoComponentId`, so canIdBypass is
    // false and it can never legitimately carry componentIds. Drop either gate and: the keep fires for
    // services with no exclude/badge-group config the moment `idsNeedHtml` is ever widened, and the warn
    // fires for EVERY active impact-bearing incident of EVERY component-scoped service on EVERY
    // /api/status request (`!componentIds?.length` is true for all of them).
    __resetMissingJoinWarnThrottle()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const CLAUDE_API_ID = 'k8w3r06qmzrp'
    expect(canIdBypass(cfg('claude'))).toBe(false)
    const components = [{ id: CLAUDE_API_ID, name: 'Claude API (api.anthropic.com)' }]
    // (a) TAGGED — exercises the keep's gate: without it, claude would inherit the id evidence.
    const tagged = openIncident([CLAUDE_API_ID]).map(i => ({ ...i, id: 'claude-inc-1' })) as Parameters<typeof filterByComponentStatus>[0]
    expect(filterByComponentStatus(tagged, 'operational', cfg('claude'), components)).toEqual([])
    // (b) UNTAGGED — exercises the WARN's gate, which the tagged fixture cannot reach
    // (`!componentIds?.length` is false there). This is the noisy direction: ungated, every
    // component-scoped service would emit a #1104 line for every active incident, every request.
    const untagged = openIncident().map(i => ({ ...i, id: 'claude-inc-2' })) as Parameters<typeof filterByComponentStatus>[0]
    expect(filterByComponentStatus(untagged, 'operational', cfg('claude'), components)).toEqual([])
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('#1104'))).toHaveLength(0)
  })

  it('the warn throttle is keyed per SERVICE — the three bypass services share one status page', () => {
    // openai/chatgpt/codex are exactly the canIdBypass set AND they share status.openai.com, so one
    // incident id passes through all three in a single fetchAllServices pass. Drop `${config.id}` from
    // the key (in BOTH the has and the add — a half-mutation goes red on its own) and two of the three
    // services' diagnostics vanish: the silent-drop class this warn exists to prevent.
    __resetMissingJoinWarnThrottle()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    filterByComponentStatus(openIncident(), 'operational', cfg('openai'), COMPONENTS)
    filterByComponentStatus(openIncident(), 'operational', cfg('chatgpt'), COMPONENTS)
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('#1104') && l.includes(INC))
    expect(lines).toHaveLength(2)
    expect(lines.some((l) => l.includes('openai'))).toBe(true)
    expect(lines.some((l) => l.includes('chatgpt'))).toBe(true)
  })

  it('is scoped to the operational gate: while we are degraded the incident was already kept', () => {
    expect(filterByComponentStatus(openIncident([IMAGES]), 'degraded', cfg('openai'), COMPONENTS)).toHaveLength(1)
  })

  it('does not disturb the resolved path (kept before this change, kept after)', () => {
    const resolved = openIncident([IMAGES]).map(i => ({ ...i, status: 'resolved' })) as Parameters<typeof filterByComponentStatus>[0]
    expect(filterByComponentStatus(resolved, 'operational', cfg('openai'), COMPONENTS)).toHaveLength(1)
  })

  it('#970 regression guard: an UNTAGGED impact:none incident is still dropped', () => {
    const impactNone = openIncident().map(i => ({ ...i, impact: null })) as Parameters<typeof filterByComponentStatus>[0]
    expect(filterByComponentStatus(impactNone, 'operational', cfg('openai'), COMPONENTS)).toEqual([])
  })
})

// The pure-function block above cannot see whether `componentIds` ever REACH that gate in production,
// nor whether an impact whose window has ENDED still yields one — and that second fact is the premise
// the whole fix rests on (#1093 is queued to read more out of these very records). Both are
// invisible to it, so drive the real chain: HTML → attachIncidentIoComponentIds → filterIncidents →
// filterByComponentStatus → ServiceStatus.incidents (the #966/#940 tested-twin rule).
describe('#1104 fetchService — the REAL production call path, with a CLOSED impact window', () => {
  afterEach(() => { vi.restoreAllMocks() })

  const IMAGES = '01JMXBRMFE4MAP2BHSJNZ787WX'
  const INC = '01KY23YCPJ9M5BFFT6ZHKQE9MP'
  const TITLE = 'Image generation unavailable in ChatGPT'

  // The real 2026-07-21 record: the impact on `Images` STARTED at 12:25:05Z and ENDED at 13:31:39Z,
  // while the incident itself is still `identified`. `end_at` is a real timestamp here, not the
  // `$undefined` every other fixture in the repo carries — that is the point of this fixture.
  const endedImpact = `{\\"component_id\\":\\"${IMAGES}\\",\\"end_at\\":\\"2026-07-21T13:31:39Z\\",\\"id\\":\\"IMP1104\\",` +
    `\\"start_at\\":\\"2026-07-21T12:25:05Z\\",\\"status\\":\\"partial_outage\\",\\"status_page_incident_id\\":\\"${INC}\\"}`
  const html = `<script>self.__next_f.push([1,"a:{\\"component_impacts\\":[${endedImpact}],` +
    `\\"component_uptimes\\":[],\\"incident_links\\":[]}"])</script>`

  // Every openai badge component back to `operational` — the state at 13:31Z, after the recovery.
  const summary = {
    status: { indicator: 'none', description: 'All Systems Operational' },
    components: [{ id: IMAGES, name: 'Images', status: 'operational' }],
    incidents: [{
      id: INC,
      name: TITLE,
      status: 'identified',
      impact: 'major',
      created_at: '2026-07-21T10:36:02Z',
      started_at: '2026-07-21T10:36:02Z',
      updated_at: '2026-07-21T14:04:58Z',
      incident_updates: [{ status: 'identified', body: 'We have identified the issue.', created_at: '2026-07-21T14:04:58Z' }],
      components: [],
    }],
  }

  const fetchOpenai = (uptimeHtml?: string) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
    return fetchService(cfg('openai'), { summary: summary as never, incidents: null, latency: 120, uptimeHtml } as never)
  }

  it('openai keeps the incident while its own badge reads operational — the #1104 bug, end to end', async () => {
    const svc = await fetchOpenai(html)
    // BOTH halves matter: the badge must stay green (the component really did recover) AND the incident
    // must still be there to explain the alert we already sent. Asserting either alone misses the bug.
    expect(svc.status).toBe('operational')
    expect(svc.incidents.map((i) => i.id)).toContain(INC)
  })

  it('an ENDED impact window still yields the component id — the premise the keep stands on', async () => {
    // Pins `parseIncidentIoIncidentComponentIds` ignoring `end_at`. If a future "only current impacts"
    // refactor (#1093 reads these same records) starts filtering on it, componentIds goes empty, the
    // keep silently stops firing, and #1104 returns — with every other test in this file still green.
    const svc = await fetchOpenai(html)
    expect(svc.incidents.find((i) => i.id === INC)?.componentIds).toContain(IMAGES)
  })

  it('without the join the incident is dropped — so the test above is measuring the join, not the title', async () => {
    // The title matches openai's 'chatgpt' exclude, so with no ids it never survives rule 5 either.
    // This is the mutation direction: remove the attach wiring and the previous two tests go red.
    const svc = await fetchOpenai(undefined)
    expect(svc.incidents.map((i) => i.id)).not.toContain(INC)
  })
})
