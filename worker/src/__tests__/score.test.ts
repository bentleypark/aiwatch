import { describe, it, expect } from 'vitest'
import { calculateAIWatchScore, classifyProbe, computeMttrHours, isReliabilityIncident, MTTR_PRIOR_MIN, MTTR_PRIOR_WEIGHT, MIN_VALID_DAYS, type ProbeContext } from '../score'
import { PROBE_TARGETS, resolveProbeId } from '../probe'
import { scoreFor } from '../index'
import type { ProbeSummary, ServiceStatus } from '../types'

describe('computeMttrHours (#1019 Part B — small-sample robustness)', () => {
  it('returns null for an empty (or all-zero) sample', () => {
    expect(computeMttrHours([])).toBeNull()
    expect(computeMttrHours([0, 0])).toBeNull()
  })

  it('uses the robust MEDIAN at ≥3 (one outlier cannot move it)', () => {
    // [10, 30, 60, 90, 799] → median 60 min = 1h. The 799 outlier is ignored.
    expect(computeMttrHours([10, 30, 60, 90, 799])).toBeCloseTo(1, 5)
    // even count → lower-median index (floor(n/2)) — unchanged from the prior behaviour
    expect(computeMttrHours([20, 40, 60, 800])).toBeCloseTo(1, 5)
  })

  it('leaves a thin sample FASTER than the prior untouched (no churn on good low-incident services)', () => {
    // 1 incident, 30 min < 60 min prior → unchanged 0.5h (a genuinely fast recovery keeps its score).
    expect(computeMttrHours([30])).toBeCloseTo(0.5, 5)
    // 2 fast incidents → plain mean, no shrinkage.
    expect(computeMttrHours([20, 40])).toBeCloseTo(0.5, 5)
    // exactly at the prior → boundary is "≤", so unchanged.
    expect(computeMttrHours([MTTR_PRIOR_MIN])).toBeCloseTo(1, 5)
  })

  it('shrinks a thin sample WORSE than the prior toward it — the luma/gemini case', () => {
    // luma: 1 incident, 7.5h (450 min) → (450 + 2·60)/(1+2) = 190 min = 3.1667h (vs 7.5h raw).
    expect(computeMttrHours([450])).toBeCloseTo(190 / 60, 5)
    // gemini: 1 incident, 4.6h (276 min) → (276 + 120)/3 = 132 min = 2.2h.
    expect(computeMttrHours([276])).toBeCloseTo(2.2, 5)
    // 2 incidents, mean 300 min > 60 prior → shrunk (200+400 + 2·60)/(2+2) = 720/4 = 180 min = 3h.
    expect(computeMttrHours([200, 400])).toBeCloseTo((600 + MTTR_PRIOR_WEIGHT * MTTR_PRIOR_MIN) / (2 + MTTR_PRIOR_WEIGHT) / 60, 5)
  })

  it('the shrunk value stays between the prior and the raw mean (bounded, never fully spared, never below prior)', () => {
    const raw = 450, shrunkH = computeMttrHours([raw])!
    expect(shrunkH * 60).toBeGreaterThan(MTTR_PRIOR_MIN) // still penalises (> prior)
    expect(shrunkH * 60).toBeLessThan(raw)               // but bounded below the raw outlier
  })

  it('is continuous into the median at the 3-incident boundary (no cliff)', () => {
    // At exactly 3 it switches to median; a thin 2-sample shrinks. Same durations, different regime.
    expect(computeMttrHours([120, 480])).toBeCloseTo((600 + 120) / 4 / 60, 5) // 2 → shrunk
    expect(computeMttrHours([120, 480, 300])).toBeCloseTo(300 / 60, 5)         // 3 → median (300)
  })
})

function makeSvc(overrides: Partial<ServiceStatus> = {}): ServiceStatus {
  return {
    id: 'test', name: 'Test', provider: 'Test', category: 'api',
    status: 'operational', latency: 100, uptime30d: 99.9,
    lastChecked: new Date().toISOString(), incidents: [],
    ...overrides,
  }
}

function makeIncident(daysAgo: number, duration = '1h 0m', status = 'resolved' as const) {
  const startedAt = new Date(Date.now() - daysAgo * 86_400_000).toISOString()
  return {
    id: `inc-${daysAgo}-${Math.random()}`, title: 'Test incident',
    status, impact: 'major' as const, startedAt, duration,
    timeline: [],
  }
}

function makeProbeSummary(overrides: Partial<ProbeSummary> = {}): ProbeSummary {
  return { p50: 200, p95: 400, cvCombined: 0.5, validDays: 7, ...overrides }
}

