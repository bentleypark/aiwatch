import { describe, it, expect } from 'vitest'
import { groupIncidents, GROUP_THRESHOLD, normalizeTitle, isGenericTitle, GENERIC_TITLE_PATTERNS_SOURCES } from '../incidentGrouping'

// Minimal Incident factory — fields match worker/src/types.ts shape
function makeIncident({ id, title, startedAt, status = 'resolved', impact = null, duration = '5m' }) {
  return { id, title, startedAt, status, impact, duration, timeline: [] }
}

describe('normalizeTitle', () => {
  it('strips trailing " — recovered"', () => {
    expect(normalizeTitle('Nomic Embed Text v1.5 embeddings API — recovered'))
      .toBe('Nomic Embed Text v1.5 embeddings API')
  })

  it('leaves untouched titles alone', () => {
    expect(normalizeTitle('Major Outage Reported')).toBe('Major Outage Reported')
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeTitle('  Service X — recovered  ')).toBe('Service X')
  })

  it('does not strip "recovered" elsewhere in title', () => {
    expect(normalizeTitle('Service recovered after issue'))
      .toBe('Service recovered after issue')
  })
})

describe('groupIncidents — threshold + impact rules', () => {
  // Tests in this block pin timeZone: 'UTC' so day-key extraction is deterministic regardless
  // of where Vitest runs. KST-specific behavior is exercised in the dedicated TZ block below.
  const UTC = { timeZone: 'UTC' }

  it('groups 14 same-day same-title null-impact entries into one group (Fireworks AI Nomic case)', () => {
    const incs = Array.from({ length: 14 }, (_, i) => makeIncident({
      id: `nomic-${i}`,
      title: 'Nomic Embed Text v1.5 embeddings API — recovered',
      // Spread across 17h on same UTC day (2026-04-16)
      startedAt: `2026-04-16T${String(6 + Math.floor(i * 1.2)).padStart(2, '0')}:00:00Z`,
    }))
    const result = groupIncidents(incs, UTC)
    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe('group')
    expect(result[0].count).toBe(14)
    expect(result[0].normalizedTitle).toBe('Nomic Embed Text v1.5 embeddings API')
    expect(result[0].entries).toHaveLength(14)
  })

  it('does NOT group when count is below threshold (1 entry)', () => {
    const incs = [
      makeIncident({ id: 'a', title: 'X — recovered', startedAt: '2026-04-16T10:00:00Z' }),
    ]
    const result = groupIncidents(incs, UTC)
    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe('single')
  })

  it('groups exactly at threshold (2 entries) — lowered from 3 in #373', () => {
    expect(GROUP_THRESHOLD).toBe(2)
    const incs = Array.from({ length: 2 }, (_, i) => makeIncident({
      id: `x-${i}`,
      title: 'X — recovered',
      startedAt: `2026-04-16T${10 + i}:00:00Z`,
    }))
    const result = groupIncidents(incs, UTC)
    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe('group')
    expect(result[0].count).toBe(2)
  })

  it('never groups entries with non-null impact, even if 3+ match the key', () => {
    const incs = Array.from({ length: 5 }, (_, i) => makeIncident({
      id: `real-${i}`,
      title: 'API Outage — recovered',
      startedAt: `2026-04-16T${10 + i}:00:00Z`,
      impact: 'major',
    }))
    const result = groupIncidents(incs, UTC)
    expect(result).toHaveLength(5)
    expect(result.every(r => r.kind === 'single')).toBe(true)
  })

  it('mixes grouped + individual rows when a service has both flap and real incidents', () => {
    const incs = [
      ...Array.from({ length: 5 }, (_, i) => makeIncident({
        id: `flap-${i}`,
        title: 'Embeddings API — recovered',
        startedAt: `2026-04-16T${10 + i}:00:00Z`,
      })),
      makeIncident({
        id: 'real-1',
        title: 'Major Outage',
        startedAt: '2026-04-16T18:00:00Z',
        impact: 'major',
      }),
    ]
    const result = groupIncidents(incs, UTC)
    expect(result).toHaveLength(2)
    const group = result.find(r => r.kind === 'group')
    const single = result.find(r => r.kind === 'single')
    expect(group.count).toBe(5)
    expect(single.incident.id).toBe('real-1')
  })
})

