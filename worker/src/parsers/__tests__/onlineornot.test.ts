import { describe, it, expect } from 'vitest'
import { parseOnlineOrNotIncidents, computeOnlineOrNotUptime } from '../onlineornot'

// Minimal OnlineOrNot HTML with embedded React Router SSR data
function makeHtml(
  incidents: Array<{ id: string; title: string; started: string; ended: string | null; impact: string }>,
  uptimeComponent?: { name: string; uptime: string },
  // #894 — planned-maintenance entries live under `scheduledMaintenance` and reuse the SAME
  // title/started/ended key indices as incidents (but carry no impact), mirroring the real payload.
  maintenance?: Array<{ title: string; started: string; ended: string | null }>,
) {
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

  // #894 — `scheduledMaintenance` grouping key
  if (maintenance) {
    keyIndices.scheduledMaintenance = arr.length
    arr.push('scheduledMaintenance')
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

  // #894 — add maintenance entries + a container object that references them via the
  // `scheduledMaintenance` key, exactly as OnlineOrNot's loader data does.
  if (maintenance) {
    const maintenanceIdxs: number[] = []
    for (const m of maintenance) {
      const titleIdx = arr.length; arr.push(m.title)
      const startedIdx = arr.length; arr.push(m.started)
      const endedIdx = arr.length; arr.push(m.ended)

      const obj: Record<string, number> = {}
      obj[`_${keyIndices.title}`] = titleIdx      // reuses the incident title key index
      obj[`_${keyIndices.started}`] = startedIdx  // reuses the incident started key index
      obj[`_${keyIndices.ended}`] = endedIdx
      maintenanceIdxs.push(arr.length)
      arr.push(obj)
    }
    const arrRef = arr.length; arr.push(maintenanceIdxs)
    const container: Record<string, number> = {}
    container[`_${keyIndices.scheduledMaintenance}`] = arrRef
    arr.push(container)
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

  // #894 — planned maintenance must NOT be parsed as an incident.
  it('excludes scheduled-maintenance entries (#894)', () => {
    const html = makeHtml(
      [],
      undefined,
      [{ title: 'Scheduled Database Maintenance', started: '2026-07-05T06:00:39.333Z', ended: null }],
    )
    expect(parseOnlineOrNotIncidents(html)).toEqual([])
  })

  it('keeps real incidents while excluding maintenance (#894)', () => {
    const html = makeHtml(
      [{ id: 'real1', title: '[Automated] Generation was inaccessible', started: '2026-04-14T17:02:56.209Z', ended: '2026-04-14T18:07:52.805Z', impact: 'MAJOR_OUTAGE' }],
      undefined,
      [{ title: 'Scheduled Database Maintenance', started: '2026-07-05T06:00:39.333Z', ended: null }],
    )
    const incidents = parseOnlineOrNotIncidents(html)
    expect(incidents).toHaveLength(1)
    expect(incidents[0].id).toBe('real1')
    expect(incidents[0].impact).toBe('major')
    expect(incidents.some(i => /maintenance/i.test(i.title))).toBe(false)
  })

  // #896 — a COMPLETED maintenance is relocated out of `scheduledMaintenance`, so it arrives
  // as a normal resolved entry; the title backstop must still exclude it.
  it('excludes a completed maintenance that leaked out of the scheduledMaintenance group (#896)', () => {
    const html = makeHtml([
      { id: 'm-done', title: 'Scheduled Database Maintenance', started: '2026-07-05T06:00:39.333Z', ended: '2026-07-05T06:30:32.830Z', impact: '' },
    ])
    expect(parseOnlineOrNotIncidents(html)).toEqual([])
  })

  it('keeps a real resolved incident whose title merely mentions maintenance mode (#896)', () => {
    // MAINTENANCE_TITLE deliberately does NOT match "Stuck in maintenance mode".
    const html = makeHtml([
      { id: 'real-inc', title: 'Stuck in maintenance mode', started: '2026-07-05T06:00:00.000Z', ended: '2026-07-05T07:00:00.000Z', impact: 'MAJOR_OUTAGE' },
    ])
    const incidents = parseOnlineOrNotIncidents(html)
    expect(incidents).toHaveLength(1)
    expect(incidents[0].id).toBe('real-inc')
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

describe('computeOnlineOrNotUptime (#1006 — computed from incidents, not the aggregate)', () => {
  const NOW = Date.parse('2026-07-14T00:00:00Z')
  const DAY = 86_400_000
  const ago = (d: number) => new Date(NOW - d * DAY).toISOString()
  const inc = (id: string, startDaysAgo: number, hours: number, impact: string) => ({
    id, title: `${impact} event`, started: ago(startDaysAgo),
    ended: new Date(NOW - startDaysAgo * DAY + hours * 3_600_000).toISOString(), impact,
  })

  it('a clean 30-day window is 100%', () => {
    expect(computeOnlineOrNotUptime(makeHtml([]), NOW)).toBe(100)
  })

  it('a 24h MAJOR_OUTAGE is weighted 1.0 — 1 day of 30', () => {
    expect(computeOnlineOrNotUptime(makeHtml([inc('i1', 5, 24, 'MAJOR_OUTAGE')]), NOW)).toBe(96.66)
  })

  it('DEGRADED/PARTIAL is weighted 0.3, per /methodology', () => {
    // 24h × 0.3 = 7.2h of 30 days → 99.00%
    expect(computeOnlineOrNotUptime(makeHtml([inc('i1', 5, 24, 'DEGRADED_PERFORMANCE')]), NOW)).toBe(99)
    expect(computeOnlineOrNotUptime(makeHtml([inc('i1', 5, 24, 'PARTIAL_OUTAGE')]), NOW)).toBe(99)
  })

  it('an incident OUTSIDE the 30-day window does not count', () => {
    expect(computeOnlineOrNotUptime(makeHtml([inc('i1', 60, 24, 'MAJOR_OUTAGE')]), NOW)).toBe(100)
  })

  it('returns null for a page that is not an OnlineOrNot status page (never a fabricated 100%)', () => {
    expect(computeOnlineOrNotUptime('<html></html>', NOW)).toBeNull()
  })
})
