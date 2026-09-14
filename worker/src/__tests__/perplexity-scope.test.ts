import { describe, it, expect, vi, afterEach } from 'vitest'
import { SERVICES, filterIncidents, fetchService } from '../services'
import type { Incident } from '../types'

// #1390 — status.perplexity.com moved from Instatus to incident.io. The page carried its own migration
// notice: announced 2026-09-07, cut over by DNS on 2026-09-10 21:00 UTC — the cycle our uptime snapshot
// went null. The Instatus parser cannot read an incident.io page, so the integration was dead and a
// Tier-1 service silently left incident coverage. Nothing looked wrong on the card: the #713 gates emptied
// the list HONESTLY (`sourceUnknown` + `incidentSourceStale`, uptime withheld), so there was no wrong
// screen to notice — the same shape as #1381 (Mistral → Rootly).
//
// The old roster was API + Website + Computer; the new one is Website + App + Computer. There is no `API`
// component any more, so #635's `statusComponent: 'API'` primary lost its referent. That cost nothing,
// because #1177 had already widened this card to every component it displays (see the second block) —
// the page-wide scope here carries that decision across a platform change, it does not make a new one.
//
// The two kinds of test below catch different things, and the split is the #1004 one:
//   - CONFIG assertions are a REVERT guard. They pin our own constants, so the NEXT upstream migration
//     leaves them green — they cannot detect one.
//   - the WIRING assertions are the ones that would have failed here: they push an incident.io-shaped
//     payload through the real config, which the Instatus config could not read at all.

// Captured from status.perplexity.com 2026-09-14. Literals, not `perplexity.displayComponentIds`
// destructured: a config edited to the wrong ids must fail HERE rather than silently re-pointing the
// fixture at itself.
const APP_ID = '01KZSFD424NN3EYBS78TMVWNEK'       // primary — the page tagged `Investigating API issue` (2026-08-13) onto it
const WEBSITE_ID = '01KZSFD424KQ6VQYV4R0KCA30P'
const COMPUTER_ID = '01M0TRMC3ED1PG4GRRXXMVNNZ6'
const SCOPE = [APP_ID, WEBSITE_ID, COMPUTER_ID]
/** The Instatus cuids the dead config addressed. Absent from the incident.io page entirely. */
const DEAD_INSTATUS_IDS = ['clyiakn7i60113hvojwho6za6j', 'clyi6jhgg31469ihojbwbsmeeg', 'cmr18ih7201l20rqmap66bx4l']

const perplexity = SERVICES.find((s) => s.id === 'perplexity')!