const probeAvailable = (overrides?: Partial<ProbeSummary>): ProbeContext => ({
  kind: 'available',
  summary: makeProbeSummary(overrides),
})
const probeInsufficient: ProbeContext = { kind: 'insufficient' }
const probeUnavailable: ProbeContext = { kind: 'unavailable' }
const probeUnsupported: ProbeContext = { kind: 'unsupported' }

// Test helpers. No default — naming makes the probe context choice explicit at every callsite,
// so a future probed-service test can't silently get 'unsupported' behavior by forgetting an arg.
const scoreUnprobed = (svc: ServiceStatus, cutoffDays = 30) =>
  calculateAIWatchScore(svc, cutoffDays, probeUnsupported)
const scoreWithProbe = (svc: ServiceStatus, probe: ProbeContext, cutoffDays = 30) =>
  calculateAIWatchScore(svc, cutoffDays, probe)

describe('calculateAIWatchScore', () => {
  // ── Probe-less (unsupported) baseline ──

  it('returns 100 for perfect probe-less service (100% uptime, 0 incidents)', () => {
    const result = scoreUnprobed(makeSvc({ uptime30d: 100 }))
    expect(result.score).toBe(100)
    expect(result.grade).toBe('excellent')
    expect(result.confidence).toBe('high')
  })

  it('calculates uptime_score on 40-pt scale with 95% baseline', () => {
    expect(scoreUnprobed(makeSvc({ uptime30d: 100 })).breakdown.uptime).toBe(40)
    expect(scoreUnprobed(makeSvc({ uptime30d: 99 })).breakdown.uptime).toBe(32)
    expect(scoreUnprobed(makeSvc({ uptime30d: 95 })).breakdown.uptime).toBe(0)
    expect(scoreUnprobed(makeSvc({ uptime30d: 90 })).breakdown.uptime).toBe(0) // clamped
  })

  it('calculates incident_score on 25-pt scale based on affected days', () => {
    const r0 = scoreUnprobed(makeSvc())
    const r5days = scoreUnprobed(makeSvc({ incidents: Array.from({ length: 5 }, (_, i) => makeIncident(i + 1)) }))
    const r5same = scoreUnprobed(makeSvc({ incidents: Array.from({ length: 5 }, () => makeIncident(1)) }))

    expect(r0.breakdown.incidents).toBe(25)
    expect(r5days.breakdown.incidents).toBeLessThan(r5same.breakdown.incidents)
    expect(r5same.metrics.affectedDays30d).toBe(1)
    expect(r5days.metrics.affectedDays30d).toBe(5)
  })

  it('excludes null-impact incidents from affectedDays (#261)', () => {
    // Mix: 3 informational (null) + 2 major. Only the major days should count.
    const incidents = [
      { ...makeIncident(1), impact: null },
      { ...makeIncident(2), impact: null },
      { ...makeIncident(3), impact: null },
      makeIncident(10), // major
      makeIncident(11), // major
    ]
    const r = scoreUnprobed(makeSvc({ incidents }))
    // affectedDays30d should reflect the 2 impactful days, NOT 5
    expect(r.metrics.affectedDays30d).toBe(2)
    // incidentScore should match a 2-major-day calculation: 25 × exp(-2/10) ≈ 20.5
    expect(r.breakdown.incidents).toBeCloseTo(25 * Math.exp(-2 / 10), 1)
  })

  it('null-only feed treats incidents as if there were none (#261)', () => {
    const incidents = [
      { ...makeIncident(1), impact: null },
      { ...makeIncident(2), impact: null },
      { ...makeIncident(5), impact: null },
    ]
    const r = scoreUnprobed(makeSvc({ incidents }))
    expect(r.metrics.affectedDays30d).toBe(0)
    expect(r.breakdown.incidents).toBe(25) // full credit
  })

  it('weights minor-only days at 0.3 vs major-only days at 1.0 (#260)', () => {
    // 5 days of minor incidents vs 5 days of major incidents.
    // Weighted: minor-only = 5 × 0.3 = 1.5 effective days; major-only = 5 × 1.0 = 5.
    // incidentScore: minor 25×exp(-1.5/10)=21.5, major 25×exp(-5/10)=15.2 → minor higher.
    const minorIncidents = Array.from({ length: 5 }, (_, i) => ({ ...makeIncident(i + 1), impact: 'minor' as const }))
    const majorIncidents = Array.from({ length: 5 }, (_, i) => makeIncident(i + 1))
    const minorR = scoreUnprobed(makeSvc({ incidents: minorIncidents }))
    const majorR = scoreUnprobed(makeSvc({ incidents: majorIncidents }))
    expect(minorR.breakdown.incidents).toBeGreaterThan(majorR.breakdown.incidents)
    // Same affectedDays30d (raw count of impactful days) — only the score weight differs
    expect(minorR.metrics.affectedDays30d).toBe(5)
    expect(majorR.metrics.affectedDays30d).toBe(5)
    // Weighted formula: 5 × 0.3 = 1.5 → 25 × exp(-1.5/10) ≈ 21.52
    expect(minorR.breakdown.incidents).toBeCloseTo(25 * Math.exp(-1.5 / 10), 1)
  })

  it('per day uses MAX impact weight (a critical+minor day counts as critical, #260)', () => {
    // Two services each with 3 days of incidents:
    // A: 3 days of minor only → 3 × 0.3 = 0.9 effective
    // B: 3 days each with both critical AND minor → max-wins → 3 × 1.0 = 3.0 effective
    const minorOnly = [
      { ...makeIncident(1), impact: 'minor' as const },
      { ...makeIncident(2), impact: 'minor' as const },
      { ...makeIncident(3), impact: 'minor' as const },
    ]
    const criticalPlusMinor = [
      makeIncident(1), { ...makeIncident(1), impact: 'minor' as const },
      makeIncident(2), { ...makeIncident(2), impact: 'minor' as const },
      makeIncident(3), { ...makeIncident(3), impact: 'minor' as const },
    ]
    const a = scoreUnprobed(makeSvc({ incidents: minorOnly }))
    const b = scoreUnprobed(makeSvc({ incidents: criticalPlusMinor }))
    // Minor-only must score better than mixed major+minor on the same days
    expect(a.breakdown.incidents).toBeGreaterThan(b.breakdown.incidents)
    // Both report affectedDays30d=3 (raw day count)
    expect(a.metrics.affectedDays30d).toBe(3)
    expect(b.metrics.affectedDays30d).toBe(3)
  })

  it('calculates recovery_score on 15-pt scale', () => {
    expect(scoreUnprobed(makeSvc({ incidents: [] })).breakdown.recovery).toBe(15)
  })

  it('uses median MTTR for 3+ samples', () => {
    const incidents = [makeIncident(1, '30m'), makeIncident(2, '1h 0m'), makeIncident(3, '10h 0m')]
    expect(scoreUnprobed(makeSvc({ incidents })).metrics.mttrHours).toBe(1)
  })

  it('#1019 Part B: shrinks a <3 sample worse than the prior toward it', () => {
    // [2h, 4h] mean = 3h > 1h prior → shrunk (120+240 + 2·60)/(2+2) = 120 min = 2h (was 3h raw mean).
    const incidents = [makeIncident(1, '2h 0m'), makeIncident(2, '4h 0m')]
    expect(scoreUnprobed(makeSvc({ incidents })).metrics.mttrHours).toBe(2)
  })

  it('#713: no official uptime + no probe → score WITHHELD (null), confidence low', () => {
    // Only 2 of 4 components (incidents+recovery) measured → over-scores under the rescale, so the
    // figure is withheld (null) rather than surfaced. The breakdown still shows the partial computation.
    const noUptime = scoreUnprobed(makeSvc({ uptime30d: null, incidents: [makeIncident(1)] }))
    expect(noUptime.confidence).toBe('low')
    expect(noUptime.score).toBeNull()
    expect(noUptime.grade).toBeNull()
    expect(noUptime.breakdown.uptime).toBeNull()
    expect(noUptime.breakdown.incidents).toBeGreaterThan(0)   // partial breakdown still computed (transparency)
  })

  it('#713: no official uptime + no probe → still null even with a clean record (no fabricated 100)', () => {
    const result = scoreUnprobed(makeSvc({ uptime30d: null, incidents: [] }))
    expect(result.score).toBeNull()        // NOT a baseless 100 (and no assumed-99.5%/86 either) — withheld
    expect(result.grade).toBeNull()
    expect(result.confidence).toBe('low')
    expect(result.breakdown.incidents).toBe(25)  // breakdown still shows what we measured
    expect(result.breakdown.recovery).toBe(15)
  })

  it('#713: no official uptime BUT a probe → score IS emitted (confidence medium, rankable)', () => {
    const probed = scoreWithProbe(makeSvc({ uptime30d: null, incidents: [] }), probeAvailable({ p50: 200, cvCombined: 0.4 }))
    expect(probed.confidence).toBe('medium')      // a real responsiveness signal → enough to score
    expect(probed.score).not.toBeNull()
    expect(probed.grade).not.toBeNull()
    expect(probed.breakdown.uptime).toBeNull()
    expect(probed.breakdown.responsiveness).not.toBeNull()
  })

  it('#713: no official uptime + INSUFFICIENT probe (<7d data) → still null/low (no usable responsiveness yet)', () => {
    // An insufficient probe is NOT a responsiveness signal (no component, only a 5% penalty), so a
    // no-uptime service in its probe warm-up week has only incidents+recovery measured → withheld.
    // Intended: it re-appears once ≥7d of probe data accumulates (→ confidence medium). Symmetric with
    // a no-uptime+no-probe service; the difference from an official-uptime service (which stays 'high'
    // with an insufficient probe) is that here there's no uptime to anchor the score.
    const r = scoreWithProbe(makeSvc({ uptime30d: null, incidents: [] }), probeInsufficient)
    expect(r.confidence).toBe('low')
    expect(r.score).toBeNull()
    expect(r.grade).toBeNull()
    expect(r.breakdown.responsiveness).toBeNull()
  })

  it('#713: uptime source no longer affects the score (the estimate ×0.9 penalty is removed)', () => {
    const official = scoreUnprobed(makeSvc({ uptime30d: 99.5, uptimeSource: 'official' }))
    const platform = scoreUnprobed(makeSvc({ uptime30d: 99.5, uptimeSource: 'platform_avg' }))
    expect(official.confidence).toBe('high')           // any official uptime present → high
    expect(platform.score).toBe(official.score)        // source is irrelevant to the score now
    expect(platform.confidence).toBe('high')
  })

  it('#713: null score ONLY for confidence-low (no uptime + no probe); non-null otherwise', () => {
    // confidence 'low' (no official uptime AND no probe) → score withheld
    for (const svc of [
      makeSvc({ uptime30d: null, incidents: [] }),
      makeSvc({ uptime30d: null, incidents: [makeIncident(1)] }),
    ]) {
      const result = scoreUnprobed(svc)
      expect(result.score).toBeNull()
      expect(result.grade).toBeNull()
      expect(result.confidence).toBe('low')
    }
    // any official uptime present → confidence 'high' → real score
    for (const svc of [
      makeSvc({ uptime30d: 0, incidents: [] }),
      makeSvc({ uptime30d: 100, incidents: [] }),
    ]) {
      const result = scoreUnprobed(svc)
      expect(result.score).not.toBeNull()
      expect(result.grade).not.toBeNull()
      expect(result.confidence).toBe('high')
    }
    // no uptime but a probe → confidence 'medium' → real score
    const probed = scoreWithProbe(makeSvc({ uptime30d: null, incidents: [] }), probeAvailable({ p50: 200, cvCombined: 0.4 }))
    expect(probed.score).not.toBeNull()
    expect(probed.confidence).toBe('medium')
  })

  it('filters incidents to 30 days only', () => {
    const oldIncident = makeIncident(60)
    const recentIncident = makeIncident(5)
    const result = scoreUnprobed(makeSvc({ incidents: [oldIncident, recentIncident] }))
    expect(result.metrics.incidents30d).toBe(1)
  })

  it('clamps score between 0 and 100', () => {
    const result = scoreUnprobed(makeSvc({ uptime30d: 100 }))
    expect(result.score).toBeLessThanOrEqual(100)
    expect(result.score).toBeGreaterThanOrEqual(0)
  })

  it('handles duration edge cases correctly', () => {
    expect(scoreUnprobed(makeSvc({ incidents: [makeIncident(1, '1h')] })).metrics.mttrHours).toBe(1)     // = prior → unchanged
    expect(scoreUnprobed(makeSvc({ incidents: [makeIncident(1, '30m')] })).metrics.mttrHours).toBe(0.5)  // < prior → unchanged
    // 2h30m (150m) > 1h prior → #1019 Part B shrinks: (150 + 2·60)/(1+2) = 90 min = 1.5h (was 2.5h raw).
    expect(scoreUnprobed(makeSvc({ incidents: [makeIncident(1, '2h 30m')] })).metrics.mttrHours).toBe(1.5)
  })

  it('gives 0 recovery score for unresolved incidents', () => {
    const result = scoreUnprobed(makeSvc({ incidents: [makeIncident(1, '1h 0m', 'investigating' as any)] }))
    expect(result.breakdown.recovery).toBe(0)
  })

  it('skips 0-duration incidents in MTTR', () => {
    // 0m dropped → single 2h sample; > 1h prior → #1019 Part B shrinks (120+120)/3 = 80 min ≈ 1.3h.
    const incidents = [makeIncident(1, '0m'), makeIncident(2, '2h 0m')]
    expect(scoreUnprobed(makeSvc({ incidents })).metrics.mttrHours).toBe(1.3)
  })

  // ── #707: null-impact incidents are informational (compliance/advisory) — excluded from MTTR/recovery
  // (symmetric with the #261 exclusion from affectedDays + the uptime estimate), so a non-reliability
  // event doesn't zero a service's Recovery score on a window where it never actually went down.
  const nullImpactInc = (daysAgo: number, duration: string) => ({
    ...makeIncident(daysAgo, duration), impact: null as null,
  })

  it('#707: a null-impact resolved incident does NOT penalize recovery (informational advisory)', () => {
    // a single 64.8h compliance event — pre-#707 this zeroed recovery (15·e^-16.2 ≈ 0)
    const result = scoreUnprobed(makeSvc({ incidents: [nullImpactInc(2, '64h 47m')] }))
    expect(result.metrics.mttrHours).toBeNull()  // excluded from the MTTR set
    expect(result.breakdown.recovery).toBe(15)   // no reliability recovery to penalize → full 15
    expect(result.breakdown.incidents).toBe(25)  // null-impact also excluded from affectedDays (#261)
  })

  it('#707: MTTR ignores a null-impact incident when a real (impactful) one is present', () => {
    const incidents = [makeIncident(1, '2h 0m'), nullImpactInc(2, '100h 0m')]
    // only the real 2h incident reaches the MTTR set (the 100h advisory is excluded, not dominating);
    // that lone 2h sample > 1h prior → #1019 Part B shrinks (120+120)/3 = 80 min ≈ 1.3h.
    expect(scoreUnprobed(makeSvc({ incidents })).metrics.mttrHours).toBe(1.3)
  })

  // ── Responsiveness component (probe-supported services) ──

  it('adds Responsiveness when probe context is "available"', () => {
    const result = scoreWithProbe(makeSvc({ uptime30d: 100 }), probeAvailable({ p50: 200, cvCombined: 0.3 }))

    expect(result.breakdown.responsiveness).not.toBeNull()
    // speed = 10 * exp(-200/400) = 6.07; stability = 10 * exp(-0.3/0.5) = 5.49 → ~11.6
    expect(result.breakdown.responsiveness!).toBeGreaterThan(10)
    expect(result.breakdown.responsiveness!).toBeLessThan(13)
    expect(result.breakdown.responsivenessStatus).toBe('available')
  })

  it('floors p50 at 50ms in Speed calculation (bimodal protection)', () => {
    // p50=10ms (Claude-like bimodal) should not score higher than p50=50ms
    const fast = scoreWithProbe(makeSvc({ uptime30d: 100 }), probeAvailable({ p50: 10, cvCombined: 0.2 }))
    const floored = scoreWithProbe(makeSvc({ uptime30d: 100 }), probeAvailable({ p50: 50, cvCombined: 0.2 }))
    // 10ms gets floored to 50ms — Speed component is identical
    expect(fast.metrics.probe?.p50).toBe(10) // raw value preserved
    expect(floored.metrics.probe?.p50).toBe(50)
    expect(fast.breakdown.responsiveness).toBe(floored.breakdown.responsiveness)
  })

  it('penalizes high CV in Stability score', () => {
    const stable = scoreWithProbe(makeSvc({ uptime30d: 100 }), probeAvailable({ cvCombined: 0.1 }))
    const unstable = scoreWithProbe(makeSvc({ uptime30d: 100 }), probeAvailable({ cvCombined: 2.0 }))
    expect(stable.breakdown.responsiveness!).toBeGreaterThan(unstable.breakdown.responsiveness!)
  })

  it('insufficient probe → 0.95 penalty applied to scaled base', () => {
    const result = scoreWithProbe(makeSvc({ uptime30d: 100 }), probeInsufficient)
    expect(result.breakdown.responsiveness).toBeNull()
    expect(result.breakdown.responsivenessStatus).toBe('insufficient')
    // perfect base = 80, scaled = 100, × 0.95 = 95
    expect(result.score).toBe(95)
  })

  it('unavailable (KV failure) → no penalty, behaves like unsupported for math but distinct status', () => {
    const insufficient = scoreWithProbe(makeSvc({ uptime30d: 100 }), probeInsufficient)
    const unavailable = scoreWithProbe(makeSvc({ uptime30d: 100 }), probeUnavailable)
    const unsupported = scoreWithProbe(makeSvc({ uptime30d: 100 }), probeUnsupported)

    expect(unavailable.score).toBe(100)
    expect(unsupported.score).toBe(100)
    expect(insufficient.score).toBe(95)
    expect(unavailable.breakdown.responsiveness).toBeNull()
    expect(unavailable.metrics.probe).toBeNull()
    // Status field distinguishes the three cases that all show responsiveness=null
    expect(unavailable.breakdown.responsivenessStatus).toBe('unavailable')
    expect(unsupported.breakdown.responsivenessStatus).toBe('unsupported')
    expect(insufficient.breakdown.responsivenessStatus).toBe('insufficient')
  })

  it('unsupported (no probe endpoint) → no penalty', () => {
    const result = scoreWithProbe(makeSvc({ uptime30d: 100 }), probeUnsupported)
    expect(result.breakdown.responsiveness).toBeNull()
    expect(result.score).toBe(100)
  })

  it('exposes raw probe metrics as a single nullable summary when available', () => {
    const result = scoreWithProbe(makeSvc(), probeAvailable({ p50: 178, p95: 311, cvCombined: 0.596, validDays: 7 }))
    expect(result.metrics.probe).toEqual({ p50: 178, p95: 311, cvCombined: 0.596, validDays: 7 })
  })

  it('returns null probe metrics when probe context has no summary', () => {
    expect(scoreWithProbe(makeSvc(), probeUnsupported).metrics.probe).toBeNull()
    expect(scoreWithProbe(makeSvc(), probeUnavailable).metrics.probe).toBeNull()
    expect(scoreWithProbe(makeSvc(), probeInsufficient).metrics.probe).toBeNull()
  })

  it('full Responsiveness path scores lower than probe-less perfect service when probe metrics are weak', () => {
    const probed = scoreWithProbe(makeSvc({ uptime30d: 100 }), probeAvailable({ p50: 500, p95: 1000, cvCombined: 0.8, validDays: 7 }))
    const probeLess = scoreUnprobed(makeSvc({ uptime30d: 100 }))
    expect(probed.score!).toBeLessThan(probeLess.score!)
  })

  // ── Real-world calibration locks (issue #132 reference data) ──

  it('Claude-like profile (p50=10ms bimodal, low CV) reaches "excellent" grade', () => {
    // p50 floored to 50ms → speed=10*exp(-50/400)=8.82, stability=10*exp(-0.3/0.5)=5.49
    // Total = 40 (uptime) + 25 (no incidents) + 15 (no incidents) + ~14.3 = ~94
    const result = scoreWithProbe(makeSvc({ uptime30d: 100 }), probeAvailable({ p50: 10, p95: 193, cvCombined: 0.3, validDays: 7 }))
    expect(result.score).toBeGreaterThanOrEqual(90)
    expect(result.grade).toBe('excellent')
  })

  it('Deepgram-like profile (p50=1409ms, low CV) scores measurably lower than fast probe', () => {
    // speed=10*exp(-1409/400)≈0.30, stability=10*exp(-0.44/0.5)≈4.14 → ~4.4
    const slow = scoreWithProbe(makeSvc({ uptime30d: 99.0, incidents: [makeIncident(2, '4h')] }), probeAvailable({ p50: 1409, p95: 2860, cvCombined: 0.44, validDays: 7 }))
    const fast = scoreWithProbe(makeSvc({ uptime30d: 99.0, incidents: [makeIncident(2, '4h')] }), probeAvailable({ p50: 100, p95: 200, cvCombined: 0.44, validDays: 7 }))
    expect(slow.score!).toBeLessThan(fast.score!)
  })

  // ── Boundary tests ──

  it('validDays=7 boundary — at MIN_VALID_DAYS exactly, treated as available by caller', () => {
    const at = scoreWithProbe(makeSvc({ uptime30d: 100 }), probeAvailable({ validDays: MIN_VALID_DAYS }))
    expect(at.breakdown.responsiveness).not.toBeNull()
  })

  // ── Grade transitions ──
  it('assigns correct grades with #260/#261 thresholds (excellent ≥90, good ≥75)', () => {
    expect(scoreUnprobed(makeSvc({ uptime30d: 100 })).grade).toBe('excellent')
    expect(scoreUnprobed(makeSvc({
      uptime30d: 99, incidents: Array.from({ length: 10 }, (_, i) => makeIncident(i + 1))
    })).grade).not.toBe('excellent')

    // Boundary: score 89 → good, score 90 → excellent
    // Boundary: score 74 → fair, score 75 → good
    // Construct precise scores via uptime tuning. baseScore × 1.25 for unprobed.
    // For 90: need baseScore=72. uptime=32 (99%) + incidents=25 + recovery=15 = 72 ✓
    const ninetyExact = scoreUnprobed(makeSvc({ uptime30d: 99 }))
    expect(ninetyExact.score).toBe(90)
    expect(ninetyExact.grade).toBe('excellent')

    // 89: baseScore=71.2. Get there via uptime=31.2 (98.9%) + 25 + 15
    const eightyNine = scoreUnprobed(makeSvc({ uptime30d: 98.9 }))
    expect(eightyNine.score).toBe(89)
    expect(eightyNine.grade).toBe('good')
  })
})

