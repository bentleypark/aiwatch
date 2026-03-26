import { describe, it, expect } from 'vitest'
import { normalizeStatus, parseIncidents, parseUptimeData } from '../statuspage'

describe('normalizeStatus', () => {
  it('maps none/operational to operational', () => {
    expect(normalizeStatus('none')).toBe('operational')
    expect(normalizeStatus('operational')).toBe('operational')
  })

  it('maps minor/degraded_performance/partial_outage to degraded', () => {
    expect(normalizeStatus('minor')).toBe('degraded')
    expect(normalizeStatus('degraded_performance')).toBe('degraded')
    expect(normalizeStatus('partial_outage')).toBe('degraded')
  })

  it('maps major/critical/major_outage to down', () => {
    expect(normalizeStatus('major')).toBe('down')
    expect(normalizeStatus('critical')).toBe('down')
    expect(normalizeStatus('major_outage')).toBe('down')
  })

  it('defaults unknown to operational', () => {
    expect(normalizeStatus('unknown')).toBe('operational')
  })
})

describe('parseIncidents', () => {
  it('parses incidents from Statuspage response', () => {
    const data = {
      status: { indicator: 'none', description: 'All Systems Operational' },
      incidents: [
        {
          id: 'inc1',
          name: 'API Errors',
          status: 'resolved',
          impact: 'major',
          created_at: '2026-03-01T10:00:00Z',
          resolved_at: '2026-03-01T12:00:00Z',
          incident_updates: [
            { status: 'resolved', body: 'Fixed', created_at: '2026-03-01T12:00:00Z' },
            { status: 'investigating', body: 'Looking into it', created_at: '2026-03-01T10:00:00Z' },
          ],
        },
      ],
    }

    const result = parseIncidents(data)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('inc1')
    expect(result[0].title).toBe('API Errors')
    expect(result[0].status).toBe('resolved')
    expect(result[0].impact).toBe('major')
    expect(result[0].duration).toBe('2h 0m')
    expect(result[0].resolvedAt).toBe('2026-03-01T12:00:00Z')
    expect(result[0].timeline).toHaveLength(2)
    // Timeline reversed to oldest first: investigating → resolved
    expect(result[0].timeline[0].stage).toBe('investigating')
    expect(result[0].timeline[1].stage).toBe('resolved')
  })

  it('returns empty array when no incidents', () => {
    const data = { status: { indicator: 'none', description: '' } }
    expect(parseIncidents(data)).toEqual([])
  })

  it('deduplicates timeline entries by stage+time', () => {
    const data = {
      status: { indicator: 'none', description: '' },
      incidents: [{
        id: 'inc2',
        name: 'Dup test',
        status: 'resolved',
        impact: 'minor',
        created_at: '2026-03-01T10:00:00Z',
        resolved_at: '2026-03-01T11:00:00Z',
        incident_updates: [
          { status: 'investigating', body: 'First', created_at: '2026-03-01T10:00:00Z' },
          { status: 'investigating', body: 'Duplicate', created_at: '2026-03-01T10:00:00Z' },
          { status: 'resolved', body: 'Done', created_at: '2026-03-01T11:00:00Z' },
        ],
      }],
    }
    const result = parseIncidents(data)
    expect(result[0].timeline).toHaveLength(2) // deduped from 3
  })
})

describe('parseUptimeData', () => {
  const makeHtml = (uptimeData: object) =>
    `<script>var uptimeData = ${JSON.stringify(uptimeData)}</script>`

  it('parses uptime% with 30% partial weight', () => {
    const html = makeHtml({
      comp1: {
        days: [
          { date: '2026-03-01', outages: { p: 1000, m: 0 } },
          { date: '2026-03-02', outages: { p: 0, m: 0 } },
          { date: '2026-03-03', outages: {} },
        ],
      },
    })
    const result = parseUptimeData(html, 'comp1')
    expect(result.uptimePercent).not.toBeNull()
    // 3 valid days, weighted outage = 0 + 300 (1000*0.3) = 300
    // uptime = (1 - 300 / (3 * 86400)) * 100
    const expected = Math.round((1 - 300 / (3 * 86400)) * 10000) / 100
    expect(result.uptimePercent).toBe(expected)
  })

  it('sets dailyImpact correctly — critical when m > p', () => {
    const html = makeHtml({
      comp1: {
        days: [
          { date: '2026-03-01', outages: { p: 100, m: 200 } },
          { date: '2026-03-02', outages: { p: 300, m: 100 } },
        ],
      },
    })
    const result = parseUptimeData(html, 'comp1')
    expect(result.dailyImpact['2026-03-01']).toBe('critical') // m > p
    expect(result.dailyImpact['2026-03-02']).toBe('major')    // p >= m
  })

  it('returns empty when component not found', () => {
    const html = makeHtml({ other: { days: [] } })
    const result = parseUptimeData(html, 'missing')
    expect(result.dailyImpact).toEqual({})
    expect(result.uptimePercent).toBeNull()
  })

  it('returns empty when no uptimeData in HTML', () => {
    const result = parseUptimeData('<html></html>', 'comp1')
    expect(result.dailyImpact).toEqual({})
    expect(result.uptimePercent).toBeNull()
  })
})
