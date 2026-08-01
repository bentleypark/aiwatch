import { describe, it, expect, vi } from 'vitest'
import { noOfficialUptime, isUnreliableUptime, hasReliableScoreData, hasSufficientCoverage, isProbeWarming, isRecentlyAdded, splitByConfidence, rankTier, buildRanking } from '../serviceReliability'

// #713 — AIWatch no longer invents a uptime % for services without an official figure (the old
// `uptimeSource: 'estimate'` was removed). A no-official-uptime service carries `uptime30d: null` and
// is incident-tracked + scored on its measured components: shown as "No official uptime —
// incident-tracked". A frozen/stale feed is a separate case. Ranking uses `scoreConfidence`:
//   high   = has an official uptime %
//   medium = no uptime, but a real probe (responsiveness) signal  → still rankable
//   low    = NEITHER uptime nor probe (only incidents+recovery)    → over-scores, NOT ranked
describe('serviceReliability predicates (#713)', () => {
  const official = { uptimeSource: 'official', uptime30d: 99.5, scoreConfidence: 'high' }
  const probedNoUptime = { uptime30d: null, scoreConfidence: 'medium' }   // Gemini/xAI-shaped (probe, no uptime)
  const thinNoUptime = { uptime30d: null, scoreConfidence: 'low' }        // Bedrock/Azure-shaped (no uptime, no probe)
  const staleService = { uptime30d: 99.9, scoreConfidence: 'high', incidentSourceStale: true } // frozen feed

  it('noOfficialUptime: true when uptime is null and the feed is NOT stale', () => {
    expect(noOfficialUptime(probedNoUptime)).toBe(true)
    expect(noOfficialUptime(thinNoUptime)).toBe(true)
  })

  it('noOfficialUptime: false for a frozen/stale feed, and for a real official uptime %', () => {
    expect(noOfficialUptime({ uptime30d: null, incidentSourceStale: true })).toBe(false)
    expect(noOfficialUptime(official)).toBe(false)
  })

  it('isUnreliableUptime: true for any null uptime OR a stale feed; false with a real %', () => {
    expect(isUnreliableUptime(probedNoUptime)).toBe(true)   // null uptime → blank the uptime display
    expect(isUnreliableUptime(staleService)).toBe(true)     // stale → frozen, not current
    expect(isUnreliableUptime(official)).toBe(false)
  })

  it('hasReliableScoreData: rankable unless stale, and unless confidence is "low" (no uptime + no probe)', () => {
    expect(hasReliableScoreData(official)).toBe(true)         // official uptime → high → ranked
    expect(hasReliableScoreData(probedNoUptime)).toBe(true)   // #713 — probe signal (medium) → ranked
    expect(hasReliableScoreData(thinNoUptime)).toBe(false)    // no uptime + no probe (low) → NOT ranked
    expect(hasReliableScoreData(staleService)).toBe(false)    // stale feed → NOT ranked
  })

  it('#802 — hasSufficientCoverage: absent coverageDays = established (full); <30d = insufficient', () => {
    expect(hasSufficientCoverage(official)).toBe(true)                          // no coverageDays → established
    expect(hasSufficientCoverage({ ...official, coverageDays: 30 })).toBe(true) // boundary inclusive
    expect(hasSufficientCoverage({ ...official, coverageDays: 31 })).toBe(true)
    expect(hasSufficientCoverage({ ...official, coverageDays: 29 })).toBe(false)
    expect(hasSufficientCoverage({ ...official, coverageDays: 2 })).toBe(false)
  })

  it('#802 — hasReliableScoreData EXCLUDES a recently-added (<30d) service even with high confidence', () => {
    // The exact ranking-distortion case: a new service WITH official uptime (high confidence) must still
    // be held out of the ranking until it accrues a full 30-day window.
    expect(hasReliableScoreData({ ...official, coverageDays: 10 })).toBe(false)
    expect(hasReliableScoreData({ ...official, coverageDays: 30 })).toBe(true) // rejoins at 30d
  })
})