describe('groupIncidents — local timezone day boundary (KST = UTC+9)', () => {
  // All tests in this block pin timeZone: 'Asia/Seoul' so behavior is deterministic
  // regardless of where Vitest runs (CI vs local). Production callers omit timeZone and
  // get the runtime default (browser TZ in the SPA).
  const KST = { timeZone: 'Asia/Seoul' }

  it('splits a UTC-day-spanning batch when entries fall on different KST dates', () => {
    // The exact case from production: BetterStack flap entries straddling 15:00 UTC
    // (= 00:00 KST). User reads these as different days in the UI even though UTC date matches.
    const incs = [
      makeIncident({ id: 'a', title: 'X — recovered', startedAt: '2026-04-16T14:30:00Z' }), // KST 04-16 23:30
      makeIncident({ id: 'b', title: 'X — recovered', startedAt: '2026-04-16T14:55:00Z' }), // KST 04-16 23:55
      makeIncident({ id: 'c', title: 'X — recovered', startedAt: '2026-04-16T16:30:00Z' }), // KST 04-17 01:30
      makeIncident({ id: 'd', title: 'X — recovered', startedAt: '2026-04-16T17:30:00Z' }), // KST 04-17 02:30
      makeIncident({ id: 'e', title: 'X — recovered', startedAt: '2026-04-16T20:00:00Z' }), // KST 04-17 05:00
    ]
    const result = groupIncidents(incs, KST)
    // Two KST dates: 04-16 (2 entries → group) + 04-17 (3 entries → group). After #373 the
    // ≥2 threshold makes both date buckets cluster, so no entries fall through as singles.
    expect(result.filter(r => r.kind === 'group')).toHaveLength(2)
    const apr16 = result.find(r => r.kind === 'group' && r.dayKey === '2026-04-16')
    const apr17 = result.find(r => r.kind === 'group' && r.dayKey === '2026-04-17')
    expect(apr16?.count).toBe(2)
    expect(apr17?.count).toBe(3)
    expect(result.filter(r => r.kind === 'single')).toHaveLength(0)
  })

  it('groups entries spanning UTC midnight that share the same KST date', () => {
    // 23:00 UTC and 02:00 next-UTC-day are both KST 04-17 (08:00 and 11:00 KST).
    const incs = [
      makeIncident({ id: 'a', title: 'X — recovered', startedAt: '2026-04-16T23:00:00Z' }), // KST 04-17 08:00
      makeIncident({ id: 'b', title: 'X — recovered', startedAt: '2026-04-17T01:00:00Z' }), // KST 04-17 10:00
      makeIncident({ id: 'c', title: 'X — recovered', startedAt: '2026-04-17T02:00:00Z' }), // KST 04-17 11:00
    ]
    const result = groupIncidents(incs, KST)
    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe('group')
    expect(result[0].dayKey).toBe('2026-04-17')
    expect(result[0].count).toBe(3)
  })

  it('does not group entries on consecutive KST days even if titles match', () => {
    const incs = [
      ...Array.from({ length: 3 }, (_, i) => makeIncident({
        id: `d1-${i}`,
        title: 'X — recovered',
        // KST 04-17 (UTC 04-16 18:00–20:00 = KST 04-17 03:00–05:00)
        startedAt: `2026-04-16T${18 + i}:00:00Z`,
      })),
      ...Array.from({ length: 3 }, (_, i) => makeIncident({
        id: `d2-${i}`,
        title: 'X — recovered',
        // KST 04-18 (UTC 04-17 18:00–20:00 = KST 04-18 03:00–05:00)
        startedAt: `2026-04-17T${18 + i}:00:00Z`,
      })),
    ]
    const result = groupIncidents(incs, KST)
    expect(result).toHaveLength(2)
    expect(result.every(r => r.kind === 'group')).toBe(true)
    expect(result.map(r => r.dayKey).sort()).toEqual(['2026-04-17', '2026-04-18'])
  })

  it('UTC option produces UTC-date grouping when explicitly requested', () => {
    // Sanity check that the timeZone option is actually wired through.
    const incs = [
      makeIncident({ id: 'a', title: 'X — recovered', startedAt: '2026-04-16T14:30:00Z' }),
      makeIncident({ id: 'b', title: 'X — recovered', startedAt: '2026-04-16T20:00:00Z' }),
      makeIncident({ id: 'c', title: 'X — recovered', startedAt: '2026-04-16T23:00:00Z' }),
    ]
    const result = groupIncidents(incs, { timeZone: 'UTC' })
    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe('group')
    expect(result[0].dayKey).toBe('2026-04-16')
  })
})

