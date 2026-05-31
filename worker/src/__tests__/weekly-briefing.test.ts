import { describe, it, expect } from 'vitest'
import { getWeekRange, buildIncidentSummary, buildStabilityChanges, buildWeeklyBriefing, buildSecuritySummary, type WeeklyBriefingData } from '../weekly-briefing'

describe('getWeekRange', () => {
  it('returns Mon–Sun for a Wednesday', () => {
    const { start, end } = getWeekRange(new Date('2026-04-08T12:00:00Z')) // Wednesday
    expect(start).toBe('2026-04-06')
    expect(end).toBe('2026-04-12')
  })

  it('returns Mon–Sun for a Monday', () => {
    const { start, end } = getWeekRange(new Date('2026-04-06T00:00:00Z')) // Monday
    expect(start).toBe('2026-04-06')
    expect(end).toBe('2026-04-12')
  })

  it('returns Mon–Sun for a Sunday', () => {
    const { start, end } = getWeekRange(new Date('2026-04-12T23:59:00Z')) // Sunday
    expect(start).toBe('2026-04-06')
    expect(end).toBe('2026-04-12')
  })
})

describe('buildIncidentSummary', () => {
  const incidents = [
    { id: '1', serviceId: 'mistral', serviceName: 'Mistral API', title: 'Files API Degraded', startedAt: '2026-04-07T10:00:00Z', duration: '25m' },
    { id: '2', serviceId: 'mistral', serviceName: 'Mistral API', title: 'Batch API Degraded', startedAt: '2026-04-08T03:00:00Z', duration: '1h 10m' },
    { id: '3', serviceId: 'openai', serviceName: 'OpenAI API', title: 'Elevated Error Rates', startedAt: '2026-04-09T15:00:00Z', duration: '45m' },
    { id: '4', serviceId: 'claude', serviceName: 'Claude API', title: 'Old incident', startedAt: '2026-03-30T10:00:00Z', duration: '30m' },
  ]

  it('aggregates incidents within the week range', () => {
    const result = buildIncidentSummary(incidents, '2026-04-06', '2026-04-12')
    expect(result).toHaveLength(2) // mistral, openai (old claude excluded)
    expect(result[0].serviceId).toBe('mistral')
    expect(result[0].count).toBe(2)
    expect(result[0].totalDurationMin).toBe(95) // 25 + 70
    expect(result[1].serviceId).toBe('openai')
    expect(result[1].count).toBe(1)
  })

  it('returns empty for no incidents in range', () => {
    expect(buildIncidentSummary(incidents, '2026-04-20', '2026-04-26')).toEqual([])
  })

  it('handles hours-only duration ("2h")', () => {
    const incs = [
      { id: '1', serviceId: 'claude', serviceName: 'Claude API', title: 'Outage', startedAt: '2026-04-07T10:00:00Z', duration: '2h' },
    ]
    const result = buildIncidentSummary(incs, '2026-04-06', '2026-04-12')
    expect(result[0].totalDurationMin).toBe(120)
  })
})

describe('buildStabilityChanges', () => {
  it('reports changes > 0.5%', () => {
    const thisWeek = { groq: { ok: 998, total: 1000 }, mistral: { ok: 980, total: 1000 } }
    const prevWeek = { groq: { ok: 990, total: 1000 }, mistral: { ok: 999, total: 1000 } }
    const names = { groq: 'Groq Cloud', mistral: 'Mistral API' }
    const result = buildStabilityChanges(thisWeek, prevWeek, names)
    expect(result).toHaveLength(2)
    // Sorted by change ascending (declined first)
    expect(result[0].serviceId).toBe('mistral')
    expect(result[0].currUptime).toBeCloseTo(98.0)
    expect(result[1].serviceId).toBe('groq')
    expect(result[1].currUptime).toBeCloseTo(99.8)
  })

  it('ignores changes <= 0.5%', () => {
    const thisWeek = { groq: { ok: 998, total: 1000 } }
    const prevWeek = { groq: { ok: 995, total: 1000 } }
    const result = buildStabilityChanges(thisWeek, prevWeek, { groq: 'Groq' })
    expect(result).toHaveLength(0) // 0.3% change
  })
})

