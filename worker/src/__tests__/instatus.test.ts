import { describe, it, expect, vi } from 'vitest'
import { mapInstatusImpact, parseInstatusIncidents, parseInstatusUptime, parseInstatusComponents } from '../parsers/instatus'
import { filterIncidents, resolveSvcComponents } from '../services'
import type { ServiceConfig } from '../types'

describe('mapInstatusImpact (#556)', () => {
  it('maps Next.js component-status impact values', () => {
    expect(mapInstatusImpact('MAJOROUTAGE')).toBe('major')
    expect(mapInstatusImpact('PARTIALOUTAGE')).toBe('minor')
    // The live Perplexity regression: DEGRADEDPERFORMANCE used to fall through to null.
    expect(mapInstatusImpact('DEGRADEDPERFORMANCE')).toBe('minor')
  })

  it('maps Nuxt incident-severity values', () => {
    expect(mapInstatusImpact('CRITICAL')).toBe('critical')
    expect(mapInstatusImpact('MAJOR')).toBe('major')
    expect(mapInstatusImpact('HIGH')).toBe('major')
    // The live Mistral case: MEDIUM (incl. the 29h Audio outage) used to be hardcoded null.
    expect(mapInstatusImpact('MEDIUM')).toBe('minor')
    expect(mapInstatusImpact('MINOR')).toBe('minor')
    expect(mapInstatusImpact('LOW')).toBe('minor')
  })

  it('is case-insensitive', () => {
    expect(mapInstatusImpact('degradedperformance')).toBe('minor')
    expect(mapInstatusImpact('Critical')).toBe('critical')
  })

  it('returns null for non-incident / informational states', () => {
    expect(mapInstatusImpact('OPERATIONAL')).toBeNull()
    expect(mapInstatusImpact('UNDERMAINTENANCE')).toBeNull()
    expect(mapInstatusImpact('MAINTENANCE')).toBeNull()
    expect(mapInstatusImpact('NONE')).toBeNull()
    expect(mapInstatusImpact('')).toBeNull()
    expect(mapInstatusImpact(null)).toBeNull()
    expect(mapInstatusImpact(undefined)).toBeNull()
  })

  it('defaults an unknown value to minor and warns once (diagnosable, never silently null)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(mapInstatusImpact('SOME_NEW_LEVEL')).toBe('minor')
    expect(mapInstatusImpact('SOME_NEW_LEVEL')).toBe('minor') // second call: no re-warn
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('SOME_NEW_LEVEL')
    warn.mockRestore()
  })
})

describe('parseInstatusIncidents — Nuxt format severity mapping (#556, Mistral)', () => {
  // Minimal __NUXT_DATA__ flat-index array mirroring status.mistral.ai: one resolved MEDIUM incident.
  // Layout: each incident field is an index into the flat array (Nuxt SSR encoding).
  function nuxtHtml(severity: string, durationSec = 106_391) {
    const arr: unknown[] = [
      'Audio API Degraded',          // 0 name
      'RESOLVED',                    // 1 lastUpdateStatus
      '2026-06-01T08:07:26.765Z',    // 2 created_at
      durationSec,                   // 3 duration (s)
      severity,                      // 4 severity
      'inc-1',                       // 5 id
      [],                            // 6 services
      [],                            // 7 incidentUpdates
      { id: 5, name: 0, lastUpdateStatus: 1, created_at: 2, duration: 3, severity: 4, services: 6, incidentUpdates: 7 }, // 8 inc
      [8],                           // 9 incIndices
      { incidents: 9 },              // 10 incObj
      { 'incidents-by-date-2026': 10 }, // 11 dataRefs
    ]
    return `<html><body><script id="__NUXT_DATA__" type="application/json">${JSON.stringify(arr)}</script></body></html>`
  }

  it('maps the Nuxt `severity` field (MEDIUM → minor) instead of hardcoding null', () => {
    const incidents = parseInstatusIncidents(nuxtHtml('MEDIUM'))
    expect(incidents).toHaveLength(1)
    expect(incidents[0].title).toBe('Audio API Degraded')
    expect(incidents[0].status).toBe('resolved')
    expect(incidents[0].impact).toBe('minor') // was null before #556 → affectedDays/score ignored it
  })

  it('maps a CRITICAL Nuxt incident to critical', () => {
    expect(parseInstatusIncidents(nuxtHtml('CRITICAL'))[0].impact).toBe('critical')
  })

  it('an unknown Nuxt severity still surfaces the incident as minor (never silently dropped)', () => {
    const inc = parseInstatusIncidents(nuxtHtml('SOME_FUTURE_LEVEL'))
    expect(inc).toHaveLength(1)
    expect(inc[0].impact).toBe('minor')
  })

  it('a Nuxt incident with NO severity field → impact null (parses, not crashes), end-to-end', () => {
    // Drop the `severity` ref from the inc mapping; arr[inc.severity] → undefined → null.
    const arr: unknown[] = [
      'Files API Degraded', 'RESOLVED', '2026-06-01T08:07:26.765Z', 600, 'inc-2', [], [],
      { id: 4, name: 0, lastUpdateStatus: 1, created_at: 2, duration: 3, services: 5, incidentUpdates: 6 }, // no `severity` key
      [7], { incidents: 8 }, { 'incidents-by-date-2026': 9 },
    ]
    const html = `<script id="__NUXT_DATA__" type="application/json">${JSON.stringify(arr)}</script>`
    const incidents = parseInstatusIncidents(html)
    expect(incidents).toHaveLength(1)
    expect(incidents[0].title).toBe('Files API Degraded')
    expect(incidents[0].impact).toBeNull()
  })

  it('still filters sub-60s micro-incidents (unchanged)', () => {
    expect(parseInstatusIncidents(nuxtHtml('MEDIUM', 30))).toHaveLength(0)
  })
})

