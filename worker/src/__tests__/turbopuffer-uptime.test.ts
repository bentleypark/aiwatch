import { describe, it, expect, vi, afterEach } from 'vitest'
import { computeIncidentIoUptime } from '../parsers/incident-io'
import { SERVICES } from '../services'

// #857 — turbopuffer's status page is an **incident.io** page (ULID component ids) that merely serves a
// Statuspage-compatible summary.json. It was configured as an Atlassian Statuspage, so `needsHtml` never
// fetched the status HTML and uptime30d stayed null. The page has no group aggregate (every component is
// ungrouped), so uptime is a WORST-OF across the per-region API components.
//
// #1006 — the mechanism changed underneath: AIWatch no longer copies the page's published
// `component_uptimes[].uptime`, it COMPUTES from `component_impacts` with the weights on /methodology.
// What this file pins is that turbopuffer's REAL configured id roster still resolves through that path
// (a silent null here is exactly what #857 was), and that the worst-of + rotation-warn conventions
// survived the rewrite.
//
// It also pins the #1006 windfall: the three `chart_only` pages (Stability / ElevenLabs / Replicate)
// publish impact records but HIDE the percentage (`uptime: "$undefined"`), so under the old
// copy-the-aggregate path they had NO uptime at all ("Not provided", confidence capped at `medium`)
// despite the page carrying the full impact history. Computing from the raw records gives them a real
// figure — the same one, by the same formula, as everyone else.

const NOW = Date.parse('2026-07-14T00:00:00Z')
const DAY = 86_400_000
const ago = (days: number) => new Date(NOW - days * DAY).toISOString()

/** One `component_uptimes` entry, in the page's real backslash-escaped form. `uptime` defaults to
 *  `$undefined` — the chart_only shape — to prove we no longer depend on the published value. */
const uptimeEntry = (id: string, since: string, uptime = '$undefined') =>
  `{\\"component_id\\":\\"${id}\\",\\"data_available_since\\":\\"${since}\\",` +
  `\\"status_page_component_group_id\\":\\"$undefined\\",\\"uptime\\":\\"${uptime}\\"}`

const impactEntry = (id: string, startDaysAgo: number, endDaysAgo: number, status: string) =>
  `{\\"component_id\\":\\"${id}\\",\\"end_at\\":\\"${ago(endDaysAgo)}\\",\\"id\\":\\"IMP\\",` +
  `\\"start_at\\":\\"${ago(startDaysAgo)}\\",\\"status\\":\\"${status}\\",\\"status_page_incident_id\\":\\"INC\\"}`

const page = (impacts: string[], uptimes: string[]) =>
  `<script>self.__next_f.push([1,"a:{\\"component_impacts\\":[${impacts.join(',')}],` +
  `\\"component_uptimes\\":[${uptimes.join(',')}],\\"incident_links\\":[]}"])</script>`

afterEach(() => vi.restoreAllMocks())

describe('turbopuffer — the real region roster resolves to a worst-of uptime (#857 + #1006)', () => {
  const turbopuffer = SERVICES.find((s) => s.id === 'turbopuffer')!
  const ids = turbopuffer.incidentIoComponentId as string[]
  const established = () => ids.map((id) => uptimeEntry(id, '2023-12-07T00:00:00Z'))

  it('is configured as a LIST — an empty roster would be a silent uptime drop', () => {
    expect(Array.isArray(ids)).toBe(true)
    expect(ids.length).toBeGreaterThan(1)
  })

  it('computes a worst-of across the CONFIGURED ids, though the page publishes no percentage', () => {
    // One region takes a 24h full outage; every other region is clean.
    const html = page([impactEntry(ids[3], 5, 4, 'full_outage')], established())
    expect(computeIncidentIoUptime(html, ids, NOW)).toEqual({ pct: 96.66, days: 30 })
  })

  it('WARNS when a configured id no longer resolves — a rotated ULID must not silently shrink the worst-of', () => {
    // The page still returns 200 and the parser still yields a number, so no fetch-failure or
    // component-miss alert fires. This warn is the only signal that the roster went stale.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const html = page([], [uptimeEntry(ids[0], '2023-12-07T00:00:00Z')])
    expect(computeIncidentIoUptime(html, ids, NOW)).toEqual({ pct: 100, days: 30 })
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0][0]).toContain(`${ids.length - 1}/${ids.length} configured components absent`)
  })

  it('null when the page tracks NONE of the configured ids (the #857 silent-null shape)', () => {
    const html = page([], [uptimeEntry('some-other-component', '2023-12-07T00:00:00Z')])
    expect(computeIncidentIoUptime(html, ids, NOW)).toBeNull()
  })
})

describe('chart_only pages now get an uptime (#1006)', () => {
  // Chart-only pages hide the percentage but publish the impact records. The first configured component
  // is the uptime primary (replicate/elevenlabs also worst-of the rest of their roster, #1006 — tested
  // separately); one degraded window on it must still yield a computed figure, never "Not provided".
  it.each(['stability', 'elevenlabs', 'replicate'])('%s resolves a figure from impacts alone', (id) => {
    const svc = SERVICES.find((s) => s.id === id)!
    const scope = svc.incidentIoComponentId!
    const primary = Array.isArray(scope) ? scope[0] : scope

    const html = page(
      [impactEntry(primary, 3, 3 - 6 / 24, 'degraded_performance')], // 6h degraded
      // every configured component present + clean, so the worst-of is driven by the one impact above
      (Array.isArray(scope) ? scope : [scope]).map((c) => uptimeEntry(c, '2024-01-01T00:00:00Z')),
    )
    // 6h × 0.3 = 1.8h of 30 days → 99.75%
    expect(computeIncidentIoUptime(html, scope, NOW)).toEqual({ pct: 99.75, days: 30 })
  })
})
