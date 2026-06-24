import { describe, it, expect } from 'vitest'
import {
  reportDateKey,
  reportCountKey,
  reportSeenKey,
  isReportableService,
  hashIp,
  nextCount,
  formatReportCountsSection,
  isValidCategory,
  sanitizeReportDescription,
  reportFeedKey,
  appendReportFeed,
  recentReportFeed,
  reportWindowFloor,
  REPORT_PRE_INCIDENT_BUFFER_MS,
  REPORT_SPIKE_FALLBACK_MS,
  REPORT_FEED_MAX,
  REPORT_DESC_MAX,
  type ReportFeedEntry,
  shouldSurfaceReports,
  REPORT_DISPLAY_MIN,
} from '../report'

describe('report — key builders', () => {
  it('reportDateKey is the UTC YYYY-MM-DD', () => {
    expect(reportDateKey(Date.parse('2026-06-21T23:30:00Z'))).toBe('2026-06-21')
    // Just-before-midnight UTC stays on the same UTC day regardless of local TZ.
    expect(reportDateKey(Date.parse('2026-06-21T00:00:00Z'))).toBe('2026-06-21')
  })

  it('count + seen keys are namespaced and stable', () => {
    expect(reportCountKey('claude', '2026-06-21')).toBe('report:count:claude:2026-06-21')
    expect(reportSeenKey('claude', 'abc123', '2026-06-21')).toBe('report:seen:claude:abc123:2026-06-21')
  })
})

describe('isReportableService', () => {
  const known = new Set(['claude', 'openai', 'gemini'])
  it('accepts a known id', () => expect(isReportableService('claude', known)).toBe(true))
  it('rejects unknown / wrong types', () => {
    expect(isReportableService('not-a-service', known)).toBe(false)
    expect(isReportableService('', known)).toBe(false)
    expect(isReportableService(undefined, known)).toBe(false)
    expect(isReportableService(42, known)).toBe(false)
    expect(isReportableService({ id: 'claude' }, known)).toBe(false)
  })
})

describe('hashIp', () => {
  it('is deterministic for the same ip+salt', async () => {
    expect(await hashIp('1.2.3.4', 's')).toBe(await hashIp('1.2.3.4', 's'))
  })
  it('never returns the raw IP and is fixed-length hex (128-bit)', async () => {
    const h = await hashIp('203.0.113.9', 'salt')
    expect(h).not.toContain('203.0.113.9')
    expect(h).toMatch(/^[0-9a-f]{32}$/)
  })
  it('salt changes the output (defeats trivial IPv4 precompute)', async () => {
    expect(await hashIp('1.2.3.4', 'saltA')).not.toBe(await hashIp('1.2.3.4', 'saltB'))
  })
  it('different IPs hash differently', async () => {
    expect(await hashIp('1.2.3.4', 's')).not.toBe(await hashIp('1.2.3.5', 's'))
  })
})

describe('nextCount', () => {
  it('starts at 1 for a fresh counter', () => {
    expect(nextCount(null)).toBe(1)
    expect(nextCount('')).toBe(1)
    expect(nextCount('garbage')).toBe(1)
    expect(nextCount('0')).toBe(1)
    expect(nextCount('-3')).toBe(1) // negative/garbage floored to 0 → 1
  })
  it('increments a valid stored value', () => {
    expect(nextCount('1')).toBe(2)
    expect(nextCount('41')).toBe(42)
  })
})

describe('formatReportCountsSection', () => {
  const nameOf = (id: string) => ({ claude: 'Claude API', openai: 'OpenAI API', gemini: 'Gemini API' }[id] ?? id)

  it('returns empty string when there are no reports', () => {
    expect(formatReportCountsSection({}, nameOf)).toBe('')
    expect(formatReportCountsSection({ claude: 0 }, nameOf)).toBe('')
  })

  it('lists services busiest-first with a total, using display names', () => {
    const out = formatReportCountsSection({ claude: 5, openai: 12, gemini: 2 }, nameOf)
    expect(out).toContain('User Reports (today)')
    expect(out).toContain('19 total')
    expect(out).toContain('OpenAI API 12 · Claude API 5 · Gemini API 2')
    // No public "N reporting" verdict phrasing.
    expect(out).not.toMatch(/reporting/i)
  })

  it('caps the listed services at topN but still totals everything', () => {
    const counts = { a: 9, b: 8, c: 7, d: 6, e: 5, f: 4, g: 3, h: 2, i: 1 }
    const out = formatReportCountsSection(counts, (id) => id, 3)
    expect(out).toContain('45 total')           // sum of all 9
    expect(out).toContain('a 9 · b 8 · c 7')    // only top 3 listed
    expect(out).not.toContain('d 6')
  })
})