// #870 — a new probe-target service whose probe is still WARMING (<7d → responsivenessStatus
// 'insufficient' → confidence low, score withheld) must show as "Recently Added" (it WILL rank), not
// "Insufficient Data" (genuinely un-measurable). The signal is scoreBreakdown.responsivenessStatus.
describe('isProbeWarming / isRecentlyAdded (#870)', () => {
  // turbopuffer days 1-7: no uptime by design + a probe target still building history.
  const warmingNew = { uptime30d: null, scoreConfidence: 'low', aiwatchScore: null, coverageDays: 1, scoreBreakdown: { responsivenessStatus: 'insufficient' } }
  // Bedrock/Azure: no probe target ever + no uptime.
  const unmeasurable = { uptime30d: null, scoreConfidence: 'low', aiwatchScore: null, coverageDays: null, scoreBreakdown: { responsivenessStatus: 'unsupported' } }
  // A new service that's already scorable (probe available or uptime), just <30d.
  const scorableNew = { uptime30d: 99.9, scoreConfidence: 'high', aiwatchScore: 88, coverageDays: 12, scoreBreakdown: { responsivenessStatus: 'unsupported' } }

  it('isProbeWarming is true only for a probe target with <7d data (insufficient), not unsupported/available', () => {
    expect(isProbeWarming(warmingNew)).toBe(true)
    expect(isProbeWarming(unmeasurable)).toBe(false)          // no probe target
    expect(isProbeWarming({ scoreBreakdown: { responsivenessStatus: 'available' } })).toBe(false)
    // 'unavailable' = a transient global probe-KV read failure (all probed services at once), NOT a
    // per-service warming state — a day-0 new probe target gets 'insufficient', not 'unavailable'. Pin
    // the intent so a future `!== 'available'` refactor of isProbeWarming can't silently regress it.
    expect(isProbeWarming({ scoreBreakdown: { responsivenessStatus: 'unavailable' } })).toBe(false)
    expect(isProbeWarming({})).toBe(false)                    // no breakdown → false, no throw
  })

  it('a warming new probe-target service is Recently Added (not Insufficient Data)', () => {
    expect(isRecentlyAdded(warmingNew)).toBe(true)
  })

  it('a genuinely un-measurable service (no probe, no uptime) is NOT Recently Added', () => {
    expect(isRecentlyAdded(unmeasurable)).toBe(false)         // → stays in Insufficient Data (coverageDays null)
    // The real risk boundary this fix creates: a RECENTLY-ADDED (<30d) but genuinely un-measurable
    // service (a new app/agent with no probe target + no uptime → 'unsupported') must NOT be lumped into
    // Recently Added just because it's new — it belongs in Insufficient Data.
    expect(isRecentlyAdded({ ...unmeasurable, coverageDays: 5 })).toBe(false)
  })

  it('an already-scorable <30d service is Recently Added (the #802 coverage-only case)', () => {
    expect(isRecentlyAdded(scorableNew)).toBe(true)
  })

  it('a STALE new service is NOT Recently Added even if probe-warming (stale feed dominates)', () => {
    expect(isRecentlyAdded({ ...warmingNew, incidentSourceStale: true })).toBe(false)
  })

  it('an established service (coverageDays null) is never Recently Added', () => {
    expect(isRecentlyAdded({ ...warmingNew, coverageDays: null })).toBe(false)
    expect(isRecentlyAdded({ ...scorableNew, coverageDays: null })).toBe(false)
  })

  it('a warming service that has reached 30d coverage is no longer held out (not <30)', () => {
    expect(isRecentlyAdded({ ...warmingNew, coverageDays: 30 })).toBe(false)
  })
})

