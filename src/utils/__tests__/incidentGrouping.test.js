import { describe, it, expect } from 'vitest'
import { groupIncidents, GROUP_THRESHOLD, normalizeTitle, isGenericTitle, GENERIC_TITLE_PATTERNS_SOURCES } from '../incidentGrouping'
import { compareIncidents, compareGroupedRows } from '../incidentSort'

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
    // Newest first by `getLatestActivity` (#411). For these fixtures resolvedAt is unset, so
    // getLatestActivity falls through to startedAt for singles and max(startedAt) for groups —
    // i.e. the comparison happens to match rangeEnd here, but the sort axis is no longer
    // rangeEnd-specific. See the dedicated #411 describe block below for the discriminating tests.
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

describe('groupIncidents — sort axis alignment with getLatestActivity (#411)', () => {
  // Regression: pre-#411 `groupIncidents` sorted singles by `inc.startedAt` and
  // groups by `max(startedAt)` while Overview's `compareIncidents`/`getLatestActivity`
  // sorted resolved incidents by `resolvedAt`. The Modal/Together pair on
  // 2026-05-11 was the canary — both pages showed the pair in opposite order.
  // Post-#411 the axes match: the page that gets `groupIncidents` output sorts
  // the same way Overview does.
  const UTC = { timeZone: 'UTC' }

  it('two resolved singles: sorts by resolvedAt desc, not startedAt desc', () => {
    // Modal:        startedAt 08:59, resolvedAt 09:00 (later startedAt, earlier resolvedAt)
    // Together AI:  startedAt 08:57, resolvedAt 09:10 (earlier startedAt, later resolvedAt)
    // Pre-fix: Modal first (startedAt-desc). Post-fix: Together first (resolvedAt-desc).
    const modal = { id: 'modal-1', title: 'Storage refactor following AWS us-east-1c issues', startedAt: '2026-05-11T08:59:00Z', resolvedAt: '2026-05-11T09:00:00Z', status: 'resolved', impact: 'minor', duration: '1m', timeline: [] }
    const together = { id: 'together-1', title: 'Kimi K2.6 — recovered', startedAt: '2026-05-11T08:57:00Z', resolvedAt: '2026-05-11T09:10:00Z', status: 'resolved', impact: null, duration: '13m', timeline: [] }
    const result = groupIncidents([modal, together], UTC)
    expect(result).toHaveLength(2)
    expect(result[0].kind).toBe('single')
    expect(result[1].kind).toBe('single')
    expect(result[0].incident.id).toBe('together-1') // resolved 09:10 > 09:00
    expect(result[1].incident.id).toBe('modal-1')
  })

  it('active incident with later startedAt does not get pushed below a resolved one with earlier startedAt but later resolvedAt', () => {
    // Active uses startedAt as latest activity (no timeline). Resolved uses resolvedAt.
    // Active started 09:05 → sortKey 09:05. Resolved 08:57 → 09:10 → sortKey 09:10 → resolved first.
    // This is correct: resolved's resolution is the more recent activity than the active's start.
    // Pre-fix would have ranked by startedAt only: active(09:05) > resolved(08:57) → active first.
    const active = { id: 'active-1', title: 'Service A outage', startedAt: '2026-05-11T09:05:00Z', status: 'investigating', impact: 'major', timeline: [] }
    const resolved = { id: 'resolved-1', title: 'Service B blip — recovered', startedAt: '2026-05-11T08:57:00Z', resolvedAt: '2026-05-11T09:10:00Z', status: 'resolved', impact: null, duration: '13m', timeline: [] }
    const result = groupIncidents([active, resolved], UTC)
    expect(result[0].incident.id).toBe('resolved-1') // 09:10 resolved
    expect(result[1].incident.id).toBe('active-1')   // 09:05 active
    // Tier-aware reorder happens *after* groupIncidents via compareGroupedRows
    // in callers — `groupIncidents` alone now reports newest-activity-first
    // regardless of status. Callers that need the active-on-top behavior
    // already pipe through compareGroupedRows (verified at the existing call
    // sites in Incidents.jsx and ServiceDetails.jsx).
  })

  it('two groups: ranks by max(getLatestActivity) across entries, not max(startedAt)', () => {
    // Asymmetric fixture so the test discriminates max-getLatestActivity from max-startedAt
    // (would-be pre-fix axis) AND from tiebreak ordering. All entries have resolvedAt ≥ startedAt
    // to stay in the valid-payload space:
    // - Group A entries: max(startedAt) = 09:00, max(resolvedAt) = 09:30  → latestActivity 09:30
    // - Group B entries: max(startedAt) = 09:10, max(resolvedAt) = 09:15  → latestActivity 09:15
    // Pre-fix sort by max(startedAt) would rank B first (09:10 > 09:00). Post-fix sort by
    // max(getLatestActivity) ranks A first (09:30 > 09:15). Different answers ⇒ the test
    // actually exercises the new axis instead of passing via tiebreak.
    const incs = [
      { id: 'a1', title: 'Model X — recovered', startedAt: '2026-05-11T08:00:00Z', resolvedAt: '2026-05-11T09:30:00Z', status: 'resolved', impact: null, duration: '90m', timeline: [] },
      { id: 'a2', title: 'Model X — recovered', startedAt: '2026-05-11T09:00:00Z', resolvedAt: '2026-05-11T09:20:00Z', status: 'resolved', impact: null, duration: '20m', timeline: [] },
      { id: 'b1', title: 'Model Y — recovered', startedAt: '2026-05-11T09:10:00Z', resolvedAt: '2026-05-11T09:15:00Z', status: 'resolved', impact: null, duration: '5m', timeline: [] },
      { id: 'b2', title: 'Model Y — recovered', startedAt: '2026-05-11T09:08:00Z', resolvedAt: '2026-05-11T09:14:00Z', status: 'resolved', impact: null, duration: '6m', timeline: [] },
    ]
    const result = groupIncidents(incs, UTC)
    expect(result).toHaveLength(2)
    expect(result[0].kind).toBe('group')
    expect(result[1].kind).toBe('group')
    expect(result[0].normalizedTitle).toBe('Model X') // Group A peaks at 09:30 → ranks first
    expect(result[1].normalizedTitle).toBe('Model Y') // Group B peaks at 09:15
  })

  it('tiebreak on identical sortKey preserves original input index for determinism', () => {
    const a = { id: 'a', title: 'Service A — recovered', startedAt: '2026-05-11T08:00:00Z', resolvedAt: '2026-05-11T09:00:00Z', status: 'resolved', impact: null, duration: '60m', timeline: [] }
    const b = { id: 'b', title: 'Service B — recovered', startedAt: '2026-05-11T08:30:00Z', resolvedAt: '2026-05-11T09:00:00Z', status: 'resolved', impact: null, duration: '30m', timeline: [] }
    // Both resolved at exactly 09:00. Tiebreak by input index → a first.
    const result = groupIncidents([a, b], UTC)
    expect(result[0].incident.id).toBe('a')
    expect(result[1].incident.id).toBe('b')
  })
})

