import { describe, it, expect, vi, afterEach } from 'vitest'
import { SERVICES, filterIncidents, fetchService } from '../services'
import { parseInstatusUptime, parseInstatusReportedUptime, __resetInstatusUptimeWarnings } from '../parsers/instatus'
import type { Incident } from '../types'

// #1177 — perplexity's card displays API + Website + Computer (#761/#911) but #623 scoped its incidents
// to the API component alone. On 2026-07-23 `Computer sandbox issues` (MAJOROUTAGE, tagged onto
// Computer) was therefore dropped and the card read: Computer chip Major Outage · Recent Incidents
// EMPTY · uptime 100%. The fix widens the SERVICE scope to the components the card represents — for
// incidents (no `incidentKeywords`) and for uptime (`uptimeOverDisplayComponents`) together.

const perplexity = SERVICES.find((s) => s.id === 'perplexity')!
const [API_ID, WEBSITE_ID, COMPUTER_ID] = perplexity.displayComponentIds!

describe('#1177 perplexity config — one decision, two fields', () => {
  it('has NO incidentKeywords: every incident on this single-owner page is a Perplexity incident', () => {
    // The regression pin. Restoring `['api']` silently drops Computer/Website incidents again — the
    // exact 2026-07-23 state — and nothing else in the suite would notice.
    expect(perplexity.incidentKeywords).toBeUndefined()
    expect(perplexity.incidentComponents, 'no name-allowlist scoping either').toBeUndefined()
  })

  it('computes uptime over the displayed components, not the single primary one', () => {
    expect(perplexity.uptimeOverDisplayComponents).toBe(true)
    expect(perplexity.displayComponentIds).toEqual([API_ID, WEBSITE_ID, COMPUTER_ID])
    // statusComponent stays as the primary/fallback component (see the config comment).
    expect(perplexity.statusComponent).toBe('API')
  })

  it('EVERY opted-in service holds the whole contract — the rule, not just perplexity', () => {
    // The instance pins above protect today's config; this protects the next one. A second service
    // shipping the flag beside `incidentKeywords` re-creates the half-fix the type comment warns
    // about, and a flag on a non-Instatus service (or with no ids to widen to) is silently inert.
    const optedIn = SERVICES.filter((s) => s.uptimeOverDisplayComponents)
    expect(optedIn.map((s) => s.id)).toEqual(['perplexity'])
    for (const s of optedIn) {
      expect(s.instatusUrl, `${s.id}: the flag is read only in the Instatus branch`).toBeTruthy()
      expect(s.displayComponentIds?.length, `${s.id}: nothing to widen the scope to`).toBeGreaterThan(0)
      expect(s.incidentKeywords, `${s.id}: wide uptime + keyword-narrowed incidents is the half-fix`).toBeUndefined()
      expect(s.incidentComponents, `${s.id}: same, on the component-name axis`).toBeUndefined()
    }
  })

  it('does not sweep the sibling Instatus services along', () => {
    // fal and mistral are deliberately API-surface cards: keyword-scoped incidents + single-component
    // uptime. A blanket "display scope == incident scope" rule would have moved their badges + Scores.
    // Values pinned, not mere presence: `incidentKeywords ?? incidentExclude` being *defined* would
    // still pass if fal swapped one scoping mechanism for a weaker one.
    const fal = SERVICES.find((x) => x.id === 'fal')!
    expect(fal.uptimeOverDisplayComponents).toBeUndefined()
    expect(fal.incidentKeywords).toEqual(['api'])
    expect(fal.statusComponent).toBe('API')
    const mistral = SERVICES.find((x) => x.id === 'mistral')!
    expect(mistral.uptimeOverDisplayComponents).toBeUndefined()
    expect(mistral.incidentExclude).toContain('website')
    expect(mistral.statusComponent).toBe('API')
  })
})

