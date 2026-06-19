import { describe, it, expect } from 'vitest'
import { noOfficialUptime, isUnreliableUptime, hasReliableScoreData } from '../serviceReliability'

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
})