describe('classifyProbe', () => {
  const validSummary: ProbeSummary = { p50: 200, p95: 400, cvCombined: 0.5, validDays: 7 }

  it('returns unsupported when service is not probed (apps, agents, infra)', () => {
    const ctx = classifyProbe('chatgpt', false, new Map())
    expect(ctx).toEqual({ kind: 'unsupported' })
  })

  it('returns unavailable when summaries map is undefined (KV read failure)', () => {
    const ctx = classifyProbe('claude', true, undefined)
    expect(ctx).toEqual({ kind: 'unavailable' })
  })

  it('returns insufficient (NOT unavailable) when summaries is an empty Map', () => {
    // Locks the distinction: undefined = KV failure (no penalty), empty Map = real "no data" (penalty).
    // Regression guard against a future refactor returning Map() instead of undefined on error.
    const ctx = classifyProbe('claude', true, new Map())
    expect(ctx).toEqual({ kind: 'insufficient' })
  })

  it('returns insufficient when probed but svcId missing from summaries (newly added)', () => {
    const ctx = classifyProbe('newservice', true, new Map([['claude', validSummary]]))
    expect(ctx).toEqual({ kind: 'insufficient' })
  })

  it('returns insufficient when probed but validDays < MIN_VALID_DAYS', () => {
    const partial = { ...validSummary, validDays: 6 }
    const ctx = classifyProbe('claude', true, new Map([['claude', partial]]))
    expect(ctx).toEqual({ kind: 'insufficient' })
  })

  it('returns insufficient when p50 is 0 (degenerate summary)', () => {
    const broken = { ...validSummary, p50: 0 }
    const ctx = classifyProbe('claude', true, new Map([['claude', broken]]))
    expect(ctx).toEqual({ kind: 'insufficient' })
  })

  it('returns available with summary when probed + valid', () => {
    const ctx = classifyProbe('claude', true, new Map([['claude', validSummary]]))
    expect(ctx).toEqual({ kind: 'available', summary: validSummary })
  })

  it('non-probed service ignores summaries map (returns unsupported even if entry exists)', () => {
    // Defensive: even if a probe-less service somehow has a summary entry, classifier ignores it
    const ctx = classifyProbe('chatgpt', false, new Map([['chatgpt', validSummary]]))
    expect(ctx).toEqual({ kind: 'unsupported' })
  })
})