describe('Overview recentIncidents grouping regression (#496)', () => {
  // Simulates the exact incMap + groupIncidents pipeline used in Overview.jsx.
  // Bug: Overview was calling groupIncidents() nowhere — flap incidents with unique
  // IDs (BetterStack: Together AI, Fireworks AI, Mistral) appeared as separate rows,
  // filling the panel's 5-item limit with duplicates and hiding real incidents.
  const UTC = { timeZone: 'UTC' }

  function buildRecentIncidents(services, { sevenDaysAgo = 0, limit = 5 } = {}) {
    // mirrors Overview.jsx incMap dedup + filter + compareIncidents + groupIncidents + compareGroupedRows
    const incMap = new Map()
    for (const s of services) {
      for (const inc of s.incidents ?? []) {
        const existing = incMap.get(inc.id)
        if (existing) {
          if (!existing.affectedNames.includes(s.name)) existing.affectedNames.push(s.name)
        } else {
          incMap.set(inc.id, { ...inc, serviceName: s.name, affectedNames: [s.name] })
        }
      }
    }
    const flat = [...incMap.values()]
      .filter(inc => inc.status !== 'resolved' || new Date(inc.startedAt).getTime() >= sevenDaysAgo)
      .sort(compareIncidents)
    return groupIncidents(flat, UTC).sort(compareGroupedRows).slice(0, limit)
  }

  it('WITHOUT groupIncidents: 3 flap incidents from Together AI fill 3 of 5 slots', () => {
    // This is the BUG: same title, same day, different IDs appear as separate rows.
    // Simulate the pre-fix behavior (no groupIncidents call).
    const services = [
      { name: 'Together AI', incidents: [
        { id: 'flap-1', title: 'DeepSeek V4 Pro — recovered', status: 'resolved', startedAt: '2026-05-31T02:00:00Z', impact: null, duration: '2m', timeline: [] },
        { id: 'flap-2', title: 'DeepSeek V4 Pro — recovered', status: 'resolved', startedAt: '2026-05-31T04:00:00Z', impact: null, duration: '2m', timeline: [] },
        { id: 'flap-3', title: 'DeepSeek V4 Pro — recovered', status: 'resolved', startedAt: '2026-05-31T06:00:00Z', impact: null, duration: '2m', timeline: [] },
      ]},
      { name: 'Claude API', incidents: [
        { id: 'real-1', title: 'Elevated errors on Claude Opus 4.8', status: 'resolved', startedAt: '2026-05-29T10:00:00Z', impact: 'minor', duration: '45m', timeline: [] },
        { id: 'real-2', title: 'Elevated errors on Claude Opus 4.7', status: 'resolved', startedAt: '2026-05-28T08:00:00Z', impact: 'minor', duration: '30m', timeline: [] },
        { id: 'real-3', title: 'Billing issues', status: 'resolved', startedAt: '2026-05-27T12:00:00Z', impact: 'minor', duration: '60m', timeline: [] },
      ]},
    ]
    const incMap = new Map()
    for (const s of services) {
      for (const inc of s.incidents) {
        if (!incMap.has(inc.id)) incMap.set(inc.id, { ...inc, serviceName: s.name, affectedNames: [s.name] })
      }
    }
    // Pre-fix: no groupIncidents, just sort + slice
    const bugged = [...incMap.values()]
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
      .slice(0, 5)
    // 3 flap + 2 real: "real-3" (oldest real) is pushed out of the top 5
    expect(bugged.map(i => i.id)).toEqual(['flap-3', 'flap-2', 'flap-1', 'real-1', 'real-2'])
    expect(bugged.filter(i => i.title === 'DeepSeek V4 Pro — recovered')).toHaveLength(3)
  })

  it('WITH groupIncidents: 3 flap incidents collapse to 1 group, all 3 real incidents visible', () => {
    const sevenDaysAgo = new Date('2026-05-24T00:00:00Z').getTime()
    const services = [
      { name: 'Together AI', incidents: [
        { id: 'flap-1', title: 'DeepSeek V4 Pro — recovered', status: 'resolved', startedAt: '2026-05-31T02:00:00Z', impact: null, duration: '2m', timeline: [] },
        { id: 'flap-2', title: 'DeepSeek V4 Pro — recovered', status: 'resolved', startedAt: '2026-05-31T04:00:00Z', impact: null, duration: '2m', timeline: [] },
        { id: 'flap-3', title: 'DeepSeek V4 Pro — recovered', status: 'resolved', startedAt: '2026-05-31T06:00:00Z', impact: null, duration: '3m', timeline: [] },
      ]},
      { name: 'Claude API', incidents: [
        { id: 'real-1', title: 'Elevated errors on Claude Opus 4.8', status: 'resolved', startedAt: '2026-05-29T10:00:00Z', impact: 'minor', duration: '45m', timeline: [] },
        { id: 'real-2', title: 'Elevated errors on Claude Opus 4.7', status: 'resolved', startedAt: '2026-05-28T08:00:00Z', impact: 'minor', duration: '30m', timeline: [] },
        { id: 'real-3', title: 'Billing issues', status: 'resolved', startedAt: '2026-05-27T12:00:00Z', impact: 'minor', duration: '60m', timeline: [] },
      ]},
    ]
    const rows = buildRecentIncidents(services, { sevenDaysAgo, limit: 5 })
    // 3 flap → 1 group + 3 real = 4 rows (all fit in 5-item limit)
    expect(rows).toHaveLength(4)
    expect(rows[0].kind).toBe('group')
    expect(rows[0].normalizedTitle).toBe('DeepSeek V4 Pro')
    expect(rows[0].count).toBe(3)
    // All 3 real incidents are now visible
    const realIds = rows.filter(r => r.kind === 'single').map(r => r.incident.id)
    expect(realIds).toContain('real-1')
    expect(realIds).toContain('real-2')
    expect(realIds).toContain('real-3')
    // Group entries retain their duration (most-recent entry = 'flap-3' with '3m')
    // Critical: duration must NOT be null — null causes IncidentItem to show "In Progress"
    // instead of the resolved state indicator (#496 follow-up fix)
    expect(rows[0].entries[0].duration).toBe('3m')
  })

  it('cross-service same-id dedup still works alongside flap grouping', () => {
    // Anthropic shares the same incident ID across Claude API + Claude Code + claude.ai
    const sevenDaysAgo = new Date('2026-05-24T00:00:00Z').getTime()
    const sharedInc = { id: 'shared-1', title: 'Opus 4.8 elevated errors', status: 'resolved', startedAt: '2026-05-29T10:00:00Z', impact: 'minor', duration: '45m', timeline: [] }
    const services = [
      { name: 'Claude API', incidents: [sharedInc] },
      { name: 'claude.ai', incidents: [sharedInc] },
      { name: 'Claude Code', incidents: [sharedInc] },
    ]
    const rows = buildRecentIncidents(services, { sevenDaysAgo })
    // Should be 1 row (deduped by id), with affectedNames from all 3 services
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('single')
    expect(rows[0].incident.affectedNames).toContain('Claude API')
    expect(rows[0].incident.affectedNames).toContain('claude.ai')
    expect(rows[0].incident.affectedNames).toContain('Claude Code')
  })
})
