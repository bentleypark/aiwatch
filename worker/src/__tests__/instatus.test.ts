import { describe, it, expect, vi } from 'vitest'
import { mapInstatusImpact, parseInstatusIncidents, parseInstatusUptime } from '../parsers/instatus'

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

  it('returns null for an unknown component, missing name, or Next.js format', () => {
    expect(parseInstatusUptime(nuxtHtmlWithUptime(), 'Nonexistent')).toBeNull()
    expect(parseInstatusUptime(nuxtHtmlWithUptime(), undefined)).toBeNull()
    expect(parseInstatusUptime('<script>self.__next_f.push([1,"x"])</script>', 'API')).toBeNull()
  })
})
