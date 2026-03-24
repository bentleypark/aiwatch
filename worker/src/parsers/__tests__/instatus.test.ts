import { describe, it, expect } from 'vitest'
import { parseInstatusIncidents } from '../instatus'

describe('parseInstatusIncidents — Nuxt SSR', () => {
  it('returns empty when no __NUXT_DATA__ found', () => {
    expect(parseInstatusIncidents('<html>no data</html>')).toEqual([])
  })

  it('falls through to Next.js parser when __next_f found', () => {
    // Minimal Next.js SSR payload — should attempt parseInstatusNextIncidents
    const html = '<script>self.__next_f.push([1,"some data"])</script>'
    // No valid notices → empty
    expect(parseInstatusIncidents(html)).toEqual([])
  })
})

describe('parseInstatusIncidents — Next.js SSR (Perplexity format)', () => {
  it('parses notices from escaped Next.js payload', () => {
    const notice = {
      id1: {
        id: 'id1',
        name: { default: 'API Outage' },
        impact: 'MAJOROUTAGE',
        started: '2026-03-01T10:00:00Z',
        resolved: '2026-03-01T12:00:00Z',
        status: 'RESOLVED',
      },
    }
    const escaped = JSON.stringify(notice)
      .slice(1, -1) // remove outer {}
      .replace(/"/g, '\\"')
    const html = `<script>self.__next_f.push([1,"notices\\":{${escaped}},\\"metrics"])</script>`

    const result = parseInstatusIncidents(html)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('id1')
    expect(result[0].title).toBe('API Outage')
    expect(result[0].status).toBe('resolved')
    expect(result[0].impact).toBe('major') // MAJOROUTAGE → major
  })

  it('maps PARTIALOUTAGE to minor impact', () => {
    const notice = {
      id1: {
        id: 'id1', name: { default: 'Slow API' },
        impact: 'PARTIALOUTAGE', started: '2026-03-01T10:00:00Z',
        resolved: null, status: 'INVESTIGATING',
      },
    }
    const escaped = JSON.stringify(notice).slice(1, -1).replace(/"/g, '\\"')
    const html = `<script>self.__next_f.push([1,"notices\\":{${escaped}},\\"metrics"])</script>`
    const result = parseInstatusIncidents(html)
    expect(result).toHaveLength(1)
    expect(result[0].status).toBe('investigating')
    expect(result[0].impact).toBe('minor')
    expect(result[0].duration).toBeNull()
  })

  it('computes duration for resolved incidents', () => {
    const notice = {
      id1: {
        id: 'id1', name: { default: 'Fixed' },
        impact: 'MAJOROUTAGE', started: '2026-03-01T10:00:00Z',
        resolved: '2026-03-01T11:30:00Z', status: 'RESOLVED',
      },
    }
    const escaped = JSON.stringify(notice).slice(1, -1).replace(/"/g, '\\"')
    const html = `<script>self.__next_f.push([1,"notices\\":{${escaped}},\\"metrics"])</script>`
    const result = parseInstatusIncidents(html)
    expect(result[0].duration).toBe('1h 30m')
  })

  it('builds timeline with investigating + resolved entries', () => {
    const notice = {
      id1: {
        id: 'id1', name: { default: 'Test' },
        impact: 'MAJOROUTAGE', started: '2026-03-01T10:00:00Z',
        resolved: '2026-03-01T11:00:00Z', status: 'RESOLVED',
      },
    }
    const escaped = JSON.stringify(notice).slice(1, -1).replace(/"/g, '\\"')
    const html = `<script>self.__next_f.push([1,"notices\\":{${escaped}},\\"metrics"])</script>`
    const result = parseInstatusIncidents(html)
    expect(result[0].timeline).toHaveLength(2)
    expect(result[0].timeline[0].stage).toBe('investigating')
    expect(result[0].timeline[1].stage).toBe('resolved')
  })

  it('limits to 5 incidents', () => {
    const notices: Record<string, unknown> = {}
    for (let i = 0; i < 8; i++) {
      notices[`id${i}`] = {
        id: `id${i}`, name: { default: `Inc ${i}` },
        impact: 'MAJOROUTAGE', started: `2026-03-0${i + 1}T10:00:00Z`,
        resolved: null, status: 'INVESTIGATING',
      }
    }
    const escaped = JSON.stringify(notices).slice(1, -1).replace(/"/g, '\\"')
    const html = `<script>self.__next_f.push([1,"notices\\":{${escaped}},\\"metrics"])</script>`
    const result = parseInstatusIncidents(html)
    expect(result).toHaveLength(5)
  })

  it('skips micro-incidents shorter than 1 minute', () => {
    const notice = {
      id1: {
        id: 'id1', name: { default: 'Completion API Degraded' },
        impact: 'PARTIALOUTAGE', started: '2026-03-23T14:57:00Z',
        resolved: '2026-03-23T14:57:30Z', status: 'RESOLVED', // 30 seconds
      },
    }
    const escaped = JSON.stringify(notice).slice(1, -1).replace(/"/g, '\\"')
    const html = `<script>self.__next_f.push([1,"notices\\":{${escaped}},\\"metrics"])</script>`
    const result = parseInstatusIncidents(html)
    expect(result).toHaveLength(0)
  })

  it('keeps incidents exactly 1 minute or longer', () => {
    const notice = {
      id1: {
        id: 'id1', name: { default: 'Completion API Degraded' },
        impact: 'PARTIALOUTAGE', started: '2026-03-23T14:57:00Z',
        resolved: '2026-03-23T14:58:00Z', status: 'RESOLVED', // exactly 60s
      },
    }
    const escaped = JSON.stringify(notice).slice(1, -1).replace(/"/g, '\\"')
    const html = `<script>self.__next_f.push([1,"notices\\":{${escaped}},\\"metrics"])</script>`
    const result = parseInstatusIncidents(html)
    expect(result).toHaveLength(1)
  })

  it('keeps ongoing (unresolved) micro-incidents', () => {
    const notice = {
      id1: {
        id: 'id1', name: { default: 'API Down' },
        impact: 'MAJOROUTAGE', started: '2026-03-23T14:57:00Z',
        resolved: null, status: 'INVESTIGATING',
      },
    }
    const escaped = JSON.stringify(notice).slice(1, -1).replace(/"/g, '\\"')
    const html = `<script>self.__next_f.push([1,"notices\\":{${escaped}},\\"metrics"])</script>`
    const result = parseInstatusIncidents(html)
    expect(result).toHaveLength(1)
  })

  it('skips notices with invalid dates', () => {
    const notice = {
      id1: {
        id: 'id1', name: { default: 'Bad date' },
        impact: 'MAJOROUTAGE', started: 'not-a-date',
        resolved: null, status: 'INVESTIGATING',
      },
    }
    const escaped = JSON.stringify(notice).slice(1, -1).replace(/"/g, '\\"')
    const html = `<script>self.__next_f.push([1,"notices\\":{${escaped}},\\"metrics"])</script>`
    const result = parseInstatusIncidents(html)
    expect(result).toHaveLength(0)
  })
})

describe('parseInstatusIncidents — Nuxt SSR (Mistral format)', () => {
  it('parses incidents from __NUXT_DATA__ payload', () => {
    // Simplified Nuxt SSR payload structure
    const nuxtData = [
      null, // 0
      { 'incidents-by-date-2026-03': 2 }, // 1 — dataRefs
      { incidents: 3 }, // 2 — incObj
      [4], // 3 — incIndices
      { id: 5, name: 6, lastUpdateStatus: 7, created_at: 8, duration: 9, incidentUpdates: 10 }, // 4 — incident
      'inc-001', // 5
      'API Down', // 6
      'RESOLVED', // 7
      '2026-03-01T10:00:00Z', // 8
      3600, // 9 — 1 hour in seconds
      [11], // 10 — updates array
      { status: 12, description: 13, created_at: 14 }, // 11 — update
      'RESOLVED', // 12
      'Issue has been fixed', // 13
      '2026-03-01T11:00:00Z', // 14
    ]
    const html = `<script type="application/json" id="__NUXT_DATA__">${JSON.stringify(nuxtData)}</script>`
    const result = parseInstatusIncidents(html)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('inc-001')
    expect(result[0].title).toBe('API Down')
    expect(result[0].status).toBe('resolved')
    expect(result[0].duration).toBe('1h 0m')
    expect(result[0].timeline).toHaveLength(1)
    expect(result[0].timeline[0].stage).toBe('resolved')
    expect(result[0].timeline[0].text).toBe('Issue has been fixed')
  })

  it('skips Nuxt micro-incidents shorter than 1 minute', () => {
    const nuxtData = [
      null,
      { 'incidents-by-date-2026-03': 2 },
      { incidents: 3 },
      [4],
      { id: 5, name: 6, lastUpdateStatus: 7, created_at: 8, duration: 9, incidentUpdates: 10 },
      'inc-micro', 'Completion API Degraded', 'RESOLVED',
      '2026-03-23T14:57:00Z', 30, // 30 seconds
      [],
    ]
    const html = `<script type="application/json" id="__NUXT_DATA__">${JSON.stringify(nuxtData)}</script>`
    const result = parseInstatusIncidents(html)
    expect(result).toHaveLength(0)
  })

  it('returns empty for malformed __NUXT_DATA__', () => {
    const html = `<script type="application/json" id="__NUXT_DATA__">not json</script>`
    expect(parseInstatusIncidents(html)).toEqual([])
  })

  it('returns empty when incidents-by-date key is missing', () => {
    const nuxtData = [null, { someOtherKey: 2 }]
    const html = `<script type="application/json" id="__NUXT_DATA__">${JSON.stringify(nuxtData)}</script>`
    expect(parseInstatusIncidents(html)).toEqual([])
  })
})