// #883 — reproduces the scoreFor() resolution (resolveProbeId → classifyProbe) so the inheritance
// wiring is unit-covered without booting the worker. An inheriting agent must be classified against
// its PARENT's probe, giving it a real Responsiveness component instead of the probe-less rescale.
describe('parent-probe inheritance in scoring (#883)', () => {
  const PROBED = new Set(PROBE_TARGETS.map((t) => t.id))
  // Mirror of scoreFor(): resolve the probe id, then classify + score against it.
  const scoreWithInheritance = (svc: ServiceStatus, summaries: Map<string, ProbeSummary>) => {
    const pid = resolveProbeId(svc.id)
    return calculateAIWatchScore(svc, 30, classifyProbe(pid, PROBED.has(pid), summaries))
  }

  it('Claude Code inherits claude probe → available, real Responsiveness (not rescaled)', () => {
    const summaries = new Map([['claude', makeProbeSummary({ p50: 150, cvCombined: 0.2 })]])
    const svc = makeSvc({ id: 'claudecode', category: 'agent', uptime30d: 99.9 })
    const result = scoreWithInheritance(svc, summaries)
    expect(result.breakdown.responsiveness).not.toBeNull()
    expect(result.breakdown.responsivenessStatus).toBe('available')
  })

  it('Codex inherits openai probe', () => {
    const summaries = new Map([['openai', makeProbeSummary()]])
    const svc = makeSvc({ id: 'codex', category: 'agent', uptime30d: 99.9 })
    const result = scoreWithInheritance(svc, summaries)
    expect(result.breakdown.responsivenessStatus).toBe('available')
  })

  it('inheritance changes the score vs the probe-less rescale (the whole point)', () => {
    // Same service inputs, only the probe treatment differs: inherited (4-component) vs unsupported
    // (3-component rescale). A fast/stable parent probe must move the number.
    const svc = makeSvc({ id: 'claudecode', category: 'agent', uptime30d: 99.0 })
    const inherited = scoreWithInheritance(svc, new Map([['claude', makeProbeSummary({ p50: 120, cvCombined: 0.1 })]]))
    const rescaled = calculateAIWatchScore(svc, 30, probeUnsupported)
    expect(inherited.breakdown.responsivenessStatus).toBe('available')
    expect(rescaled.breakdown.responsivenessStatus).toBe('unsupported')
    expect(inherited.score).not.toBe(rescaled.score)
  })

  it('an inheriting agent with NO parent summary yet falls back to insufficient (not unsupported)', () => {
    // Parent is a real probe target, so before 7d of data the child is insufficient (5% penalty),
    // exactly like any freshly-added probed service — never silently unsupported.
    const svc = makeSvc({ id: 'claudecode', category: 'agent' })
    const result = scoreWithInheritance(svc, new Map())
    expect(result.breakdown.responsivenessStatus).toBe('insufficient')
  })

  // Direct coverage of the REAL wiring (index.ts scoreFor), not the mirror — a regression on that
  // single resolveProbeId→classifyProbe line is caught here even though the mirror above would pass.
  it('the actual scoreFor() applies inheritance (Claude Code gets claude probe)', () => {
    const summaries = new Map([['claude', makeProbeSummary()]])
    const svc = makeSvc({ id: 'claudecode', category: 'agent', uptime30d: 99.9 })
    expect(scoreFor(svc, summaries).breakdown.responsivenessStatus).toBe('available')
  })

  it('the actual scoreFor() leaves a non-inheriting probe-less service unsupported', () => {
    // chatgpt is neither probed nor an inheritor → must stay unsupported through the real path.
    const svc = makeSvc({ id: 'chatgpt', category: 'app', uptime30d: 99.9 })
    expect(scoreFor(svc, new Map()).breakdown.responsivenessStatus).toBe('unsupported')
  })
})

