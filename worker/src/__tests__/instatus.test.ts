import { describe, it, expect, vi } from 'vitest'
import { mapInstatusImpact, parseInstatusIncidents, parseInstatusIncidentsResult, parseInstatusUptime, parseInstatusComponents } from '../parsers/instatus'
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
    expect(parseInstatusUptime(html, 'API', NOW)?.pct).toBe(96.66)
  })

  it('weights a MEDIUM severity as a partial outage (0.3), per /methodology', () => {
    // 24h × 0.3 = 7.2h of 30 days → 99.00%
    const html = nuxtHtml([{ daysAgo: 5, duration: 86_400, severity: 'MEDIUM' }])
    expect(parseInstatusUptime(html, 'API', NOW)?.pct).toBe(99)
  })

  it('ignores an event OUTSIDE the 30-day window — the whole point of the rewrite', () => {
    const html = nuxtHtml([{ daysAgo: 60, duration: 86_400, severity: 'CRITICAL' }])
    expect(parseInstatusUptime(html, 'API', NOW)?.pct).toBe(100)
  })

  it('clips an event that straddles the window edge', () => {
    // Starts 31 days ago, runs 2 days → only ~1 day lands inside.
    const html = nuxtHtml([{ daysAgo: 31, duration: 2 * 86_400, severity: 'CRITICAL' }])
    expect(parseInstatusUptime(html, 'API', NOW)?.pct).toBe(96.66)
  })

  it('returns null for an unknown component or a missing name', () => {
    const html = nuxtHtml([])
    expect(parseInstatusUptime(html, 'Nonexistent', NOW)).toBeNull()
    expect(parseInstatusUptime(html, undefined, NOW)).toBeNull()
  })

  // #1017 — this block's NOW is exactly midnight UTC, so "today so far" is always a zero-length
  // window there (correctly 0 in every test above, same reason incident-io.test.ts needed a second
  // NOW). `daysAgo` accepts a negative/fractional value (ago(-0.5) = NOW + 12h) to place an event
  // later in the SAME UTC day without a second fixture builder — the day-bucket index (`i===0`) the
  // event structurally lands in is irrelevant to the computation, which sweeps on created_at/duration.
  it('todayWeightedOutageSec (#1017) reflects only the portion of an event inside today', () => {
    const queryNow = NOW + 15 * 3_600_000 // 15h into the same UTC day as NOW
    const html = nuxtHtml([{ daysAgo: -0.5, duration: 2 * 3600, severity: 'CRITICAL' }]) // NOW+12h, 2h long
    expect(parseInstatusUptime(html, 'API', queryNow)?.todayWeightedOutageSec).toBe(2 * 3600)
  })
})

