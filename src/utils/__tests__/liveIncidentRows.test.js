import { describe, it, expect } from 'vitest'
import { unfilteredIncidentRows } from '../liveIncidentRows'

const rowsOf = (services, archives = {}, months = []) => unfilteredIncidentRows(services, archives, months, (r) => r)

// 2026-09-03, as GET /api/status serves it with #1338: two ids, one crossEventKey.
const KEY = 'xai:53g239'
const API = { id: 'xai-evt:mger3p', title: '[API] Models outage (regions: Global, US)', status: 'resolved', impact: 'major', startedAt: '2026-09-03T13:30:00.000Z', resolvedAt: '2026-09-03T17:09:14.000Z', crossEventKey: KEY }
const GROK = { id: 'xai-grok:53g239', title: '[Grok (Android, Build, grok.com, X, iOS, Office/Workspace Plugins)] Models outage', status: 'resolved', impact: 'major', startedAt: '2026-09-03T13:30:00.000Z', resolvedAt: '2026-09-03T17:09:14.000Z', crossEventKey: KEY }
const xai = (incidents) => ({ id: 'xai', name: 'SpaceXSI API', incidents })
const grok = (incidents) => ({ id: 'grok', name: 'Grok', incidents })

describe('unfilteredIncidentRows (#1338)', () => {
  it('one xAI event on both cards is ONE row naming both services', () => {
    const rows = rowsOf([xai([API]), grok([GROK])])
    expect(rows).toHaveLength(1)
    expect(rows[0].affectedNames).toEqual(['SpaceXSI API', 'Grok'])
  })

  it('composite ids are the ones the per-service rows had before', () => {
    expect(rowsOf([xai([API]), grok([GROK])])[0].id).toBe('xai:xai-evt:mger3p')
  })

  it('two incidents of ONE service sharing a crossEventKey stay two rows — the worker keeps them apart', () => {
    const twin = { ...GROK, id: 'xai-grok:53g239-2' }
    expect(rowsOf([grok([GROK, twin])])).toHaveLength(2)
    expect(rowsOf([xai([API]), grok([GROK, twin])]).map((r) => r.affectedNames)).toEqual([['SpaceXSI API', 'Grok'], ['Grok']])
    expect(rowsOf([grok([GROK, twin]), xai([API])]).map((r) => [r.id, r.affectedNames])).toEqual([
      ['grok:xai-grok:53g239', ['Grok', 'SpaceXSI API']],
      ['grok:xai-grok:53g239-2', ['Grok']],
    ])
  })

  it('the row shows the more open of the two: a Grok surface still down outranks a resolved API', () => {
    const open = { ...GROK, status: 'investigating', resolvedAt: null }
    const [row] = rowsOf([xai([API]), grok([open])])
    expect(row.status).toBe('ongoing')
    expect(row.resolvedAt).toBeNull()
    expect(row.affectedNames).toEqual(['SpaceXSI API', 'Grok'])
  })

  it('a more open member replaces the row whole — no field of the other member survives', () => {
    const tagged = { ...API, derived: 'status_history' }
    const open = { ...GROK, status: 'investigating', resolvedAt: null }
    const [row] = rowsOf([xai([tagged]), grok([open])])
    expect(row.derived).toBeUndefined()
    expect(row.id).toBe('grok:xai-grok:53g239')
  })

  it('both resolved: the row carries the later resolution', () => {
    const later = { ...GROK, resolvedAt: '2026-09-03T17:30:00.000Z' }
    const [row] = rowsOf([xai([API]), grok([later])])
    expect(row.resolvedAt).toBe('2026-09-03T17:30:00.000Z')
  })

  it('different crossEventKeys stay two rows', () => {
    const rows = rowsOf([xai([API]), grok([{ ...GROK, crossEventKey: 'xai:other' }])])
    expect(rows).toHaveLength(2)
  })

  it('no crossEventKey: rows still group by raw id only', () => {
    const shared = { id: '461yvfrzpwtt', title: 'Elevated errors for multiple models', status: 'resolved', startedAt: '2026-09-03T13:26:04.201Z' }
    const rows = rowsOf([
      { id: 'claude', name: 'Claude API', incidents: [shared] },
      { id: 'claudeai', name: 'claude.ai', incidents: [shared] },
      xai([{ ...API, crossEventKey: undefined }]),
      grok([{ ...GROK, crossEventKey: undefined }]),
    ])
    expect(rows.map((r) => r.affectedNames)).toEqual([['Claude API', 'claude.ai'], ['SpaceXSI API'], ['Grok']])
  })

  it('the archive merge finds the joined row under either raw id and adds no duplicate', () => {
    const archives = { '2026-09': { services: {
      xai: { incidentList: [
        { id: API.id, title: API.title, startedAt: API.startedAt, finalStatus: 'resolved' },
        { id: 'xai-evt:60k8qx', title: '[API] Enterprise Voice Degraded (regions: Global, US)', startedAt: '2026-09-10T07:03:52.000Z', finalStatus: 'resolved' },
      ] },
      grok: { incidentList: [{ id: GROK.id, title: GROK.title, startedAt: GROK.startedAt, finalStatus: 'resolved' }] },
    } } }
    const rows = rowsOf([xai([API]), grok([GROK])], archives, ['2026-09'])
    expect(rows.map((r) => [r.id, r.affectedNames])).toEqual([
      ['xai:xai-evt:mger3p', ['SpaceXSI API', 'Grok']],
      ['xai:xai-evt:60k8qx', ['SpaceXSI API']],
    ])
  })

  it('a shared id keeps the first service\'s row even when another card\'s copy is more open', () => {
    const shared = { id: '461yvfrzpwtt', title: 'Elevated errors for multiple models', status: 'resolved', startedAt: '2026-09-03T13:26:04.201Z', resolvedAt: '2026-09-03T16:00:00.000Z' }
    const [row] = rowsOf([
      { id: 'claude', name: 'Claude API', incidents: [shared] },
      { id: 'claudeai', name: 'claude.ai', incidents: [{ ...shared, status: 'investigating', resolvedAt: null }] },
    ])
    expect(row.id).toBe('claude:461yvfrzpwtt')
    expect(row.status).toBe('resolved')
  })
})