// #1186 — a medium-confidence score (no official uptime; the #713 rescale imputes uptime = 0.667 ×
// (Incidents+Recovery+Responsiveness), verified against score.ts) is not on the same scale as a
// high-confidence one. Ranking.jsx must render them as two SEPARATE rank sequences, never one shared
// table — this pins the partition so a future change that re-merges them into one array fails here
// first, not silently in the rendered page.
describe('splitByConfidence (#1186)', () => {
  const high1 = { id: 'claude', scoreConfidence: 'high' }
  const high2 = { id: 'openai', scoreConfidence: 'high' }
  const medium1 = { id: 'gemini', scoreConfidence: 'medium' }
  const medium2 = { id: 'xai', scoreConfidence: 'medium' }

  it('partitions a mixed array into high and medium buckets, order preserved within each', () => {
    const out = splitByConfidence([high1, medium1, high2, medium2])
    expect(out.high).toEqual([high1, high2])
    expect(out.medium).toEqual([medium1, medium2])
  })

  it('an all-high input produces an empty medium bucket (not omitted, not undefined)', () => {
    const out = splitByConfidence([high1, high2])
    expect(out.high).toEqual([high1, high2])
    expect(out.medium).toEqual([])
  })

  it('an all-medium input produces an empty high bucket', () => {
    const out = splitByConfidence([medium1, medium2])
    expect(out.high).toEqual([])
    expect(out.medium).toEqual([medium1, medium2])
  })

  it('an empty input produces two empty buckets, no throw', () => {
    const out = splitByConfidence([])
    expect(out).toEqual({ high: [], medium: [] })
  })

  it('never puts a low-confidence entry in either bucket (the caller must pre-filter via hasReliableScoreData)', () => {
    const low = { id: 'bedrock', scoreConfidence: 'low' }
    const out = splitByConfidence([high1, low, medium1])
    expect(out.high).toEqual([high1])
    expect(out.medium).toEqual([medium1])
    expect(out.high).not.toContainEqual(low)
    expect(out.medium).not.toContainEqual(low)
  })

  // hasReliableScoreData's `scoreConfidence !== 'low'` check lets `undefined` through (it isn't `'low'`),
  // but splitByConfidence's strict `=== 'high'`/`=== 'medium'` checks don't recognize it — same silent-drop
  // shape as the existing `console.warn` guard at worker/src/monthly-archive.ts:800 for scoreConfidence == null.
  it('silently drops a service with scoreConfidence undefined from both buckets', () => {
    const undefinedConf = { id: 'mystery' }
    const out = splitByConfidence([high1, undefinedConf, medium1])
    expect(out.high).toEqual([high1])
    expect(out.medium).toEqual([medium1])
    expect(out.high).not.toContainEqual(undefinedConf)
    expect(out.medium).not.toContainEqual(undefinedConf)
  })
})

describe('rankTier (#1186)', () => {
  it('sorts descending by score and assigns rank 1 to the highest', () => {
    const out = rankTier([
      { id: 'a', aiwatchScore: 70 },
      { id: 'b', aiwatchScore: 95 },
      { id: 'c', aiwatchScore: 82 },
    ])
    expect(out.map((s) => s.id)).toEqual(['b', 'c', 'a'])
    expect(out.map((s) => s.rank)).toEqual([1, 2, 3])
    expect(out.every((s) => s.isTied === false)).toBe(true)
  })

  it('competition ranking: tied scores share a rank, the next distinct score skips ahead', () => {
    const out = rankTier([
      { id: 'a', aiwatchScore: 90 },
      { id: 'b', aiwatchScore: 90 },
      { id: 'c', aiwatchScore: 80 },
    ])
    const byId = Object.fromEntries(out.map((s) => [s.id, s]))
    expect(byId.a.rank).toBe(1)
    expect(byId.b.rank).toBe(1)
    expect(byId.a.isTied).toBe(true)
    expect(byId.b.isTied).toBe(true)
    expect(byId.c.rank).toBe(3)
    expect(byId.c.isTied).toBe(false)
  })

  it('does not mutate the input array', () => {
    const input = [{ id: 'a', aiwatchScore: 70 }, { id: 'b', aiwatchScore: 95 }]
    const inputCopy = [...input]
    rankTier(input)
    expect(input).toEqual(inputCopy)
  })

  it('an empty array returns an empty array', () => {
    expect(rankTier([])).toEqual([])
  })
})