describe('buildWeeklyBriefing', () => {
  it('formats complete briefing with all sections', () => {
    const data: WeeklyBriefingData = {
      weekStart: '2026-04-06',
      weekEnd: '2026-04-12',
      changelog: [
        { source: 'openai', title: 'GPT-5 released', url: 'https://openai.com', date: '2026-04-10T00:00:00Z' },
      ],
      incidents: [
        { serviceId: 'mistral', serviceName: 'Mistral API', count: 6, totalDurationMin: 120 },
        { serviceId: 'openai', serviceName: 'OpenAI API', count: 2, totalDurationMin: 45 },
      ],
      stabilityChanges: [
        { serviceId: 'groq', serviceName: 'Groq Cloud', prevUptime: 99.2, currUptime: 99.8 },
        { serviceId: 'mistral', serviceName: 'Mistral API', prevUptime: 99.9, currUptime: 98.1 },
      ],
    }
    const result = buildWeeklyBriefing(data)
    // Title is in embed title now, not description
    expect(result).not.toContain('Weekly Briefing')
    expect(result).toContain('Service Changes')
    expect(result).toContain('GPT-5 released')
    expect(result).toContain('8 incidents across 2 services')
    expect(result).toContain('Mistral API (6)')
    expect(result).toContain('2h 45m')
    expect(result).toContain('Improved: Groq Cloud')
    expect(result).toContain('Declined: Mistral API')
  })

  it('handles empty data gracefully', () => {
    const data: WeeklyBriefingData = {
      weekStart: '2026-04-06',
      weekEnd: '2026-04-12',
      changelog: [],
      incidents: [],
      stabilityChanges: [],
    }
    const result = buildWeeklyBriefing(data)
    expect(result).toContain('No service changes detected')
    expect(result).toContain('No incidents this week')
    expect(result).toContain('No significant changes')
  })

  it('includes security section when security data is present', () => {
    const data: WeeklyBriefingData = {
      weekStart: '2026-04-06',
      weekEnd: '2026-04-12',
      changelog: [],
      incidents: [],
      stabilityChanges: [],
      security: { hnCount: 3, osvCount: 2, highlights: ['xAI API key leaked on GitHub', 'CVE-2026-1234 in anthropic SDK'] },
    }
    const result = buildWeeklyBriefing(data)
    expect(result).toContain('🔒 **Security**')
    expect(result).toContain('2 SDK vulnerabilities')
    expect(result).toContain('3 security news')
    expect(result).toContain('xAI API key leaked')
    expect(result).toContain('CVE-2026-1234')
  })

  it('omits security section when no security data', () => {
    const data: WeeklyBriefingData = {
      weekStart: '2026-04-06',
      weekEnd: '2026-04-12',
      changelog: [],
      incidents: [],
      stabilityChanges: [],
    }
    const result = buildWeeklyBriefing(data)
    expect(result).not.toContain('Security')
  })
})

describe('buildSecuritySummary', () => {
  it('counts HN and OSV keys separately', () => {
    const keys = [
      { name: 'security:seen:hn:12345' },
      { name: 'security:seen:hn:67890' },
      { name: 'security:seen:osv:GHSA-abc' },
    ]
    const result = buildSecuritySummary(keys, ['Some highlight'])
    expect(result.hnCount).toBe(2)
    expect(result.osvCount).toBe(1)
    expect(result.highlights).toEqual(['Some highlight'])
  })

  it('returns zero counts for empty keys', () => {
    const result = buildSecuritySummary([], [])
    expect(result.hnCount).toBe(0)
    expect(result.osvCount).toBe(0)
    expect(result.highlights).toEqual([])
  })

  it('limits highlights to 5', () => {
    const highlights = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    const result = buildSecuritySummary([], highlights)
    expect(result.highlights).toHaveLength(5)
  })
})
