import { describe, it, expect } from 'vitest'
import { parseIncidentIoUptime, parseIncidentIoComponentImpacts, computeUptimeFromIncidents } from '../incident-io'

describe('parseIncidentIoUptime', () => {
  const makeHtml = (uptimes: Array<{ component_id: string; uptime: string }>) => {
    const escaped = JSON.stringify(uptimes).replace(/"/g, '\\"')
    return `<script>self.__next_f.push([1,"component_uptimes\\":${escaped}"])</script>`
  }

  it('extracts uptime for matching component', () => {
    const html = makeHtml([
      { component_id: 'comp1', uptime: '99.95' },
      { component_id: 'comp2', uptime: '100.00' },
    ])
    expect(parseIncidentIoUptime(html, 'comp1')).toBe(99.95)
    expect(parseIncidentIoUptime(html, 'comp2')).toBe(100)
  })

  it('returns null for $undefined uptime', () => {
    const html = `<script>self.__next_f.push([1,"\\"component_id\\":\\"comp1\\",\\"uptime\\":\\"$undefined\\""])</script>`
    // The actual HTML has component_uptimes context
    const realHtml = `<script>self.__next_f.push([1,"component_uptimes\\":[{\\"component_id\\":\\"comp1\\",\\"uptime\\":\\"$undefined\\"}]"])</script>`
    expect(parseIncidentIoUptime(realHtml, 'comp1')).toBeNull()
  })

  it('returns null when component not found', () => {
    const html = '<html>no data</html>'
    expect(parseIncidentIoUptime(html, 'missing')).toBeNull()
  })
})

describe('parseIncidentIoComponentImpacts', () => {
  const makeHtml = (impacts: Array<{ component_id: string; start_at: string; end_at: string; status: string }>) => {
    const escaped = JSON.stringify(impacts).replace(/"/g, '\\"')
    return `<script>self.__next_f.push([1,"component_impacts\\":${escaped},\\"component_uptimes\\":[]"])</script>`
  }

  it('maps status to daily impact levels', () => {
    const result = parseIncidentIoComponentImpacts(
      makeHtml([
        { component_id: 'c1', start_at: '2026-03-01T10:00:00Z', end_at: '2026-03-01T12:00:00Z', status: 'full_outage' },
        { component_id: 'c1', start_at: '2026-03-02T10:00:00Z', end_at: '2026-03-02T11:00:00Z', status: 'partial_outage' },
        { component_id: 'c1', start_at: '2026-03-03T10:00:00Z', end_at: '2026-03-03T10:30:00Z', status: 'degraded_performance' },
      ]),
      'c1'
    )
    expect(result['2026-03-01']).toBe('critical')
    expect(result['2026-03-02']).toBe('major')
    expect(result['2026-03-03']).toBe('minor')
  })

  it('skips impacts shorter than 10 minutes', () => {
    const result = parseIncidentIoComponentImpacts(
      makeHtml([
        { component_id: 'c1', start_at: '2026-03-01T10:00:00Z', end_at: '2026-03-01T10:05:00Z', status: 'degraded_performance' },
      ]),
      'c1'
    )
    expect(result).toEqual({})
  })

  it('filters by component ID', () => {
    const result = parseIncidentIoComponentImpacts(
      makeHtml([
        { component_id: 'c1', start_at: '2026-03-01T10:00:00Z', end_at: '2026-03-01T12:00:00Z', status: 'partial_outage' },
        { component_id: 'c2', start_at: '2026-03-02T10:00:00Z', end_at: '2026-03-02T12:00:00Z', status: 'full_outage' },
      ]),
      'c1'
    )
    expect(Object.keys(result)).toEqual(['2026-03-01'])
  })

  it('spans multi-day impacts', () => {
    const result = parseIncidentIoComponentImpacts(
      makeHtml([
        { component_id: 'c1', start_at: '2026-03-01T22:00:00Z', end_at: '2026-03-03T02:00:00Z', status: 'degraded_performance' },
      ]),
      'c1'
    )
    expect(result['2026-03-01']).toBe('minor')
    expect(result['2026-03-02']).toBe('minor')
    expect(result['2026-03-03']).toBe('minor')
  })
})

describe('computeUptimeFromIncidents', () => {
  it('returns null for empty incidents', () => {
    expect(computeUptimeFromIncidents([])).toBeNull()
  })

  it('returns 100 when all incidents are outside 90-day window', () => {
    const result = computeUptimeFromIncidents([{
      id: '1', title: 'Old', status: 'resolved', impact: null,
      startedAt: '2020-01-01T00:00:00Z', duration: '1h 0m',
      componentNames: [], timeline: [],
    }])
    expect(result).toBe(100)
  })

  it('computes uptime from recent incidents', () => {
    const now = new Date()
    const yesterday = new Date(now.getTime() - 86_400_000).toISOString()
    const result = computeUptimeFromIncidents([{
      id: '1', title: 'Recent', status: 'resolved', impact: 'major',
      startedAt: yesterday, duration: '1h 0m',
      componentNames: [], timeline: [],
    }])
    expect(result).not.toBeNull()
    expect(result!).toBeGreaterThan(99)
    expect(result!).toBeLessThan(100)
  })

  it('merges overlapping intervals', () => {
    const now = new Date()
    const base = new Date(now.getTime() - 86_400_000).toISOString()
    const result = computeUptimeFromIncidents([
      { id: '1', title: 'A', status: 'resolved', impact: 'major', startedAt: base, duration: '2h 0m', componentNames: [], timeline: [] },
      { id: '2', title: 'B', status: 'resolved', impact: 'major', startedAt: base, duration: '1h 0m', componentNames: [], timeline: [] },
    ])
    // Overlapping — should not double count
    expect(result).not.toBeNull()
    // 2h out of 90 days ≈ 99.91%
    expect(result!).toBeGreaterThan(99.9)
  })
})
