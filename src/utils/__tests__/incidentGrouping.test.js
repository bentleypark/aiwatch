import { describe, it, expect } from 'vitest'
import { groupIncidents, GROUP_THRESHOLD, normalizeTitle, isGenericTitle, isFlapTitle, isAutoMonitorTitle, GENERIC_TITLE_PATTERNS_SOURCES } from '../incidentGrouping'
import { compareIncidents, compareGroupedRows, getContextualTime } from '../incidentSort'
import { formatDate } from '../time'

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

describe('groupIncidents — BetterStack minor flap markers (#597)', () => {
  const UTC = { timeZone: 'UTC' }

  it('groups same-day minor "<model> — recovered" flap series (Together/Gemma case)', () => {
    // BetterStack tags auto-recovery model blips impact:'minor' (not null), so before
    // #597 they escaped the impact != null guard and swamped the history individually.
    const incs = Array.from({ length: 7 }, (_, i) => makeIncident({
      id: `gemma-${i}`,
      title: 'Google Gemma 4 31B IT — recovered',
      startedAt: `2026-06-08T${String(5 + i * 2).padStart(2, '0')}:00:00Z`,
      impact: 'minor',
    }))
    const result = groupIncidents(incs, UTC)
    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe('group')
    expect(result[0].count).toBe(7)
    expect(result[0].normalizedTitle).toBe('Google Gemma 4 31B IT')
  })

  it('does NOT group major/critical "— recovered" — only minor flaps cluster', () => {
    // A severity-tagged incident that happens to carry the suffix is a real event,
    // not BetterStack flap noise. Stays individually visible even at 3+ same-day.
    const incs = Array.from({ length: 3 }, (_, i) => makeIncident({
      id: `maj-${i}`,
      title: 'Model serving — recovered',
      startedAt: `2026-06-08T1${i}:00:00Z`,
      impact: 'major',
    }))
    const result = groupIncidents(incs, UTC)
    expect(result.every(r => r.kind === 'single')).toBe(true)
    expect(result).toHaveLength(3)
  })

  it('buckets a "— down" + "— recovered" minor flap cycle into one group', () => {
    // normalizeTitle strips both halves, so a down/recovered pair for the same model
    // on the same day collapses to a single grouped event.
    const incs = [
      makeIncident({ id: 'd1', title: 'Pearl-ai Gemma 4 31B IT — down', startedAt: '2026-06-08T05:00:00Z', impact: 'minor' }),
      makeIncident({ id: 'r1', title: 'Pearl-ai Gemma 4 31B IT — recovered', startedAt: '2026-06-08T05:25:00Z', impact: 'minor' }),
    ]
    const result = groupIncidents(incs, UTC)
    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe('group')
    expect(result[0].count).toBe(2)
    expect(result[0].normalizedTitle).toBe('Pearl-ai Gemma 4 31B IT')
  })

  it('a lone minor flap stays a single row (below threshold — no false-positive)', () => {
    const result = groupIncidents([
      makeIncident({ id: 'solo', title: 'Some Model — recovered', startedAt: '2026-06-08T05:00:00Z', impact: 'minor' }),
    ], UTC)
    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe('single')
  })
})

describe('isFlapTitle (#597)', () => {
  it('matches BetterStack "— recovered" / "— down" suffixes (case-insensitive)', () => {
    expect(isFlapTitle('Google Gemma 4 31B IT — recovered')).toBe(true)
    expect(isFlapTitle('Foo — down')).toBe(true)
    expect(isFlapTitle('Bar — RECOVERED')).toBe(true)
  })
  it('does not match plain or mid-string occurrences', () => {
    expect(isFlapTitle('Elevated API errors')).toBe(false)
    expect(isFlapTitle('Service recovered after a brief outage')).toBe(false)
    expect(isFlapTitle('')).toBe(false)
  })
})

