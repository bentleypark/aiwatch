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
  'incidents.status.continuing': 'Still down',
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
  it('shows a continuing row as still down', () => {
    const html = render(Component, continuing)
    expect(html).toContain('Still down')
    expect(html).not.toContain('>Resolved<')
    expect(html).toContain('var(--red)')
  })

  it('CONTROL — the same row without the flag stays resolved', () => {
    const html = render(Component, row)
    expect(html).toContain('Resolved')
    expect(html).not.toContain('Still down')
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
