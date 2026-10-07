// #1622 — a `status_history` row whose resource is still down (`continuing`) must not read "Resolved"
// on any dashboard surface that renders a single incident row.
import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { filterIncidentList } from '../../utils/incidentFilter'
import { compareIncidents, compareGroupedRows } from '../../utils/incidentSort'
import { groupIncidents } from '../../utils/incidentGrouping'

const { IncidentRow: DetailsRow } = await import('../ServiceDetails')
const { IncidentRow: TableRow, IncidentCard } = await import('../Incidents')
const { IncidentItem } = await import('../Overview')

const STRINGS = {
  'incidents.status.continuing': 'In Progress',
  'incidents.status.resolved': 'Resolved',
  'incidents.time.down': 'Down',
  'incidents.time.resolved': 'Resolved at',
  'incidents.derived.dayTotal': 'that day',
}
const t = (k) => STRINGS[k] ?? k

const row = {
  id: 'bs-hist:7615061:2026-10-04', title: 'api.hconeai.com — downtime', status: 'resolved', impact: 'minor',
  startedAt: '2026-10-04T12:00:00.000Z', resolvedAt: '2026-10-05T12:00:00.000Z', duration: '24h 0m',
  timeline: [], derived: 'status_history', derivedDay: '2026-10-04', serviceName: 'Helicone', serviceId: 'helicone',
}
const continuing = { ...row, continuing: true }

const render = (Component, incident) => renderToStaticMarkup(createElement(Component, {
  incident, isSelected: false, onClick: () => {}, onClose: () => {}, isRecentlyRecovered: false, t, lang: 'en',
}))

describe.each([
  ['ServiceDetails row', DetailsRow],
  ['Incidents table row', TableRow],
  ['Incidents mobile card', IncidentCard],
])('%s', (_name, Component) => {
  it('shows a continuing row as in progress', () => {
    const html = render(Component, continuing)
    expect(html).toContain('In Progress')
    expect(html).not.toContain('>Resolved<')
    expect(html).toContain('var(--red)')
  })

  it('CONTROL — the same row without the flag stays resolved', () => {
    const html = render(Component, row)
    expect(html).toContain('Resolved')
    expect(html).not.toContain('In Progress')
  })
})

describe('Overview incident item', () => {
  it('draws a continuing row with the ongoing bar, not the resolved one', () => {
    expect(render(IncidentItem, continuing)).toContain('bg-[var(--red)]')
    expect(render(IncidentItem, row)).not.toContain('bg-[var(--red)]')
  })
})

describe('Incidents filter + order', () => {
  const now = Date.now()
  const live = (extra) => ({ ...continuing, startedAt: new Date(now - 36e5 * 30).toISOString(), resolvedAt: new Date(now - 36e5 * 6).toISOString(), ...extra })
  const still = live({})
  const newerResolved = { id: 'r1', title: 'Elevated errors', status: 'resolved', impact: 'minor', serviceId: 'openai',
    startedAt: new Date(now - 36e5 * 3).toISOString(), resolvedAt: new Date(now - 36e5 * 2).toISOString(), duration: '1h 0m', timeline: [] }
  const list = (statusFilter) => filterIncidentList([newerResolved, still], { serviceFilter: 'all', statusFilter, cutoff: now - 7 * 864e5 }).map((i) => i.id)

  it('files a continuing row under In progress, not Resolved', () => {
    expect(list('ongoing')).toEqual([still.id])
    expect(list('resolved')).toEqual([newerResolved.id])
  })

  it('lists a continuing row above a NEWER resolved one, on the flat and the grouped order', () => {
    expect(list('all')).toEqual([still.id, newerResolved.id])
    const rows = groupIncidents([newerResolved, still].sort(compareIncidents)).sort(compareGroupedRows)
    expect(rows.map((r) => r.incident?.id)).toEqual([still.id, newerResolved.id])
  })
})

describe('#1623 — the running outage reads newest-first', () => {
  it('lists today\'s ongoing row above yesterday\'s continuing one', () => {
    const now = Date.now()
    const today = new Date(now).toISOString().slice(0, 10)
    const yesterday = new Date(now - 864e5).toISOString().slice(0, 10)
    const ongoing = { id: `bs-hist:r:${today}`, title: 'api.hconeai.com — down', status: 'investigating', impact: 'minor',
      startedAt: new Date(now - 36e5).toISOString(), resolvedAt: null, duration: null, timeline: [],
      derived: 'status_history', derivedDay: today, serviceId: 'helicone' }
    const prior = { ...continuing, id: `bs-hist:r:${yesterday}`, derivedDay: yesterday,
      startedAt: new Date(now - 864e5).toISOString(), resolvedAt: new Date(now + 36e5).toISOString() }
    const flat = filterIncidentList([prior, ongoing], { serviceFilter: 'all', statusFilter: 'all', cutoff: now - 7 * 864e5 })
    expect(flat.map((i) => i.id)).toEqual([ongoing.id, prior.id])
    const rows = groupIncidents([prior, ongoing].sort(compareIncidents)).sort(compareGroupedRows)
    expect(rows.map((r) => r.incident?.id)).toEqual([ongoing.id, prior.id])
  })
})

