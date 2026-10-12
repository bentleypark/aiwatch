import { describe, it, expect } from 'vitest'
import { referenceIncidentRows, mergeReferenceRows } from '../referenceIncidents'
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
