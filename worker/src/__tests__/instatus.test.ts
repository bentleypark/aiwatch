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

describe('parseInstatusUptime — Nuxt (#627 → #1006: computed, not copied)', () => {
  // #1006 — the old parser read the component's published `uptime` float. That aggregate spans the
  // page's own period (status.mistral.ai renders 90 days), so it was not comparable with the 30-day
  // figures every other source now yields. The raw material sits beside it: each component carries
  // `days` (90 × {date, events[]}) and each event has `created_at` + `duration` (seconds) + `severity`.
  const NOW = Date.parse('2026-07-14T00:00:00Z')
  const DAY = 86_400_000
  const ago = (d: number) => new Date(NOW - d * DAY).toISOString()

  /** Nuxt serialises as a flat array with index refs; component = {days, id, name, uptime}. */
  function nuxtHtml(events: Array<{ daysAgo: number; duration: number; severity: string }>) {
    const arr: unknown[] = ['API', 99.599, 'ignored-published-aggregate']
    const eventIdx: number[] = []
    for (const e of events) {
      arr.push(ago(e.daysAgo)); const createdAt = arr.length - 1
      arr.push(e.severity); const sev = arr.length - 1
      // EVERY Nuxt scalar is an index ref — including numbers. Inlining a raw duration would be
      // dereferenced as an array index and silently read as undefined.
      arr.push(e.duration); const dur = arr.length - 1
      arr.push({ created_at: createdAt, duration: dur, severity: sev })
      eventIdx.push(arr.length - 1)
    }
    // 90 days; every event is pinned to day 0's bucket (the parser reads created_at, not the bucket).
    const dayIdx: number[] = []
    for (let i = 0; i < 90; i++) {
      arr.push(i === 0 ? eventIdx : [])
      const evList = arr.length - 1
      arr.push({ date: ago(i), events: evList })
      dayIdx.push(arr.length - 1)
    }
    arr.push(dayIdx); const daysList = arr.length - 1
    arr.push({ id: 0, name: 0, uptime: 1, days: daysList })
    return `<script id="__NUXT_DATA__" type="application/json">${JSON.stringify(arr)}</script>`
  }

  it('computes the trailing 30 days from days[].events, ignoring the published aggregate', () => {
    // 24h MAJOR inside the window → 1 day of 30 → 96.66%. The page's own `uptime` (99.599) is not used.
    const html = nuxtHtml([{ daysAgo: 5, duration: 86_400, severity: 'CRITICAL' }])
    expect(parseInstatusUptime(html, 'API', NOW)).toBe(96.66)
  })

  it('weights a MEDIUM severity as a partial outage (0.3), per /methodology', () => {
    // 24h × 0.3 = 7.2h of 30 days → 99.00%
    const html = nuxtHtml([{ daysAgo: 5, duration: 86_400, severity: 'MEDIUM' }])
    expect(parseInstatusUptime(html, 'API', NOW)).toBe(99)
  })

  it('ignores an event OUTSIDE the 30-day window — the whole point of the rewrite', () => {
    const html = nuxtHtml([{ daysAgo: 60, duration: 86_400, severity: 'CRITICAL' }])
    expect(parseInstatusUptime(html, 'API', NOW)).toBe(100)
  })

  it('clips an event that straddles the window edge', () => {
    // Starts 31 days ago, runs 2 days → only ~1 day lands inside.
    const html = nuxtHtml([{ daysAgo: 31, duration: 2 * 86_400, severity: 'CRITICAL' }])
    expect(parseInstatusUptime(html, 'API', NOW)).toBe(96.66)
  })

  it('returns null for an unknown component or a missing name', () => {
    const html = nuxtHtml([])
    expect(parseInstatusUptime(html, 'Nonexistent', NOW)).toBeNull()
    expect(parseInstatusUptime(html, undefined, NOW)).toBeNull()
  })
})