function inc(overrides: Partial<Incident> = {}): Incident {
  return {
    id: 'cmrxt1rlu000f0zlcv4dzmdlr',
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

describe('#1177 filterIncidents — the Computer incident is in scope now', () => {
  it('keeps the Computer-only incident that #623 dropped', () => {
    expect(filterIncidents([inc()], perplexity).map((i) => i.id)).toEqual(['cmrxt1rlu000f0zlcv4dzmdlr'])
  })

  it('keeps a Website-only incident too — the card shows Website as well', () => {
    const website = inc({ id: 'cmq08', title: 'Connector connectivity issues', componentNames: ['Website'] })
    expect(filterIncidents([website], perplexity).map((i) => i.id)).toEqual(['cmq08'])
  })

  it('still keeps the API incidents it always kept (no regression on the original scope)', () => {
    const api = inc({ id: 'cmow6', title: 'Perplexity Website and API incident', componentNames: ['Website', 'API'] })
    expect(filterIncidents([api], perplexity).map((i) => i.id)).toEqual(['cmow6'])
  })
})

// ── Multi-component uptime (parser level) ──
describe('#1177 parseInstatusUptime — multi-component scope is worst-of', () => {
  // Midday, not midnight: `todayWeightedOutageSec` measures [startOfTodayUTC, now], which is a
  // zero-length window at 00:00Z — every today-assertion would read 0 for the wrong reason.
  const NOW = Date.parse('2026-07-28T12:00:00Z')
  const DAY = 86_400_000
  const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString()
  const compDef = (id: string, name: string) =>
    `\\"id\\":\\"${id}\\",\\"name\\":{\\"default\\":\\"${name}\\"},\\"nameHtml\\":{\\"default\\":\\"\\u003cp\\u003e${name}\\u003c/p\\u003e\\"},\\"group\\":null,\\"children\\":[],`
  const outage = (fromDaysAgo: number, hours: number, status: string) => {
    const from = iso(fromDaysAgo)
    const to = new Date(Date.parse(from) + hours * 3_600_000).toISOString()
    return `{\\"from\\":\\"${from}\\",\\"to\\":\\"${to}\\",\\"status\\":\\"${status}\\"}`
  }
  /** All three real components. API clean, Website with a SHORT outage, Computer with a 24h major one
   *  — so the middle element of the triple is load-bearing (a scope that silently drops Website still
   *  has to change the answer somewhere) and the worst-of has more than two candidates to order. */
  const html = () => {
    const escaped =
      compDef('cidapi', 'API') + compDef('cidweb', 'Website') + compDef('cidcomputer', 'Computer') +
      '\\"componentsUptime\\":{' +
        '\\"cidapi\\":{\\"outages\\":[],\\"uptime\\":\\"100\\"},' +
        `\\"cidweb\\":{\\"outages\\":[${outage(9, 2, 'MAJOROUTAGE')}],\\"uptime\\":\\"99.95\\"},` +
        `\\"cidcomputer\\":{\\"outages\\":[${outage(5, 24, 'MAJOROUTAGE')}],\\"uptime\\":\\"99.9\\"}}`
    return `<script>self.__next_f.push([1,"${escaped}"])</script>`
  }

  it('single-component scope is unchanged (API reads 100)', () => {
    expect(parseInstatusUptime(html(), 'API', NOW)?.pct).toBe(100)
  })

  it('multi-component scope returns the WORST component, not the primary one', () => {
    // 24h of 30d at weight 1.0 → 96.66. The bug being fixed is precisely that this read 100.
    const one = parseInstatusUptime(html(), 'Computer', NOW)!
    const many = parseInstatusUptime(html(), ['API', 'Computer'], NOW)!
    expect(many.pct).toBe(one.pct)
    expect(many.pct).toBeLessThan(100)
  })

  it('worst-of`s todayWeightedOutageSec independently of pct', () => {
    // An outage that is open TODAY on the otherwise-healthier component must still be archived.
    const todayHtml = () => {
      const escaped =
        compDef('cidapi', 'API') + compDef('cidcomputer', 'Computer') +
        '\\"componentsUptime\\":{' +
          `\\"cidapi\\":{\\"outages\\":[${outage(0.25, 1, 'MAJOROUTAGE')}],\\"uptime\\":\\"100\\"},` +
          `\\"cidcomputer\\":{\\"outages\\":[${outage(20, 24, 'MAJOROUTAGE')}],\\"uptime\\":\\"99.9\\"}}`
      return `<script>self.__next_f.push([1,"${escaped}"])</script>`
    }
    const many = parseInstatusUptime(todayHtml(), ['API', 'Computer'], NOW)!
    const api = parseInstatusUptime(todayHtml(), 'API', NOW)!
    const computer = parseInstatusUptime(todayHtml(), 'Computer', NOW)!
    expect(many.pct).toBe(computer.pct)                                   // 30-day worst = Computer
    expect(many.todayWeightedOutageSec).toBe(api.todayWeightedOutageSec)  // today's worst = API
    expect(many.todayWeightedOutageSec).toBeGreaterThan(0)
  })

  it('the middle component of the scope is load-bearing (Website is not decoration)', () => {
    // A scope that silently drops Website must fail SOMETHING. With Computer excluded, Website is the
    // worst — so this pins the element that the Computer-driven cases would otherwise never exercise.
    const withWebsite = parseInstatusUptime(html(), ['API', 'Website'], NOW)!
    expect(withWebsite.pct).toBeLessThan(100)
    expect(withWebsite.pct).toBe(parseInstatusUptime(html(), 'Website', NOW)!.pct)
  })

  it('a member with no uptime figure is skipped BUT the partial scope warns (#1177 self-recreation)', () => {
    // The one way this fix could re-create #1177: a component whose chip still renders (it is in the
    // component tree, so the fetchService drift-warn stays silent) but which carries no
    // `componentsUptime` entry — the provider turning off its `showUptime`, or a young component whose
    // series is not backfilled. The healthy members' figure is then published as `official`, and it can
    // only look BETTER than reality. Skipping is right; skipping SILENTLY is not.
    __resetInstatusUptimeWarnings()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // 'Renamed Away' is in neither the tree nor componentsUptime — the same silent-drop shape.
      expect(parseInstatusUptime(html(), ['API', 'Renamed Away'], NOW)?.pct).toBe(100)
      expect(warn.mock.calls.flat().join(' '), 'the partial scope must be observable').toContain('PARTIAL uptime scope')
    } finally {
      warn.mockRestore()
    }
  })

  it('an all-unresolvable scope returns null — visible as "Not provided", not a fabricated 100', () => {
    expect(parseInstatusUptime(html(), ['Renamed Away'], NOW)).toBeNull()
  })

  it('the published-% disclosure stays SINGLE-component — it is attributed to the provider', () => {
    // A min across components would be our own aggregate wearing the provider's label, and need not be
    // the component our worst-of picked. `fetchService` withholds it entirely for a multi-scope card.
    expect(parseInstatusReportedUptime(html(), 'API')).toBe(100)
    expect(parseInstatusReportedUptime(html(), 'Computer')).toBe(99.9)
  })
})

// ── Wiring: the real perplexity config through the real fetchService path ──
// The pure tests above stay green if `uptimeScope` is never wired into the fetch, or if the widened
// incidents never reach the published list (the #966 tested-twin class).

/** Mirrors the real status.perplexity.com Next.js payload — the 3 top-level components, their
 *  `componentsUptime` entries, and one notice modelled on the 2026-07-23 Computer incident (a 24h
 *  outage rather than its real 26 minutes, so the 30-day figure moves by a legible amount).
 *
 *  Clocks are RELATIVE to `Date.now()`, because `fetchService` passes no clock down and
 *  `parseInstatusUptime` defaults to the wall clock: a fixture pinned to a fixed date would drift out
 *  of the trailing 30-day window a few weeks after merge and fail as a red CI on an unrelated PR.
 *
 *  `ongoing: true` flips the notice to an in-progress incident (and the Computer chip to MAJOROUTAGE,
 *  which is what the live page publishes while a notice is open) — the badge case. */
function perplexityHtml({ ongoing = false, onWebsite = false } = {}) {
  const start = Date.now() - 5 * 86_400_000
  const from = new Date(start).toISOString()
  const to = new Date(start + 24 * 3_600_000).toISOString()
  const hitId = onWebsite ? WEBSITE_ID : COMPUTER_ID
  const component = (id: string, name: string, status: string) =>
    `{\\"id\\":\\"${id}\\",\\"name\\":{\\"default\\":\\"${name}\\"},\\"nameHtml\\":{\\"default\\":\\"\\u003cp\\u003e${name}\\u003c/p\\u003e\\"},` +
    `\\"isCollapsed\\":false,\\"order\\":1,\\"showUptime\\":true,\\"status\\":\\"${status}\\",\\"isParent\\":false,\\"group\\":null,\\"children\\":[]}`
  const chip = (id: string) => (id === hitId && ongoing ? 'MAJOROUTAGE' : 'OPERATIONAL')
  const components = '\\"components\\":[' + [
    component(API_ID, 'API', chip(API_ID)),
    component(WEBSITE_ID, 'Website', chip(WEBSITE_ID)),
    component(COMPUTER_ID, 'Computer', chip(COMPUTER_ID)),
  ].join(',') + ']'
  const entry = (id: string) => id === hitId
    ? `\\"${id}\\":{\\"outages\\":[{\\"from\\":\\"${from}\\",\\"to\\":\\"${to}\\",\\"status\\":\\"MAJOROUTAGE\\"}],\\"uptime\\":\\"99.9\\"}`
    : `\\"${id}\\":{\\"outages\\":[],\\"uptime\\":\\"100\\"}`
  const uptime = '\\"componentsUptime\\":{' + [API_ID, WEBSITE_ID, COMPUTER_ID].map(entry).join(',') + '}'
  const title = onWebsite ? 'Connector connectivity issues' : 'Computer sandbox issues'
  const notice =
    `\\"cmrxt1rlu000f0zlcv4dzmdlr\\":{\\"id\\":\\"cmrxt1rlu000f0zlcv4dzmdlr\\",\\"name\\":{\\"en\\":\\"${title}\\",\\"default\\":\\"${title}\\"},` +
    `\\"impact\\":\\"MAJOROUTAGE\\",\\"started\\":\\"${from}\\",\\"resolved\\":${ongoing ? 'null' : `\\"${to}\\"`},` +
    `\\"status\\":\\"${ongoing ? 'INVESTIGATING' : 'RESOLVED'}\\",\\"components\\":[{\\"id\\":\\"${hitId}\\"}]}`
  return `<script>self.__next_f.push([1,"x:${components}:${uptime}:notices\\":{${notice}},\\"metrics\\":{}"])</script>`
}

afterEach(() => vi.unstubAllGlobals())

describe('#1177 wiring — the Computer outage reaches BOTH the incident list and uptime', () => {
  const stub = (opts?: { ongoing?: boolean; onWebsite?: boolean }) =>
    vi.stubGlobal('fetch', vi.fn(async () => new Response(perplexityHtml(opts), { status: 200 })))

  it('publishes the Computer incident in incidents (it was dropped before)', async () => {
    stub()
    const svc = await fetchService(perplexity, undefined, undefined)
    expect(svc.incidents.map((i) => i.title)).toContain('Computer sandbox issues')
  })

  it('uptime30d follows the Computer outage instead of the API component 100%', async () => {
    // The half-fix guard: widening incidents alone leaves "1 incident listed, uptime 100%".
    stub()
    const svc = await fetchService(perplexity, undefined, undefined)
    expect(svc.uptime30d).toBeLessThan(100)
    expect(svc.uptimeSource).toBe('official')
  })

  it('withholds the provider-attributed uptimeReported on a multi-component scope', async () => {
    // The fixture publishes 99.9 for the hit component and 100 for the others; a min across them would
    // render as "status page shows 99.9%" beside our own worst-of — a number the page never published
    // for this card, and not necessarily even the same component. Nothing is the honest answer.
    stub()
    const svc = await fetchService(perplexity, undefined, undefined)
    expect(svc.uptimeReported).toBeUndefined()
    expect(svc.uptimeReportedDays).toBeUndefined()
  })

  it('an ONGOING incident on a non-API component degrades the badge (#1177 widened it)', async () => {
    // The most user-visible half of the change and the one with the widest blast radius: the badge
    // drives /is-perplexity-down, the Discord alert and the RSS entry. Pre-#1177 this read
    // `operational` with an empty incident list.
    stub({ ongoing: true, onWebsite: true })
    const svc = await fetchService(perplexity, undefined, undefined)
    expect(svc.incidents.some((i) => i.status !== 'resolved')).toBe(true)
    expect(svc.status).toBe('degraded')
  })

  it('a resolved-only page stays operational — the badge follows OPEN incidents, not the list', async () => {
    stub()
    const svc = await fetchService(perplexity, undefined, undefined)
    expect(svc.status).toBe('operational')
  })

  it('falls back to statusComponent + warns when no configured id resolves', async () => {
    // Upstream rotates every component id: the wide scope is unrecoverable, but uptime must not vanish.
    // Guards the `names.length > 0` branch, whose default state is "never taken".
    // Replacement ids stay cuid-shaped (lowercase alnum, no hyphen) — `buildInstatusComponentMap`
    // matches on that charset, so a hyphenated id would break the component parse itself and this
    // would silently test the "page yielded no components" path instead of the id-rotation one.
    const rotated = () => perplexityHtml()
      .replaceAll(API_ID, 'rotatedapi001').replaceAll(WEBSITE_ID, 'rotatedweb002').replaceAll(COMPUTER_ID, 'rotatedcomputer003')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(rotated(), { status: 200 })))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const svc = await fetchService(perplexity, undefined, undefined)
      expect(warn.mock.calls.flat().join(' ')).toContain('falling back to statusComponent')
      // 'API' still resolves by name in the rotated payload, so the single-component figure survives.
      expect(svc.uptime30d).toBe(100)
    } finally {
      warn.mockRestore()
    }
  })

  it('still renders all three components in the breakdown', async () => {
    stub()
    const svc = await fetchService(perplexity, undefined, undefined)
    expect(svc.components?.map((c) => c.name)).toEqual(['API', 'Website', 'Computer'])
  })
})
