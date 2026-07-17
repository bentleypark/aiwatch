import { describe, it, expect, vi, afterEach } from 'vitest'
import { parseIncidents, resolveComponentNames, type StatuspageResponse } from '../parsers/statuspage'
import { filterIncidents, filterByComponentStatus, includeUntaggedIncidents, fetchService, SERVICES } from '../services'
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
    // Pre-#1047 this incident was untagged at resolve, so `scopeResolvedToComponent`'s
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
