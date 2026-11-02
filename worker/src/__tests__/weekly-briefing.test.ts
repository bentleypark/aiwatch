import { describe, it, expect } from 'vitest'
import { getBriefingWindow, previousWindowDates, weekDateStrings, buildIncidentSummary, buildStabilityChanges, liveStabilityUptime, accumulatePrevWeekCounters, buildWeeklyBriefing, buildSecuritySummary, parseMonthlyIncidents, filterChangelogToWeek, parseStrategyBrief, isStrategyBriefStale, STRATEGY_STALE_DAYS, STRATEGY_FIELD_MAX, type WeeklyBriefingData } from '../weekly-briefing'

describe('getBriefingWindow', () => {
  it.each([
    ['a Sunday run, as the cron fires', '2026-11-01T00:02:00Z', '2026-10-25', '2026-10-31'],
    ['the same Sunday late in the day', '2026-11-01T23:59:00Z', '2026-10-25', '2026-10-31'],
    ['a Wednesday', '2026-04-08T12:00:00Z', '2026-04-01', '2026-04-07'],
    ['across a month boundary', '2026-03-01T00:02:00Z', '2026-02-22', '2026-02-28'],
    ['across a year boundary', '2027-01-03T00:02:00Z', '2026-12-27', '2027-01-02'],
    ['across a leap day', '2028-03-05T00:02:00Z', '2028-02-27', '2028-03-04'],
  ])('%s: the 7 complete days before the run day', (_name, runAt, start, end) => {
    expect(getBriefingWindow(new Date(runAt))).toEqual({ start, end })
  })

  it.each(['2026-11-01T00:02:00Z', '2026-12-27T00:02:00Z', '2028-02-27T00:02:00Z'])('the window of the run after %s starts the day after this one ends', (first) => {
    const run = new Date(first)
    const next = new Date(run.getTime() + 7 * 86_400_000)
    const dayAfterEnd = new Date(new Date(`${getBriefingWindow(run).end}T00:00:00Z`).getTime() + 86_400_000).toISOString().split('T')[0]
    expect(getBriefingWindow(next).start).toBe(dayAfterEnd)
    expect(weekDateStrings(getBriefingWindow(run).start, getBriefingWindow(run).end)).toHaveLength(7)
  })
})

