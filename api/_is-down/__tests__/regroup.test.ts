import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderPage, regroupClientJs, type ServiceData } from '../html-template'
import { getSEOContent } from '../seo-content'
import { extractInlineScripts } from '../../_shared/csp-hash'
import { groupIncidents } from '../../../src/utils/incidentGrouping.js'
import { compareGroupedRows } from '../../../src/utils/incidentSort.js'
import { viewIn } from '../../__tests__/local-time-helpers'

// #2062 — the server groups by UTC day; regroupClientJs regroups by the viewer's day. The expected
// list is what the dashboard's own grouping and sort give for the same incidents in that zone.

const ZONES = ['UTC', 'Asia/Seoul', 'America/Los_Angeles', 'Asia/Kolkata', 'Pacific/Auckland']
const HOUR = 3_600_000
const midnight = new Date(Date.now() - 3 * 86_400_000).setUTCHours(0, 0, 0, 0)
const iso = (hours: number) => new Date(midnight + hours * HOUR).toISOString()

interface Inc {
  id: string; title: string; status: string; impact: string | null; startedAt: string; resolvedAt: string | null
  duration: string | null; timeline: []; autoMonitor?: boolean; derived?: 'status_history'; derivedDay?: string
  outageRun?: { id: string; startDay: string; endDay: string; days: number; downSec: number; ongoing: boolean }
}
const incident = (hours: number, over: Partial<Inc> = {}): Inc => {
  const status = over.status ?? 'resolved'
  return {
    id: `i${hours}`, title: 'api — recovered', status, impact: null, startedAt: iso(hours),
    resolvedAt: status === 'resolved' ? iso(hours + 0.25) : null, duration: status === 'resolved' ? '15m' : null, timeline: [], ...over,
  }
}

const page = (incidents: Inc[]) => renderPage('helicone', {
  id: 'helicone', name: 'Helicone', provider: 'Helicone', category: 'api', status: 'operational',
  latency: null, uptime30d: 99, lastChecked: new Date().toISOString(), incidents, aiwatchScore: null, scoreGrade: null,
} as unknown as ServiceData as never, getSEOContent('helicone')!, [], null)

/** Serves `incidents`, then runs the page's own regroup script once in `zone`. */
function open(incidents: Inc[], zone: string): { served: string; card: () => HTMLElement } {
  const html = page(incidents)
  const from = html.indexOf('<h2>Recent Incidents')
  document.body.innerHTML = html.slice(from, html.indexOf('<p class="ih-history">', from))
  const card = () => document.querySelector<HTMLElement>('.card')!
  const served = card().innerHTML
  const script = extractInlineScripts(html).find((s) => s.includes('[data-regroup]'))!
  viewIn(zone)
  const add = vi.spyOn(document, 'addEventListener').mockImplementation((_type, listener) => { (listener as () => void)() })
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(script)()
  add.mockRestore()
  return { served, card }
}

const startOf = (el: Element) => el.querySelector('.incident-meta>time')!.getAttribute('datetime')
function describeRow(el: Element) {
  if (!el.classList.contains('incident-group')) return `${el.querySelector('.incident-title')!.textContent} | ${startOf(el)}`
  const title = el.querySelector('.incident-group-title')!
  return {
    heading: title.firstChild!.textContent!.trim(),
    count: title.querySelector('span')!.textContent,
    header: [...el.querySelectorAll('.incident-group-meta time')].map((t) => t.getAttribute('datetime')),
    entries: [...el.querySelectorAll('.incident-item')].map(startOf),
  }
}
function shownRows(card: HTMLElement) {
  const direct = [...card.children].filter((el) => el.matches('.incident-item, .incident-group'))
  const rest = [...(card.querySelector(':scope>.ih-rest')?.children ?? [])]
  return { preview: direct.length, rows: [...direct, ...rest].map(describeRow) }
}
function dashboardRows(incidents: Inc[], zone: string) {
  return groupIncidents(incidents, { timeZone: zone }).slice().sort(compareGroupedRows).map((row) => {
    if (row.kind !== 'group') return `${row.incident.title} | ${row.incident.derived ? row.incident.derivedDay : row.incident.startedAt}`
    if (row.run) return { heading: row.heading, count: `· ${row.count} days`, header: [row.startDay, row.endDay], entries: row.entries.map((e: Inc) => e.derivedDay) }
    return {
      heading: row.heading, count: `· ${row.count}×`,
      header: row.uniformStatus ? [row.rangeEnd] : [row.rangeStart, row.rangeEnd],
      entries: row.entries.map((e: Inc) => e.startedAt),
    }
  })
}