describe('parseInstatusIncidents — Next.js format impact mapping (#556, Perplexity)', () => {
  // Minimal Next.js SSR payload: escaped `notices\":{...},\"metrics` block with one resolved incident.
  function nextHtml(impact: string) {
    const notice = [
      '\\"ppx-1\\":{',
      '\\"id\\":\\"ppx-1\\",',
      '\\"name\\":{\\"default\\":\\"Perplexity Website and API incident\\"},',
      `\\"impact\\":\\"${impact}\\",`,
      '\\"started\\":\\"2026-05-20T10:00:00.000Z\\",',
      '\\"resolved\\":\\"2026-05-20T12:00:00.000Z\\",',
      '\\"status\\":\\"RESOLVED\\"}',
    ].join('')
    return `<script>self.__next_f.push([1,"x:notices\\":{${notice}},\\"metrics\\":{}"])</script>`
  }

  it('maps DEGRADEDPERFORMANCE → minor (was null before #556)', () => {
    const incidents = parseInstatusIncidents(nextHtml('DEGRADEDPERFORMANCE'))
    expect(incidents).toHaveLength(1)
    expect(incidents[0].impact).toBe('minor')
  })

  it('maps MAJOROUTAGE → major', () => {
    expect(parseInstatusIncidents(nextHtml('MAJOROUTAGE'))[0].impact).toBe('major')
  })
})

