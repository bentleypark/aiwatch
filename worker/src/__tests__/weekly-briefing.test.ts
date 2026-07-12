import { describe, it, expect } from 'vitest'
import { getWeekRange, weekDateStrings, buildIncidentSummary, buildStabilityChanges, buildWeeklyBriefing, buildSecuritySummary, parseMonthlyIncidents, filterChangelogToWeek, type WeeklyBriefingData } from '../weekly-briefing'

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

describe('weekDateStrings (#995)', () => {
  it('enumerates all 7 dates INCLUSIVE of both ends', () => {
    expect(weekDateStrings('2026-07-06', '2026-07-12')).toEqual([
      '2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10', '2026-07-11', '2026-07-12',
    ])
  })

  it('crosses a month boundary correctly (UTC, no drift)', () => {
    expect(weekDateStrings('2026-06-29', '2026-07-05')).toEqual([
      '2026-06-29', '2026-06-30', '2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04', '2026-07-05',
    ])
  })

  it('single-day range returns that one day', () => {
    expect(weekDateStrings('2026-07-06', '2026-07-06')).toEqual(['2026-07-06'])
  })

  it('inverted range returns [] (no hang, trend omitted)', () => {
    expect(weekDateStrings('2026-07-12', '2026-07-06')).toEqual([])
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

describe('buildStabilityChanges (#733 — live official uptime vs prev-week snapshot)', () => {
  it('reports changes > 0.5% (currentUptime vs prev officialUptime), sorted declined-first', () => {
    const currentUptime = { groq: 99.8, mistral: 98.0 }
    const prevWeek = {
      groq: { ok: 1, total: 1, officialUptime: 99.0 },
      mistral: { ok: 1, total: 1, officialUptime: 99.5 },
    }
    const names = { groq: 'Groq Cloud', mistral: 'Mistral API' }
    const result = buildStabilityChanges(currentUptime, prevWeek, names)
    expect(result).toHaveLength(2)
    expect(result[0].serviceId).toBe('mistral') // declined first
    expect(result[0].currUptime).toBeCloseTo(98.0)
    expect(result[1].serviceId).toBe('groq')
    expect(result[1].currUptime).toBeCloseTo(99.8)
  })

  it('ignores changes <= 0.5%', () => {
    expect(buildStabilityChanges({ groq: 99.8 }, { groq: { ok: 1, total: 1, officialUptime: 99.5 } }, { groq: 'Groq' })).toHaveLength(0)
  })

  it('excludes a service whose LIVE uptime is null — no-official-uptime/stale, even if prev-week had a (stale) snapshot (#733 — Bedrock)', () => {
    // Bedrock currently publishes no uptime → currentUptime null → excluded, regardless of a leftover
    // pre-#713 prev-week officialUptime snapshot (the exact leak the live-gate fixes).
    const currentUptime = { bedrock: null }
    const prevWeek = { bedrock: { ok: 48, total: 981, officialUptime: 100 } }
    expect(buildStabilityChanges(currentUptime, prevWeek, { bedrock: 'Amazon Bedrock' })).toHaveLength(0)
  })

  it('excludes a service with no prev-week official snapshot', () => {
    expect(buildStabilityChanges({ x: 95 }, { x: { ok: 1, total: 1, officialUptime: null } }, { x: 'X' })).toHaveLength(0)
    expect(buildStabilityChanges({ x: 95 }, {}, { x: 'X' })).toHaveLength(0)
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

  it('#995 — renders the AI-analysis trend line when aiUsageTrend has calls', () => {
    const data: WeeklyBriefingData = {
      weekStart: '2026-04-06',
      weekEnd: '2026-04-12',
      changelog: [],
      incidents: [],
      stabilityChanges: [],
      aiUsageTrend: { days: 7, calls: 12, gemma: 9, gemmaAttempts: 11, sonnet: 2, sonnetAttempts: 3, timedOut: 2, failed: 0, gemmaSuccessRate: 9 / 11, timedOutRate: 2 / 12 },
    }
    const result = buildWeeklyBriefing(data)
    expect(result).toContain('AI Analysis')
    expect(result).toContain('Gemma 9/11')
    expect(result).toContain('0 failed')
  })

  it('#995 — omits the AI-analysis line when aiUsageTrend is absent or had no calls', () => {
    const base = { weekStart: '2026-04-06', weekEnd: '2026-04-12', changelog: [], incidents: [], stabilityChanges: [] }
    expect(buildWeeklyBriefing(base)).not.toContain('AI Analysis')
    expect(buildWeeklyBriefing({ ...base, aiUsageTrend: { days: 7, calls: 0, gemma: 0, gemmaAttempts: 0, sonnet: 0, sonnetAttempts: 0, timedOut: 0, failed: 0, gemmaSuccessRate: null, timedOutRate: null } })).not.toContain('AI Analysis')
  })

  it('renders "data unavailable" (not "No significant changes") when stabilityDataAvailable is false (#733)', () => {
    const data: WeeklyBriefingData = {
      weekStart: '2026-04-06',
      weekEnd: '2026-04-12',
      changelog: [],
      incidents: [],
      stabilityChanges: [],
      stabilityDataAvailable: false,
    }
    const result = buildWeeklyBriefing(data)
    expect(result).toContain('Stability data unavailable this week')
    expect(result).not.toContain('No significant changes')
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

describe('filterChangelogToWeek', () => {
  it('excludes entries before weekStart and includes entries within the window', () => {
    // Regression: changelog:entries KV accumulates 14 days; without this filter
    // the weekly briefing showed entries from before the current week (e.g. 5/22 in 5/25-5/31).
    const entries = [
      { source: 'anthropic', title: 'Project Glasswing', url: 'https://anthropic.com/glasswing', date: '2026-05-22T00:00:00Z' }, // outside week
      { source: 'openai', title: 'Codex Enterprise', url: 'https://openai.com/blog/codex', date: '2026-05-27T00:00:00Z' },       // inside week
      { source: 'anthropic', title: 'Claude Opus 4.8', url: 'https://anthropic.com/news/opus', date: '2026-05-29T00:00:00Z' },    // inside week
    ]
    const result = filterChangelogToWeek(entries, '2026-05-25', '2026-05-31')
    expect(result).toHaveLength(2)
    expect(result.every((e) => e.title !== 'Project Glasswing')).toBe(true)
  })

  it('includes entries on weekEnd day up to 23:59:59Z', () => {
    const entries = [
      { source: 'openai', title: 'Last day entry', url: 'https://openai.com', date: '2026-05-31T23:59:00Z' },
      { source: 'openai', title: 'Next day entry', url: 'https://openai.com', date: '2026-06-01T00:00:00Z' },
    ]
    const result = filterChangelogToWeek(entries, '2026-05-25', '2026-05-31')
    expect(result).toHaveLength(1)
    expect(result[0].title).toBe('Last day entry')
  })

  it('returns empty array when no entries fall in the window', () => {
    const entries = [
      { source: 'anthropic', title: 'Old news', url: 'https://anthropic.com', date: '2026-05-10T00:00:00Z' },
    ]
    expect(filterChangelogToWeek(entries, '2026-05-25', '2026-05-31')).toEqual([])
  })
})

describe('parseMonthlyIncidents', () => {
  const svcNames = { claude: 'Claude API', openai: 'OpenAI API' }

  it('flattens nested services.incidents into a flat list with serviceId/serviceName', () => {
    const raw = {
      services: {
        claude: {
          incidents: [
            { id: 'inc-1', title: 'Outage', startedAt: '2026-05-28T10:00:00Z', durationMin: 90 },
          ],
        },
        openai: {
          incidents: [
            { id: 'inc-2', title: 'Degraded', startedAt: '2026-05-29T08:00:00Z', durationMin: 30 },
          ],
        },
      },
    }
    const result = parseMonthlyIncidents(raw, svcNames)
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ id: 'inc-1', serviceId: 'claude', serviceName: 'Claude API', duration: '1h 30m' })
    expect(result[1]).toMatchObject({ id: 'inc-2', serviceId: 'openai', serviceName: 'OpenAI API', duration: '30m' })
  })

  it('returns empty array for a root-level incidents key (old bug: was reading .incidents at root)', () => {
    // This validates that the old pattern JSON.parse(mRaw).incidents would have returned undefined
    const raw = { incidents: [{ id: 'inc-1' }] } as unknown as Parameters<typeof parseMonthlyIncidents>[0]
    const result = parseMonthlyIncidents(raw, svcNames)
    expect(result).toHaveLength(0) // no .services → empty, not the stale root .incidents
  })

  it('handles services with no incidents array (backward compat)', () => {
    const raw = { services: { claude: { count: 2, totalMinutes: 60 } } } as unknown as Parameters<typeof parseMonthlyIncidents>[0]
    const result = parseMonthlyIncidents(raw, svcNames)
    expect(result).toHaveLength(0)
  })

  it('converts durationMin to duration string correctly', () => {
    const raw = {
      services: {
        claude: {
          incidents: [
            { id: 'a', title: 'T', startedAt: '2026-05-01T00:00:00Z', durationMin: 120 },
            { id: 'b', title: 'T', startedAt: '2026-05-01T00:00:00Z', durationMin: 45 },
            { id: 'c', title: 'T', startedAt: '2026-05-01T00:00:00Z', durationMin: 0 },
          ],
        },
      },
    }
    const result = parseMonthlyIncidents(raw, svcNames)
    expect(result[0].duration).toBe('2h')
    expect(result[1].duration).toBe('45m')
    expect(result[2].duration).toBeNull()
  })

  it('uses svcId as fallback serviceName when not in map', () => {
    const raw = { services: { unknown_svc: { incidents: [{ id: 'x', title: 'T', startedAt: '2026-05-01T00:00:00Z' }] } } }
    const result = parseMonthlyIncidents(raw, {})
    expect(result[0].serviceName).toBe('unknown_svc')
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
