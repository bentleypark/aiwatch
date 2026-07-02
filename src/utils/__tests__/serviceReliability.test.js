import { describe, it, expect } from 'vitest'
import { noOfficialUptime, isUnreliableUptime, hasReliableScoreData, hasSufficientCoverage, isProbeWarming, isRecentlyAdded } from '../serviceReliability'

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
