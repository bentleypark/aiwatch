import { describe, it, expect } from 'vitest'
import { parseIncidentIoUptime, parseIncidentIoComponentImpacts, computeUptimeFromIncidents, parseIncidentIoUpdates, applyTextCache, buildTextCache } from '../incident-io'
import type { IncidentTextCache } from '../incident-io'
import type { Incident } from '../../types'

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

  it('does not cross-match componentId from component_impacts section', () => {
    // Simulates real OpenAI status page: same componentId appears in both
    // component_impacts (incident data) and component_uptimes (uptime data).
    // The regex must only match within component_uptimes to get the correct value.
    const html = `<script>self.__next_f.push([1,"component_impacts\\":[{\\"component_id\\":\\"target\\",\\"status\\":\\"degraded\\"}],\\"component_uptimes\\":[{\\"component_id\\":\\"other\\",\\"uptime\\":\\"100.00\\"},{\\"component_id\\":\\"target\\",\\"uptime\\":\\"99.98\\"}]"])</script>`
    expect(parseIncidentIoUptime(html, 'target')).toBe(99.98)
  })

  it('prefers group uptime over individual component uptime when groupId provided', () => {
    // OpenAI "APIs" group has aggregate uptime 99.99% with $undefined component_id
    const html = `<script>self.__next_f.push([1,"component_uptimes\\":[{\\"component_id\\":\\"comp1\\",\\"data_available_since\\":\\"2021-01-01\\",\\"status_page_component_group_id\\":\\"$undefined\\",\\"uptime\\":\\"100.00\\"},{\\"component_id\\":\\"$undefined\\",\\"data_available_since\\":\\"2021-01-01\\",\\"status_page_component_group_id\\":\\"group1\\",\\"uptime\\":\\"99.99\\"}]"])</script>`
    // With groupId → returns group aggregate (99.99%)
    expect(parseIncidentIoUptime(html, 'comp1', 'group1')).toBe(99.99)
    // Without groupId → returns individual component (100%)
    expect(parseIncidentIoUptime(html, 'comp1')).toBe(100)
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

describe('parseIncidentIoUpdates', () => {
  it('extracts updates from __next_f SSR payload', () => {
    const html = `<script>self.__next_f.push([1,"\\"message_string\\":\\"We are investigating elevated errors\\",\\"published_at\\":\\"2026-03-20T10:00:00Z\\",\\"to_status\\":\\"investigating\\""])</script>`
    const updates = parseIncidentIoUpdates(html)
    expect(updates).toHaveLength(1)
    expect(updates[0].stage).toBe('investigating')
    expect(updates[0].text).toBe('We are investigating elevated errors')
    expect(updates[0].at).toBe('2026-03-20T10:00:00Z')
  })

  it('maps to_status to correct stage', () => {
    const make = (status: string) =>
      `<script>self.__next_f.push([1,"\\"message_string\\":\\"msg\\",\\"published_at\\":\\"2026-03-20T10:00:00Z\\",\\"to_status\\":\\"${status}\\""])</script>`
    expect(parseIncidentIoUpdates(make('resolved'))[0].stage).toBe('resolved')
    expect(parseIncidentIoUpdates(make('monitoring'))[0].stage).toBe('monitoring')
    expect(parseIncidentIoUpdates(make('identified'))[0].stage).toBe('identified')
    expect(parseIncidentIoUpdates(make('investigating'))[0].stage).toBe('investigating')
    expect(parseIncidentIoUpdates(make('unknown_status'))[0].stage).toBe('investigating')
  })

  it('extracts multiple updates from a single chunk', () => {
    const html = `<script>self.__next_f.push([1,"\\"message_string\\":\\"First update\\",\\"published_at\\":\\"2026-03-20T10:00:00Z\\",\\"to_status\\":\\"investigating\\",\\"message_string\\":\\"Second update\\",\\"published_at\\":\\"2026-03-20T11:00:00Z\\",\\"to_status\\":\\"resolved\\""])</script>`
    const updates = parseIncidentIoUpdates(html)
    expect(updates).toHaveLength(2)
    expect(updates[0].stage).toBe('investigating')
    expect(updates[1].stage).toBe('resolved')
  })

  it('returns empty for HTML without __next_f', () => {
    expect(parseIncidentIoUpdates('<html>no data</html>')).toEqual([])
  })
})

describe('buildTextCache', () => {
  it('creates cache from incident timeline', () => {
    const inc: Incident = {
      id: 'inc1', title: 'Test', status: 'resolved', impact: 'major',
      startedAt: '2026-03-20T10:00:00Z', duration: '1h 0m',
      timeline: [
        { stage: 'investigating', text: 'Looking into it', at: '2026-03-20T10:00:00Z' },
        { stage: 'resolved', text: 'Fixed', at: '2026-03-20T11:00:00Z' },
      ],
    }
    const cache = buildTextCache(inc)
    expect(cache.textByKey['investigating:2026-03-20T10:00:00Z']).toBe('Looking into it')
    expect(cache.textByKey['resolved:2026-03-20T11:00:00Z']).toBe('Fixed')
    expect(cache.cachedAt).toBeDefined()
  })

  it('stores null for timeline entries without text', () => {
    const inc: Incident = {
      id: 'inc1', title: 'Test', status: 'investigating', impact: null,
      startedAt: '2026-03-20T10:00:00Z', duration: null,
      timeline: [{ stage: 'investigating', text: null, at: '2026-03-20T10:00:00Z' }],
    }
    const cache = buildTextCache(inc)
    expect(cache.textByKey['investigating:2026-03-20T10:00:00Z']).toBeNull()
  })
})

describe('applyTextCache', () => {
  it('fills null text from cache', () => {
    const inc: Incident = {
      id: 'inc1', title: 'Test', status: 'resolved', impact: 'major',
      startedAt: '2026-03-20T10:00:00Z', duration: '1h 0m',
      timeline: [
        { stage: 'investigating', text: null, at: '2026-03-20T10:00:00Z' },
        { stage: 'resolved', text: null, at: '2026-03-20T11:00:00Z' },
      ],
    }
    const cache: IncidentTextCache = {
      textByKey: {
        'investigating:2026-03-20T10:00:00Z': 'Cached investigating text',
        'resolved:2026-03-20T11:00:00Z': 'Cached resolved text',
      },
      cachedAt: '2026-03-20T12:00:00Z',
    }
    const result = applyTextCache(inc, cache)
    expect(result.timeline[0].text).toBe('Cached investigating text')
    expect(result.timeline[1].text).toBe('Cached resolved text')
  })

  it('preserves existing text (does not overwrite)', () => {
    const inc: Incident = {
      id: 'inc1', title: 'Test', status: 'resolved', impact: null,
      startedAt: '2026-03-20T10:00:00Z', duration: null,
      timeline: [{ stage: 'investigating', text: 'Original', at: '2026-03-20T10:00:00Z' }],
    }
    const cache: IncidentTextCache = {
      textByKey: { 'investigating:2026-03-20T10:00:00Z': 'Cached' },
      cachedAt: '2026-03-20T12:00:00Z',
    }
    const result = applyTextCache(inc, cache)
    expect(result.timeline[0].text).toBe('Original')
  })

  it('leaves text as null when cache key is absent', () => {
    const inc: Incident = {
      id: 'inc1', title: 'Test', status: 'investigating', impact: null,
      startedAt: '2026-03-20T10:00:00Z', duration: null,
      timeline: [{ stage: 'investigating', text: null, at: '2026-03-20T10:00:00Z' }],
    }
    const cache: IncidentTextCache = { textByKey: {}, cachedAt: '2026-03-20T12:00:00Z' }
    const result = applyTextCache(inc, cache)
    expect(result.timeline[0].text).toBeNull()
  })

  it('applies cached null (scraped but no text found)', () => {
    const inc: Incident = {
      id: 'inc1', title: 'Test', status: 'investigating', impact: null,
      startedAt: '2026-03-20T10:00:00Z', duration: null,
      timeline: [{ stage: 'investigating', text: null, at: '2026-03-20T10:00:00Z' }],
    }
    const cache: IncidentTextCache = {
      textByKey: { 'investigating:2026-03-20T10:00:00Z': null },
      cachedAt: '2026-03-20T12:00:00Z',
    }
    const result = applyTextCache(inc, cache)
    expect(result.timeline[0].text).toBeNull()
  })
})
