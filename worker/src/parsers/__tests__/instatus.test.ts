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
})