describe('parseInstatusUptime — Nuxt GROUP node worst-of independence (#1017)', () => {
  // Mistral's configured `statusComponent: 'API'` addresses the API GROUP, not a single component
  // (instatus.ts's `services` branch, ~line 615) — every test in the describe block above exercises
  // only the single-component `'days' in o` branch, leaving this group branch's worst-of logic
  // completely untested even though it runs in production every cycle for Mistral.
  const NOW = Date.parse('2026-07-14T00:00:00Z')
  const DAY = 86_400_000
  const ago = (d: number) => new Date(NOW - d * DAY).toISOString()

  /** Appends one Nuxt member component ({id,name,uptime,days}) to the flat array; returns its index. */
  function pushMember(arr: unknown[], name: string, events: Array<{ daysAgo: number; duration: number; severity: string }>): number {
    arr.push(name); const nameIdx = arr.length - 1
    const eventIdx: number[] = []
    for (const e of events) {
      arr.push(ago(e.daysAgo)); const createdAt = arr.length - 1
      arr.push(e.severity); const sev = arr.length - 1
      arr.push(e.duration); const dur = arr.length - 1
      arr.push({ created_at: createdAt, duration: dur, severity: sev })
      eventIdx.push(arr.length - 1)
    }
    const dayIdx: number[] = []
    for (let i = 0; i < 90; i++) {
      arr.push(i === 0 ? eventIdx : [])
      const evList = arr.length - 1
      arr.push({ date: ago(i), events: evList })
      dayIdx.push(arr.length - 1)
    }
    arr.push(dayIdx); const daysList = arr.length - 1
    arr.push({ id: name, name: nameIdx, uptime: 99, days: daysList })
    return arr.length - 1
  }

  // Alpha: a large outage 5 days ago (the 30-day-worst member), nothing today.
  // Beta: a small outage TODAY only (negligible 30-day impact, but the worst-TODAY member).
  // A group that just takes the 30-day-worst member's todayWeightedOutageSec (instead of independently
  // worst-of'ing it) would report 0 — Alpha's figure — hiding Beta's live outage entirely.
  function nuxtGroupHtml(): string {
    const arr: unknown[] = []
    const alphaIdx = pushMember(arr, 'Alpha', [{ daysAgo: 5, duration: 86_400, severity: 'CRITICAL' }])
    const betaIdx = pushMember(arr, 'Beta', [{ daysAgo: -0.5, duration: 2 * 3600, severity: 'CRITICAL' }])
    arr.push([alphaIdx, betaIdx]); const servicesList = arr.length - 1
    arr.push('API'); const groupNameIdx = arr.length - 1
    arr.push({ id: 'grp-api', name: groupNameIdx, services: servicesList, uptime: 99.5, order: 0 })
    return `<script id="__NUXT_DATA__" type="application/json">${JSON.stringify(arr)}</script>`
  }

  it('pct worst-of picks the 30-day-worst member while todayWeightedOutageSec independently picks the worst-TODAY member', () => {
    const queryNow = NOW + 15 * 3_600_000 // 15h in — after Beta's event, same UTC day
    const result = parseInstatusUptime(nuxtGroupHtml(), 'API', queryNow)
    expect(result?.pct).toBe(96.66) // Alpha's 24h outage dominates the 30-day figure
    expect(result?.todayWeightedOutageSec).toBe(2 * 3600) // Beta's today outage — Alpha contributes 0 today
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
    expect(parseInstatusUptime(html, 'API', NOW)?.pct).toBe(96.66) // NOT 99.82
  })

  it('uses the provider’s OWN impact fraction when it states one (customImpactPercentage)', () => {
    // Instatus says this partial outage hit 50% of capacity. Their number beats our 0.3 default.
    // 24h × 0.5 = 12h of 30 days → 98.33%
    const html = nextHtml([outage(5, 24, 'PARTIALOUTAGE', 50)])
    expect(parseInstatusUptime(html, 'API', NOW)?.pct).toBe(98.33)
  })

  it('falls back to the documented weights when no custom fraction is given', () => {
    // PARTIALOUTAGE → 0.3. 24h × 0.3 = 7.2h of 30 → 99.00%
    const html = nextHtml([outage(5, 24, 'PARTIALOUTAGE')])
    expect(parseInstatusUptime(html, 'API', NOW)?.pct).toBe(99)
  })

  it('ignores an OPERATIONAL "outage" row and anything outside the window', () => {
    expect(parseInstatusUptime(nextHtml([outage(5, 24, 'OPERATIONAL')]), 'API', NOW)?.pct).toBe(100)
    expect(parseInstatusUptime(nextHtml([outage(60, 24, 'MAJOROUTAGE')]), 'API', NOW)?.pct).toBe(100)
  })

  // #1006 review — an OPEN outage has `to: null`; it must count to now, not be dropped (the "spotless
  // 100% during a live outage" symptom the rewrite exists to kill).
  it('an ONGOING outage (to null) counts to now, it is not dropped', () => {
    const openOutage = `{\\"from\\":\\"${iso(1)}\\",\\"to\\":null,\\"status\\":\\"MAJOROUTAGE\\"}` // started 24h ago, still open
    expect(parseInstatusUptime(nextHtml([openOutage]), 'API', NOW)?.pct).toBe(96.66) // 24h of 30d, NOT 100
  })

  it('a clean component is 100%', () => {
    expect(parseInstatusUptime(nextHtml([]), 'API', NOW)?.pct).toBe(100)
  })

  it('returns null for an unknown component or undefined name', () => {
    expect(parseInstatusUptime(nextHtml([]), 'Nonexistent', NOW)).toBeNull()
    expect(parseInstatusUptime(nextHtml([]), undefined, NOW)).toBeNull()
  })

  // #1017 — this describe block's NOW is exactly midnight UTC (see the file-level comment on the Nuxt
  // block's equivalent test below), so exercising a genuinely non-zero todayWeightedOutageSec needs a
  // query time later in the same UTC day. `outage()`'s `fromDaysAgo` accepts a negative/fractional
  // value to place the interval AFTER the closure's NOW without needing a second fixture builder.
  it('todayWeightedOutageSec (#1017) reflects only the portion of an outage inside today', () => {
    const queryNow = NOW + 15 * 3_600_000 // 15h into the same UTC day as NOW
    // fromDaysAgo=-0.5 → iso(-0.5) = NOW + 12h; a 2h outage ending at NOW+14h, entirely before queryNow.
    const html = nextHtml([outage(-0.5, 2, 'MAJOROUTAGE')])
    expect(parseInstatusUptime(html, 'API', queryNow)?.todayWeightedOutageSec).toBe(2 * 3600)
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

  // NOT "Nuxt is unsupported" — #761 made Nuxt a first-class producer (see the Nuxt describe block
  // below). This payload returns [] because it has no component GROUP object, not because it is Nuxt.
  it('returns [] for a Nuxt payload with no component tree', () => {
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

describe('parseInstatusComponents (#761) — Nuxt per-component snapshot (Mistral)', () => {
  // Faithful to the real status.mistral.ai __NUXT_DATA__ shape (captured 2026-07-20): a FLAT array
  // where every scalar is an index-ref into that same array. The payload publishes NO per-component
  // status, so the snapshot is derived from the component tree + each ongoing incident's `services[]`.
  // Built as a real index-ref graph — a fixture of plain literals would pass a parser that never
  // dereferences, which is the bug most likely to ship here.
  function nuxtHtml(opts: {
    groups: Record<string, string[]>            // group name → component names
    incidents?: Array<{ name: string; severity: string; status: string; services: string[] }>
  }) {
    const arr: unknown[] = []
    const put = (v: unknown) => { arr.push(v); return arr.length - 1 }
    const idOf = (name: string) => `id-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`

    const compRef = new Map<string, number>()
    for (const names of Object.values(opts.groups)) {
      for (const name of names) {
        // Component object: {id,name,createdAt,order} — note `createdAt`, which distinguishes it
        // from a GROUP (the discriminator the parser relies on).
        // `createdAt` mirrors the live component shape; note the parser SELECTS groups by the
        // services+order+name+id signature — `createdAt` is one of the defence-in-depth exclusions,
        // not the discriminator that does the work.
        compRef.set(name, put({
          id: put(idOf(name)), name: put(name),
          createdAt: put('2025-06-01T18:12:11.236Z'), order: put(0),
        }))
      }
    }
    for (const [group, names] of Object.entries(opts.groups)) {
      put({
        id: put(idOf(group)), name: put(group), order: put(0),
        services: put(names.map((n) => compRef.get(n)!)),
      })
    }
    for (const inc of opts.incidents ?? []) {
      put({
        id: put(idOf(inc.name)), name: put(inc.name),
        severity: put(inc.severity), duration: put(0),
        created_at: put('2026-07-17T07:55:56.406Z'), updated_at: put('2026-07-17T07:55:56.428Z'),
        lastUpdateStatus: put(inc.status),
        // An incident's `services[]` entries are the SAME component objects the tree references —
        // matching ids is what makes the attribution work (verified against the live payload).
        services: put(inc.services.map((n) => compRef.get(n)!)),
        incidentUpdates: put([]),
      })
    }
    return `<script id="__NUXT_DATA__" type="application/json">${JSON.stringify(arr)}</script>`
  }

  const MISTRAL_GROUPS = {
    API: ['Chat Completions API', 'Embeddings API', 'Audio API', 'Batch API'],
    Services: ['Documentation', 'Mistral.ai Website'],
  }

  it('derives the whole component tree as operational when nothing is ongoing', () => {
    const comps = parseInstatusComponents(nuxtHtml({ groups: MISTRAL_GROUPS }))
    expect(comps).toHaveLength(6)
    expect(comps.every((c) => c.status === 'operational')).toBe(true)
    expect(comps.map((c) => c.name)).toContain('Audio API')
  })

  it('marks ONLY the components an ongoing incident names (the #1062 facet-B signal)', () => {
    const comps = parseInstatusComponents(nuxtHtml({
      groups: MISTRAL_GROUPS,
      incidents: [{ name: 'Audio API Degraded', severity: 'MEDIUM', status: 'INVESTIGATING', services: ['Audio API'] }],
    }))
    const byName = Object.fromEntries(comps.map((c) => [c.name, c.status]))
    expect(byName['Audio API']).toBe('degraded_performance')
    // The service's PRIMARY surface must stay operational — that separation is the whole point.
    expect(byName['Chat Completions API']).toBe('operational')
    expect(byName['Embeddings API']).toBe('operational')
  })

  it('ignores a RESOLVED incident (it is history, not current state)', () => {
    const comps = parseInstatusComponents(nuxtHtml({
      groups: MISTRAL_GROUPS,
      incidents: [{ name: 'Batch API Degraded', severity: 'MAJOR', status: 'RESOLVED', services: ['Batch API'] }],
    }))
    expect(comps.find((c) => c.name === 'Batch API')!.status).toBe('operational')
  })

  it('maps severity to the Atlassian vocabulary via mapInstatusImpact', () => {
    const comps = parseInstatusComponents(nuxtHtml({
      groups: MISTRAL_GROUPS,
      incidents: [
        { name: 'Down', severity: 'CRITICAL', status: 'INVESTIGATING', services: ['Chat Completions API'] },
        { name: 'Slow', severity: 'MINOR', status: 'MONITORING', services: ['Embeddings API'] },
      ],
    }))
    const byName = Object.fromEntries(comps.map((c) => [c.name, c.status]))
    expect(byName['Chat Completions API']).toBe('major_outage')
    expect(byName['Embeddings API']).toBe('degraded_performance')
  })

  // BOTH orderings — the severe-first case is the one that fails under a naive last-write-wins
  // overlay, so testing only minor-first would pass a parser with no worst-of at all.
  it.each([
    ['minor first', ['MINOR', 'CRITICAL']],
    ['severe first', ['CRITICAL', 'MINOR']],
  ])('worst-ofs two ongoing incidents on the same component (%s)', (_label, [a, b]) => {
    const comps = parseInstatusComponents(nuxtHtml({
      groups: MISTRAL_GROUPS,
      incidents: [
        { name: 'First', severity: a, status: 'INVESTIGATING', services: ['Audio API'] },
        { name: 'Second', severity: b, status: 'INVESTIGATING', services: ['Audio API'] },
      ],
    }))
    expect(comps.find((c) => c.name === 'Audio API')!.status).toBe('major_outage')
  })

  it('does not mistake an incident object for a component group', () => {
    // An incident carries `services` + `name` + `id` just like a GROUP does, so it reaches the tree
    // scan. This asserts the OUTCOME that matters — no phantom component row, no incident title
    // leaking in as a component name — with the incident also given an `order` field so it clears the
    // group signature. Note the incident-field guard in the parser is defence-in-depth, NOT what saves
    // us here: an incident's `services[]` reference the very same component objects the tree does, so
    // reading one as a group would re-add known components rather than invent new ones. Mutating that
    // guard away therefore does NOT fail this test, and no claim is made that it would.
    const html = nuxtHtml({
      groups: MISTRAL_GROUPS,
      incidents: [{ name: 'Audio API Degraded', severity: 'MEDIUM', status: 'INVESTIGATING', services: ['Audio API'] }],
    })
    const arr = JSON.parse(html.slice(html.indexOf('>') + 1, html.lastIndexOf('<')))
    const inc = arr.find((v: unknown) => v != null && typeof v === 'object' && !Array.isArray(v) && 'severity' in (v as object))
    inc.order = arr.push(0) - 1
    const comps = parseInstatusComponents(
      `<script id="__NUXT_DATA__" type="application/json">${JSON.stringify(arr)}</script>`,
    )
    expect(comps).toHaveLength(6)
    expect(comps.map((c) => c.name)).not.toContain('Audio API Degraded')
  })

  it('leaves components operational for an in-progress MAINTENANCE window', () => {
    // Maintenance clears the RESOLVED skip (its lastUpdateStatus is NOTSTARTEDYET/INPROGRESS/…), so
    // it reaches the severity mapping and must land on `operational` via mapInstatusImpact's null.
    const comps = parseInstatusComponents(nuxtHtml({
      groups: MISTRAL_GROUPS,
      incidents: [{ name: 'Scheduled upgrade', severity: 'MAINTENANCE', status: 'INPROGRESS', services: ['Batch API'] }],
    }))
    expect(comps.find((c) => c.name === 'Batch API')!.status).toBe('operational')
  })

  it('treats an UNKNOWN severity as degraded, not operational (fails safe)', () => {
    // mapInstatusImpact maps an unrecognised severity to 'minor' + warns. Pinning it here so the
    // fail-safe direction is a decision on record: a new Instatus word must not read as green.
    const comps = parseInstatusComponents(nuxtHtml({
      groups: MISTRAL_GROUPS,
      incidents: [{ name: 'Odd', severity: 'CATASTROPHIC', status: 'INVESTIGATING', services: ['Audio API'] }],
    }))
    expect(comps.find((c) => c.name === 'Audio API')!.status).toBe('degraded_performance')
  })

  it('ignores an ongoing incident with an empty services[] (no attribution yet)', () => {
    // Very common real state: the incident is opened before components are attached.
    const comps = parseInstatusComponents(nuxtHtml({
      groups: MISTRAL_GROUPS,
      incidents: [{ name: 'Investigating elevated errors', severity: 'MAJOR', status: 'INVESTIGATING', services: [] }],
    }))
    expect(comps.every((c) => c.status === 'operational')).toBe(true)
  })

  it('drops an incident-named component that is absent from the tree (no phantom row)', () => {
    const html = nuxtHtml({
      groups: MISTRAL_GROUPS,
      incidents: [{ name: 'Ungrouped surface down', severity: 'MAJOR', status: 'INVESTIGATING', services: [] }],
    })
    const arr = JSON.parse(html.slice(html.indexOf('>') + 1, html.lastIndexOf('<')))
    // Point the incident at a component object that no group references.
    const orphan = arr.push({ id: arr.push('id-orphan') - 1, name: arr.push('Orphan API') - 1 }) - 1
    const inc = arr.find((v: unknown) => v != null && typeof v === 'object' && !Array.isArray(v) && 'severity' in (v as object))
    inc.services = arr.push([orphan]) - 1
    const comps = parseInstatusComponents(`<script id="__NUXT_DATA__" type="application/json">${JSON.stringify(arr)}</script>`)
    expect(comps).toHaveLength(6)
    expect(comps.map((c) => c.name)).not.toContain('Orphan API')
    expect(comps.every((c) => c.status === 'operational')).toBe(true)
  })

  it('prefers the Nuxt path when BOTH SSR markers are present', () => {
    const nuxt = nuxtHtml({
      groups: MISTRAL_GROUPS,
      incidents: [{ name: 'Audio API Degraded', severity: 'MEDIUM', status: 'INVESTIGATING', services: ['Audio API'] }],
    })
    const comps = parseInstatusComponents(`${nuxt}<script>self.__next_f.push([1,"x:"])</script>`)
    expect(comps).toHaveLength(6)
    expect(comps.find((c) => c.name === 'Audio API')!.status).toBe('degraded_performance')
  })

  it('returns [] on a payload with no component tree, and on malformed JSON', () => {
    expect(parseInstatusComponents(nuxtHtml({ groups: {} }))).toEqual([])
    expect(parseInstatusComponents('<script id="__NUXT_DATA__" type="application/json">{{oops</script>')).toEqual([])
  })

  // The two drift diagnostics. A warn is "pass by default" code — it fires only on a payload nobody
  // has yet seen — so each is asserted in BOTH directions: it fires on the drifted fixture AND stays
  // silent on the healthy one. Without the negative half a warn wired to `true` would look tested.
  describe('drift diagnostics (#761)', () => {
    // The module warns ONCE per isolate; vitest shares module state across tests in a file, so each
    // case re-imports the parser fresh to get an un-fired warn latch.
    async function freshParse(html: string) {
      vi.resetModules()
      const mod = await import('../parsers/instatus')
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const out = mod.parseInstatusComponents(html)
        return { out, warns: warn.mock.calls.map((c) => String(c[0])) }
      } finally {
        warn.mockRestore()
      }
    }

    const healthy = () => nuxtHtml({
      groups: MISTRAL_GROUPS,
      incidents: [{ name: 'Audio API Degraded', severity: 'MEDIUM', status: 'INVESTIGATING', services: ['Audio API'] }],
    })

    it('warns when the component tree matches nothing (group shape drift)', async () => {
      // Assumption (a) broken: groups now also carry `createdAt`, so the exclusion skips every one.
      const html = healthy()
      const arr = JSON.parse(html.slice(html.indexOf('>') + 1, html.lastIndexOf('<')))
      for (const v of arr) {
        if (v && typeof v === 'object' && !Array.isArray(v) && 'services' in v && 'order' in v) {
          v.createdAt = arr.push('2025-06-01T18:12:11.236Z') - 1
        }
      }
      const { out, warns } = await freshParse(`<script id="__NUXT_DATA__" type="application/json">${JSON.stringify(arr)}</script>`)
      expect(out).toEqual([])
      expect(warns.some((w) => w.includes('NO component group matched'))).toBe(true)
    })

    it('warns when unresolved incidents exist but NONE overlay onto a component', async () => {
      // Assumption (b) broken: the incident's services[] no longer deref to component objects. The
      // tree still parses, so the output is a full all-operational snapshot — the malignant case.
      const html = healthy()
      const arr = JSON.parse(html.slice(html.indexOf('>') + 1, html.lastIndexOf('<')))
      const inc = arr.find((v: unknown) => v != null && typeof v === 'object' && !Array.isArray(v) && 'severity' in (v as object))
      inc.services = arr.push(['not-a-ref']) - 1
      const { out, warns } = await freshParse(`<script id="__NUXT_DATA__" type="application/json">${JSON.stringify(arr)}</script>`)
      expect(out).toHaveLength(6)
      expect(out.every((c) => c.status === 'operational')).toBe(true) // the wrong-looking-right output
      expect(warns.some((w) => w.includes('NONE overlaid onto a tree component'))).toBe(true)
    })

    // A maintenance window and an incident with no components attached yet are BOTH legitimate
    // reasons for an all-operational snapshot, so neither may trip the drift warn — a diagnostic that
    // fires on ordinary traffic gets learned as noise. Asserting the OUTPUT alone (as the tests above
    // do) would not catch a warn that fires anyway, so the silence is pinned here explicitly.
    it.each([
      ['an in-progress MAINTENANCE window', { name: 'Scheduled upgrade', severity: 'MAINTENANCE', status: 'INPROGRESS', services: ['Batch API'] }],
      ['an ongoing incident with no components attached', { name: 'Investigating', severity: 'MAJOR', status: 'INVESTIGATING', services: [] }],
    ])('stays SILENT on %s', async (_label, incident) => {
      const { out, warns } = await freshParse(nuxtHtml({ groups: MISTRAL_GROUPS, incidents: [incident as never] }))
      expect(out.every((c) => c.status === 'operational')).toBe(true)
      expect(warns.filter((w) => w.includes('NONE overlaid'))).toEqual([])
    })

    it('stays SILENT on a healthy payload, and on one with no ongoing incidents', async () => {
      const ok = await freshParse(healthy())
      expect(ok.out.find((c) => c.name === 'Audio API')!.status).toBe('degraded_performance')
      expect(ok.warns.filter((w) => w.includes('parseInstatusNuxtComponents'))).toEqual([])

      // No ongoing incidents at all is the healthy steady state — an all-operational snapshot here
      // must NOT warn, or the diagnostic would fire on every quiet cron cycle and be ignored.
      const quiet = await freshParse(nuxtHtml({ groups: MISTRAL_GROUPS }))
      expect(quiet.out.every((c) => c.status === 'operational')).toBe(true)
      expect(quiet.warns.filter((w) => w.includes('parseInstatusNuxtComponents'))).toEqual([])
    })

    // The boundary of what this diagnostic can see, pinned so nobody later reads the warn as a
    // guarantee. If the incident-side `services` KEY is renamed away, no incident is counted and no
    // warn fires — undiagnosable here, because the payload offers nothing that separates it from the
    // benign "opened before attribution" state (live: 1 of 284 incident objects carries `services`,
    // and 0 resolved ones do, so past incidents cannot witness the field either).
    it('does NOT warn when the incident-side services key itself is renamed (known limitation)', async () => {
      const html = healthy()
      const arr = JSON.parse(html.slice(html.indexOf('>') + 1, html.lastIndexOf('<')))
      const inc = arr.find((v: unknown) => v != null && typeof v === 'object' && !Array.isArray(v) && 'severity' in (v as object))
      inc.affectedComponents = inc.services
      delete inc.services
      const { out, warns } = await freshParse(`<script id="__NUXT_DATA__" type="application/json">${JSON.stringify(arr)}</script>`)
      expect(out).toHaveLength(6)
      expect(out.every((c) => c.status === 'operational')).toBe(true) // wrong, and knowingly unwarned
      expect(warns.filter((w) => w.includes('parseInstatusNuxtComponents'))).toEqual([])
    })

    it('logs a malformed payload distinguishably from a traversal failure', async () => {
      const { out, warns } = await freshParse('<script id="__NUXT_DATA__" type="application/json">{{oops</script>')
      expect(out).toEqual([])
      expect(warns.some((w) => w.includes('JSON parse failed'))).toBe(true)
    })
  })

  it('feeds resolveSvcComponents with the service displayComponentIds (end-to-end wiring)', () => {
    const comps = parseInstatusComponents(nuxtHtml({
      groups: MISTRAL_GROUPS,
      incidents: [{ name: 'Audio API Degraded', severity: 'MEDIUM', status: 'INVESTIGATING', services: ['Audio API'] }],
    }))
    const cfg = {
      id: 'mistral',
      displayComponentIds: ['id-chat-completions-api', 'id-audio-api', 'id-batch-api'],
    } as unknown as ServiceConfig
    const resolved = resolveSvcComponents(cfg, { components: comps })
    expect(resolved.map((c) => c.name)).toEqual(['Chat Completions API', 'Audio API', 'Batch API'])
    expect(resolved.find((c) => c.name === 'Audio API')!.status).toBe('degraded')
    // Website/Documentation are outside displayComponentIds → never reach the API-surface card.
    expect(resolved.map((c) => c.name)).not.toContain('Mistral.ai Website')
  })
})

describe('#1089 — an unreadable incident list is NOT "no incidents"', () => {
  // The bug: every failure path returned `[]`, identical to a healthy page with zero incidents. On the
  // Instatus branch the badge is `hasOngoing ? 'degraded' : httpStatus`, so that `[]` published a false
  // RECOVERY while the incident was still open upstream (observed 2026-07-20 on Mistral, whose incident
  // 4288f6a2 stayed `investigating` throughout while the monitor emitted "✅ recovered").

  /** A structurally VALID Nuxt payload carrying `incidents` — count controlled by the caller. */
  function nuxtPayload(incIndices: number[]) {
    return [
      'Audio API Degraded', 'INVESTIGATING', '2026-07-17T07:55:56.406Z', 0, 'MEDIUM', 'inc-1', [], [],
      { id: 5, name: 0, lastUpdateStatus: 1, created_at: 2, duration: 3, severity: 4, services: 6, incidentUpdates: 7 },
      incIndices,
      { incidents: 9 },
      { 'incidents-by-date-2026': 10 },
    ]
  }
  const wrap = (arr: unknown[]) => `<script id="__NUXT_DATA__" type="application/json">${JSON.stringify(arr)}</script>`

  it('a genuinely empty page is ok:true with no incidents — NOT a failure', () => {
    // The distinction the whole fix rests on. If this ever flips to ok:false, every quiet day would be
    // reported as an unreadable source and `sourceUnknown` would be permanently on.
    const got = parseInstatusIncidentsResult(wrap(nuxtPayload([])))
    expect(got).toEqual({ ok: true, incidents: [] })
  })

  it('a healthy page with an ongoing incident is ok:true and carries it', () => {
    const got = parseInstatusIncidentsResult(wrap(nuxtPayload([8])))
    expect(got.ok).toBe(true)
    expect(got.ok && got.incidents.map(i => i.status)).toEqual(['investigating'])
  })

  it.each([
    ['no __NUXT_DATA__ script at all', '<html><body>maintenance</body></html>', 'no-nuxt-payload'],
    ['payload is not valid JSON', '<script id="__NUXT_DATA__" type="application/json">{oops</script>', 'bad-json'],
  ])('structural failure — %s → ok:false (%s)', (_label, html, reason) => {
    expect(parseInstatusIncidentsResult(html)).toEqual({ ok: false, reason })
  })

  it('structural failure — payload parses but carries no incidents-by-date ref', () => {
    expect(parseInstatusIncidentsResult(wrap([{ 'components-by-id': 0 }]))).toEqual({ ok: false, reason: 'no-incident-refs' })
  })

  it('structural failure — the ref exists but points at nothing usable', () => {
    const arr: unknown[] = ['x', { incidents: undefined }, { 'incidents-by-date-2026': 1 }]
    expect(parseInstatusIncidentsResult(wrap(arr))).toEqual({ ok: false, reason: 'no-incident-index' })
  })

  it('structural failure — the incident index is not an array', () => {
    const arr: unknown[] = ['not-an-array', { incidents: 0 }, { 'incidents-by-date-2026': 1 }]
    expect(parseInstatusIncidentsResult(wrap(arr))).toEqual({ ok: false, reason: 'no-incident-index' })
  })

  // The five per-item `return []` sites inside the flatMap are CORRECT behavior on a healthy payload —
  // counting them as failures would report a normal quiet page as an unreadable source. The <60s
  // micro-incident filter is the one most likely to empty the list on a real page.
  it('a payload whose only incident is filtered out (<60s micro-incident) stays ok:true', () => {
    const arr = nuxtPayload([8]) as unknown[]
    arr[1] = 'RESOLVED'
    arr[3] = 30 // 30s → dropped by the micro-incident filter
    const got = parseInstatusIncidentsResult(wrap(arr))
    expect(got).toEqual({ ok: true, incidents: [] })
  })

  it('a malformed single entry does not fail the whole parse', () => {
    const arr = nuxtPayload([8, 999]) as unknown[] // 999 is out of range → per-item skip
    const got = parseInstatusIncidentsResult(wrap(arr))
    expect(got.ok).toBe(true)
    expect(got.ok && got.incidents).toHaveLength(1)
  })

  it('the back-compat wrapper still collapses a failure to [] for read-only callers', () => {
    expect(parseInstatusIncidents('<html>nothing</html>')).toEqual([])
    expect(parseInstatusIncidentsResult('<html>nothing</html>').ok).toBe(false)
  })

  // perplexity / fal are Next-format. A guard covering only Mistral would read as protection while two
  // of the three Instatus services stayed exposed.
  it('Next.js format — a missing notices envelope is a structural failure, not "no incidents"', () => {
    expect(parseInstatusIncidentsResult('<script>self.__next_f.push([1,"other"])</script>'))
      .toEqual({ ok: false, reason: 'no-next-notices' })
  })

  it('Next.js format — a present-but-empty notices envelope is a genuine empty', () => {
    const html = '<script>self.__next_f.push([1,"{\\"notices\\":{},\\"metrics\\":{}}"])</script>'
    const got = parseInstatusIncidentsResult(html)
    expect(got).toEqual({ ok: true, incidents: [] })
  })
})

describe('#1089 review — Next.js inner-shape drift is a failure, not a quiet page', () => {
  // Review round 1 (Important 2): the first guard only asked "is the `notices` substring present?",
  // so every INNER shape change still returned ok:true with []. That is the same class of failure
  // Mistral actually hit on the Nuxt side — so perplexity/fal would have stayed exposed while the
  // comment claimed all three Instatus services were covered.
  const withEnvelope = (inner: string) => `<script>self.__next_f.push([1,"{\\"notices\\":{${inner}},\\"metrics\\":{}}"])</script>`

  it('an empty envelope is a genuine quiet page', () => {
    expect(parseInstatusIncidentsResult(withEnvelope(''))).toEqual({ ok: true, incidents: [] })
  })

  // The id-charset drift case lives in the round-3 describe below, with a REALISTIC notice. The version
  // that sat here carried no `started` field, so the parser would legitimately skip it either way —
  // the fixture, not the payload shape, was doing the work. It asserted the right thing for the wrong
  // reason, which is worse than not asserting it.


  it('a missing envelope is still reported as such', () => {
    expect(parseInstatusIncidentsResult('<script>self.__next_f.push([1,"other"])</script>'))
      .toEqual({ ok: false, reason: 'no-next-notices' })
  })
})

describe('#1089 review round 2 — a filtered-out Next page is quiet, not broken', () => {
  // Round-2 CRITICAL: the first Next guard accepted only a literally-empty `notices\\":{},` envelope.
  // A page whose notices are ALL dropped by the parser's own filters (the <60s micro-incident filter —
  // exactly the automated noise it exists for — or an unparseable `started`) yields zero incidents from
  // a POPULATED envelope, and was reported as a structural failure → sourceUnknown → a fabricated
  // outage after three cycles. The Nuxt path has always treated its per-item skips as invisible; these
  // make the two agree.
  //
  // Fixtures are built the way the real payload is — whole blob JSON-stringified, then every quote
  // escaped — after an ad-hoc hand-escaped version turned out to be malformed and produced failures
  // that looked like product bugs.
  const page = (obj: unknown) =>
    `<script>self.__next_f.push([1,"${JSON.stringify(obj).replace(/"/g, '\\"')}"])</script>`
  const mk = (o: Record<string, unknown>) => ({ id: 'n', name: { default: 'X' }, impact: 'minor', status: 'RESOLVED', ...o })

  it('a page whose only notice is a <60s micro-incident is ok:true, not a source failure', () => {
    const html = page({ notices: { n1: mk({ id: 'n1', started: '2026-07-20T00:00:00Z', resolved: '2026-07-20T00:00:30Z' }) }, metrics: {} })
    const got = parseInstatusIncidentsResult(html)
    expect(got.ok, `micro-incident-only must not read as drift: ${JSON.stringify(got)}`).toBe(true)
    expect(got.ok && got.incidents).toEqual([])
  })

  it('a page whose only notice has an unparseable start date is ok:true', () => {
    const html = page({ notices: { n2: mk({ id: 'n2', started: 'not-a-date', resolved: null, status: 'INVESTIGATING' }) }, metrics: {} })
    const got = parseInstatusIncidentsResult(html)
    expect(got.ok, `bad-date-only must not read as drift: ${JSON.stringify(got)}`).toBe(true)
  })

  it('a real ongoing notice still parses through', () => {
    // Guards the false-negative direction: the fix must not make everything ok:true-with-nothing.
    const html = page({ notices: { n3: mk({ id: 'n3', name: { default: 'API Degraded' }, started: '2026-07-20T00:00:00Z', resolved: null, status: 'INVESTIGATING' }) }, metrics: {} })
    const got = parseInstatusIncidentsResult(html)
    expect(got.ok && got.incidents.length, `an ongoing notice must survive: ${JSON.stringify(got)}`).toBe(1)
  })

  it('an empty envelope is a genuine quiet page — regardless of key order', () => {
    // The old guard hard-coded `notices\\":{},`; if Instatus ever emitted `notices` LAST, every quiet
    // day on perplexity/fal became a fabricated outage. Extraction does not care about key order.
    expect(parseInstatusIncidentsResult(page({ notices: {}, metrics: {} })).ok).toBe(true)
    expect(parseInstatusIncidentsResult(page({ metrics: {}, notices: {} })).ok).toBe(true)
  })

  it('an envelope whose contents no longer parse IS a failure', () => {
    const html = `<script>self.__next_f.push([1,"{\\"notices\\":{\\"n\\":{oops},\\"metrics\\":{}}"])</script>`
    expect(parseInstatusIncidentsResult(html)).toEqual({ ok: false, reason: 'next-shape-changed' })
  })

  it('a missing envelope is still reported as such', () => {
    expect(parseInstatusIncidentsResult('<script>self.__next_f.push([1,"other"])</script>'))
      .toEqual({ ok: false, reason: 'no-next-notices' })
  })
})

describe('#1089 review round 2 — a Nuxt incidents ref at index 0 is a valid ref', () => {
  it('does not read a falsy array index as "no incident index"', () => {
    // `if (!incObj?.incidents)` treated a legitimate index of 0 as absent. Pre-existing, but #1089
    // escalated the cost: it used to mean a silent `[]` (badge unchanged), and would now mean
    // sourceUnknown → degraded after three cycles, i.e. a fabricated outage from a healthy page.
    // Index 0 is unusual in a real Nuxt payload but nothing in the format forbids it.
    const arr: unknown[] = [
      [7],                          // 0 — incIndices, deliberately at index 0
      'API Degraded',               // 1 name
      'INVESTIGATING',              // 2 lastUpdateStatus
      '2026-07-20T00:00:00.000Z',   // 3 created_at
      0,                            // 4 duration
      'MEDIUM',                     // 5 severity
      'inc-0',                      // 6 id
      { id: 6, name: 1, lastUpdateStatus: 2, created_at: 3, duration: 4, severity: 5, services: 9, incidentUpdates: 9 }, // 7
      { incidents: 0 },             // 8 incObj → points at index 0
      [],                           // 9 empty services / updates
      { 'incidents-by-date-2026': 8 }, // 10 dataRefs
    ]
    const html = `<script id="__NUXT_DATA__" type="application/json">${JSON.stringify(arr)}</script>`
    const got = parseInstatusIncidentsResult(html)
    expect(got.ok, `index 0 must be honoured, not read as absent: ${JSON.stringify(got)}`).toBe(true)
    expect(got.ok && got.incidents.map(i => i.status)).toEqual(['investigating'])
  })
})

describe('#1089 review round 3 — Next whole-list regex failure is drift, not a quiet page', () => {
  // Round-3 Important: extraction alone made the Next path only APPEAR to agree with Nuxt. Nuxt's skips
  // are per-entry (losing the whole list needs every entry to fail independently); Next has ONE regex
  // covering the entire list, so a single anchor failure drops open incidents silently. These pin the
  // three drift shapes the reviewer demonstrated, each carrying a genuinely ONGOING incident.
  const page = (obj: unknown) =>
    `<script>self.__next_f.push([1,"${JSON.stringify(obj).replace(/"/g, '\\"')}"])</script>`
  const ongoing = (id: string) => ({ id, name: { default: 'API Degraded' }, impact: 'major', started: '2026-07-20T00:00:00Z', resolved: null, status: 'INVESTIGATING' })

  it('baseline: notices then metrics parses the ongoing incident', () => {
    const got = parseInstatusIncidentsResult(page({ notices: { n1: ongoing('n1') }, metrics: {} }))
    expect(got.ok && got.incidents).toHaveLength(1)
  })

  it('key order flipped (metrics before notices) → drift, not a quiet page', () => {
    const got = parseInstatusIncidentsResult(page({ metrics: {}, notices: { n1: ongoing('n1') } }))
    expect(got, 'an ongoing incident must not vanish into ok:true').toEqual({ ok: false, reason: 'next-shape-changed' })
  })

  it('an extra key between notices and metrics → drift', () => {
    const got = parseInstatusIncidentsResult(page({ notices: { n1: ongoing('n1') }, extra: {}, metrics: {} }))
    expect(got).toEqual({ ok: false, reason: 'next-shape-changed' })
  })

  it('id charset drift → drift', () => {
    const got = parseInstatusIncidentsResult(page({ notices: { _N3: ongoing('_N3') }, metrics: {} }))
    expect(got).toEqual({ ok: false, reason: 'next-shape-changed' })
  })
})
