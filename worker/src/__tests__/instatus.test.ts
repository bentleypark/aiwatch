import { describe, it, expect, vi } from 'vitest'
import { mapInstatusImpact, parseInstatusIncidents } from '../parsers/instatus'
import { filterIncidents } from '../services'
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