// #1186 — pins the full assembly (filter → split by confidence → rank each tier independently → bucket
// the rest by reason) as ONE tested unit, since Ranking.jsx now just wires buildRanking's output to
// JSX. A regression here (e.g. a future edit re-merging high/medium into one sort) fails this test, not
// just a visual check of the rendered page.
describe('buildRanking (#1186)', () => {
  const highA = { id: 'claude', aiwatchScore: 95, scoreConfidence: 'high' }
  const highB = { id: 'openai', aiwatchScore: 88, scoreConfidence: 'high' }
  const mediumA = { id: 'gemini', aiwatchScore: 86, scoreConfidence: 'medium' }
  const mediumB = { id: 'xai', aiwatchScore: 70, scoreConfidence: 'medium' }
  const low = { id: 'bedrock', aiwatchScore: 60, scoreConfidence: 'low' } // over-scores under the rescale, never ranked
  const recentlyAdded = { id: 'turbopuffer', aiwatchScore: null, scoreConfidence: null, coverageDays: 3, scoreBreakdown: { responsivenessStatus: 'insufficient' } }
  const insufficient = { id: 'sagemaker', aiwatchScore: null, scoreConfidence: null, coverageDays: 3, scoreBreakdown: { responsivenessStatus: 'unsupported' } }

  it('ranks high and medium as two independent tiers, sorted and numbered within each', () => {
    const out = buildRanking([highA, highB, mediumA, mediumB, low])
    expect(out.scoredHigh.map((s) => s.id)).toEqual(['claude', 'openai'])
    expect(out.scoredHigh.map((s) => s.rank)).toEqual([1, 2])
    expect(out.scoredMedium.map((s) => s.id)).toEqual(['gemini', 'xai'])
    expect(out.scoredMedium.map((s) => s.rank)).toEqual([1, 2]) // separate rank-1 sequence, not [3, 4]
  })

  it('excludes low-confidence services from both scored tiers', () => {
    const out = buildRanking([highA, low])
    expect(out.scoredHigh.map((s) => s.id)).toEqual(['claude'])
    expect(out.scoredMedium).toEqual([])
  })

  it('a low-confidence service with no coverageDays lands in insufficient, not recentlyAdded', () => {
    const out = buildRanking([low])
    expect(out.recentlyAdded).toEqual([])
    expect(out.insufficient.map((s) => s.id)).toEqual(['bedrock'])
  })

  it('buckets the not-ranked set into recentlyAdded vs insufficient by reason (#802/#870)', () => {
    const out = buildRanking([highA, recentlyAdded, insufficient])
    expect(out.recentlyAdded.map((s) => s.id)).toEqual(['turbopuffer'])
    expect(out.insufficient.map((s) => s.id)).toEqual(['sagemaker'])
  })

  it('an all-empty input returns four empty arrays, no throw', () => {
    expect(buildRanking([])).toEqual({ scoredHigh: [], scoredMedium: [], recentlyAdded: [], insufficient: [] })
  })

  it('a service with a real score but scoreConfidence outside {high,medium,low} lands in insufficient, not vanishing', () => {
    // hasReliableScoreData only excludes 'low' (scoreConfidence !== 'low'), so undefined passes it —
    // but splitByConfidence's strict === checks don't recognize undefined either. Pre-#1186 this
    // service (real score, live feed) would have rendered in the single table; it must still render
    // SOMEWHERE now, not disappear.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const orphan = { id: 'mystery', aiwatchScore: 77, scoreConfidence: undefined }
    const out = buildRanking([highA, orphan])
    expect(out.scoredHigh.map((s) => s.id)).toEqual(['claude'])
    expect(out.scoredMedium).toEqual([])
    expect(out.recentlyAdded).toEqual([])
    expect(out.insufficient.map((s) => s.id)).toEqual(['mystery'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('mystery'))
    warn.mockRestore()
  })

  it('every input service appears in exactly one of the four output buckets (total partition invariant)', () => {
    const all = [highA, highB, mediumA, mediumB, low, recentlyAdded, insufficient, { id: 'mystery', aiwatchScore: 77, scoreConfidence: undefined }]
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = buildRanking(all)
    const seen = [...out.scoredHigh, ...out.scoredMedium, ...out.recentlyAdded, ...out.insufficient].map((s) => s.id)
    expect(seen.sort()).toEqual(all.map((s) => s.id).sort())
    expect(new Set(seen).size).toBe(seen.length) // no id appears twice across buckets
    vi.restoreAllMocks()
  })
})