describe('normalizeTitle — "— down" suffix (#597)', () => {
  it('strips trailing " — down"', () => {
    expect(normalizeTitle('Google Gemma 4 31B IT — down')).toBe('Google Gemma 4 31B IT')
  })
})

describe('groupIncidents — Instatus "<Component> Degraded" auto-monitor noise (#599)', () => {
  const UTC = { timeZone: 'UTC' }

  it('groups same-day minor "Conversations API Degraded" series (Mistral case)', () => {
    // Instatus maps DEGRADEDPERFORMANCE → minor (not null), so before #599 these
    // auto-monitor blips escaped the impact != null guard and listed individually.
    const incs = Array.from({ length: 4 }, (_, i) => makeIncident({
      id: `conv-${i}`,
      title: 'Conversations API Degraded',
      startedAt: `2026-06-10T${String(2 + i * 3).padStart(2, '0')}:00:00Z`,
      impact: 'minor',
    }))
    const result = groupIncidents(incs, UTC)
    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe('group')
    expect(result[0].count).toBe(4)
  })

  it('keeps per-model "Completion API Degraded - <model>" variants in separate groups', () => {
    const incs = [
      ...Array.from({ length: 2 }, (_, i) => makeIncident({ id: `a-${i}`, title: 'Completion API Degraded - mistral-tiny-2407', startedAt: `2026-06-10T0${i}:00:00Z`, impact: 'minor' })),
      ...Array.from({ length: 2 }, (_, i) => makeIncident({ id: `b-${i}`, title: 'Completion API Degraded - mistral-tiny-latest', startedAt: `2026-06-10T1${i}:00:00Z`, impact: 'minor' })),
    ]
    const result = groupIncidents(incs, UTC)
    const groups = result.filter(r => r.kind === 'group')
    expect(groups).toHaveLength(2)
    expect(groups.every(g => g.count === 2)).toBe(true)
  })

  it('does NOT group major "X Degraded" — only minor auto-monitor noise clusters', () => {
    const incs = Array.from({ length: 3 }, (_, i) => makeIncident({
      id: `maj-${i}`, title: 'Conversations API Degraded', startedAt: `2026-06-10T0${i}:00:00Z`, impact: 'major',
    }))
    const result = groupIncidents(incs, UTC)
    expect(result.every(r => r.kind === 'single')).toBe(true)
    expect(result).toHaveLength(3)
  })

  it('a lone minor "X Degraded" stays a single row (below threshold)', () => {
    const result = groupIncidents([
      makeIncident({ id: 'solo', title: 'OCR API Degraded', startedAt: '2026-06-10T05:00:00Z', impact: 'minor' }),
    ], UTC)
    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe('single')
  })
})