function expectDashboardList(incidents: Inc[], zone: string, note = zone) {
  const { card } = open(incidents, zone)
  const expected = dashboardRows(incidents, zone)
  const actual = shownRows(card())
  expect(actual.rows, note).toEqual(expected)
  expect(actual.preview, note).toBe(Math.min(5, expected.length))
  const more = expected.length - 5
  expect(card().querySelectorAll('.ih-toggle, .ih-rest, .ih-more-label'), note).toHaveLength(more > 0 ? 3 : 0)
  if (more > 0) {
    expect(card().querySelector('.ih-more-open')!.textContent, note).toBe(`Show ${more} more`)
    expect(card().querySelector('.ih-toggle')!.getAttribute('aria-label'), note).toBe(`Show ${more} more incidents`)
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('#2062 — the incident list is regrouped by the viewer\'s day', () => {
  // 14:00Z and 16:00Z are one UTC day and two Seoul days; 23:00Z and 25:00Z the reverse.
  it.each(ZONES)('splits and joins groups as the dashboard does in %s', (zone) => {
    expectDashboardList([incident(14), incident(16)], zone)
    expectDashboardList([incident(23), incident(25)], zone)
  })

  it('splits one UTC group into two rows in Seoul and joins two rows into one group', () => {
    const rowsInSeoul = (list: Inc[]) => shownRows(open(list, 'Asia/Seoul').card()).rows
    expect(rowsInSeoul([incident(16), incident(14)])).toEqual([`api — recovered | ${iso(16)}`, `api — recovered | ${iso(14)}`])
    expect(rowsInSeoul([incident(25), incident(23)])).toEqual([expect.objectContaining({ count: '· 2×', entries: [iso(25), iso(23)] })])
  })

  // Five to seven rows depending on the zone, so the preview toggle is created, kept and dropped.
  it.each(ZONES)('moves the preview split and its count with the rows in %s', (zone) => {
    const human = (h: number) => incident(h, { title: `Outage ${h}`, impact: 'major' })
    expectDashboardList([human(1), human(2), human(3), human(4), incident(14), incident(16)], zone)
    expectDashboardList([human(1), human(2), human(3), human(4), incident(23), incident(25)], zone)
    expectDashboardList([human(1), human(2), human(3), human(4), human(5), incident(23), incident(25)], zone)
  })

  it.each(ZONES)('orders a group and a row that tie on latest activity as the dashboard does in %s', (zone) => {
    const at = (hours: number, over: Partial<Inc> = {}) => incident(hours, { resolvedAt: iso(30), ...over })
    expectDashboardList([incident(25), at(24, { title: 'other — recovered' }), at(23)], zone)
    expectDashboardList([at(24), at(23, { title: 'other — recovered' }), incident(22)], zone)
  })

  it.each(ZONES)('matches the dashboard over generated lists in %s', (zone) => {
    let seed = 2062
    const next = (n: number) => { seed = (seed * 48_271) % 2_147_483_647; return seed % n }
    const kinds: Array<Partial<Inc>> = [
      { title: 'a — recovered' }, { title: 'a — down', impact: 'minor' }, { title: 'b — recovered', impact: 'minor' },
      { title: 'Partial outage: s.jina.ai', impact: 'major', autoMonitor: true },
      { title: 'Service outage: s.jina.ai', impact: 'major', autoMonitor: true },
      { title: 'Elevated errors', impact: 'major' },
    ]
    for (let trial = 0; trial < 60; trial++) {
      const list = Array.from({ length: 2 + next(14) }, (_, n) => {
        const hours = next(60) + n / 100
        const status = ['resolved', 'resolved', 'resolved', 'monitoring', 'investigating'][next(5)]
        // Whole-hour ends make latest-activity ties.
        const resolvedAt = status === 'resolved' ? iso(Math.ceil(hours) + next(3) * 6) : null
        if (trial % 3 === 0 && next(3) === 0) {
          const day = iso(24 * (1 + next(2))).slice(0, 10)
          const noon = Date.parse(`${day}T12:00:00.000Z`)
          return incident(hours, {
            id: `t${n}`, title: `r${next(30)} — down`, impact: 'minor', derived: 'status_history', derivedDay: day,
            startedAt: new Date(noon).toISOString(), duration: '1h 0m',
            ...(next(4) === 0 ? { status: 'investigating', resolvedAt: null, duration: null } : { status: 'resolved', resolvedAt: new Date(noon + (1 + next(20)) * HOUR).toISOString() }),
          })
        }
        return incident(hours, { ...kinds[next(trial % 2 ? kinds.length : 3)], id: `t${n}`, status, resolvedAt })
      })
      expectDashboardList(list, zone, `${zone} trial ${trial}`)
    }
  })

  // The two records order by length and the flap by time: the three comparisons form a cycle.
  it.each(ZONES)('places a flap that ends between two same-day records as the dashboard does in %s', (zone) => {
    const day = iso(24).slice(0, 10)
    const record = (name: string, from: number, until: number) => incident(from, {
      id: name, title: `${name} — down`, impact: 'minor', derived: 'status_history', derivedDay: day, resolvedAt: iso(until), duration: '1h 0m',
    })
    const first = record('long', 24, 37)
    const second = record('short', 43.5, 44)
    const between = incident(39, { resolvedAt: iso(40) })
    for (const list of [[first, second, between, incident(5)], [first, between, second, incident(5)], [second, first, between, incident(5)]]) {
      expectDashboardList(list, zone)
    }
  })

  it.each(ZONES)('places a multi-day run that ends between two same-day records as the dashboard does in %s', (zone) => {
    const day = iso(24).slice(0, 10)
    const record = (name: string, from: number, until: number) => incident(from, {
      id: name, title: `${name} — down`, impact: 'minor', derived: 'status_history', derivedDay: day, resolvedAt: iso(until), duration: '1h 0m',
    })
    const run = { id: 'bs-run:2', startDay: day, endDay: day, days: 2, downSec: 7200, ongoing: false }
    const inRun = { ...record('eu', 39, 40), outageRun: run }
    const [first, second] = [record('long', 24, 37), record('short', 43.5, 44)]
    for (const list of [[first, second, inRun], [first, inRun, second], [inRun, second, first], [second, first, inRun]]) {
      expectDashboardList([...list, incident(14), incident(16)], zone)
    }
  })

  // A record still down has no end, so it compares by name and the other two by length: a cycle.
  it.each(ZONES)('orders same-day records as the dashboard does when one has no end, in %s', (zone) => {
    const day = iso(24).slice(0, 10)
    const record = (name: string, minutes: number | null) => incident(36, {
      id: name, title: `${name} — down`, impact: 'minor', derived: 'status_history', derivedDay: day,
      ...(minutes === null ? { status: 'investigating', resolvedAt: null, duration: null } : { resolvedAt: iso(36 + minutes / 60) }),
    })
    const [down, short, long] = [record('m', null), record('a', 10), record('z', 20)]
    for (const list of [[down, short, long], [short, long, down], [long, down, short], [long, short, down]]) {
      expectDashboardList([...list, incident(14), incident(16)], zone)
    }
  })

  it('keeps two day records with the same end in the dashboard\'s name order, not the input order', () => {
    const day = iso(24).slice(0, 10)
    const record = (name: string) => incident(36, { id: name, title: `${name} — down`, derived: 'status_history', derivedDay: day, duration: '1h 0m' })
    const list = [record('zulu'), record('alpha'), incident(14), incident(16)]
    const { card } = open(list, 'Asia/Seoul')
    const titles = [...card().querySelectorAll('.incident-title')].map((el) => el.textContent)
    expect(titles.filter((t) => t!.endsWith('down'))).toEqual(['alpha — down', 'zulu — down'])
  })

  it.each(ZONES)('keeps a multi-day run as one row among regrouped ones in %s', (zone) => {
    const days = [iso(24).slice(0, 10), iso(48).slice(0, 10)]
    const run = { id: 'bs-run:1', startDay: days[0], endDay: days[1], days: 2, downSec: 7200, ongoing: false }
    const record = (d: string, n: number) => incident(n ? 48 : 24, {
      id: `r${n}`, title: 'eu — down', impact: 'minor', derived: 'status_history', derivedDay: d, outageRun: run,
      startedAt: `${d}T12:00:00.000Z`, resolvedAt: `${d}T13:00:00.000Z`, duration: '1h 0m',
    })
    expectDashboardList([record(days[0], 0), record(days[1], 1), incident(14), incident(16), incident(40, { status: 'investigating' })], zone)
  })

  it('rebuilds the server\'s own markup for a UTC viewer', () => {
    const list = [
      incident(50, { status: 'monitoring' }), incident(49), incident(30), incident(26),
      ...[20, 19, 18, 17, 16].map((h) => incident(h, { title: `Outage ${h}`, impact: 'major' })),
    ]
    const { served, card } = open(list, 'UTC')
    const flat = (html: string) => html.replace(/>\s+</g, '><').trim()
    const after = flat(card().innerHTML)
    expect(served).toContain('incident-group')
    expect(served).toContain('ih-more')
    expect(after).toBe(flat(served))
  })

  it('writes a provider title into a rebuilt heading as text', () => {
    const title = '<img src=x onerror=alert(1)> — recovered'
    const { card } = open([incident(25, { title }), incident(23, { title })], 'Asia/Seoul')
    expect(card().querySelector('img')).toBeNull()
    expect(card().querySelector('.incident-group-title')!.textContent).toContain('<img src=x onerror=alert(1)>')
  })

  it('leaves a list alone when no two incidents could share a group', () => {
    const html = page([incident(14), incident(16, { title: 'other — recovered' })])
    expect(html).not.toMatch(/<div class="card" data-regroup>/)
    expect(html).not.toContain('data-index="')
  })

  it('keeps a row whose start does not parse', () => {
    const broken = incident(14, { status: 'investigating', startedAt: 'not-a-date' })
    const { card } = open([incident(25), incident(23), broken], 'Asia/Seoul')
    expect(card().textContent).toContain('Unknown date')
    expect(card().querySelectorAll('.incident-item')).toHaveLength(3)
  })

  it('ships the script that regroupClientJs returns', () => {
    expect(page([])).toContain(`<script>${regroupClientJs()}</script>`)
  })
})
