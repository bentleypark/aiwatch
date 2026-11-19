import { describe, it, expect, vi, afterEach } from 'vitest'
import type { Incident } from '../types'
import { preferEarlierImpactStart, correctIncidentIoImpossibleTimes } from '../parsers/incident-io'
import { SERVICES, fetchService } from '../services'

const esc = (o: unknown) => JSON.stringify(o).replace(/"/g, '\\"')
function pageWithImpacts(impacts: Array<Record<string, unknown>>): string {
  const payload = `\\"component_impacts\\":${esc(impacts)},\\"component_uptimes\\":${esc([])}`
  return `<script>self.__next_f.push([1,"${payload}"])</script>`
}

// Shaped on chatgpt 01M2JZR57HRQTKQGTCWG31M3AS (#2044): posted 09-15 16:52 at "monitoring", impact
// window 07:30 → 16:54, archived as a 2-minute incident.
function inc(o: Partial<Incident> = {}): Incident {
  return {
    id: 'inc-1',
    title: 'Elevated errors',
    status: 'resolved',
    impact: 'minor',
    startedAt: '2026-09-15T16:52:23.000Z',
    resolvedAt: '2026-09-15T16:54:00.000Z',
    duration: '2m',
    timeline: [],
    ...o,
  }
}
const impact = (start_at: string, end_at: string | undefined, o: Record<string, unknown> = {}) =>
  ({ component_id: 'c1', start_at, end_at, status: 'degraded_performance', status_page_incident_id: 'inc-1', ...o })

describe('#2044 preferEarlierImpactStart — a resolved incident starts at the earliest record of it', () => {
  it('takes an impact window that opens before the post, keeping resolvedAt', () => {
    const [out] = preferEarlierImpactStart([inc()], pageWithImpacts([impact('2026-09-15T07:30:00Z', '2026-09-15T16:54:00Z')]))
    expect(out.startedAt).toBe('2026-09-15T07:30:00.000Z')
    expect(out.resolvedAt).toBe('2026-09-15T16:54:00.000Z')
    expect(out.duration).toBe('9h 24m')
  })

  it('takes the earliest start across several impacts of the incident', () => {
    const html = pageWithImpacts([impact('2026-09-15T12:00:00Z', '2026-09-15T16:54:00Z'), impact('2026-09-15T07:30:00Z', '2026-09-15T09:00:00Z', { component_id: 'c2' })])
    expect(preferEarlierImpactStart([inc()], html)[0].startedAt).toBe('2026-09-15T07:30:00.000Z')
  })

  it.each([
    ['the window opens after the post', [impact('2026-09-15T16:53:00Z', '2026-09-15T16:54:00Z')], inc()],
    ['no window for this incident', [impact('2026-09-15T07:30:00Z', '2026-09-15T16:54:00Z', { status_page_incident_id: 'other' })], inc()],
    ['the window is not ordered', [impact('2026-09-15T07:30:00Z', '2026-09-15T07:00:00Z')], inc()],
    ['the window is a maintenance', [impact('2026-09-15T07:30:00Z', '2026-09-15T16:54:00Z', { status: 'under_maintenance' })], inc()],
    ['the window has no end', [impact('2026-09-15T07:30:00Z', undefined)], inc()],
    ['the incident is still open', [impact('2026-09-15T07:30:00Z', '2026-09-15T16:54:00Z')], inc({ status: 'investigating', resolvedAt: null, duration: null })],
    ['the record carries one instant for both ends', [impact('2026-09-15T07:30:00Z', '2026-09-15T16:54:00Z')], inc({ startedAt: '2026-09-15T16:54:00.000Z', duration: null })],
    ['the start is already unknown', [impact('2026-09-15T07:30:00Z', '2026-09-15T16:54:00Z')], inc({ startUnknown: true })],
    ['the window opens in an earlier month', [impact('2026-08-31T22:00:00Z', '2026-09-01T00:40:00Z')], inc({ startedAt: '2026-09-01T00:30:00.000Z', resolvedAt: '2026-09-01T00:40:00.000Z', duration: '10m' })],
  ])('leaves the incident unchanged when %s', (_case, impacts, given) => {
    const [out] = preferEarlierImpactStart([given], pageWithImpacts(impacts))
    expect(out).toEqual(given)
  })

  it('leaves every incident unchanged without page HTML', () => {
    expect(preferEarlierImpactStart([inc()], undefined)).toEqual([inc()])
  })

  it('after the inverted-record repair, a repaired record is not moved again', () => {
    const inverted = inc({ startedAt: '2026-09-15T18:00:00.000Z', resolvedAt: '2026-09-15T16:54:00.000Z', duration: '1m' })
    const html = pageWithImpacts([impact('2026-09-15T07:30:00Z', '2026-09-15T16:54:00Z')])
    const repaired = correctIncidentIoImpossibleTimes([inverted], html)
    expect(preferEarlierImpactStart(repaired, html)).toEqual(repaired)
  })
})

afterEach(() => vi.unstubAllGlobals())

describe('#2044 wiring — fetchService publishes the earlier start', () => {
  it('a turbopuffer incident posted after its impact window opened starts at the window', async () => {
    const turbopuffer = SERVICES.find((s) => s.id === 'turbopuffer')!
    const posted = {
      id: 'inc-1', name: 'Elevated latency', status: 'resolved', impact: 'minor',
      created_at: '2026-09-05T18:40:07.218Z', updated_at: '2026-09-05T18:53:00Z', resolved_at: '2026-09-05T18:53:00Z',
      incident_updates: [], components: [],
    }
    const summary = {
      page: { id: 'p', name: 'turbopuffer', updated_at: new Date().toISOString() },
      status: { indicator: 'none', description: 'All Systems Operational' },
      components: [{ id: turbopuffer.statusComponentId ?? 'c1', name: 'API', status: 'operational' }],
      incidents: [posted],
    }
    const html = pageWithImpacts([impact('2026-09-05T18:21:00Z', '2026-09-05T18:53:00Z', { component_id: turbopuffer.statusComponentId ?? 'c1' })])
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html></html>', { status: 200 })))
    const svc = await fetchService(turbopuffer, { summary: summary as never, incidents: null, uptimeHtml: html } as never, undefined, {})
    expect(svc.incidents.find((i) => i.id === 'inc-1')).toMatchObject({ startedAt: '2026-09-05T18:21:00.000Z', duration: '32m' })
  })
})