describe('isReliabilityIncident (#989 — autoMonitor + null-impact excluded from Score)', () => {
  it('counts a real impactful incident; excludes null-impact and autoMonitor machine noise', () => {
    expect(isReliabilityIncident({ impact: 'critical' })).toBe(true)
    expect(isReliabilityIncident({ impact: 'minor' })).toBe(true)
    expect(isReliabilityIncident({ impact: null })).toBe(false)                            // #707/#261 advisory
    expect(isReliabilityIncident({ impact: 'critical', autoMonitor: true })).toBe(false)   // #989 machine noise
    expect(isReliabilityIncident({ impact: 'major', autoMonitor: false })).toBe(true)      // explicit false = counts
  })

  it('a provider auto-monitor firing ~1 critical/day does NOT crater the Score (the Kimi case)', () => {
    // 30 daily `critical` autoMonitor blips — the Moonshot pattern. Without the #989 exclusion these
    // drive weightedAffectedDays ~30 and collapse the 25-pt Incidents component to ~1. The ONLY
    // difference between the two services below is the autoMonitor tag.
    const days = Array.from({ length: 30 }, (_, i) => {
      const d = new Date(Date.now() - (i + 1) * 86_400_000).toISOString()
      return {
        id: `am-${i}`, title: 'Agentic model error alert', status: 'resolved' as const,
        impact: 'critical' as const, autoMonitor: true, startedAt: d, resolvedAt: d, duration: '3m', timeline: [],
      }
    })
    const tagged = calculateAIWatchScore(makeSvc({ id: 'kimi', uptime30d: 99.98, incidents: days }), 30, probeUnsupported)
    const untagged = calculateAIWatchScore(
      makeSvc({ id: 'kimi', uptime30d: 99.98, incidents: days.map(({ autoMonitor, ...rest }) => rest) }),
      30, probeUnsupported,
    )
    // The tag rescues the Incidents component: near-full vs near-zero — proving the exclusion is what
    // does the work (not some incidental clamp).
    expect(tagged.breakdown.incidents).toBeGreaterThan(24)
    expect(untagged.breakdown.incidents).toBeLessThan(5)
    expect(tagged.score).not.toBeNull()
    expect(untagged.score).not.toBeNull()
    expect(tagged.score!).toBeGreaterThan(untagged.score! + 15)
  })

  it('excludes autoMonitor from Recovery/MTTR too — a paperwork-inflated duration must not tank recovery', () => {
    // Moonshot's auto-monitor leaves incidents open for HOURS (recorded ~11h median vs minutes of real
    // impact — the #1019 pattern). This guards the isReliabilityIncident use at the MTTR site
    // specifically: long durations move Recovery but NOT breakdown.incidents, so the prior test can't
    // see a mutation that reverts only that site. Same fixture tagged vs untagged.
    const longBlips = Array.from({ length: 5 }, (_, i) => {
      const d = new Date(Date.now() - (i + 1) * 86_400_000).toISOString()
      return {
        id: `lb-${i}`, title: 'Agentic model error alert', status: 'resolved' as const,
        impact: 'critical' as const, autoMonitor: true, startedAt: d, resolvedAt: d, duration: '11h 0m', timeline: [],
      }
    })
    const tagged = calculateAIWatchScore(makeSvc({ id: 'kimi', uptime30d: 99.98, incidents: longBlips }), 30, probeUnsupported)
    const untagged = calculateAIWatchScore(
      makeSvc({ id: 'kimi', uptime30d: 99.98, incidents: longBlips.map(({ autoMonitor, ...rest }) => rest) }),
      30, probeUnsupported,
    )
    expect(tagged.breakdown.recovery).toBeGreaterThan(14)  // excluded → no MTTR penalty → ~full 15
    expect(untagged.breakdown.recovery).toBeLessThan(2)    // 11h MTTR → recovery craters (~1)
    expect(tagged.breakdown.recovery - untagged.breakdown.recovery).toBeGreaterThan(12) // the tag does the work
  })
})