describe('isValidCategory', () => {
  it('accepts the allowlisted ids', () => {
    for (const c of ['outage', 'degraded', 'errors', 'login', 'other']) expect(isValidCategory(c)).toBe(true)
  })
  it('rejects anything else', () => {
    expect(isValidCategory('Outage')).toBe(false) // case-sensitive id, not label
    expect(isValidCategory('')).toBe(false)
    expect(isValidCategory(undefined)).toBe(false)
    expect(isValidCategory(3)).toBe(false)
  })
})

describe('sanitizeReportDescription', () => {
  it('strips angle brackets (markup) and collapses whitespace', () => {
    expect(sanitizeReportDescription('  500   <b>errors</b> in   EU  ')).toBe('500 berrors/b in EU')
  })
  it('removes control chars (replaced with space, then collapsed)', () => {
    expect(sanitizeReportDescription('a\tb\x07c')).toBe('a b c')
  })
  it('caps at REPORT_DESC_MAX chars', () => {
    const long = 'x'.repeat(200)
    expect(sanitizeReportDescription(long).length).toBe(REPORT_DESC_MAX)
  })
  it('returns empty string for non-strings / empties (description is optional)', () => {
    expect(sanitizeReportDescription(undefined)).toBe('')
    expect(sanitizeReportDescription(42)).toBe('')
    expect(sanitizeReportDescription('   ')).toBe('')
  })
})

describe('report feed', () => {
  it('reportFeedKey is namespaced', () => {
    expect(reportFeedKey('claude')).toBe('report:feed:claude')
  })

  it('appendReportFeed prepends newest-first and caps the list', () => {
    let feed: ReportFeedEntry[] = []
    for (let i = 0; i < REPORT_FEED_MAX + 5; i++) {
      feed = appendReportFeed(feed, { cat: 'outage', desc: `r${i}`, ts: i })
    }
    expect(feed.length).toBe(REPORT_FEED_MAX)
    expect(feed[0].desc).toBe(`r${REPORT_FEED_MAX + 4}`) // most recent first
  })

  it('recentReportFeed drops entries older than the 24h window and any malformed ones', () => {
    const now = Date.parse('2026-06-21T12:00:00Z')
    const entries = [
      { cat: 'outage' as const, desc: 'fresh', ts: now - 60_000 },
      { cat: 'errors' as const, desc: 'old', ts: now - 25 * 3_600_000 },
      { cat: 'bogus', desc: 'bad cat', ts: now } as unknown as ReportFeedEntry,
      { desc: 'no ts', cat: 'outage' } as unknown as ReportFeedEntry,
    ]
    const recent = recentReportFeed(entries, now)
    expect(recent.map((e) => e.desc)).toEqual(['fresh'])
  })
})


describe('shouldSurfaceReports (#575 Phase B gate)', () => {
  it('never surfaces with zero reports', () => {
    expect(shouldSurfaceReports({ status: 'down', reportCount: 0 })).toBe(false)
    expect(shouldSurfaceReports({ status: 'operational', probeSpike: true, reportCount: 0 })).toBe(false)
  })
  it('official problem (degraded/down) surfaces any reports', () => {
    expect(shouldSurfaceReports({ status: 'degraded', reportCount: 1 })).toBe(true)
    expect(shouldSurfaceReports({ status: 'down', reportCount: 1 })).toBe(true)
  })
  it('operational + partialCount surfaces any reports', () => {
    expect(shouldSurfaceReports({ status: 'operational', partialCount: 2, reportCount: 1 })).toBe(true)
  })
  it('operational + probe spike requires the baseline crowd volume', () => {
    expect(shouldSurfaceReports({ status: 'operational', probeSpike: true, reportCount: REPORT_DISPLAY_MIN - 1 })).toBe(false)
    expect(shouldSurfaceReports({ status: 'operational', probeSpike: true, reportCount: REPORT_DISPLAY_MIN })).toBe(true)
  })
  it('operational, clean probe, reports present → NEVER surfaces (crowd-alone, load-bearing)', () => {
    expect(shouldSurfaceReports({ status: 'operational', reportCount: 99 })).toBe(false)
    expect(shouldSurfaceReports({ status: 'operational', probeSpike: false, reportCount: 99 })).toBe(false)
  })
})