describe('previousWindowDates', () => {
  it('is the 7 days before the window start, most recent first', () => {
    expect(previousWindowDates('2026-10-25')).toEqual([
      '2026-10-24', '2026-10-23', '2026-10-22', '2026-10-21', '2026-10-20', '2026-10-19', '2026-10-18',
    ])
  })

  it('ends the day before the window it precedes begins', () => {
    const { start } = getBriefingWindow(new Date('2026-11-08T00:02:00Z'))
    expect(previousWindowDates(start)[0]).toBe(getBriefingWindow(new Date('2026-11-01T00:02:00Z')).end)
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
    const names = { groq: 'GroqCloud', mistral: 'Mistral API' }
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

describe('Stability Trend short-window gate (#1839)', () => {
  const names = { helicone: 'Helicone', groq: 'GroqCloud' }
  const stability = (
    live: Parameters<typeof liveStabilityUptime>[0],
    rows: Parameters<typeof accumulatePrevWeekCounters>[0],
  ) => buildStabilityChanges(liveStabilityUptime(live), accumulatePrevWeekCounters(rows), names)

  it('drops a service whose live figure covers fewer than 30 days', () => {
    const rows = [{ helicone: { ok: 288, total: 288, officialUptime: 91.22 } }]
    expect(stability([{ id: 'helicone', uptime30d: 100, uptimeWindowDays: 1 }], rows)).toEqual([])
  })

  it('drops a service whose only previous-week snapshots cover a short window', () => {
    const rows = [
      { helicone: { ok: 288, total: 288, officialUptime: 100, officialUptimeWindowDays: 1 } },
      { helicone: { ok: 288, total: 288, officialUptime: 99, officialUptimeWindowDays: 2 } },
    ]
    expect(stability([{ id: 'helicone', uptime30d: 91.22 }], rows)).toEqual([])
  })

  it('skips a short-window snapshot and takes the next full-window one', () => {
    const rows = [
      { groq: { ok: 288, total: 288, officialUptime: 99.9, officialUptimeWindowDays: 3 } },
      { groq: { ok: 288, total: 288, officialUptime: 97.0 } },
    ]
    expect(stability([{ id: 'groq', uptime30d: 99.5 }], rows)).toEqual([
      { serviceId: 'groq', serviceName: 'GroqCloud', prevUptime: 97.0, currUptime: 99.5 },
    ])
  })

  it('still reports a full-window pair, including a row written before the window field existed', () => {
    const rows = [{ helicone: { ok: 288, total: 288, officialUptime: 99.9 } }]
    expect(stability([{ id: 'helicone', uptime30d: 98.0 }], rows)).toEqual([
      { serviceId: 'helicone', serviceName: 'Helicone', prevUptime: 99.9, currUptime: 98.0 },
    ])
  })

  it('keeps the existing exclusions for a missing figure and a stale incident source', () => {
    expect(liveStabilityUptime([
      { id: 'a', uptime30d: null },
      { id: 'b', uptime30d: 99, incidentSourceStale: true },
      { id: 'c', uptime30d: 99 },
    ])).toEqual({ a: null, b: null, c: 99 })
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
        { serviceId: 'groq', serviceName: 'GroqCloud', prevUptime: 99.2, currUptime: 99.8 },
        { serviceId: 'mistral', serviceName: 'Mistral API', prevUptime: 99.9, currUptime: 98.1 },
      ],
    }
    const result = buildWeeklyBriefing(data)
    // Title is in embed title now, not description
    expect(result).not.toContain('Weekly Briefing')
    expect(result).toContain('Service Changes')
    expect(result).toContain('GPT-5 released')
    // #1292 — "records", not "incidents": a synthesized row is one downtime DAY, not one event, so the
    // count changes meaning for a service whose feed died. The downtime sum below is unaffected.
    expect(result).toContain('8 incident records across 2 services')
    expect(result).toContain('Mistral API (6)')
    expect(result).toContain('2h 45m')
    expect(result).toContain('Improved: GroqCloud')
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
      aiUsageTrend: { days: 7, calls: 12, gemma: 9, gemmaAttempts: 11, sonnet: 2, sonnetAttempts: 3, timedOut: 2, failed: 0, gemmaSuccessRate: 9 / 11, timedOutRate: 2 / 12, hold: null },
    }
    const result = buildWeeklyBriefing(data)
    expect(result).toContain('AI Analysis')
    expect(result).toContain('Gemma 9/11')
    expect(result).toContain('0 failed')
  })

  it('#1262 — carries the AI-hold roll-up into the assembled briefing', () => {
    const result = buildWeeklyBriefing({
      weekStart: '2026-04-06',
      weekEnd: '2026-04-12',
      changelog: [],
      incidents: [],
      stabilityChanges: [],
      aiUsageTrend: { days: 7, calls: 12, gemma: 9, gemmaAttempts: 11, sonnet: 0, sonnetAttempts: 0, timedOut: 0, failed: 0, gemmaSuccessRate: 9 / 11, timedOutRate: 0, hold: { held: 7, releasedWithAi: 5, releasedWithoutAi: 2 } },
    })
    expect(result).toContain('AI-hold 7 held, 5 released with AI, 2 released AI-less (29% AI-less)')
  })

  it('#995 — omits the AI-analysis line when aiUsageTrend is absent or had no calls', () => {
    const base = { weekStart: '2026-04-06', weekEnd: '2026-04-12', changelog: [], incidents: [], stabilityChanges: [] }
    expect(buildWeeklyBriefing(base)).not.toContain('AI Analysis')
    expect(buildWeeklyBriefing({ ...base, aiUsageTrend: { days: 7, calls: 0, gemma: 0, gemmaAttempts: 0, sonnet: 0, sonnetAttempts: 0, timedOut: 0, failed: 0, gemmaSuccessRate: null, timedOutRate: null, hold: null } })).not.toContain('AI Analysis')
  })

  it('#1158 — renders the Badge Adopters section when badgeRepoDiscovery has new repos', () => {
    const base = { weekStart: '2026-04-06', weekEnd: '2026-04-12', changelog: [], incidents: [], stabilityChanges: [] }
    const result = buildWeeklyBriefing({
      ...base,
      badgeRepoDiscovery: {
        newRepos: [{ fullName: 'acme/widget', path: 'README.md', htmlUrl: 'https://github.com/acme/widget' }],
        seen: ['acme/widget'],
        totalKnown: 3,
      },
    })
    expect(result).toContain('Badge Adopters')
    expect(result).toContain('acme/widget')
  })

  it('#1158 — omits the Badge Adopters section when badgeRepoDiscovery is absent or has nothing new', () => {
    const base = { weekStart: '2026-04-06', weekEnd: '2026-04-12', changelog: [], incidents: [], stabilityChanges: [] }
    expect(buildWeeklyBriefing(base)).not.toContain('Badge Adopters')
    expect(buildWeeklyBriefing({ ...base, badgeRepoDiscovery: { newRepos: [], seen: ['acme/widget'], totalKnown: 1 } })).not.toContain('Badge Adopters')
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
      security: { hnCount: 3, osvCount: 2, nvdCount: 4, highlights: ['xAI API key leaked on GitHub', 'CVE-2026-1234 in anthropic SDK'] },
    }
    const result = buildWeeklyBriefing(data)
    expect(result).toContain('🔒 **Security**')
    expect(result).toContain('2 SDK vulnerabilities')
    expect(result).toContain('4 first-party CVEs')
    expect(result).toContain('3 security news')
    expect(result).toContain('xAI API key leaked')
    expect(result).toContain('CVE-2026-1234')
  })

  it('renders the Security section for an NVD-only week (#949 — was suppressed)', () => {
    const data: WeeklyBriefingData = {
      weekStart: '2026-04-06', weekEnd: '2026-04-12',
      changelog: [], incidents: [], stabilityChanges: [],
      security: { hnCount: 0, osvCount: 0, nvdCount: 2, highlights: ['CVE-2025-52882 in Claude Code'] },
    }
    const result = buildWeeklyBriefing(data)
    expect(result).toContain('🔒 **Security**')
    expect(result).toContain('2 first-party CVEs')
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

  it('#917 — renders the Strategy section from a fresh brief, no stale nudge', () => {
    const data: WeeklyBriefingData = {
      weekStart: '2026-07-13',
      weekEnd: '2026-07-19',
      changelog: [],
      incidents: [],
      stabilityChanges: [],
      strategyBrief: { status: 'Channel validated; bottleneck moved to scale.', nextAction: 'Fix #1011 (subscriber count-key).', updatedAt: '2026-07-15' },
    }
    const result = buildWeeklyBriefing(data)
    expect(result).toContain('📈 **Strategy**')
    expect(result).toContain('Channel validated; bottleneck moved to scale.')
    expect(result).toContain('**Next:** Fix #1011 (subscriber count-key).')
    expect(result).not.toContain('refresh') // fresh → no nudge
  })

  it('#917 — renders the Strategy section WITH a stale nudge when the brief is >30d old', () => {
    const data: WeeklyBriefingData = {
      weekStart: '2026-07-13',
      weekEnd: '2026-07-19',
      changelog: [],
      incidents: [],
      stabilityChanges: [],
      strategyBrief: { status: 'Old status.', nextAction: 'Old action.', updatedAt: '2026-05-01' },
    }
    const result = buildWeeklyBriefing(data)
    expect(result).toContain('📈 **Strategy**')
    expect(result).toContain('Brief last updated 2026-05-01')
    expect(result).toContain('refresh the `strategy:brief` KV key')
    expect(result).toContain('Old status.') // stale content is still shown (informative, not hidden)
  })

  it('#917 — omits the Strategy section when strategyBrief is absent or null', () => {
    const base = { weekStart: '2026-07-13', weekEnd: '2026-07-19', changelog: [], incidents: [], stabilityChanges: [] }
    expect(buildWeeklyBriefing(base)).not.toContain('Strategy')
    expect(buildWeeklyBriefing({ ...base, strategyBrief: null })).not.toContain('Strategy')
  })

  it('#917 — surfaces a fix nudge when the brief was set but malformed (not a silent omission)', () => {
    const base = { weekStart: '2026-07-13', weekEnd: '2026-07-19', changelog: [], incidents: [], stabilityChanges: [] }
    const result = buildWeeklyBriefing({ ...base, strategyBrief: null, strategyBriefMalformed: true })
    expect(result).toContain('📈 **Strategy**')
    expect(result).toContain('`strategy:brief` is set but malformed')
  })

  it('#917 — a valid brief wins over the malformed flag (flag is ignored when the brief parsed)', () => {
    const base = { weekStart: '2026-07-13', weekEnd: '2026-07-19', changelog: [], incidents: [], stabilityChanges: [] }
    const result = buildWeeklyBriefing({ ...base, strategyBrief: { status: 'ok', nextAction: 'go', updatedAt: '2026-07-15' }, strategyBriefMalformed: true })
    expect(result).toContain('ok')
    expect(result).not.toContain('malformed')
  })

  it('#917 — caps over-long operator fields so one brief cannot blow the Discord embed limit', () => {
    const base = { weekStart: '2026-07-13', weekEnd: '2026-07-19', changelog: [], incidents: [], stabilityChanges: [] }
    const long = 'x'.repeat(5000)
    const result = buildWeeklyBriefing({ ...base, strategyBrief: { status: long, nextAction: long, updatedAt: '2026-07-15' } })
    expect(result).toContain('…')
    expect(result).not.toContain('x'.repeat(STRATEGY_FIELD_MAX + 1)) // truncated below the cap
    expect(result.length).toBeLessThan(2 * STRATEGY_FIELD_MAX + 200) // whole section stays bounded
  })
})

describe('parseStrategyBrief (#917)', () => {
  it('parses a well-formed brief and trims fields', () => {
    const raw = JSON.stringify({ status: '  scale is the bottleneck  ', nextAction: ' fix #1011 ', updatedAt: '2026-07-15' })
    expect(parseStrategyBrief(raw)).toEqual({ status: 'scale is the bottleneck', nextAction: 'fix #1011', updatedAt: '2026-07-15' })
  })

  it('ignores extra fields', () => {
    const raw = JSON.stringify({ status: 's', nextAction: 'n', updatedAt: '2026-07-15', extra: 42 })
    expect(parseStrategyBrief(raw)).toEqual({ status: 's', nextAction: 'n', updatedAt: '2026-07-15' })
  })

  it('returns null on invalid JSON', () => {
    expect(parseStrategyBrief('{not json')).toBeNull()
  })

  it('returns null when a required field is missing, empty, or non-string', () => {
    expect(parseStrategyBrief(JSON.stringify({ status: 's', nextAction: 'n' }))).toBeNull() // no updatedAt
    expect(parseStrategyBrief(JSON.stringify({ status: '', nextAction: 'n', updatedAt: '2026-07-15' }))).toBeNull() // empty
    expect(parseStrategyBrief(JSON.stringify({ status: 's', nextAction: 3, updatedAt: '2026-07-15' }))).toBeNull() // non-string
    expect(parseStrategyBrief(JSON.stringify(['array']))).toBeNull()
    expect(parseStrategyBrief('null')).toBeNull()
  })
})

describe('isStrategyBriefStale (#917)', () => {
  it('is false when the brief is newer than the horizon', () => {
    expect(isStrategyBriefStale('2026-07-15', '2026-07-19')).toBe(false) // 4d
  })

  it('is false exactly at the horizon boundary (>30, not >=)', () => {
    expect(isStrategyBriefStale('2026-06-19', '2026-07-19')).toBe(false) // exactly 30d
  })

  it('is true when the brief is older than the horizon', () => {
    expect(isStrategyBriefStale('2026-06-18', '2026-07-19')).toBe(true) // 31d
  })

  it('treats an unparseable date as stale (fail-safe surface of the nudge)', () => {
    expect(isStrategyBriefStale('not-a-date', '2026-07-19')).toBe(true)
    expect(isStrategyBriefStale('2026-07-15', 'garbage')).toBe(true)
  })

  it('honors a custom horizon', () => {
    expect(isStrategyBriefStale('2026-07-12', '2026-07-19', 5)).toBe(true) // 7d > 5
    expect(STRATEGY_STALE_DAYS).toBe(30)
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
  it('counts HN, OSV and NVD keys separately', () => {
    const keys = [
      { name: 'security:seen:hn:12345' },
      { name: 'security:seen:hn:67890' },
      { name: 'security:seen:osv:GHSA-abc' },
      { name: 'security:ignored:osv:GHSA-republished-old' },
      { name: 'security:seen:nvd:CVE-2025-52882' }, // #949 first-party CVE
    ]
    const result = buildSecuritySummary(keys, ['Some highlight'])
    expect(result.hnCount).toBe(2)
    expect(result.osvCount).toBe(1)
    expect(result.nvdCount).toBe(1)
    expect(result.highlights).toEqual(['Some highlight'])
  })

  it('returns zero counts for empty keys', () => {
    const result = buildSecuritySummary([], [])
    expect(result.hnCount).toBe(0)
    expect(result.osvCount).toBe(0)
    expect(result.nvdCount).toBe(0)
    expect(result.highlights).toEqual([])
  })

  it('limits highlights to 5', () => {
    const highlights = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    const result = buildSecuritySummary([], highlights)
    expect(result.highlights).toHaveLength(5)
  })
})