describe('#1390 perplexity config — the incident.io migration (revert guard)', () => {
  it('points every endpoint at the incident.io page, with no Instatus residue', () => {
    expect(perplexity.statusUrl).toBe('https://status.perplexity.com')
    expect(perplexity.apiUrl).toBe('https://status.perplexity.com/api/v2/summary.json')
    expect(perplexity.incidentIoBaseUrl).toBe('https://status.perplexity.com/incidents')
    // The host did not change — only the platform behind it — so a URL check cannot catch a revert.
    // The Instatus-shaped FIELDS are what must be gone.
    expect(perplexity.instatusUrl).toBeUndefined()
    for (const dead of DEAD_INSTATUS_IDS) {
      expect(JSON.stringify(perplexity), `dead Instatus cuid ${dead} still configured`).not.toContain(dead)
    }
  })

  it('carries no `statusComponent`: the API component it named has no successor', () => {
    // #635 kept 'API' as the primary/uptime-fallback component. The new roster is Website + App +
    // Computer and nothing on the page is an API surface, so a name-based primary would match nothing
    // and silently disable the Instatus uptime fallback it was there for.
    expect(perplexity.statusComponent).toBeUndefined()
  })

  it('badge, breakdown card and uptime share ONE component scope (#1006)', () => {
    expect(perplexity.statusComponentIds).toEqual(SCOPE)
    // Uptime is computed over `statusComponentIds ?? incidentIoComponentId`, the badge worst-ofs the
    // same ids, and the impact calendar aggregates over them — so a card showing one set while uptime
    // measures another is the #1177 "1 incident listed, uptime 100%" split rebuilt on a new platform.
    expect(perplexity.displayComponentIds).toEqual(perplexity.statusComponentIds)
    expect(perplexity.statusComponentId).toBe(APP_ID)
  })

  it('`incidentIoComponentId` stays a SINGLE id — that number is attributed to the provider', () => {
    // It is what `parseIncidentIoReportedUptime` reads for the side-by-side disclosure. Over a LIST
    // that function returns the min across components: our own aggregate wearing the provider's label,
    // and not necessarily even the component our worst-of picked. #1177 refused to publish that.
    expect(typeof perplexity.incidentIoComponentId).toBe('string')
    expect(perplexity.incidentIoComponentId).toBe(APP_ID)
    expect(SCOPE, 'the disclosed component must be inside the measured scope').toContain(perplexity.incidentIoComponentId as string)
  })

  it('uptime can only arrive via the prefetched page HTML — so the prefetch must still fetch it', () => {
    // incident.io keeps `component_impacts` in the page RSC, never in summary.json, and fetchService's
    // own HTML re-fetch is gated on `incidentComponents` or `canIdBypass` — perplexity has neither. So
    // `uptimeHtml` reaches it ONLY from the prefetch, whose predicate is "some service on this apiUrl
    // has a statusComponentId or an incidentIoComponentId". Dropping both in favour of
    // `statusComponentIds` alone would leave the badge working and uptime permanently null.
    expect(perplexity.statusComponentId ?? perplexity.incidentIoComponentId).toBeTruthy()
    expect(perplexity.incidentComponents).toBeUndefined()
  })
})

describe('#1177 scope decision — carried across the platform change, not revisited', () => {
  it('has NO incidentKeywords: every incident on this single-owner page is a Perplexity incident', () => {
    // The regression pin. Restoring `['api']` silently drops Computer/Website incidents again — the
    // exact 2026-07-23 state (`Computer sandbox issues`, MAJOROUTAGE, dropped while the Computer chip
    // showed Major Outage next to an empty incident list) — and nothing else in the suite would notice.
    expect(perplexity.incidentKeywords).toBeUndefined()
    expect(perplexity.incidentComponents, 'no name-allowlist scoping either').toBeUndefined()
  })

  it('fal keeps its narrow API-surface scope — the sibling is not swept along', () => {
    // fal is deliberately an API-surface card: keyword-scoped incidents + single-component uptime. A
    // blanket "display scope == incident scope" rule would have moved its badge + Score. Values pinned,
    // not mere presence: `incidentKeywords` being *defined* would still pass if fal swapped one scoping
    // mechanism for a weaker one.
    const fal = SERVICES.find((x) => x.id === 'fal')!
    expect(fal.incidentKeywords).toEqual(['api'])
    expect(fal.statusComponent).toBe('API')
  })

  it('fal is now the ONLY Instatus service', () => {
    // Why `uptimeOverDisplayComponents` (and `parseInstatusUptime`'s multi-name branch) went with this
    // migration: perplexity was the flag's only user, and the one remaining Instatus card is
    // single-component by decision. A second Instatus service arriving is the moment to re-derive that,
    // rather than inheriting a config path no service takes.
    expect(SERVICES.filter((s) => s.instatusUrl).map((s) => s.id)).toEqual(['fal'])
  })
})

function inc(overrides: Partial<Incident> = {}): Incident {
  return {
    id: '01M0V29ZJNEY4QTWMR93NMCJGM',
    title: 'Computer sandbox issues',
    status: 'resolved',
    impact: 'major',
    componentNames: ['Computer'],
    startedAt: '2026-07-23T17:48:28.028Z',
    resolvedAt: '2026-07-23T18:14:10.034Z',
    duration: '25m',
    timeline: [],
    ...overrides,
  }
}

