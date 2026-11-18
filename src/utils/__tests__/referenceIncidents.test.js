import { describe, it, expect } from 'vitest'
import { referenceIncidentRows, mergeReferenceRows, openReferenceRows } from '../referenceIncidents'
import { filterIncidentList } from '../incidentFilter'

const CONSOLE = 'Claude Console (platform.claude.com)'
const claude = {
  id: 'claude', name: 'Claude API', provider: 'Anthropic', incidents: [],
  referenceIncidents: [{ id: '978mjkgw6mh7', title: 'Elevated errors on platform.claude.com', status: 'monitoring', startedAt: '2026-10-07T13:25:04.163Z', componentNames: [CONSOLE] }],
}

describe('referenceIncidentRows (#1669)', () => {
  it('labels the row with the provider and the component, not the service', () => {
    const [row] = referenceIncidentRows([claude])
    expect(row.serviceName).toBe(`Anthropic · ${CONSOLE}`)
    expect(row.affectedNames).toEqual([`Anthropic · ${CONSOLE}`])
  })

  it('shows in the all-services view, never under a service filter (Console is not Claude API)', () => {
    const rows = referenceIncidentRows([claude])
    expect(filterIncidentList(rows, { serviceFilter: 'claude', statusFilter: 'all', cutoff: null })).toEqual([])
    expect(filterIncidentList(rows, { serviceFilter: 'all', statusFilter: 'all', cutoff: null })).toHaveLength(1)
  })

  it('is filed under the service its label names (turbopuffer · Dashboard under turbopuffer)', () => {
    const turbopuffer = {
      id: 'turbopuffer', name: 'turbopuffer', provider: 'turbopuffer', incidents: [],
      referenceIncidents: [{ id: 'dash-1', title: 'Dashboard outage', status: 'resolved', startedAt: '2026-09-05T18:40:07Z', componentNames: ['Dashboard'] }],
    }
    const rows = referenceIncidentRows([turbopuffer])
    expect(rows[0].serviceName).toBe('turbopuffer · Dashboard')
    expect(filterIncidentList(rows, { serviceFilter: 'turbopuffer', statusFilter: 'all', cutoff: null })).toHaveLength(1)
  })

  it('a service without reference incidents adds nothing', () => {
    expect(referenceIncidentRows([{ id: 'openai', provider: 'OpenAI', incidents: [] }])).toEqual([])
    expect(referenceIncidentRows(undefined)).toEqual([])
  })
})

describe('mergeReferenceRows (#1669)', () => {
  it('adds a reference row the map does not hold, in the caller row shape', () => {
    const map = mergeReferenceRows(new Map(), [claude], (r) => ({ ...r, shaped: true }))
    expect(map.get('978mjkgw6mh7').serviceName).toBe(`Anthropic · ${CONSOLE}`)
    expect(map.get('978mjkgw6mh7').shaped).toBe(true)
  })

  it('never overwrites a service row for the same id', () => {
    const live = { id: 'claudeai:978mjkgw6mh7', serviceName: 'claude.ai' }
    const map = new Map([['978mjkgw6mh7', live]])
    mergeReferenceRows(map, [claude])
    expect(map.get('978mjkgw6mh7')).toBe(live)
  })
})

// #2027
describe('openReferenceRows (#2027)', () => {
  const costs = { id: '01M7N9VNR6X5SEC90M1YCDB36D', title: 'Costs API data is delayed', status: 'monitoring', startedAt: '2026-11-17T17:46:15Z', componentNames: ['Compliance API'] }
  const svc = (id, provider, refs) => ({ id, name: id, provider, incidents: [], referenceIncidents: refs })

  it('lists an incident carried by two services once, labelled provider · component', () => {
    const rows = openReferenceRows([svc('openai', 'OpenAI', [costs]), svc('chatgpt', 'OpenAI', [costs])])
    expect(rows).toHaveLength(1)
    expect(rows[0].serviceName).toBe('OpenAI · Compliance API')
  })

  it('drops resolved incidents and maps a live status to `ongoing`, as the Incidents page shows it', () => {
    const rows = openReferenceRows([svc('a', 'A', [
      { ...costs, id: 'done', status: 'resolved' },
      { ...costs, id: 'live', status: 'identified' },
      costs,
    ])])
    expect(rows.map((r) => [r.id, r.status])).toEqual([['live', 'ongoing'], [costs.id, 'monitoring']])
  })

  // Local worker, #2027: one id was a service incident on `openai` and a reference incident on `chatgpt`.
  it('leaves out an id some service already counts as its own incident', () => {
    const counted = { id: costs.id, title: costs.title, status: 'monitoring', startedAt: costs.startedAt }
    const rows = openReferenceRows([
      { id: 'openai', name: 'OpenAI API', provider: 'OpenAI', incidents: [counted] },
      svc('chatgpt', 'OpenAI', [costs]),
      svc('other', 'Other', [{ ...costs, id: 'only-ref' }]),
    ])
    expect(rows.map((r) => r.id)).toEqual(['only-ref'])
  })

  it('is empty without reference incidents, and a malformed field does not throw', () => {
    expect(openReferenceRows([])).toEqual([])
    expect(openReferenceRows(undefined)).toEqual([])
    expect(openReferenceRows([{ id: 'x', name: 'X', referenceIncidents: null }])).toEqual([])  })
})
