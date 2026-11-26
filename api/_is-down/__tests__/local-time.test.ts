import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderIncidents, renderScheduledMaintenance, renderPage, type ServiceData } from '../html-template'
import { getSEOContent } from '../seo-content'
import { formatDate } from '../../../src/utils/time.js'
import { formatMaintenanceRange } from '../../../src/utils/maintenance.js'
import { runLocalTimeScript as load, viewIn } from '../../__tests__/local-time-helpers'

// #2062 — the server writes UTC; LOCAL_TIME_CLIENT_JS rewrites it in the viewer's zone. These run the
// shipped string over the shipped markup with the zone forced through `Intl.DateTimeFormat`, and take
// the expected text from the dashboard's own formatters.

const texts = (selector: string) => [...document.querySelectorAll(selector)].map((el) => el.textContent)

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const HOUR = 3_600_000
// Inside the page's 7-day list. 15:00Z is midnight in Seoul.
const base = new Date(Date.now() - 2 * 86_400_000)
base.setUTCHours(15, 0, 0, 0)
const iso = (offsetHours: number) => new Date(base.getTime() + offsetHours * HOUR).toISOString()

const incident = (over: object) => ({
  id: 'i1', title: 'Elevated errors', status: 'resolved', impact: 'major', startedAt: iso(0),
  resolvedAt: iso(1), duration: '1h 0m', timeline: [], ...over,
})
const service = (incidents: object[]) => ({
  id: 'helicone', name: 'Helicone', provider: 'Helicone', category: 'api', status: 'operational',
  latency: null, uptime30d: 99, lastChecked: new Date().toISOString(), incidents, aiwatchScore: null, scoreGrade: null,
}) as unknown as ServiceData
const page = (incidents: object[]) => renderPage('helicone', service(incidents) as never, getSEOContent('helicone')!, [], null)
const body = (html: string) => html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script\b[\s\S]*?<\/script>/g, '')

describe('#2062 — incident times in the viewer\'s zone', () => {
  const withTimeline = incident({ timeline: [{ stage: 'investigating', text: null, at: iso(0.5) }] })

  it('serves UTC text with the instant on every timestamp', () => {
    document.body.innerHTML = body(page([withTimeline]))
    const stamps = [...document.querySelectorAll('time.local-time')]
    // Last incident, the row, its timeline step.
    expect(stamps.map((el) => el.getAttribute('datetime'))).toEqual([iso(0), iso(0), iso(0.5)])
    for (const el of stamps) expect(el.textContent).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2} UTC$/)
  })

  it.each(['Asia/Seoul', 'America/Los_Angeles', 'Asia/Kolkata', 'UTC'])('rewrites them as the dashboard prints them in %s', (zone) => {
    viewIn(zone)
    load(body(page([withTimeline])))
    expect(texts('time.local-time')).toEqual([iso(0), iso(0), iso(0.5)].map((at) => formatDate(at, 'en')))
  })

  it('renders an open incident whose start does not parse', () => {
    expect(page([incident({ status: 'investigating', startedAt: 'not-a-date', resolvedAt: null, duration: null })])).toContain('Unknown date')
  })

  it.each([
    ['both ends of a mixed-status group header', 'investigating', [iso(-1), iso(1)]],
    ['the latest time in a same-status group header', 'resolved', [iso(1)]],
  ])('rewrites %s', (_name, second, instants) => {
    const flap = (id: string, h: number, status: string) => incident({ id, title: 'api — recovered', impact: null, status, startedAt: iso(h) })
    viewIn('Asia/Seoul')
    load(renderIncidents(service([flap('a', -1, 'resolved'), flap('b', 1, second)])))
    expect(texts('.incident-group-title')).toEqual(['api · 2×'])
    expect(texts('.incident-group-meta time.local-time')).toEqual(instants.map((at) => formatDate(at, 'en')))
  })

  it('leaves a day-only incident on its stated day in a zone 14 hours ahead', () => {
    const stated = iso(0).slice(0, 10)
    const day = (id: string, derivedDay: string | undefined, startedAt: string) => incident({
      id, title: `${id} — down`, derived: 'status_history', derivedDay, startedAt,
    })
    const dayBefore = new Date(Date.parse(`${stated}T23:00:00.000Z`) - 86_400_000).toISOString()
    const html = body(page([day('stated', stated, dayBefore), day('untagged-day', undefined, `${stated}T11:30:00.000Z`), incident({ id: 'published' })]))
    document.body.innerHTML = html
    const dayOnly = () => texts('time:not(.local-time):not(.last-checked)')
    const served = dayOnly()
    // Last incident plus the two day rows.
    expect(served).toHaveLength(3)
    expect([...document.querySelectorAll('time:not(.local-time):not(.last-checked)')].map((el) => el.getAttribute('datetime'))).toEqual([stated, stated, stated])
    for (const text of served) expect(text).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/)

    viewIn('Pacific/Kiritimati')
    load(html)
    expect(dayOnly()).toEqual(served)
    expect(texts('time.local-time')).toEqual([formatDate(iso(0), 'en')])
  })

  it('leaves a multi-day run header on its stated days', () => {
    const days = [iso(-24).slice(0, 10), iso(0).slice(0, 10)]
    const run = { id: 'bs-run:1', startDay: days[0], endDay: days[1], days: 2, downSec: 7200, ongoing: false }
    const rows = days.map((d, n) => incident({ id: `r${n}`, derived: 'status_history', derivedDay: d, outageRun: run, startedAt: `${d}T12:00:00.000Z` }))
    const html = renderIncidents(service(rows))
    document.body.innerHTML = html
    const served = texts('.incident-group-meta time')
    expect(served).toHaveLength(2)
    viewIn('Pacific/Kiritimati')
    load(html)
    expect(texts('.incident-group-meta time')).toEqual(served)
  })
})

describe('#2062 — maintenance windows in the viewer\'s zone', () => {
  const NOW = Date.parse('2026-08-01T00:00:00Z')
  const shown = (scheduledFor: string, scheduledUntil: string | null, zone: string) => {
    viewIn(zone)
    load(renderScheduledMaintenance([{ id: 'm', title: 't', scheduledFor, scheduledUntil, componentNames: [] }], 'upcoming', NOW))
    const range = document.querySelector('time')!.parentElement!.textContent
    return { range, dashboard: formatMaintenanceRange({ scheduledFor, scheduledUntil }, 'en', zone) }
  }

  it.each([
    ['one day in both zones', '2026-11-04T04:00:00.000Z', '2026-11-04T06:00:00.000Z'],
    ['one UTC day, two Seoul days', '2026-11-04T14:00:00.000Z', '2026-11-04T16:00:00.000Z'],
    ['two UTC days, one Seoul day', '2026-11-04T23:00:00.000Z', '2026-11-05T01:00:00.000Z'],
    ['no published end', '2026-11-04T01:00:00.000Z', null],
  ])('reads as on the dashboard: %s', (_name, from, until) => {
    const { range, dashboard } = shown(from, until, 'Asia/Seoul')
    expect(range).toBe(dashboard)
    expect(range).not.toContain('UTC')
  })
})