describe('#1177 filterIncidents — no component is scoped out', () => {
  it('keeps the Computer-only incident that #623 dropped', () => {
    expect(filterIncidents([inc()], perplexity).map((i) => i.id)).toEqual(['01M0V29ZJNEY4QTWMR93NMCJGM'])
  })

  it('keeps a Website-only incident too — the card shows Website as well', () => {
    const website = inc({ id: 'w1', title: 'Connector connectivity issues', componentNames: ['Website'] })
    expect(filterIncidents([website], perplexity).map((i) => i.id)).toEqual(['w1'])
  })

  it('keeps an App-only incident — the component that carries the API surface now', () => {
    const app = inc({ id: 'a1', title: 'Investigating API issue', componentNames: ['App'] })
    expect(filterIncidents([app], perplexity).map((i) => i.id)).toEqual(['a1'])
  })
})

// ── Wiring: an incident.io payload through the real perplexity config ──
// The config pins above stay green on any payload. These push the shape the live page actually serves
// through `fetchService`, which is what the dead Instatus config could not read at all.

const DAY = 86_400_000
const esc = (o: unknown) => JSON.stringify(o).replace(/"/g, '\\"')

/** `data_available_since` values captured from the live page. All older than the 30-day window, so the
 *  computed figure covers a whole 30 days and `uptimeWindowDays` stays absent. */
const SINCE: Record<string, string> = {
  [WEBSITE_ID]: '2024-07-30T16:55:00Z',
  [APP_ID]: '2025-01-23T00:58:00Z',
  [COMPUTER_ID]: '2026-06-30T21:39:00Z',
}
/** The `component_uptimes[].uptime` figures the page publishes — NOT 30-day numbers (#1006), read only
 *  for the provider-attributed disclosure. App's differs from anything we compute below, which is what
 *  makes the `uptimeReported` assertion non-vacuous. */
const PUBLISHED: Record<string, string> = { [WEBSITE_ID]: '100.00', [APP_ID]: '99.95', [COMPUTER_ID]: '99.61' }

/** The page-root RSC chunk, in the byte shape `parseIncidentIoImpacts` reads: an escaped JSON payload
 *  inside `self.__next_f.push([1,"…"])`, `component_impacts` before `component_uptimes`.
 *
 *  Outage clocks are RELATIVE to `Date.now()` — `computeIncidentIoUptime` takes the wall clock, so a
 *  fixture pinned to a fixed date would drift out of the trailing 30-day window weeks after merge and
 *  fail as a red CI on an unrelated PR. */
function ioPageHtml(outage: { componentId: string; hours: number; status: string; ongoing?: boolean } | null): string {
  const start = Date.now() - 5 * DAY
  const impacts = outage
    ? [{
        component_id: outage.componentId,
        start_at: new Date(start).toISOString(),
        end_at: outage.ongoing ? null : new Date(start + outage.hours * 3_600_000).toISOString(),
        status: outage.status,
        status_page_incident_id: 'inc-1',
      }]
    : []
  const uptimes = SCOPE.map((id) => ({
    component_id: id,
    data_available_since: SINCE[id],
    status_page_component_group_id: '$undefined',
    uptime: PUBLISHED[id],
  }))
  const payload = `\\"component_impacts\\":${esc(impacts)},\\"component_uptimes\\":${esc(uptimes)}`
  return `<script>self.__next_f.push([1,"${payload}"])</script>`
}

/** The Atlassian-compat summary incident.io serves. `components: []` on every incident is real (#1004):
 *  the compat API drops the tags, which is why `componentNames` is absent throughout this block. */
function summary(opts: { degradedId?: string; incidents?: Array<Record<string, unknown>> } = {}) {
  const name = (id: string) => (id === APP_ID ? 'App' : id === WEBSITE_ID ? 'Website' : 'Computer')
  return {
    page: { id: '01KZSFD3VPNK8C7QRFH0GAZ4H2', name: 'Perplexity', updated_at: new Date().toISOString() },
    status: opts.degradedId
      ? { indicator: 'minor', description: 'Partially Degraded Service' }
      : { indicator: 'none', description: 'All Systems Operational' },
    components: SCOPE.map((id) => ({
      id,
      name: name(id),
      status: id === opts.degradedId ? 'partial_outage' : 'operational',
    })),
    incidents: opts.incidents ?? [],
  }
}

const resolvedIncident = () => ({
  id: '01M0V29ZJNEY4QTWMR93NMCJGM',
  name: 'Computer sandbox issues',
  status: 'resolved',
  impact: 'major',
  created_at: new Date(Date.now() - 5 * DAY).toISOString(),
  updated_at: new Date(Date.now() - 5 * DAY + 3_600_000).toISOString(),
  resolved_at: new Date(Date.now() - 5 * DAY + 3_600_000).toISOString(),
  incident_updates: [],
  components: [],
})

const activeIncident = () => ({
  id: '01M1Z156VYPETMR4QRNMQMF3AM',
  name: 'We have identified few connectors that are impacting users.',
  status: 'investigating',
  impact: 'major',
  created_at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
  updated_at: new Date().toISOString(),
  resolved_at: null,
  incident_updates: [],
  components: [],
})

const fetchPerplexity = (summaryData: unknown, uptimeHtml: string) => {
  // `enrichIncidentIoText` scrapes incident pages off `incidentIoBaseUrl`; nothing here asserts on text.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('<html></html>', { status: 200 })))
  return fetchService(
    perplexity,
    { summary: summaryData as never, incidents: null, latency: 120, uptimeHtml } as never,
    undefined,
    {},
  )
}

afterEach(() => vi.unstubAllGlobals())

describe('#1390 wiring — the incident.io payload reaches incidents, uptime and the breakdown', () => {
  it('publishes the resolved incident (the dead Instatus parser published none)', async () => {
    const svc = await fetchPerplexity(
      summary({ incidents: [resolvedIncident()] }),
      ioPageHtml({ componentId: COMPUTER_ID, hours: 24, status: 'full_outage' }),
    )
    expect(svc.incidents.map((i) => i.title)).toContain('Computer sandbox issues')
    expect(svc.sourceUnknown, 'the source reads cleanly again').toBeFalsy()
  })

  it('computes uptime from component_impacts over a whole 30-day window', async () => {
    const svc = await fetchPerplexity(
      summary(),
      ioPageHtml({ componentId: COMPUTER_ID, hours: 24, status: 'full_outage' }),
    )
    // 24h of 30d at weight 1.0 → 96.66. The point is the VALUE, not merely non-null: a scope that
    // silently fell back to one clean component would still publish an `official` 100.
    expect(svc.uptime30d).toBe(96.66)
    expect(svc.uptimeSource).toBe('official')
    expect(svc.uptimeWindowDays, 'every component has >30d of records').toBeUndefined()
  })

  it.each([
    ['App', APP_ID],
    ['Website', WEBSITE_ID],
    ['Computer', COMPUTER_ID],
  ])('an outage on %s alone moves uptime — every member of the scope is load-bearing', async (_name, id) => {
    // Without this, a scope quietly narrowed to the primary (or to whichever component the other cases
    // happen to hit) still passes them all.
    const svc = await fetchPerplexity(summary(), ioPageHtml({ componentId: id, hours: 12, status: 'full_outage' }))
    expect(svc.uptime30d).toBe(98.33)
  })

  it('withholds uptime rather than inventing 100% when the page tracks none of our ids (#713)', async () => {
    const rotated = ioPageHtml(null).replaceAll(APP_ID, 'ROTATED1').replaceAll(WEBSITE_ID, 'ROTATED2').replaceAll(COMPUTER_ID, 'ROTATED3')
    const svc = await fetchPerplexity(summary(), rotated)
    expect(svc.uptime30d).toBeNull()
  })

  it('discloses the provider-published % for the primary component only', async () => {
    const svc = await fetchPerplexity(summary(), ioPageHtml({ componentId: COMPUTER_ID, hours: 24, status: 'full_outage' }))
    // App publishes 99.95; our worst-of computes 96.66. Shown side by side because they differ — and it
    // is App's own number, not a min we synthesized across three components.
    expect(svc.uptimeReported).toBe(99.95)
  })

  it('declares its dailyImpact INCOMPLETE — the calendar must still supplement it (#1390)', async () => {
    // incident.io builds `dailyImpact` from `component_impacts`, and a provider can open and resolve an
    // incident without ever writing an impact row (perplexity's own `Computer Tasks Degraded`,
    // 2026-09-01). The client used to infer completeness from `calendarDays === 30`, which this
    // migration flipped on — so the day went unpainted while the incident sat in the list below it.
    const svc = await fetchPerplexity(
      summary(),
      ioPageHtml({ componentId: COMPUTER_ID, hours: 24, status: 'full_outage' }),
    )
    expect(svc.dailyImpact, 'premise: there IS a per-day record to qualify').toBeTruthy()
    expect(svc.dailyImpactComplete).toBe(false)
    // Pinned together, because the pair is the bug: a 30-day window whose record is incomplete is
    // exactly the combination the old `days === 30` gate got wrong. The 30 is itself a CONSEQUENCE of
    // this migration (`calendarDays` derives from `statusComponentId`), disclosed on the config and
    // deliberately kept — so this line is the record of that decision, and #1406 is where the
    // derivation itself is re-decided.
    expect(svc.calendarDays).toBe(30)
  })

  it('renders all three components in the breakdown, in card order', async () => {
    const svc = await fetchPerplexity(summary(), ioPageHtml(null))
    expect(svc.components?.map((c) => c.name)).toEqual(['App', 'Website', 'Computer'])
  })

  it('an ongoing incident on a non-primary component degrades the badge', async () => {
    // The most user-visible half of #1177's widening, re-verified on the new platform: the badge drives
    // /is-perplexity-down, the Discord alert and the RSS entry.
    const svc = await fetchPerplexity(
      summary({ degradedId: COMPUTER_ID, incidents: [activeIncident()] }),
      ioPageHtml({ componentId: COMPUTER_ID, hours: 2, status: 'partial_outage', ongoing: true }),
    )
    expect(svc.status).toBe('degraded')
    expect(svc.incidents.some((i) => i.status !== 'resolved')).toBe(true)
  })

  it('a resolved-only page stays operational — the badge follows OPEN incidents, not the list', async () => {
    const svc = await fetchPerplexity(
      summary({ incidents: [resolvedIncident()] }),
      ioPageHtml({ componentId: COMPUTER_ID, hours: 24, status: 'full_outage' }),
    )
    expect(svc.status).toBe('operational')
  })

  it('LIMITATION — an active incident is dropped while every component reads operational', async () => {
    // Not a property we want; a consequence of the platform move, pinned so it is a known limit rather
    // than a rediscovery. The Instatus branch never reached `filterByComponentStatus`; the incident.io
    // branch does, and there an active incident survives an operational badge only via the #1104 id-keep
    // — gated on `canIdBypass`, which needs an `incidentExclude` list this single-owner page has no use
    // for. incident.io's compat API also serves `components: []` (#1004), so the name axis has nothing
    // to match either. Every other incident.io service here already runs under exactly this rule.
    const svc = await fetchPerplexity(summary({ incidents: [activeIncident()] }), ioPageHtml(null))
    expect(svc.incidents).toEqual([])
  })
})
