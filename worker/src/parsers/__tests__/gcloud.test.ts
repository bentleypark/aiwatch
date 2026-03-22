import { describe, it, expect } from 'vitest'
import { parseGCloudIncidents } from '../gcloud'

describe('parseGCloudIncidents', () => {
  const makeIncident = (id: string, products: Array<{ title: string; id: string }>, severity = 'medium', end: string | null = '2026-03-01T12:00:00Z') => ({
    id,
    service_name: 'Cloud AI',
    severity,
    begin: '2026-03-01T10:00:00Z',
    end,
    affected_products: products,
    most_recent_update: { status: 'AVAILABLE', text: 'Resolved' },
    updates: [
      { status: 'SERVICE_DISRUPTION', when: '2026-03-01T10:00:00Z', text: 'Investigating' },
      { status: 'AVAILABLE', when: '2026-03-01T12:00:00Z', text: 'Resolved' },
    ],
  })

  it('filters by product ID when provided', () => {
    const data = [
      makeIncident('1', [{ title: 'Vertex Gemini API', id: 'gemini-id' }]),
      makeIncident('2', [{ title: 'Other Product', id: 'other-id' }]),
    ]
    const result = parseGCloudIncidents(data, 'Vertex Gemini API', 'gemini-id')
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('1')
  })

  it('falls back to product title matching', () => {
    const data = [
      makeIncident('1', [{ title: 'Vertex Gemini API', id: 'gemini-id' }]),
    ]
    const result = parseGCloudIncidents(data, 'Vertex Gemini API')
    expect(result).toHaveLength(1)
  })

  it('falls back to service_name matching', () => {
    const data = [{
      id: '1', service_name: 'Vertex Gemini API', severity: 'medium',
      begin: '2026-03-01T10:00:00Z', end: '2026-03-01T12:00:00Z',
      affected_products: [],
      most_recent_update: { status: 'AVAILABLE', text: '' },
      updates: [],
    }]
    const result = parseGCloudIncidents(data, 'Vertex Gemini API')
    expect(result).toHaveLength(1)
  })

  it('maps severity to impact', () => {
    const data = [
      makeIncident('1', [{ title: 'Gemini', id: 'g' }], 'high'),
      makeIncident('2', [{ title: 'Gemini', id: 'g' }], 'medium'),
    ]
    const result = parseGCloudIncidents(data, 'Gemini', 'g')
    expect(result[0].impact).toBe('major')  // high → major
    expect(result[1].impact).toBe('minor')  // medium → minor
  })

  it('computes duration for resolved incidents', () => {
    const data = [makeIncident('1', [{ title: 'Gemini', id: 'g' }])]
    const result = parseGCloudIncidents(data, 'Gemini', 'g')
    expect(result[0].duration).toBe('2h 0m')
  })

  it('limits to 5 incidents', () => {
    const data = Array.from({ length: 10 }, (_, i) =>
      makeIncident(`${i}`, [{ title: 'Gemini', id: 'g' }])
    )
    const result = parseGCloudIncidents(data, 'Gemini', 'g')
    expect(result).toHaveLength(5)
  })
})