describe('parseInstatusIncidents — Nuxt resolution = createdAt + duration, not the post time (#626)', () => {
  // Real Mistral case: a "Conversations API Degraded" incident, active-IMPACT `duration` = 2h40m, but
  // whose RESOLVED status-page update was POSTED ~2 days later (2026-06-12T15:14). Mistral's own UI
  // shows the resolution at createdAt+duration ("Jun 10 10:48"), NOT the post time. So resolvedAt AND
  // the resolved timeline entry must both be createdAt+duration; duration stays the impact field.
  // Layout: flat-index Nuxt array with two incidentUpdates (newest-first).
  function nuxtHtmlWithUpdates() {
    const start = '2026-06-10T08:08:00.000Z'
    const finalResolved = '2026-06-12T15:14:00.000Z' // ~55h after start (= Jun 13 00:14 KST)
    const arr: unknown[] = [
      'Conversations API Degraded',  // 0 name
      'RESOLVED',                    // 1 lastUpdateStatus
      start,                         // 2 created_at
      9600,                          // 3 duration (s) = 2h40m — the misleading field
      'MEDIUM',                      // 4 severity
      'inc-1',                       // 5 id
      [],                            // 6 services
      [12, 13],                      // 7 incidentUpdates (newest-first)
      { id: 5, name: 0, lastUpdateStatus: 1, created_at: 2, duration: 3, severity: 4, services: 6, incidentUpdates: 7 }, // 8 inc
      [8],                           // 9 incIndices
      { incidents: 9 },              // 10
      { 'incidents-by-date-2026': 10 }, // 11
      { status: 14, description: 16, created_at: 18 }, // 12 resolved update (newest)
      { status: 15, description: 17, created_at: 19 }, // 13 investigating update (oldest)
      'RESOLVED',                    // 14
      'INVESTIGATING',               // 15
      'The issue has been resolved.',// 16
      'Requests are degraded.',      // 17
      finalResolved,                 // 18 resolved at
      start,                         // 19 investigating at
    ]
    return `<script id="__NUXT_DATA__" type="application/json">${JSON.stringify(arr)}</script>`
  }

  it('resolvedAt + the resolved timeline entry = createdAt+duration (10:48), NOT the late post time', () => {
    const [inc] = parseInstatusIncidents(nuxtHtmlWithUpdates())
    expect(inc.startedAt).toBe('2026-06-10T08:08:00.000Z')
    expect(inc.resolvedAt).toBe('2026-06-10T10:48:00.000Z') // createdAt 08:08 + 9600s, matches Mistral's UI
    expect(inc.duration).toBe('2h 40m')                     // Instatus active-impact field (durationSec=9600)
    // the resolved timeline entry is pinned to the resolution, not the 2026-06-12 post time
    const resolved = inc.timeline.find((t) => t.stage === 'resolved')!
    expect(resolved.at).toBe('2026-06-10T10:48:00.000Z')
    expect(inc.timeline.some((t) => t.at.startsWith('2026-06-12'))).toBe(false) // no spurious late entry
  })

  it('falls back to the wall-clock span when Instatus omits the duration field', () => {
    // No durationSec → duration is createdAt → last-resolved (the only signal available).
    const arr: unknown[] = [
      'Conversations API Degraded',  // 0
      'RESOLVED',                    // 1
      '2026-06-10T08:08:00.000Z',    // 2
      null,                          // 3 duration (omitted)
      'MEDIUM',                      // 4
      'inc-x',                       // 5
      [],                            // 6 services
      [11, 12],                      // 7 updates (newest-first)
      { id: 5, name: 0, lastUpdateStatus: 1, created_at: 2, duration: 3, severity: 4, services: 6, incidentUpdates: 7 }, // 8
      [8],                           // 9
      { incidents: 9 },              // 10
      { status: 13, created_at: 15 }, // 11 resolved
      { status: 14, created_at: 16 }, // 12 investigating
      'RESOLVED',                    // 13
      'INVESTIGATING',               // 14
      '2026-06-12T15:14:00.000Z',    // 15
      '2026-06-10T08:08:00.000Z',    // 16
      { 'incidents-by-date-2026': 10 }, // 17 dataRefs
    ]
    const html = `<script id="__NUXT_DATA__" type="application/json">${JSON.stringify(arr)}</script>`
    const [inc] = parseInstatusIncidents(html)
    expect(inc.resolvedAt).toBe('2026-06-12T15:14:00.000Z')
    expect(inc.duration).toMatch(/2d|55h/) // wall-clock fallback
  })
})

describe('parseInstatusIncidents — ongoing Nuxt incident has no duration (Mistral "1m" bug)', () => {
  // An ACTIVE (INVESTIGATING) incident: Nuxt's `duration` field is 0 (not yet resolved), which
  // formatDuration would floor to "1m" — the Overview then renders that as the recovery time on an
  // ongoing incident. The parser must leave duration null so the UI shows "Investigating"/ongoing.
  function ongoingNuxt(durationSec: number) {
    const arr: unknown[] = [
      'Completion API Degraded',     // 0 name
      'INVESTIGATING',               // 1 lastUpdateStatus (ACTIVE)
      '2026-06-30T09:30:00.000Z',    // 2 created_at
      durationSec,                   // 3 duration (s)
      'MEDIUM',                      // 4 severity
      'inc-ongoing',                 // 5 id
      [],                            // 6 services
      [],                            // 7 incidentUpdates
      { id: 5, name: 0, lastUpdateStatus: 1, created_at: 2, duration: 3, severity: 4, services: 6, incidentUpdates: 7 }, // 8 inc
      [8],                           // 9 incIndices
      { incidents: 9 },              // 10 incObj
      { 'incidents-by-date-2026': 10 }, // 11 dataRefs
    ]
    return `<script id="__NUXT_DATA__" type="application/json">${JSON.stringify(arr)}</script>`
  }

  it('leaves duration null for an active incident even when durationSec is 0 (would floor to "1m")', () => {
    const [inc] = parseInstatusIncidents(ongoingNuxt(0))
    expect(inc.status).toBe('investigating')
    expect(inc.duration).toBeNull()
    expect(inc.resolvedAt).toBeNull()
  })

  it('leaves duration null for an active incident with a nonzero elapsed durationSec too', () => {
    // Even if Nuxt reports elapsed active-impact seconds, an unresolved incident has no FINAL duration.
    const [inc] = parseInstatusIncidents(ongoingNuxt(3600))
    expect(inc.status).toBe('investigating')
    expect(inc.duration).toBeNull()
  })
})