describe('isAutoMonitorTitle (#599)', () => {
  it('matches Instatus "<X> Degraded" / "Degraded Performance" + tails', () => {
    expect(isAutoMonitorTitle('Conversations API Degraded')).toBe(true)
    expect(isAutoMonitorTitle('OCR API Degraded Performance')).toBe(true)
    expect(isAutoMonitorTitle('Completion API Degraded - mistral-tiny-2407')).toBe(true)
    expect(isAutoMonitorTitle('Conversations API Degraded · Chat Completions API')).toBe(true)
  })
  it('does not match prose, "Down", or plain titles (false-positive guard)', () => {
    expect(isAutoMonitorTitle('API degraded due to an upstream provider')).toBe(false)
    expect(isAutoMonitorTitle('Conversations API Down')).toBe(false) // "Down" deliberately excluded
    expect(isAutoMonitorTitle('Elevated error rates')).toBe(false)
    expect(isAutoMonitorTitle('')).toBe(false)
    // The "- <model>" tail requires a space after the separator; a no-space tail is fail-safe
    // (left un-grouped rather than risk a false group). Pinned so a future regex tweak is deliberate.
    expect(isAutoMonitorTitle('Completion API Degraded -mistral')).toBe(false)
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
  // `api/_is-down/incident-grouping.ts` — each test suite pins this same
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

describe('worker-tagged autoMonitor incidents (#983)', () => {
  // The real 2026-07-09 Twelve Labs burst: one auto-monitor title, four incidents, 6–16m each.
  // Three carry `impact: 'major'` — not a human severity call, just one sub-component reading
  // `major_outage`. Before #983 they were `ungroupable` (prose title, non-null impact) and rendered
  // as four rows. Pinned to America/Los_Angeles so the day-bucket is deterministic in CI.
  const TZ = { timeZone: 'America/Los_Angeles' }
  const burst = [
    { id: 'kqk7gdf0h84l', title: 'Some API features are experiencing issues', status: 'resolved', impact: 'minor', startedAt: '2026-07-09T08:24:41.241-07:00', resolvedAt: '2026-07-09T08:29:42.993-07:00', duration: '6m', timeline: [], autoMonitor: true },
    { id: 'qyc0cyhlqctg', title: 'Some API features are experiencing issues', status: 'resolved', impact: 'major', startedAt: '2026-07-09T11:13:26.312-07:00', resolvedAt: '2026-07-09T11:27:20.411-07:00', duration: '14m', timeline: [], autoMonitor: true },
    { id: 'qkkqnhkfs69j', title: 'Some API features are experiencing issues', status: 'resolved', impact: 'major', startedAt: '2026-07-09T14:07:01.069-07:00', resolvedAt: '2026-07-09T14:22:55.005-07:00', duration: '16m', timeline: [], autoMonitor: true },
    { id: '7wk40blkybtq', title: 'Some API features are experiencing issues', status: 'resolved', impact: 'major', startedAt: '2026-07-09T15:04:18.959-07:00', resolvedAt: '2026-07-09T15:15:19.428-07:00', duration: '11m', timeline: [], autoMonitor: true },
  ]

  it('folds the whole burst into a single ×4 group row', () => {
    const rows = groupIncidents(burst, TZ)
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('group')
    expect(rows[0].count).toBe(4)
    expect(rows[0].normalizedTitle).toBe('Some API features are experiencing issues')
    expect(rows[0].dayKey).toBe('2026-07-09')
    expect(rows[0].rangeStart).toBe('2026-07-09T08:24:41.241-07:00')
    expect(rows[0].rangeEnd).toBe('2026-07-09T15:04:18.959-07:00')
  })

  it('groups across mixed impact levels — the tag out-ranks impact entirely', () => {
    const rows = groupIncidents(burst, TZ)
    expect(rows[0].entries.map((e) => e.impact).sort()).toEqual(['major', 'major', 'major', 'minor'])
  })

  it('without the tag the same four incidents stay four rows (the pre-#983 behavior this fixes)', () => {
    const untagged = burst.map(({ autoMonitor, ...rest }) => rest)
    const rows = groupIncidents(untagged, TZ)
    expect(rows).toHaveLength(4)
    expect(rows.every((r) => r.kind === 'single')).toBe(true)
  })

  it('a tagged incident still needs a same-day twin — a lone one renders as a single row', () => {
    const rows = groupIncidents([burst[0]], TZ)
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('single')
  })

  it('does not swallow the provider real incidents sharing the day', () => {
    const real = { id: 'real-1', title: 'Search API failure', status: 'resolved', impact: 'major', startedAt: '2026-07-09T12:00:00.000-07:00', resolvedAt: '2026-07-09T12:40:00.000-07:00', duration: '40m', timeline: [] }
    const rows = groupIncidents([...burst, real], TZ)
    expect(rows).toHaveLength(2)
    expect(rows.filter((r) => r.kind === 'group')).toHaveLength(1)
    const single = rows.find((r) => r.kind === 'single')
    expect(single.incident.id).toBe('real-1')
  })

  it('a tagged `critical` incident still GROUPS — grouping is display-only, unlike the alert path', () => {
    // Deliberate asymmetry, pinned so it reads as intent: alerts never hold/suppress a `critical`
    // (isShortIncidentHoldable / isFlapNotice bail on it first), but the incident history has no
    // reason to keep four identical rows just because the auto-monitor escalated one of them.
    const withCritical = [burst[0], { ...burst[1], impact: 'critical' }]
    const rows = groupIncidents(withCritical, TZ)
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('group')
    expect(rows[0].count).toBe(2)
  })

  it('archive-supplemented incidents (written before the tag shipped) stay individual — known gap', () => {
    // The monthly accumulator is additive and does not self-heal (#934/#975), so rows backfilled from
    // an archive carry no `autoMonitor`. Pinned so a future reader sees this is known, not a bug.
    const archived = burst.map(({ autoMonitor, ...rest }) => rest)
    const rows = groupIncidents([...archived], TZ)
    expect(rows).toHaveLength(4)
    expect(rows.every((r) => r.kind === 'single')).toBe(true)
  })

  it('splits the burst across local-day boundaries like any other group', () => {
    const rows = groupIncidents(burst, { timeZone: 'Asia/Seoul' })
    // 08:24 PDT is 2026-07-10 00:24 KST; the other three are also 07-10 KST → still one group.
    expect(rows).toHaveLength(1)
    expect(rows[0].dayKey).toBe('2026-07-10')
  })
})

describe('#1292 — status_history-derived incidents and flap grouping', () => {
  // These carry the same `"<resource> — recovered"` suffix the BetterStack flap grouping keys on, so
  // the two features meet. An earlier version of this block built its fixtures without the tag and so
  // passed for unrelated reasons — different days, different titles — while the guard it named could
  // be deleted with the suite still green. Every fixture here carries the tag.
  const day = (d, name) => ({
    ...makeIncident({
      id: `bs-hist:8603734:${d}:${name}`, title: `${name} — recovered`,
      startedAt: `${d}T09:00:00.000Z`, impact: 'minor', duration: '17h 18m',
    }),
    derived: 'status_history',
    derivedDay: d,
  })

  it('does not group even when several land on ONE (resource, day)', () => {
    // The case that actually exercises the guard: same resource, same viewer-day, identical title,
    // past GROUP_THRESHOLD. Without the guard these collapse into a single "×N" flap row whose range
    // is rendered from two anchors — neither of which is a time the provider published.
    const rows = groupIncidents(Array.from({ length: GROUP_THRESHOLD + 1 }, (_, i) => ({
      ...day('2026-08-15', 'eu.api.helicone.ai'), id: `dup-${i}`,
    })))
    expect(rows).toHaveLength(GROUP_THRESHOLD + 1)
    expect(rows.every((r) => r.count === undefined || r.count === 1)).toBe(true)
  })

  it('CONTROL — the identical set UNTAGGED does group, so the guard is what stops it', () => {
    const rows = groupIncidents(Array.from({ length: GROUP_THRESHOLD + 1 }, (_, i) => {
      const { derived: _d, derivedDay: _dd, ...untagged } = day('2026-08-15', 'eu.api.helicone.ai')
      return { ...untagged, id: `dup-${i}` }
    }))
    expect(rows).toHaveLength(1)
    expect(rows[0].count).toBe(GROUP_THRESHOLD + 1)
  })

  it('does not absorb a REAL flap into a group either', () => {
    // Mixed set: the derived rows must not act as group members for a genuine feed item.
    const real = makeIncident({
      id: 'rss-1', title: 'eu.api.helicone.ai — recovered',
      startedAt: '2026-08-15T09:00:00.000Z', impact: 'minor', duration: '5m',
    })
    const rows = groupIncidents([
      { ...day('2026-08-15', 'eu.api.helicone.ai'), id: 'd1' },
      { ...day('2026-08-15', 'eu.api.helicone.ai'), id: 'd2' },
      real,
    ])
    expect(rows).toHaveLength(3)
  })

  it('a multi-day outage renders one row per day', () => {
    const rows = groupIncidents([
      day('2026-08-14', 'eu.api.helicone.ai'),
      day('2026-08-15', 'eu.api.helicone.ai'),
      day('2026-08-16', 'eu.api.helicone.ai'),
    ])
    expect(rows).toHaveLength(3)
  })
})

describe('#1292 — the DAY is published exactly, in every viewer zone', () => {
  // The day is the only fact this synthesis knows exactly, and the copy says so
  // ("날짜와 그날의 중단 시간은 확인되지만"). It cannot be recovered from the anchor: an instant means
  // different days in different zones. Both anchors were tried and both published a wrong date —
  // local midnight breaks every UTC-slicing consumer east of the page, local noon breaks a viewer more
  // than 12h from it — so the day now travels as its own field and the renderers read THAT.
  const DAY = '2026-07-24'
  const derived = {
    id: 'bs-hist:1:2026-07-24', title: 'api — recovered', status: 'resolved', impact: 'minor',
    // Pacific page: noon anchor = 19:00Z, and a >12h bucket resolves on the NEXT UTC day.
    startedAt: '2026-07-24T19:00:00.000Z', resolvedAt: '2026-07-25T11:18:00.000Z',
    duration: '16h 18m', timeline: [], derived: 'status_history', derivedDay: DAY,
  }
  const t = (k) => k

  it('getContextualTime carries the day alongside the resolved instant', () => {
    const ctx = getContextualTime(derived, t)
    // It returns `resolvedAt` for a resolved incident — which is 07-25. The day must not follow it.
    expect(ctx.date.slice(0, 10)).toBe('2026-07-25')
    expect(ctx.dayOnly).toBe(true)
    expect(ctx.day).toBe(DAY)
  })

  it('renders 24 July, not 25, from that context', () => {
    const ctx = getContextualTime(derived, t)
    expect(formatDate(ctx.date, 'en', { dayOnly: ctx.dayOnly, day: ctx.day })).toContain('24')
    expect(formatDate(ctx.date, 'en', { dayOnly: ctx.dayOnly, day: ctx.day })).not.toContain('25')
  })

  it('renders the same day in ko and en — the viewer zone must not move it', () => {
    const ctx = getContextualTime(derived, t)
    for (const lang of ['en', 'ko']) {
      expect(formatDate(ctx.date, lang, { dayOnly: ctx.dayOnly, day: ctx.day }),
        `${lang} must print the page's own day`).toMatch(/24/)
    }
  })

  it('CONTROL — a provider-published incident is unaffected and keeps its instant', () => {
    const published = { ...derived, derived: undefined, derivedDay: undefined }
    const ctx = getContextualTime(published, t)
    expect(ctx.dayOnly).toBe(false)
    expect(formatDate(ctx.date, 'en', { dayOnly: ctx.dayOnly, day: ctx.day })).toMatch(/\d{2}:\d{2}/)
  })
})

describe('#1292 — formatDate never throws on a malformed carried day', () => {
  // `Intl.format()` throws a RangeError on an invalid Date. In React that is an unhandled render
  // throw — the whole dashboard blanks — and `derivedDay` is a raw string forwarded through KV and
  // the archive, unlike `startedAt`, which was always a round-tripped toISOString().
  it.each(['not-a-day', '2026-13-45', ''])('returns empty for day=%o rather than throwing', (day) => {
    expect(() => formatDate('2026-07-24T12:00:00.000Z', 'en', { dayOnly: true, day })).not.toThrow()
  })

  it('still renders a valid carried day', () => {
    expect(formatDate('2026-07-23T23:00:00.000Z', 'en', { dayOnly: true, day: '2026-07-24' }))
      .toContain('24')
  })
})