describe('#1623 — inside a multi-day outage group a past day states no status of its own', () => {
  it.each([
    ['ServiceDetails row', DetailsRow],
    ['Incidents table row', TableRow],
    ['Incidents mobile card', IncidentCard],
  ])('%s', (_n, Component) => {
    const html = renderToStaticMarkup(createElement(Component, {
      incident: continuing, hideStatus: true, isSelected: false, onClick: () => {}, onClose: () => {}, isRecentlyRecovered: false, t, lang: 'en',
    }))
    expect(html).not.toContain('In Progress')
    expect(html).not.toContain('Resolved')
    expect(html).not.toContain('var(--red)')
    expect(html).toContain('that day')
  })

  it('Overview entry draws a neutral bar', () => {
    const html = renderToStaticMarkup(createElement(IncidentItem, { incident: continuing, hideStatus: true, t, lang: 'en' }))
    expect(html).not.toContain('bg-[var(--red)]')
    expect(html).not.toContain('bg-[var(--green)]')
  })
})

describe('#1623 — a multi-day outage group states its status once', () => {
  const now = Date.now()
  const day = (n) => new Date(now - n * 864e5).toISOString().slice(0, 10)
  const runRows = [0, 1, 2].map((n) => ({ ...continuing, id: `bs-hist:r:${day(n)}`, derivedDay: day(n), outageRun: { id: 'bs-run:r:x', startDay: day(2), endDay: day(0), days: 3, downSec: 3600, ongoing: true },
    ...(n === 0 ? { status: 'investigating', continuing: undefined, resolvedAt: null, duration: null, title: 'api.hconeai.com — down' } : {}) }))
  const strings = { ...STRINGS, 'incidents.status.ongoing': 'In Progress', 'incidents.group.days': '{n} days',
    'incidents.duration.ongoing': 'Ongoing', 'incidents.group.statusUniform': 'all {status}' }
  const tt = (k) => strings[k] ?? k
  const [g] = groupIncidents(runRows)
  const props = { group: g, expanded: false, onToggle: () => {}, selectedId: null, onSelect: () => {}, onClose: () => {}, t: tt, lang: 'en' }

  it.each([
    ['ServiceDetails group', async () => (await import('../ServiceDetails')).IncidentGroupRow],
    ['Incidents table group', async () => (await import('../Incidents')).IncidentGroupRow],
    ['Incidents mobile group', async () => (await import('../Incidents')).IncidentGroupCard],
  ])('%s — never "all in progress"', async (_n, load) => {
    expect(g.run).toBe(true)
    const html = renderToStaticMarkup(createElement(await load(), props))
    expect(html).toContain('→ Ongoing')
    expect(html).not.toContain('all in progress')
  })
})

describe('#1623 — ServiceDetails marks a running outage group as live', () => {
  it('draws its dot red, a finished one grey', async () => {
    const { IncidentGroupRow } = await import('../ServiceDetails')
    const mk = (ongoing) => groupIncidents(['2026-10-05', '2026-10-04'].map((d, n) => ({ ...continuing, id: `s${n}`, derivedDay: d,
      outageRun: { id: 'bs-run:r:s', startDay: '2026-10-04', endDay: '2026-10-05', days: 2, downSec: 3600, ongoing } })))[0]
    const render = (g) => renderToStaticMarkup(createElement(IncidentGroupRow, { group: g, t, lang: 'en' }))
    expect(render(mk(true))).toContain('text-[var(--red)]')
    expect(render(mk(false))).not.toContain('text-[var(--red)]')
  })
})

describe('#1623 — Overview dates a run group by its first day', () => {
  it('shows the start day, not the newest entry\'s timed start', async () => {
    const { GroupIncidentItem } = await import('../Overview')
    const rows = ['2026-10-05', '2026-10-04', '2026-10-03'].map((d, n) => ({ ...continuing, id: `o${n}`, derivedDay: d,
      outageRun: { id: 'bs-run:r:o', startDay: '2026-10-03', endDay: '2026-10-05', days: 3, downSec: 3600, ongoing: false }, startedAt: `${d}T12:00:00.000Z`, resolvedAt: `${d}T23:00:00.000Z` }))
    const [g] = groupIncidents(rows)
    const html = renderToStaticMarkup(createElement(GroupIncidentItem, { group: g, lang: 'en', t: (k) => ({ 'incidents.group.days': '{n} days' })[k] ?? k }))
    expect(html).toContain('>Oct 3<')
    expect(html).toContain('3 days')
  })
})