describe('parseInstatusUptime (#627)', () => {
  // Nuxt encodes each component's uptime as a flat-array index ref to a direct float %.
  function nuxtHtmlWithUptime() {
    const arr: unknown[] = [
      'API', 99.599,                 // 0 name, 1 uptime value
      'Le Chat', 99.854,             // 2, 3
      { id: 9, name: 0, uptime: 1, services: 8 }, // 4 component "API"
      { id: 9, name: 2, uptime: 3, services: 8 }, // 5 component "Le Chat"
      [4, 5],                        // 6 components list
      { components: 6 },             // 7
      [],                            // 8
      'comp-id',                     // 9
    ]
    return `<script id="__NUXT_DATA__" type="application/json">${JSON.stringify(arr)}</script>`
  }

  it('resolves the named component’s 30-day uptime% from the Nuxt flat array', () => {
    expect(parseInstatusUptime(nuxtHtmlWithUptime(), 'API')).toBeCloseTo(99.599, 3)
    expect(parseInstatusUptime(nuxtHtmlWithUptime(), 'Le Chat')).toBeCloseTo(99.854, 3)
  })

  it('returns null for an unknown component, missing name, or Next.js without componentsUptime', () => {
    expect(parseInstatusUptime(nuxtHtmlWithUptime(), 'Nonexistent')).toBeNull()
    expect(parseInstatusUptime(nuxtHtmlWithUptime(), undefined)).toBeNull()
    expect(parseInstatusUptime('<script>self.__next_f.push([1,"x"])</script>', 'API')).toBeNull()
  })
})

describe('parseInstatusUptime — Next.js componentsUptime (#635, Perplexity)', () => {
  // Mirrors status.perplexity.com: escaped component defs (id→name) + a `componentsUptime` object
  // keyed by component id, each entry nesting an `outages` array and an aggregate `"uptime"` string.
  function nextHtmlWithUptime() {
    const escaped =
      '\\"id\\":\\"clyi6jhgg31469ihojbwbsmeeg\\",\\"name\\":{\\"default\\":\\"Website\\"}' +
      '\\"id\\":\\"clyiakn7i60113hvojwho6za6j\\",\\"name\\":{\\"default\\":\\"API\\"}' +
      '\\"componentsUptime\\":{' +
        '\\"clyi6jhgg31469ihojbwbsmeeg\\":{\\"5\\":\\"99.47\\",' +
          '\\"outages\\":[{\\"from\\":\\"2026-06-05T01:00:00.000Z\\",\\"to\\":\\"2026-06-05T01:40:38.000Z\\",\\"status\\":\\"MAJOROUTAGE\\"}],' +
          '\\"uptime\\":\\"99.82\\"},' +
        '\\"clyiakn7i60113hvojwho6za6j\\":{\\"outages\\":[],\\"uptime\\":\\"100.0\\"}' +
      '}'
    return `<script>self.__next_f.push([1,"${escaped}"])</script>`
  }

  it('resolves the named component’s uptime% from componentsUptime[id].uptime', () => {
    expect(parseInstatusUptime(nextHtmlWithUptime(), 'API')).toBeCloseTo(100.0, 3)
    expect(parseInstatusUptime(nextHtmlWithUptime(), 'Website')).toBeCloseTo(99.82, 2)
  })

  it('returns null for an unknown component or undefined name', () => {
    expect(parseInstatusUptime(nextHtmlWithUptime(), 'Nonexistent')).toBeNull()
    expect(parseInstatusUptime(nextHtmlWithUptime(), undefined)).toBeNull()
  })

  it('matchBrace ignores braces inside string values (would truncate under a naive regex)', () => {
    // A nested outage carries `{`/`}` INSIDE string values — the quote-aware matcher must not
    // miscount them, else the slice truncates and JSON.parse fails → wrong null.
    const escaped =
      '\\"id\\":\\"abc123\\",\\"name\\":{\\"default\\":\\"API\\"}' +
      '\\"componentsUptime\\":{\\"abc123\\":{' +
        '\\"outages\\":[{\\"status\\":\\"DEGRADED}{\\",\\"noticeId\\":\\"x}y\\"}],' +
        '\\"uptime\\":\\"97.5\\"}}'
    const html = `<script>self.__next_f.push([1,"${escaped}"])</script>`
    expect(parseInstatusUptime(html, 'API')).toBeCloseTo(97.5, 2)
  })

  it('returns null for an uptime value outside [0,100]', () => {
    const escaped =
      '\\"id\\":\\"abc123\\",\\"name\\":{\\"default\\":\\"API\\"}' +
      '\\"componentsUptime\\":{\\"abc123\\":{\\"uptime\\":\\"150.0\\"}}'
    const html = `<script>self.__next_f.push([1,"${escaped}"])</script>`
    expect(parseInstatusUptime(html, 'API')).toBeNull()
  })

  it('returns null when the component resolves but has no componentsUptime entry', () => {
    const escaped =
      '\\"id\\":\\"abc123\\",\\"name\\":{\\"default\\":\\"API\\"}' +
      '\\"componentsUptime\\":{\\"other999\\":{\\"uptime\\":\\"99.0\\"}}'
    const html = `<script>self.__next_f.push([1,"${escaped}"])</script>`
    expect(parseInstatusUptime(html, 'API')).toBeNull()
  })

  it('returns null (warn-once shape path) when the component resolves but the componentsUptime block is absent', () => {
    // Resolvable component map but no `componentsUptime` key → the structural-breakage warn path.
    const escaped = '\\"id\\":\\"abc123\\",\\"name\\":{\\"default\\":\\"API\\"}\\"notices\\":{}'
    const html = `<script>self.__next_f.push([1,"${escaped}"])</script>`
    expect(parseInstatusUptime(html, 'API')).toBeNull()
  })
})

