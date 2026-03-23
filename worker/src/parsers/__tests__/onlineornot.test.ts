import { describe, it, expect } from 'vitest'
import { parseOnlineOrNotIncidents, parseOnlineOrNotUptime } from '../onlineornot'

// Minimal OnlineOrNot HTML with embedded React Router SSR data
function makeHtml(incidents: Array<{ id: string; title: string; started: string; ended: string | null; impact: string }>, uptimeComponent?: { name: string; uptime: string }) {
  // Build flat array mimicking OnlineOrNot's React Router SSR format
  // Key name strings at fixed positions, objects reference them via _N keys
  const arr: unknown[] = [
    {}, // refs object placeholder
    'loaderData',
  ]

  // Add key name strings and track their indices
  const keyIndices: Record<string, number> = {}
  for (const key of ['incidentId', 'title', 'started', 'ended', 'impact']) {
    keyIndices[key] = arr.length
    arr.push(key)
  }

  // Add component key names if uptime data present
  if (uptimeComponent) {
    keyIndices.name = arr.length
    arr.push('name')
  }

  // Add incidents
  for (const inc of incidents) {
    const idIdx = arr.length; arr.push(inc.id)
    const titleIdx = arr.length; arr.push(inc.title)
    const startedIdx = arr.length; arr.push(inc.started)
    const endedIdx = arr.length; arr.push(inc.ended)
    const impactIdx = arr.length; arr.push(inc.impact)

    const obj: Record<string, number> = {}
    obj[`_${keyIndices.incidentId}`] = idIdx
    obj[`_${keyIndices.title}`] = titleIdx
    obj[`_${keyIndices.started}`] = startedIdx
    obj[`_${keyIndices.ended}`] = endedIdx
    obj[`_${keyIndices.impact}`] = impactIdx
    arr.push(obj)
  }

  // Add uptime component data
  if (uptimeComponent) {
    arr.push(uptimeComponent.name)
    arr.push(uptimeComponent.uptime)
  }

  const jsonStr = JSON.stringify(arr)
  const escaped = jsonStr.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `<html><script>window.__reactRouterContext.streamController.enqueue("${escaped}")</script></html>`
}

describe('parseOnlineOrNotIncidents', () => {
  it('parses resolved incidents with correct fields', () => {
    const html = makeHtml([
      { id: 'inc1', title: '401 Errors across API', started: '2026-02-17T05:50:22.123Z', ended: '2026-02-17T07:12:02.870Z', impact: 'MAJOR_OUTAGE' },
    ])
    const incidents = parseOnlineOrNotIncidents(html)
    expect(incidents).toHaveLength(1)
    expect(incidents[0].id).toBe('inc1')
    expect(incidents[0].title).toBe('401 Errors across API')
    expect(incidents[0].status).toBe('resolved')
    expect(incidents[0].impact).toBe('major')
    expect(incidents[0].duration).toBeTruthy()
    expect(incidents[0].timeline).toHaveLength(2)
    expect(incidents[0].timeline[0]).toEqual({ stage: 'investigating', text: '401 Errors across API', at: '2026-02-17T05:50:22.123Z' })
    expect(incidents[0].timeline[1]).toEqual({ stage: 'resolved', text: '', at: '2026-02-17T07:12:02.870Z' })
  })

  it('parses unresolved incidents', () => {
    const html = makeHtml([
      { id: 'inc2', title: 'Ongoing issue', started: '2026-03-20T10:00:00.000Z', ended: null, impact: 'PARTIAL_OUTAGE' },
    ])
    const incidents = parseOnlineOrNotIncidents(html)
    expect(incidents).toHaveLength(1)
    expect(incidents[0].status).toBe('investigating')
    expect(incidents[0].impact).toBe('minor')
    expect(incidents[0].duration).toBeNull()
    expect(incidents[0].timeline).toHaveLength(1)
    expect(incidents[0].timeline[0].stage).toBe('investigating')
  })

  it('maps DEGRADED_PERFORMANCE to minor impact', () => {
    const html = makeHtml([
      { id: 'inc3', title: 'Slow responses', started: '2026-03-15T08:00:00.000Z', ended: '2026-03-15T09:00:00.000Z', impact: 'DEGRADED_PERFORMANCE' },
    ])
    const incidents = parseOnlineOrNotIncidents(html)
    expect(incidents[0].impact).toBe('minor')
  })

  it('deduplicates incidents by id', () => {
    const html = makeHtml([
      { id: 'dup1', title: 'Same incident', started: '2026-03-10T01:00:00.000Z', ended: '2026-03-10T02:00:00.000Z', impact: 'MAJOR_OUTAGE' },
      { id: 'dup1', title: 'Same incident', started: '2026-03-10T01:00:00.000Z', ended: '2026-03-10T02:00:00.000Z', impact: 'MAJOR_OUTAGE' },
    ])
    const incidents = parseOnlineOrNotIncidents(html)
    expect(incidents).toHaveLength(1)
  })

  it('returns empty array for invalid HTML', () => {
    expect(parseOnlineOrNotIncidents('<html>no data</html>')).toEqual([])
    expect(parseOnlineOrNotIncidents('')).toEqual([])
  })

  it('sorts by startedAt descending', () => {
    const html = makeHtml([
      { id: 'old', title: 'Old', started: '2026-01-01T00:00:00.000Z', ended: '2026-01-01T01:00:00.000Z', impact: 'MAJOR_OUTAGE' },
      { id: 'new', title: 'New', started: '2026-03-01T00:00:00.000Z', ended: '2026-03-01T01:00:00.000Z', impact: 'MAJOR_OUTAGE' },
    ])
    const incidents = parseOnlineOrNotIncidents(html)
    expect(incidents[0].id).toBe('new')
    expect(incidents[1].id).toBe('old')
  })
})

describe('parseOnlineOrNotUptime', () => {
  it('parses uptime percentage for named component', () => {
    const html = makeHtml([], { name: 'Chat (/api/v1/chat/completions)', uptime: '0.99886991' })
    const uptime = parseOnlineOrNotUptime(html, 'Chat (/api/v1/chat/completions)')
    expect(uptime).toBe(99.89)
  })

  it('returns null for unknown component', () => {
    const html = makeHtml([], { name: 'Chat API', uptime: '0.99886991' })
    expect(parseOnlineOrNotUptime(html, 'Unknown Component')).toBeNull()
  })

  it('parses low uptime below 90%', () => {
    const html = makeHtml([], { name: 'Chat API', uptime: '0.85000000' })
    const uptime = parseOnlineOrNotUptime(html, 'Chat API')
    expect(uptime).toBe(85)
  })

  it('parses perfect uptime of 1.0', () => {
    const html = makeHtml([], { name: 'Chat API', uptime: '1.00000000' })
    const uptime = parseOnlineOrNotUptime(html, 'Chat API')
    expect(uptime).toBe(100)
  })

  it('returns null for invalid HTML', () => {
    expect(parseOnlineOrNotUptime('<html></html>', 'Chat')).toBeNull()
  })
})