describe('parseInstatusUptime — Next.js componentsUptime (#635 → #1006)', () => {
  // Mirrors status.perplexity.com: escaped component defs (id→name) + a `componentsUptime` object keyed
  // by component id, each entry nesting an `outages` array and an aggregate `"uptime"` string. #1006 —
  // the OUTAGES are now the source of truth; the aggregate (over the page's own 90-day period) is not.
  const NOW = Date.parse('2026-07-14T00:00:00Z')
  const DAY = 86_400_000
  const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString()

  const compDef = (id: string, name: string) =>
    `\\"id\\":\\"${id}\\",\\"name\\":{\\"default\\":\\"${name}\\"},\\"nameHtml\\":{\\"default\\":\\"\\u003cp\\u003e${name}\\u003c/p\\u003e\\"},\\"group\\":null,\\"children\\":[],`

  const outage = (fromDaysAgo: number, hours: number, status: string, customPct?: number) => {
    const from = iso(fromDaysAgo)
    const to = new Date(Date.parse(from) + hours * 3_600_000).toISOString()
    const custom = customPct != null
      ? `,\\"customImpactPercentage\\":${customPct},\\"isCustomPercentage\\":true`
      : ''
    return `{\\"from\\":\\"${from}\\",\\"to\\":\\"${to}\\",\\"status\\":\\"${status}\\"${custom}}`
  }

  const nextHtml = (outages: string[]) => {
    const escaped =
      compDef('cidapi001', 'API') +
      '\\"componentsUptime\\":{\\"cidapi001\\":{' +
        `\\"outages\\":[${outages.join(',')}],` +
        '\\"uptime\\":\\"99.82\\"}}'   // the page's own aggregate — deliberately NOT what we return
    return `<script>self.__next_f.push([1,"${escaped}"])</script>`
  }

  it('computes from outages over 30 days, not from the published aggregate', () => {
    const html = nextHtml([outage(5, 24, 'MAJOROUTAGE')])
    expect(parseInstatusUptime(html, 'API', NOW)).toBe(96.66) // NOT 99.82
  })

  it('uses the provider’s OWN impact fraction when it states one (customImpactPercentage)', () => {
    // Instatus says this partial outage hit 50% of capacity. Their number beats our 0.3 default.
    // 24h × 0.5 = 12h of 30 days → 98.33%
    const html = nextHtml([outage(5, 24, 'PARTIALOUTAGE', 50)])
    expect(parseInstatusUptime(html, 'API', NOW)).toBe(98.33)
  })

  it('falls back to the documented weights when no custom fraction is given', () => {
    // PARTIALOUTAGE → 0.3. 24h × 0.3 = 7.2h of 30 → 99.00%
    const html = nextHtml([outage(5, 24, 'PARTIALOUTAGE')])
    expect(parseInstatusUptime(html, 'API', NOW)).toBe(99)
  })

  it('ignores an OPERATIONAL "outage" row and anything outside the window', () => {
    expect(parseInstatusUptime(nextHtml([outage(5, 24, 'OPERATIONAL')]), 'API', NOW)).toBe(100)
    expect(parseInstatusUptime(nextHtml([outage(60, 24, 'MAJOROUTAGE')]), 'API', NOW)).toBe(100)
  })

  // #1006 review — an OPEN outage has `to: null`; it must count to now, not be dropped (the "spotless
  // 100% during a live outage" symptom the rewrite exists to kill).
  it('an ONGOING outage (to null) counts to now, it is not dropped', () => {
    const openOutage = `{\\"from\\":\\"${iso(1)}\\",\\"to\\":null,\\"status\\":\\"MAJOROUTAGE\\"}` // started 24h ago, still open
    expect(parseInstatusUptime(nextHtml([openOutage]), 'API', NOW)).toBe(96.66) // 24h of 30d, NOT 100
  })

  it('a clean component is 100%', () => {
    expect(parseInstatusUptime(nextHtml([]), 'API', NOW)).toBe(100)
  })

  it('returns null for an unknown component or undefined name', () => {
    expect(parseInstatusUptime(nextHtml([]), 'Nonexistent', NOW)).toBeNull()
    expect(parseInstatusUptime(nextHtml([]), undefined, NOW)).toBeNull()
  })
})