describe('parseInstatusIncidents — Next.js component capture (#623, Perplexity)', () => {
  // Mirrors the real status.perplexity.com payload: a `components` array (id→name: Website, API,
  // name has ONLY a `default` key) + notices that reference component ids and carry `name:{en,default}`.
  function nextHtmlWithComponents() {
    // Real Instatus ids are cuid-style (e.g. clyi6jhgg31469ihojbwbsmeeg) — use that shape so the test
    // exercises the regex's id charset/length faithfully.
    const WEB = 'clyi6jhgg31469ihojbwbsmeeg'
    const API = 'clyiakn7i60113hvojwho6za6j'
    const components =
      '\\"components\\":[' +
      `{\\"id\\":\\"${WEB}\\",\\"name\\":{\\"default\\":\\"Website\\"},\\"status\\":\\"OPERATIONAL\\"},` +
      `{\\"id\\":\\"${API}\\",\\"name\\":{\\"default\\":\\"API\\"},\\"status\\":\\"OPERATIONAL\\"}]`
    const n1 =
      '\\"n1\\":{\\"id\\":\\"n1\\",\\"name\\":{\\"en\\":\\"Website and API incident\\",\\"default\\":\\"Website and API incident\\"},' +
      '\\"impact\\":\\"DEGRADEDPERFORMANCE\\",\\"started\\":\\"2026-05-08T00:20:00.000Z\\",\\"resolved\\":\\"2026-05-08T04:19:00.000Z\\",' +
      `\\"status\\":\\"RESOLVED\\",\\"components\\":[{\\"id\\":\\"${WEB}\\"},{\\"id\\":\\"${API}\\"}]}`
    const n2 =
      '\\"n2\\":{\\"id\\":\\"n2\\",\\"name\\":{\\"en\\":\\"Connector connectivity issues\\",\\"default\\":\\"Connector connectivity issues\\"},' +
      '\\"impact\\":\\"PARTIALOUTAGE\\",\\"started\\":\\"2026-06-04T21:10:00.000Z\\",\\"resolved\\":\\"2026-06-05T01:40:00.000Z\\",' +
      `\\"status\\":\\"RESOLVED\\",\\"components\\":[{\\"id\\":\\"${WEB}\\"}]}`
    return `<script>self.__next_f.push([1,"x:${components}:notices\\":{${n1},${n2}},\\"metrics\\":{}"])</script>`
  }

  const perplexity = {
    id: 'perplexity', name: 'Perplexity', provider: 'Perplexity AI', category: 'api',
    statusUrl: 'https://status.perplexity.com', apiUrl: null, incidentKeywords: ['api'],
  } as ServiceConfig

  it('resolves each incident’s affected component ids → componentNames', () => {
    const incidents = parseInstatusIncidents(nextHtmlWithComponents())
    const byId = Object.fromEntries(incidents.map((i) => [i.id, i.componentNames]))
    expect(byId['n1']).toEqual(['Website', 'API']) // Website + API
    expect(byId['n2']).toEqual(['Website'])        // Website only
  })

  it('incidentKeywords:[api] keeps the Website+API incident, drops the Website-only one', () => {
    const kept = filterIncidents(parseInstatusIncidents(nextHtmlWithComponents()), perplexity).map((i) => i.id)
    expect(kept).toContain('n1')     // affects API → kept
    expect(kept).not.toContain('n2') // Website-only → dropped
  })
})