describe('groupIncidents — group metadata', () => {
  const UTC = { timeZone: 'UTC' }

  it('preserves status distribution when statuses differ within a group', () => {
    const incs = [
      makeIncident({ id: '1', title: 'X — recovered', startedAt: '2026-04-16T10:00:00Z', status: 'resolved' }),
      makeIncident({ id: '2', title: 'X — recovered', startedAt: '2026-04-16T11:00:00Z', status: 'resolved' }),
      makeIncident({ id: '3', title: 'X — recovered', startedAt: '2026-04-16T12:00:00Z', status: 'monitoring' }),
    ]
    const result = groupIncidents(incs, UTC)
    expect(result[0].kind).toBe('group')
    expect(result[0].statusCounts).toEqual({ resolved: 2, monitoring: 1 })
    expect(result[0].uniformStatus).toBe(false)
  })

  it('marks uniformStatus when all entries share the same status', () => {
    const incs = Array.from({ length: 4 }, (_, i) => makeIncident({
      id: `x-${i}`,
      title: 'X — recovered',
      startedAt: `2026-04-16T${10 + i}:00:00Z`,
      status: 'resolved',
    }))
    const result = groupIncidents(incs, UTC)
    expect(result[0].uniformStatus).toBe(true)
    expect(result[0].statusCounts).toEqual({ resolved: 4 })
  })

  it('exposes time range: earliest startedAt and latest startedAt', () => {
    // Spread within a single UTC hour range so KST also keeps them on one local day
    // regardless of the system TZ that runs this assertion.
    const incs = [
      makeIncident({ id: 'a', title: 'X — recovered', startedAt: '2026-04-16T11:00:00Z' }),
      makeIncident({ id: 'b', title: 'X — recovered', startedAt: '2026-04-16T09:00:00Z' }),
      makeIncident({ id: 'c', title: 'X — recovered', startedAt: '2026-04-16T10:00:00Z' }),
    ]
    const result = groupIncidents(incs, UTC)
    expect(result[0].rangeStart).toBe('2026-04-16T09:00:00Z')
    expect(result[0].rangeEnd).toBe('2026-04-16T11:00:00Z')
  })

  it('preserves entries in original (input) order within the group', () => {
    const incs = [
      makeIncident({ id: 'a', title: 'X — recovered', startedAt: '2026-04-16T11:00:00Z' }),
      makeIncident({ id: 'b', title: 'X — recovered', startedAt: '2026-04-16T09:00:00Z' }),
      makeIncident({ id: 'c', title: 'X — recovered', startedAt: '2026-04-16T10:00:00Z' }),
    ]
    const result = groupIncidents(incs, UTC)
    expect(result[0].entries.map(e => e.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('groupIncidents — ordering of mixed output', () => {
  const UTC = { timeZone: 'UTC' }

  it('places groups and singles in newest-first order by representative startedAt', () => {
    const incs = [
      // Group on 04-16
      ...Array.from({ length: 3 }, (_, i) => makeIncident({
        id: `g1-${i}`,
        title: 'X — recovered',
        startedAt: `2026-04-16T${10 + i}:00:00Z`,
      })),
      // Single on 04-18 (newer)
      makeIncident({ id: 's1', title: 'Real Outage', startedAt: '2026-04-18T08:00:00Z', impact: 'major' }),
      // Single on 04-15 (older)
      makeIncident({ id: 's2', title: 'Real Outage', startedAt: '2026-04-15T08:00:00Z', impact: 'major' }),
    ]
    const result = groupIncidents(incs, UTC)
    // Newest first by representative time (rangeEnd for groups, startedAt for singles)
    const reps = result.map(r => r.kind === 'group' ? r.rangeEnd : r.incident.startedAt)
    const sorted = [...reps].sort().reverse()
    expect(reps).toEqual(sorted)
  })
})

describe('groupIncidents — edge cases', () => {
  const UTC = { timeZone: 'UTC' }

  it('returns empty array for empty input', () => {
    expect(groupIncidents([], UTC)).toEqual([])
  })

  it('returns single rows when all incidents have unique titles', () => {
    const incs = [
      makeIncident({ id: 'a', title: 'A — recovered', startedAt: '2026-04-16T10:00:00Z' }),
      makeIncident({ id: 'b', title: 'B — recovered', startedAt: '2026-04-16T11:00:00Z' }),
      makeIncident({ id: 'c', title: 'C — recovered', startedAt: '2026-04-16T12:00:00Z' }),
    ]
    const result = groupIncidents(incs, UTC)
    expect(result).toHaveLength(3)
    expect(result.every(r => r.kind === 'single')).toBe(true)
  })

  it('treats undefined impact as null (defensive)', () => {
    const incs = Array.from({ length: 3 }, (_, i) => {
      const inc = makeIncident({ id: `x-${i}`, title: 'X — recovered', startedAt: `2026-04-16T${10 + i}:00:00Z` })
      delete inc.impact
      return inc
    })
    const result = groupIncidents(incs, UTC)
    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe('group')
  })
})

describe('isGenericTitle', () => {
  it('matches Statuspage auto-monitoring default', () => {
    expect(isGenericTitle('Investigating an issue')).toBe(true)
    expect(isGenericTitle('investigating an issue')).toBe(true)
    expect(isGenericTitle('Investigating issue')).toBe(true)
  })

  it('matches the other documented placeholder titles', () => {
    expect(isGenericTitle('Service disruption')).toBe(true)
    expect(isGenericTitle('Outage')).toBe(true)
    expect(isGenericTitle('We are currently investigating')).toBe(true)
    expect(isGenericTitle('Scheduled maintenance')).toBe(true)
    expect(isGenericTitle('Partial service degradation')).toBe(true)
  })

  it('does NOT match real human-curated titles', () => {
    expect(isGenericTitle('Elevated error rates affecting ChatGPT for some users in Europe')).toBe(false)
    expect(isGenericTitle('Outage in us-east-1')).toBe(false)
    expect(isGenericTitle('Issue affecting some pages on the ChatGPT website')).toBe(false)
    expect(isGenericTitle('Partial Disruption of ChatGPT Workspace Connector Write Actions')).toBe(false)
  })

  it('does NOT match human-written copy that starts with "We are aware/investigating" (anchor regression)', () => {
    // Pre-fix the pattern was unanchored at the end, so a real curated title
    // beginning with this prose got wrongly classified as generic. Lock the
    // anchored form so a future de-anchor reverts the regex into a foot-gun.
    expect(isGenericTitle('We are aware of an issue with API requests timing out')).toBe(false)
    expect(isGenericTitle('We are investigating elevated 5xx on /v1/messages')).toBe(false)
    expect(isGenericTitle('We are currently investigating reports of degraded inference')).toBe(false)
  })

  it('still matches the bare placeholder + trailing-period variants', () => {
    // Statuspage's auto-emitted titles sometimes carry a trailing period.
    expect(isGenericTitle('Investigating an issue.')).toBe(true)
    expect(isGenericTitle('We are investigating')).toBe(true)
    expect(isGenericTitle('We are aware of an issue')).toBe(true)
    expect(isGenericTitle('We are currently investigating an incident')).toBe(true)
    expect(isGenericTitle('Service Disruption.')).toBe(true)
  })

  it('handles null/undefined defensively', () => {
    expect(isGenericTitle(null)).toBe(false)
    expect(isGenericTitle(undefined)).toBe(false)
    expect(isGenericTitle('')).toBe(false)
  })

  it('trims surrounding whitespace before matching', () => {
    expect(isGenericTitle('  Investigating an issue  ')).toBe(true)
  })
})

describe('GENERIC_TITLE_PATTERNS_SOURCES — cross-file parity (#387)', () => {
  // Canonical snapshot of the regex source strings (pattern + flags). The
  // same array MUST appear in `worker/src/ai-analysis.ts` and
  // `api/is-down/incident-grouping.ts` — each test suite pins this same
  // constant. Drift between files (a pattern added in one place but not
  // others) surfaces as a unit-test failure rather than asymmetric
  // production behavior — e.g. dashboard groups an incident as auto-noise
  // while the worker still runs AI analysis on it.
  const EXPECTED_SOURCES = [
    '^investigating (an |the |this )?issue\\.?$::i',
    '^(service |system )?(disruption|outage|issue|incident)\\.?$::i',
    '^we are (currently )?(investigating|aware)( (of )?(an?|this|the) (issue|incident|problem))?\\.?$::i',
    '^(scheduled |planned )?maintenance\\.?$::i',
    '^(partial |minor |major )?(service )?(degradation|interruption)\\.?$::i',
  ]

  it('SPA pattern sources match the canonical snapshot', () => {
    expect(GENERIC_TITLE_PATTERNS_SOURCES).toEqual(EXPECTED_SOURCES)
  })
})

describe('groupIncidents — generic-title flap clustering despite impact != null (#387)', () => {
  const UTC = { timeZone: 'UTC' }

  it("groups Character.AI's 8 same-day 'Investigating an issue' minor-impact entries", () => {
    // Real-world snapshot from May 6 Character.AI service detail.
    const incs = Array.from({ length: 8 }, (_, i) => makeIncident({
      id: `char-${i}`,
      title: 'Investigating an issue',
      // impact: 'minor' is exactly what Atlassian Statuspage assigns by default
      // for auto-monitoring entries — we still cluster them.
      impact: 'minor',
      startedAt: `2026-05-06T0${i % 10}:00:00Z`,
    }))
    const result = groupIncidents(incs, UTC)
    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe('group')
    expect(result[0].count).toBe(8)
    expect(result[0].normalizedTitle).toBe('Investigating an issue')
  })

  it('does NOT group when title is real human copy, even with same minor impact', () => {
    // Regression guard: human-tagged real incidents must keep individual rows.
    const incs = [
      makeIncident({ id: 'r-1', title: 'Outage in us-east-1', impact: 'major', startedAt: '2026-05-06T01:00:00Z' }),
      makeIncident({ id: 'r-2', title: 'Outage in us-east-1', impact: 'major', startedAt: '2026-05-06T02:00:00Z' }),
    ]
    const result = groupIncidents(incs, UTC)
    expect(result).toHaveLength(2)
    expect(result.every((r) => r.kind === 'single')).toBe(true)
  })

  it('mixed input — real incidents stay single, generic-title flaps cluster', () => {
    const incs = [
      makeIncident({ id: 'real-1', title: 'Elevated error rates in eu-west', impact: 'major', startedAt: '2026-05-06T08:00:00Z' }),
      ...Array.from({ length: 3 }, (_, i) => makeIncident({
        id: `gen-${i}`,
        title: 'Investigating an issue',
        impact: 'minor',
        startedAt: `2026-05-06T${String(9 + i).padStart(2, '0')}:00:00Z`,
      })),
      makeIncident({ id: 'real-2', title: 'Latency spike on Asia ingest', impact: 'minor', startedAt: '2026-05-06T13:00:00Z' }),
    ]
    const result = groupIncidents(incs, UTC)
    const groups = result.filter((r) => r.kind === 'group')
    const singles = result.filter((r) => r.kind === 'single')
    expect(groups).toHaveLength(1)
    expect(groups[0].count).toBe(3)
    expect(singles).toHaveLength(2)
    expect(new Set(singles.map((r) => r.incident.id))).toEqual(new Set(['real-1', 'real-2']))
  })

  it('still groups generic-title incidents with impact == null (no regression on the existing path)', () => {
    const incs = Array.from({ length: 2 }, (_, i) => makeIncident({
      id: `null-${i}`,
      title: 'Investigating an issue',
      // impact omitted → null (default behavior of makeIncident)
      startedAt: `2026-05-06T1${i}:00:00Z`,
    }))
    const result = groupIncidents(incs, UTC)
    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe('group')
    expect(result[0].count).toBe(2)
  })
})