describe('parseInstatusIncidents — Next.js component capture (#623, Perplexity)', () => {
  // Mirrors the real status.perplexity.com payload: a `components` array (id→name: Website, API) —
  // each TOP-LEVEL component carries `nameHtml` + a `group` field (#911) — plus notices that reference
  // component ids and carry `name:{en,default}` (no nameHtml).
  function nextHtmlWithComponents() {
    // Real Instatus ids are cuid-style (e.g. clyi6jhgg31469ihojbwbsmeeg) — use that shape so the test
    // exercises the regex's id charset/length faithfully.
    const WEB = 'clyi6jhgg31469ihojbwbsmeeg'
    const API = 'clyiakn7i60113hvojwho6za6j'
    const comp = (id: string, name: string) =>
      `{\\"id\\":\\"${id}\\",\\"name\\":{\\"default\\":\\"${name}\\"},\\"nameHtml\\":{\\"default\\":\\"\\u003cp\\u003e${name}\\u003c/p\\u003e\\"},\\"status\\":\\"OPERATIONAL\\",\\"group\\":null,\\"children\\":[]}`
    const components =
      '\\"components\\":[' + comp(WEB, 'Website') + ',' + comp(API, 'API') + ']'
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
  // A TOP-LEVEL component carries a `"group"` field before `"children"` (#911 discriminator). The real
  // Instatus payload includes it; the fixture must too, or the `"group"`-gated regex won't match.
  function nextHtmlWithComponents(states: Record<string, string>) {
    const comp = (id: string, name: string, status: string) =>
      `\\"id\\":\\"${id}\\",\\"name\\":{\\"default\\":\\"${name}\\"},\\"nameHtml\\":{\\"default\\":\\"\\u003cp\\u003e${name}\\u003c/p\\u003e\\"},\\"isCollapsed\\":false,\\"order\\":1,\\"showUptime\\":true,\\"status\\":\\"${status}\\",\\"isParent\\":false,\\"group\\":null,\\"children\\":[]`
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

  // #911 — Perplexity added a TOP-LEVEL "Computer" component whose name object carries an `"en"`
  // locale key BEFORE `"default"` (`{"en":"Computer","default":"Computer"}`), unlike the older
  // `default`-only "API"/"Website". The old `"name":{"default":` anchor silently dropped it.
  it('extracts a top-level component whose name has an `en` locale key before `default` (Perplexity Computer)', () => {
    const withEn = (id: string, name: string, status: string, en: boolean, group: boolean) => {
      const nameObj = en ? `{\\"en\\":\\"${name}\\",\\"default\\":\\"${name}\\"}` : `{\\"default\\":\\"${name}\\"}`
      const groupField = group ? `\\"group\\":null,` : ''
      return `\\"id\\":\\"${id}\\",\\"name\\":${nameObj},\\"nameHtml\\":{\\"default\\":\\"\\u003cp\\u003e${name}\\u003c/p\\u003e\\"},\\"isCollapsed\\":true,\\"order\\":3,\\"showUptime\\":true,\\"status\\":\\"${status}\\",\\"isParent\\":false,${groupField}\\"children\\":[]`
    }
    const escaped =
      withEn('clyiakn7i60113hvojwho6za6j', 'API', 'OPERATIONAL', false, true) + ',' +
      withEn('clyi6jhgg31469ihojbwbsmeeg', 'Website', 'OPERATIONAL', false, true) + ',' +
      withEn('cmr18ih7201l20rqmap66bx4l', 'Computer', 'DEGRADEDPERFORMANCE', true, true)
    const comps = parseInstatusComponents(`<script>self.__next_f.push([1,"x:${escaped}"])</script>`)
    const byName = Object.fromEntries(comps.map((c) => [c.name, c.status]))
    expect(byName['Computer']).toBe('degraded_performance') // en-key top-level now matched + status read
    expect(byName['API']).toBe('operational')
    expect(byName['Website']).toBe('operational')
    expect(comps.map((c) => c.id)).toContain('cmr18ih7201l20rqmap66bx4l')
  })

  // #911 — a CHILD sub-component (e.g. fal's "Model API" under the "API" parent) ALSO carries the
  // `{"en":…,"default":…}` shape, so the `en` key can't discriminate top-level from child. Children
  // have NO `"group"` field — the `"group"`-gated regex excludes them, preserving top-level granularity.
  it('excludes a child sub-component that shares the `en` name shape but has no `group` field (fal Model API)', () => {
    // Parent "API" (has group + a nested child), then the child "Model API" (en shape, NO group).
    const parent =
      `\\"id\\":\\"clzmj6mnv0283gwmwtdqtt9u3\\",\\"name\\":{\\"default\\":\\"API\\"},\\"nameHtml\\":{\\"default\\":\\"\\u003cp\\u003eAPI\\u003c/p\\u003e\\"},\\"isCollapsed\\":false,\\"order\\":1,\\"showUptime\\":true,\\"status\\":\\"OPERATIONAL\\",\\"isParent\\":true,\\"group\\":null,\\"children\\":[` +
        `{\\"id\\":\\"cmp1437hn01j2bv9drf8hek1u\\",\\"name\\":{\\"en\\":\\"Model API\\",\\"default\\":\\"Model API\\"},\\"nameHtml\\":{\\"en\\":\\"\\u003cp\\u003eModel API\\u003c/p\\u003e\\",\\"default\\":\\"\\u003cp\\u003eModel API\\u003c/p\\u003e\\"},\\"isCollapsed\\":true,\\"order\\":1,\\"showUptime\\":true,\\"status\\":\\"MAJOROUTAGE\\",\\"isParent\\":false,\\"children\\":[]}` +
      `]`
    const comps = parseInstatusComponents(`<script>self.__next_f.push([1,"x:${parent}"])</script>`)
    expect(comps.map((c) => c.name)).toEqual(['API'])                 // parent only
    expect(comps.map((c) => c.id)).not.toContain('cmp1437hn01j2bv9drf8hek1u') // child dropped
    // The bounded first-`"status"` scan must read the PARENT's status (OPERATIONAL), NOT the nested
    // child's (MAJOROUTAGE) — a regression in the anchor/window would read the child's and go unnoticed.
    expect(comps.find((c) => c.name === 'API')!.status).toBe('operational')
  })

  // #911 — an incident notice also serializes `{"en":…,"default":…}` but is followed by `"started"`,
  // not `"nameHtml"`. Anchoring on the trailing `,"nameHtml"` keeps notices out of the component map.
  it('excludes an incident notice (en name shape, no nameHtml)', () => {
    const comp =
      `\\"id\\":\\"clzmj6mnv0283gwmwtdqtt9u3\\",\\"name\\":{\\"default\\":\\"API\\"},\\"nameHtml\\":{\\"default\\":\\"\\u003cp\\u003eAPI\\u003c/p\\u003e\\"},\\"isCollapsed\\":false,\\"order\\":1,\\"showUptime\\":true,\\"status\\":\\"OPERATIONAL\\",\\"isParent\\":false,\\"group\\":null,\\"children\\":[]`
    const notice =
      `\\"id\\":\\"cmr3uqd3801w80kqfk6xdj08m\\",\\"name\\":{\\"en\\":\\"Computer Sandbox Issue\\",\\"default\\":\\"Computer Sandbox Issue\\"},\\"started\\":\\"2026-07-02T18:30:00.000Z\\",\\"resolved\\":null,\\"status\\":\\"INVESTIGATING\\",\\"impact\\":\\"PARTIALOUTAGE\\"`
    const comps = parseInstatusComponents(`<script>self.__next_f.push([1,"x:${comp},${notice}"])</script>`)
    expect(comps.map((c) => c.name)).toEqual(['API'])                    // notice excluded
    expect(comps.map((c) => c.name)).not.toContain('Computer Sandbox Issue')
  })

  // #911 — verbatim real-payload regression. The hand-built fixtures above are authored to the regex,
  // so they're self-consistent; this one uses bytes captured from the LIVE status.perplexity.com Next.js
  // payload (2026-07-06, full field set + real order) so an upstream serialization change is caught, not
  // assumed. API/Website are `default`-only; Computer carries the `{"en":…,"default":…}` shape.
  it('extracts all three components from a verbatim real status.perplexity.com payload', () => {
    // Verbatim escaped component bytes captured from a real status.perplexity.com Next.js
    // payload (2026-07-06) — defeats fixture circularity: if Instatus ever reorders/renames a
    // field the regex depends on, this real-bytes test catches it (#911).
    const REAL_API = '\\"id\\":\\"clyiakn7i60113hvojwho6za6j\\",\\"name\\":{\\"default\\":\\"API\\"},\\"nameHtml\\":{\\"default\\":\\"\\u003cp\\u003eAPI\\u003c/p\\u003e\\"},\\"description\\":{\\"default\\":\\"\\"},\\"descriptionHtml\\":{\\"default\\":\\"\\"},\\"isCollapsed\\":false,\\"order\\":2,\\"showUptime\\":true,\\"status\\":\\"OPERATIONAL\\",\\"archivedAt\\":null,\\"isThirdParty\\":false,\\"isParent\\":false,\\"thirdPartyComponentService\\":null,\\"startDate\\":null,\\"metrics\\":[],\\"group\\":null,\\"children\\":[]}'
    const REAL_WEB = '\\"id\\":\\"clyi6jhgg31469ihojbwbsmeeg\\",\\"name\\":{\\"default\\":\\"Website\\"},\\"nameHtml\\":{\\"default\\":\\"\\u003cp\\u003eWebsite\\u003c/p\\u003e\\"},\\"description\\":{\\"default\\":\\"\\"},\\"descriptionHtml\\":{\\"default\\":\\"\\"},\\"isCollapsed\\":false,\\"order\\":1,\\"showUptime\\":true,\\"status\\":\\"OPERATIONAL\\",\\"archivedAt\\":null,\\"isThirdParty\\":false,\\"isParent\\":false,\\"thirdPartyComponentService\\":null,\\"startDate\\":null,\\"metrics\\":[],\\"group\\":null,\\"children\\":[]}'
    const REAL_COMP = '\\"id\\":\\"cmr18ih7201l20rqmap66bx4l\\",\\"name\\":{\\"en\\":\\"Computer\\",\\"default\\":\\"Computer\\"},\\"nameHtml\\":{\\"en\\":\\"\\u003cp\\u003eComputer\\u003c/p\\u003e\\",\\"default\\":\\"\\u003cp\\u003eComputer\\u003c/p\\u003e\\"},\\"description\\":{\\"default\\":\\"\\"},\\"descriptionHtml\\":{\\"default\\":\\"\\"},\\"isCollapsed\\":true,\\"order\\":3,\\"showUptime\\":true,\\"status\\":\\"OPERATIONAL\\",\\"archivedAt\\":null,\\"isThirdParty\\":false,\\"isParent\\":false,\\"thirdPartyComponentService\\":null,\\"startDate\\":null,\\"metrics\\":[],\\"group\\":null,\\"children\\":[]}'
    const html = `<script>self.__next_f.push([1,"x:\\"components\\":[${REAL_API},${REAL_WEB},${REAL_COMP}]"])</script>`
    const comps = parseInstatusComponents(html)
    expect(comps.map((c) => c.name).sort()).toEqual(['API', 'Computer', 'Website'])
    expect(comps.map((c) => c.id)).toContain('cmr18ih7201l20rqmap66bx4l')
    expect(comps.every((c) => c.status === 'operational')).toBe(true)
  })

  // #911 — a top-level component that ships WITHOUT a `group` field is (by design) silently dropped:
  // the `group`-gated regex can't tell it from a child. This documents that known fragility AND asserts
  // the diagnostic warn-once fires so the silent miss is observable (mirrors warnNextUptimeShape).
  it('drops a groupless top-level component but warns once (shape-drift diagnostic)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const noGroup =
        `\\"id\\":\\"nogroupid001\\",\\"name\\":{\\"default\\":\\"API\\"},\\"nameHtml\\":{\\"default\\":\\"\\u003cp\\u003eAPI\\u003c/p\\u003e\\"},\\"isCollapsed\\":false,\\"order\\":1,\\"showUptime\\":true,\\"status\\":\\"OPERATIONAL\\",\\"isParent\\":false,\\"children\\":[]`
      const comps = parseInstatusComponents(`<script>self.__next_f.push([1,"x:${noGroup}"])</script>`)
      expect(comps).toEqual([]) // dropped — the documented `group`-presence fragility
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('top-level (`group`-gated) discriminator'))
    } finally {
      warn.mockRestore()
    }
  })
})