describe('parseInstatusComponents (#761) — per-component snapshot', () => {
  // Mirrors the real status.fal.ai / status.perplexity.com Next.js payload: top-level component
  // definitions carry `"id":"…","name":{"default":"…"},…,"status":"<STATE>"`. Children (e.g. fal's
  // "Model API" under the "API" group) serialize differently and are intentionally NOT matched, so
  // the snapshot stays at a uniform top-level granularity.
  function nextHtmlWithComponents(states: Record<string, string>) {
    const comp = (id: string, name: string, status: string) =>
      `\\"id\\":\\"${id}\\",\\"name\\":{\\"default\\":\\"${name}\\"},\\"nameHtml\\":{\\"default\\":\\"\\u003cp\\u003e${name}\\u003c/p\\u003e\\"},\\"isCollapsed\\":false,\\"order\\":1,\\"showUptime\\":true,\\"status\\":\\"${status}\\",\\"isParent\\":false,\\"children\\":[]`
    const escaped =
      comp('clzmj6mni0276gwmw95xftvtd', 'Website', states.web ?? 'OPERATIONAL') + ',' +
      comp('clzmj6mnv0283gwmwtdqtt9u3', 'API', states.api ?? 'OPERATIONAL') + ',' +
      comp('clzu5ivf0385762icocgwepue4u', 'Official Models', states.models ?? 'OPERATIONAL')
    return `<script>self.__next_f.push([1,"x:${escaped}"])</script>`
  }

  it('extracts top-level components with status mapped to the Atlassian vocabulary', () => {
    const comps = parseInstatusComponents(nextHtmlWithComponents({ api: 'MAJOROUTAGE', models: 'DEGRADEDPERFORMANCE' }))
    const byName = Object.fromEntries(comps.map((c) => [c.name, c.status]))
    expect(byName['Website']).toBe('operational')
    expect(byName['API']).toBe('major_outage')           // MAJOROUTAGE → major_outage
    expect(byName['Official Models']).toBe('degraded_performance') // DEGRADEDPERFORMANCE → degraded_performance
  })

  it('maps PARTIALOUTAGE → partial_outage and UNDERMAINTENANCE → operational', () => {
    const comps = parseInstatusComponents(nextHtmlWithComponents({ api: 'PARTIALOUTAGE', models: 'UNDERMAINTENANCE' }))
    const byName = Object.fromEntries(comps.map((c) => [c.name, c.status]))
    expect(byName['API']).toBe('partial_outage')
    expect(byName['Official Models']).toBe('operational')
  })

  it('feeds resolveSvcComponents — respects displayComponentIds order and drops unlisted ids', () => {
    // Generic resolveSvcComponents demonstration (a 2-id subset that omits Website) — shows order is
    // displayComponentIds order and an unlisted component is dropped. fal's REAL config lists all
    // three top-level components (pinned in fal-config.test.ts); this just exercises the resolver.
    const raw = parseInstatusComponents(nextHtmlWithComponents({ api: 'MAJOROUTAGE' }))
    const resolved = resolveSvcComponents(
      { displayComponentIds: ['clzu5ivf0385762icocgwepue4u', 'clzmj6mnv0283gwmwtdqtt9u3'] } as any,
      { components: raw },
    )
    expect(resolved.map((c) => c.name)).toEqual(['Official Models', 'API']) // order follows displayComponentIds; Website (unlisted) dropped
    expect(resolved.find((c) => c.name === 'API')!.status).toBe('down')      // major_outage → normalizeStatus → down
  })

  it('returns [] for a Nuxt payload (no per-component status field exposed) — Mistral deferred', () => {
    const arr = [{ uptime: 1, name: 2 }, 99.6, 'API']
    const html = `<script id="__NUXT_DATA__" type="application/json">${JSON.stringify(arr)}</script>`
    expect(parseInstatusComponents(html)).toEqual([])
  })

  it('returns [] for a non-Instatus / empty payload', () => {
    expect(parseInstatusComponents('<html></html>')).toEqual([])
  })
})
