import { describe, it, expect, vi, afterEach } from 'vitest'
import { parseIncidentIoUptime } from '../parsers/incident-io'
import { SERVICES } from '../services'

// #857 follow-up — turbopuffer's status page is an **incident.io** page (ULID component ids,
// `component_uptimes`) that merely serves a Statuspage-compatible summary.json. It was configured as
// an Atlassian Statuspage, so neither statusComponentId nor incidentIoComponentId was set, `needsHtml`
// never fetched the status HTML, and uptime30d stayed null — even though the page publishes uptime for
// all 15 per-region API components (display_uptime_mode: 'chart_and_percentage').
//
// The page has no group aggregate (every component is ungrouped), so uptime is a WORST-OF across the
// regions. These fixtures mirror the real escaped shape: the HTML carries `\"component_id\":\"…\"`.

const DASHBOARD_ID = '01K0Q5QSJV9KAZMEMMQ0NCHD9E'

/** One `component_uptimes` entry, in the page's real backslash-escaped form. */
const entry = (id: string, uptime: string) =>
  `{\\"component_id\\":\\"${id}\\",\\"data_available_since\\":\\"2023-12-07T00:00:00Z\\",` +
  `\\"status_page_component_group_id\\":\\"$undefined\\",\\"uptime\\":\\"${uptime}\\"}`

/** A group-aggregate entry (component_id=$undefined + a group id). */
const groupEntry = (groupId: string, uptime: string) =>
  `{\\"component_id\\":\\"$undefined\\",\\"status_page_component_group_id\\":\\"${groupId}\\",` +
  `\\"uptime\\":\\"${uptime}\\"}`

const chunk = (entries: string[]) =>
  `<script>self.__next_f.push([1,"a:{\\"component_uptimes\\":[${entries.join(',')}],\\"incident_links\\":[]}"])</script>`

afterEach(() => vi.restoreAllMocks())

describe('parseIncidentIoUptime — single component (pre-#857 behaviour preserved)', () => {
  it('reads a published value (groq shape)', () => {
    expect(parseIncidentIoUptime(chunk([entry('GROQ_API', '100.00')]), 'GROQ_API')).toBe(100)
  })

  it('returns null when the component publishes no value (chart_only pages: Stability/ElevenLabs/Replicate)', () => {
    expect(parseIncidentIoUptime(chunk([entry('STAB_API', '$undefined')]), 'STAB_API')).toBeNull()
  })

  it('returns null when the component is absent from component_uptimes', () => {
    expect(parseIncidentIoUptime(chunk([entry('OTHER', '99.50')]), 'MISSING')).toBeNull()
  })

  it('returns null (and warns) on an out-of-range value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseIncidentIoUptime(chunk([entry('X', '150')]), 'X')).toBeNull()
    expect(warn).toHaveBeenCalledOnce()
  })

  it('keeps scanning later chunks when an earlier component_uptimes lacks the id', () => {
    const html = chunk([entry('SOMEONE_ELSE', '99.00')]) + chunk([entry('MINE', '98.25')])
    expect(parseIncidentIoUptime(html, 'MINE')).toBe(98.25)
  })
})