describe('reportWindowFloor (#772) — anchor surfaced reports to the current incident', () => {
  const NOW = Date.parse('2026-06-24T12:00:00.000Z')
  const H = 3_600_000
  const active = (startedAt: string | null) => ({ status: 'investigating', startedAt })
  const resolved = (startedAt: string | null) => ({ status: 'resolved', startedAt })

  it('active incident → floor = earliest startedAt − 2h buffer', () => {
    const start = NOW - 1 * H // incident started 1h ago
    const floor = reportWindowFloor({ incidents: [active(new Date(start).toISOString())] }, NOW)
    expect(floor).toBe(start - REPORT_PRE_INCIDENT_BUFFER_MS)
  })

  it('keeps an EARLY reporter (before the official start, within the buffer) but excludes a prior-incident report', () => {
    const start = NOW - 1 * H
    const floor = reportWindowFloor({ incidents: [active(new Date(start).toISOString())] }, NOW)
    const early = start - 30 * 60_000   // reported 30m BEFORE the official start
    const prior = NOW - 23 * H          // a report from ~yesterday's incident
    expect(early >= floor).toBe(true)   // early reporter surfaces
    expect(prior >= floor).toBe(false)  // 23h-old prior report does NOT
  })

  it('uses the EARLIEST start across multiple active incidents', () => {
    const s1 = NOW - 1 * H, s2 = NOW - 4 * H
    const floor = reportWindowFloor({ incidents: [active(new Date(s1).toISOString()), active(new Date(s2).toISOString())] }, NOW)
    expect(floor).toBe(s2 - REPORT_PRE_INCIDENT_BUFFER_MS)
  })

  it('ignores resolved incidents (only active anchor the window)', () => {
    const floor = reportWindowFloor({ incidents: [resolved(new Date(NOW - 1 * H).toISOString())] }, NOW)
    expect(floor).toBe(NOW - REPORT_SPIKE_FALLBACK_MS) // no ACTIVE incident → fallback
  })

  it('no dated active incident (probeSpike/partial only) → now − 3h fallback', () => {
    expect(reportWindowFloor({ incidents: [] }, NOW)).toBe(NOW - REPORT_SPIKE_FALLBACK_MS)
    expect(reportWindowFloor({}, NOW)).toBe(NOW - REPORT_SPIKE_FALLBACK_MS)
  })

  it('active incident with missing/invalid startedAt → fallback (not Infinity/NaN)', () => {
    expect(reportWindowFloor({ incidents: [active(null)] }, NOW)).toBe(NOW - REPORT_SPIKE_FALLBACK_MS)
    expect(reportWindowFloor({ incidents: [active('not-a-date')] }, NOW)).toBe(NOW - REPORT_SPIKE_FALLBACK_MS)
  })

  it('a RESOLVED incident with an earlier start does NOT pull the floor back (only active anchor)', () => {
    const resolvedEarly = resolved(new Date(NOW - 10 * H).toISOString()) // older, but resolved
    const activeRecent = active(new Date(NOW - 1 * H).toISOString())
    const floor = reportWindowFloor({ incidents: [resolvedEarly, activeRecent] }, NOW)
    expect(floor).toBe((NOW - 1 * H) - REPORT_PRE_INCIDENT_BUFFER_MS) // anchored to the ACTIVE start only
  })

  // Integration: mirror buildReportFeedMap's core (recentReportFeed → floor filter → gate) so the
  // user-visible #772 regression can't reappear via a wiring change without a test failing.
  it('end-to-end filter: stale-only feed does NOT surface; mixed feed surfaces only the in-window report', () => {
    const incidentStart = NOW - 1 * H
    const svc = { incidents: [active(new Date(incidentStart).toISOString())] }
    const floor = reportWindowFloor(svc, NOW)
    const stale = { cat: 'errors' as const, desc: 'prior incident', ts: NOW - 23 * H }
    const fresh = { cat: 'outage' as const, desc: 'current incident', ts: incidentStart - 30 * 60_000 } // early reporter
    const surface = (feed: ReportFeedEntry[]) => recentReportFeed(feed, NOW).filter((e) => e.ts >= floor)

    const staleOnly = surface([stale])
    expect(staleOnly).toHaveLength(0)
    expect(shouldSurfaceReports({ status: 'down', reportCount: staleOnly.length })).toBe(false) // not surfaced

    const mixed = surface([stale, fresh])
    expect(mixed.map((e) => e.desc)).toEqual(['current incident']) // only the in-window one
    expect(shouldSurfaceReports({ status: 'down', reportCount: mixed.length })).toBe(true)
  })
})