describe('parseIncidentIoUptime — component LIST is a worst-of (#857)', () => {
  it('returns the minimum across the matched components', () => {
    const html = chunk([entry('R1', '100.00'), entry('R2', '99.61'), entry('R3', '100.00')])
    expect(parseIncidentIoUptime(html, ['R1', 'R2', 'R3'])).toBe(99.61)
  })

  it('ignores ids absent from the page (a region removed upstream does not null the uptime)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const html = chunk([entry('R1', '100.00'), entry('R2', '99.80')])
    expect(parseIncidentIoUptime(html, ['R1', 'R2', 'GONE'])).toBe(99.8)
  })

  it('accumulates the worst-of ACROSS chunks (a split component_uptimes must not drop later regions)', () => {
    // A per-chunk early return would report the healthy 100.00 and miss the degraded region entirely.
    const html = chunk([entry('R1', '100.00')]) + chunk([entry('R2', '96.30')])
    expect(parseIncidentIoUptime(html, ['R1', 'R2'])).toBe(96.3)
  })

  it('a valueless first sighting does not block a later chunk from supplying the value', () => {
    // `matched` (rotation warn) and `valued` (re-scan skip) are separate sets precisely so that a
    // component seen once as "$undefined" can still contribute its real number from a later chunk.
    const html = chunk([entry('R1', '$undefined'), entry('R2', '100.00')]) + chunk([entry('R1', '94.10')])
    expect(parseIncidentIoUptime(html, ['R1', 'R2'])).toBe(94.1)
  })

  it('returns null when every matched component carries an out-of-range value', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const html = chunk([entry('R1', '150'), entry('R2', '-3')])
    expect(parseIncidentIoUptime(html, ['R1', 'R2'])).toBeNull()
  })

  it('WARNS when a configured id no longer resolves — a rotated ULID must not silently shrink the worst-of', () => {
    // The page still returns 200 and the parser still yields a number, so no fetch-failure or
    // component-miss alert fires. This warn is the only signal that the roster went stale.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const html = chunk([entry('R1', '100.00')])
    expect(parseIncidentIoUptime(html, ['R1', 'ROTATED_AWAY'])).toBe(100)
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0][0]).toContain('1/2 configured components absent')
  })

  it('does NOT warn for a single configured id that is absent (the ordinary no-such-component case)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseIncidentIoUptime(chunk([entry('OTHER', '99.50')]), 'MISSING')).toBeNull()
    expect(warn).not.toHaveBeenCalled()
  })

  it('does NOT warn when the whole roster resolves', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseIncidentIoUptime(chunk([entry('R1', '100.00'), entry('R2', '99.90')]), ['R1', 'R2'])).toBe(99.9)
    expect(warn).not.toHaveBeenCalled()
  })

  it('SKIPS a component with no published value rather than reading it as 0', () => {
    const html = chunk([entry('R1', '$undefined'), entry('R2', '99.90')])
    expect(parseIncidentIoUptime(html, ['R1', 'R2'])).toBe(99.9)
  })

  it('returns null when every matched component publishes no value', () => {
    const html = chunk([entry('R1', '$undefined'), entry('R2', '$undefined')])
    expect(parseIncidentIoUptime(html, ['R1', 'R2'])).toBeNull()
  })

  it('skips an out-of-range value but still returns the healthy sibling', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const html = chunk([entry('R1', '150'), entry('R2', '99.10')])
    expect(parseIncidentIoUptime(html, ['R1', 'R2'])).toBe(99.1)
  })

  it('a group aggregate still wins over the per-component worst-of', () => {
    const html = chunk([groupEntry('GRP', '99.99'), entry('R1', '95.00')])
    expect(parseIncidentIoUptime(html, ['R1'], 'GRP')).toBe(99.99)
  })
})

describe('turbopuffer config — the roster the worst-of reads (#857)', () => {
  const turbopuffer = SERVICES.find((s) => s.id === 'turbopuffer')!
  const ids = turbopuffer.incidentIoComponentId as string[]

  it('sets incidentIoComponentId so needsHtml fetches the status HTML at all', () => {
    // The bug: without statusComponentId OR incidentIoComponentId, services.ts `needsHtml` is false,
    // the page HTML is never fetched, and parseIncidentIoUptime never runs → uptime30d null.
    expect(turbopuffer.statusComponentId).toBeUndefined() // badge still rides the overall indicator
    expect(Array.isArray(ids)).toBe(true)
  })

  it('covers all 15 per-region API components', () => {
    expect(ids).toHaveLength(15)
    expect(new Set(ids).size).toBe(15) // no dupes
  })

  it('EXCLUDES the Dashboard component (not an API surface; the page\'s only sub-100 uptime)', () => {
    expect(ids).not.toContain(DASHBOARD_ID)
  })

  it('worst-of over the real roster shape yields the degraded region, not the healthy majority', () => {
    const html = chunk([
      ...ids.map((id, i) => entry(id, i === 3 ? '97.40' : '100.00')),
      entry(DASHBOARD_ID, '99.92'), // present on the page, must not be read
    ])
    expect(parseIncidentIoUptime(html, ids)).toBe(97.4)
  })

  it('the excluded Dashboard uptime never becomes the service uptime', () => {
    const html = chunk([...ids.map((id) => entry(id, '100.00')), entry(DASHBOARD_ID, '99.92')])
    expect(parseIncidentIoUptime(html, ids)).toBe(100)
  })
})
