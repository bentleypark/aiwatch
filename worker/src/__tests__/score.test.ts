import { describe, it, expect } from 'vitest'
import { calculateAIWatchScore, REFERENCE_MS, REFERENCE_CV, P50_FLOOR_MS } from '../score'
import type { ServiceStatus } from '../types'

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

describe('calculateAIWatchScore', () => {
  // ── Probe-less services (Responsiveness N/A, 80→100 redistribution) ──

  it('returns 95 for perfect service without probe data (redistribution × 0.95 cap)', () => {
    const result = calculateAIWatchScore(makeSvc({ uptime30d: 100 }))
    // (40 + 25 + 15) / 80 * 100 * 0.95 = 95
    expect(result.score).toBe(95)
    expect(result.grade).toBe('excellent')
    expect(result.confidence).toBe('low') // no probe data
    expect(result.breakdown.responsiveness).toBeNull()
  })

  it('calculates uptime_score with 95% baseline (max 40)', () => {
    const r100 = calculateAIWatchScore(makeSvc({ uptime30d: 100 }))
    const r99 = calculateAIWatchScore(makeSvc({ uptime30d: 99 }))
    const r95 = calculateAIWatchScore(makeSvc({ uptime30d: 95 }))
    const r90 = calculateAIWatchScore(makeSvc({ uptime30d: 90 }))

    expect(r100.breakdown.uptime).toBe(40)
    expect(r99.breakdown.uptime).toBe(32)
    expect(r95.breakdown.uptime).toBe(0)
    expect(r90.breakdown.uptime).toBe(0) // clamped
  })

  it('calculates incident_score based on affected days (max 25)', () => {
    const r0 = calculateAIWatchScore(makeSvc())
    // 5 incidents on 5 different days
    const r5days = calculateAIWatchScore(makeSvc({ incidents: Array.from({ length: 5 }, (_, i) => makeIncident(i + 1)) }))
    // 5 incidents on same day → 1 affected day
    const r5same = calculateAIWatchScore(makeSvc({ incidents: Array.from({ length: 5 }, () => makeIncident(1)) }))

    expect(r0.breakdown.incidents).toBe(25)
    expect(r5days.breakdown.incidents).toBeLessThan(r5same.breakdown.incidents) // more days = lower score
    expect(r5same.metrics.affectedDays30d).toBe(1) // same day deduped
    expect(r5days.metrics.affectedDays30d).toBe(5)
  })

  it('uses median MTTR for 3+ samples', () => {
    const incidents = [
      makeIncident(1, '30m'),
      makeIncident(2, '1h 0m'),
      makeIncident(3, '10h 0m'), // outlier
    ]
    const result = calculateAIWatchScore(makeSvc({ incidents }))
    // Median of [30, 60, 600] = 60 min = 1h
    expect(result.metrics.mttrHours).toBe(1)
  })

  it('uses mean MTTR for <3 samples', () => {
    const incidents = [makeIncident(1, '2h 0m'), makeIncident(2, '4h 0m')]
    const result = calculateAIWatchScore(makeSvc({ incidents }))
    // Mean of [120, 240] = 180 min = 3h
    expect(result.metrics.mttrHours).toBe(3)
  })

  it('applies fallback + 0.9 penalty when uptime is null', () => {
    const withUptime = calculateAIWatchScore(makeSvc({ uptime30d: 100, incidents: [makeIncident(1)] }))
    const noUptime = calculateAIWatchScore(makeSvc({ uptime30d: null, incidents: [makeIncident(1)] }))

    expect(noUptime.confidence).toBe('low')
    expect(noUptime.breakdown.uptime).toBeNull()
    expect(noUptime.score!).toBeLessThan(withUptime.score!)
  })

  it('returns estimated score when no uptime and no incidents', () => {
    const result = calculateAIWatchScore(makeSvc({ uptime30d: null, incidents: [] }))
    // No probe: ((36 + 25 + 15) / 80) * 100 * 0.9 * 0.95 = 95 * 0.9 * 0.95 = 81.225 → 81
    expect(result.score).toBe(81)
    expect(result.grade).toBe('good')
    expect(result.confidence).toBe('low')
    expect(result.breakdown.uptime).toBeNull()
  })

  it('applies 0.9 penalty for estimate uptimeSource', () => {
    const official = calculateAIWatchScore(makeSvc({ uptime30d: 99.5 }))
    const estimate = calculateAIWatchScore(makeSvc({ uptime30d: 99.5, uptimeSource: 'estimate' }))

    expect(estimate.confidence).toBe('low')
    expect(estimate.score!).toBeLessThan(official.score!)
    expect(estimate.score).toBe(Math.round(official.score! * 0.9))
  })

  it('never returns null score for any input combination', () => {
    const cases = [
      makeSvc({ uptime30d: null, incidents: [] }),
      makeSvc({ uptime30d: null, incidents: [makeIncident(1)] }),
      makeSvc({ uptime30d: 0, incidents: [] }),
      makeSvc({ uptime30d: 100, incidents: [] }),
    ]
    for (const svc of cases) {
      const result = calculateAIWatchScore(svc)
      expect(result.score).not.toBeNull()
      expect(result.grade).not.toBeNull()
    }
  })

  it('filters incidents to 30 days only', () => {
    const oldIncident = makeIncident(60) // 60 days ago
    const recentIncident = makeIncident(5)
    const result = calculateAIWatchScore(makeSvc({ incidents: [oldIncident, recentIncident] }))
    expect(result.metrics.incidents30d).toBe(1)
  })

  it('clamps score between 0 and 100', () => {
    const result = calculateAIWatchScore(makeSvc({ uptime30d: 100 }))
    expect(result.score).toBeLessThanOrEqual(100)
    expect(result.score).toBeGreaterThanOrEqual(0)
  })

  it('assigns correct grades', () => {
    expect(calculateAIWatchScore(makeSvc({ uptime30d: 100 })).grade).toBe('excellent')
    expect(calculateAIWatchScore(makeSvc({
      uptime30d: 99, incidents: Array.from({ length: 10 }, (_, i) => makeIncident(i + 1))
    })).grade).not.toBe('excellent')
  })

  it('recovery_score is 15 when no resolved incidents (max 15)', () => {
    const result = calculateAIWatchScore(makeSvc({ incidents: [] }))
    expect(result.breakdown.recovery).toBe(15)
  })

  it('handles duration edge cases correctly', () => {
    // "1h" without minutes
    const r1 = calculateAIWatchScore(makeSvc({ incidents: [makeIncident(1, '1h')] }))
    expect(r1.metrics.mttrHours).toBe(1)

    // "30m" without hours
    const r2 = calculateAIWatchScore(makeSvc({ incidents: [makeIncident(1, '30m')] }))
    expect(r2.metrics.mttrHours).toBe(0.5)

    // "2h 30m" standard
    const r3 = calculateAIWatchScore(makeSvc({ incidents: [makeIncident(1, '2h 30m')] }))
    expect(r3.metrics.mttrHours).toBe(2.5)
  })

  it('gives 0 recovery score for unresolved incidents', () => {
    const result = calculateAIWatchScore(makeSvc({
      incidents: [makeIncident(1, '1h 0m', 'investigating' as any)],
    }))
    expect(result.breakdown.recovery).toBe(0)
  })

  it('skips 0-duration incidents in MTTR', () => {
    const incidents = [makeIncident(1, '0m'), makeIncident(2, '2h 0m')]
    const result = calculateAIWatchScore(makeSvc({ incidents }))
    // Only 2h counted, 0m skipped
    expect(result.metrics.mttrHours).toBe(2)
  })

  // ── Responsiveness scoring (with probe data) ──

  it('includes Responsiveness when probeSummary is provided', () => {
    const result = calculateAIWatchScore(makeSvc({
      uptime30d: 100,
      probeSummary: { p50: 200, p95: 400, cvCombined: 0.3 },
    }))
    expect(result.breakdown.responsiveness).not.toBeNull()
    expect(result.breakdown.responsiveness!).toBeGreaterThan(0)
    expect(result.breakdown.responsiveness!).toBeLessThanOrEqual(20)
    expect(result.confidence).toBe('high') // official uptime + probe
  })

  it('scores fast + stable service higher than slow + volatile', () => {
    const fast = calculateAIWatchScore(makeSvc({
      uptime30d: 100,
      probeSummary: { p50: 50, p95: 100, cvCombined: 0.1 },
    }))
    const slow = calculateAIWatchScore(makeSvc({
      uptime30d: 100,
      probeSummary: { p50: 800, p95: 2000, cvCombined: 0.8 },
    }))
    expect(fast.breakdown.responsiveness!).toBeGreaterThan(slow.breakdown.responsiveness!)
    expect(fast.score).toBeGreaterThan(slow.score)
  })

  it('speed score uses exponential decay with REFERENCE_MS=400', () => {
    // At p50=0ms: speed = 10 (max)
    // At p50=400ms: speed = 10 * exp(-1) ≈ 3.68
    // At p50=800ms: speed = 10 * exp(-2) ≈ 1.35
    const veryFast = calculateAIWatchScore(makeSvc({
      uptime30d: 100,
      probeSummary: { p50: 10, p95: 20, cvCombined: 0 },
    }))
    const medium = calculateAIWatchScore(makeSvc({
      uptime30d: 100,
      probeSummary: { p50: 400, p95: 600, cvCombined: 0 },
    }))
    const slow = calculateAIWatchScore(makeSvc({
      uptime30d: 100,
      probeSummary: { p50: 800, p95: 1200, cvCombined: 0 },
    }))

    // Verify ordering and approximate values (speed + stability=10 since CV=0)
    expect(veryFast.breakdown.responsiveness!).toBeGreaterThan(18) // ~19.8
    expect(medium.breakdown.responsiveness!).toBeGreaterThan(12)   // ~13.7
    expect(medium.breakdown.responsiveness!).toBeLessThan(15)
    expect(slow.breakdown.responsiveness!).toBeGreaterThan(10)     // ~11.4
    expect(slow.breakdown.responsiveness!).toBeLessThan(13)
  })

  it('stability score uses exponential decay with REFERENCE_CV=0.5', () => {
    // At CV=0: stability = 10 (max)
    // At CV=0.5: stability = 10 * exp(-1) ≈ 3.68
    const stable = calculateAIWatchScore(makeSvc({
      uptime30d: 100,
      probeSummary: { p50: 200, p95: 300, cvCombined: 0.05 },
    }))
    const volatile = calculateAIWatchScore(makeSvc({
      uptime30d: 100,
      probeSummary: { p50: 200, p95: 300, cvCombined: 0.8 },
    }))
    expect(stable.breakdown.responsiveness!).toBeGreaterThan(volatile.breakdown.responsiveness!)
  })

  it('probe-less services use 80→100 redistribution with 0.95 cap', () => {
    // A service with 99% uptime, 0 incidents, no probe
    const noProbe = calculateAIWatchScore(makeSvc({ uptime30d: 99 }))
    // uptimeScore=32, incidents=25, recovery=15 → 72/80*100*0.95 = 85.5 → 86
    expect(noProbe.score).toBe(86)
    expect(noProbe.confidence).toBe('low')
    expect(noProbe.breakdown.responsiveness).toBeNull()
  })

  it('probe service with estimate uptime gets medium confidence', () => {
    const result = calculateAIWatchScore(makeSvc({
      uptime30d: 99.5,
      uptimeSource: 'estimate',
      probeSummary: { p50: 200, p95: 400, cvCombined: 0.3 },
    }))
    expect(result.confidence).toBe('medium')
  })

  it('probe service without uptime gets medium confidence', () => {
    const result = calculateAIWatchScore(makeSvc({
      uptime30d: null,
      probeSummary: { p50: 200, p95: 400, cvCombined: 0.3 },
    }))
    expect(result.confidence).toBe('medium')
  })

  it('reference constants are exported', () => {
    expect(REFERENCE_MS).toBe(400)
    expect(REFERENCE_CV).toBe(0.5)
    expect(P50_FLOOR_MS).toBe(50)
  })

  it('applies p50 floor: services below 50ms get same speed score', () => {
    const claude = calculateAIWatchScore(makeSvc({
      uptime30d: 100,
      probeSummary: { p50: 9, p95: 20, cvCombined: 0.1 },
    }))
    const gemini = calculateAIWatchScore(makeSvc({
      uptime30d: 100,
      probeSummary: { p50: 46, p95: 80, cvCombined: 0.1 },
    }))
    // Both below floor (50ms) → same speed component → same responsiveness
    expect(claude.breakdown.responsiveness).toBe(gemini.breakdown.responsiveness)
  })

  it('p50 floor does not affect services above 50ms', () => {
    const above = calculateAIWatchScore(makeSvc({
      uptime30d: 100,
      probeSummary: { p50: 200, p95: 400, cvCombined: 0.3 },
    }))
    const atFloor = calculateAIWatchScore(makeSvc({
      uptime30d: 100,
      probeSummary: { p50: 50, p95: 100, cvCombined: 0.3 },
    }))
    // 200ms should score lower speed than 50ms
    expect(atFloor.breakdown.responsiveness!).toBeGreaterThan(above.breakdown.responsiveness!)
  })

  // ── Edge cases: corrupted probe data ──

  it('ignores NaN probe values (falls back to probe-less scoring)', () => {
    const result = calculateAIWatchScore(makeSvc({
      uptime30d: 100,
      probeSummary: { p50: NaN, p95: 400, cvCombined: 0.3 },
    }))
    expect(result.breakdown.responsiveness).toBeNull()
    expect(result.confidence).toBe('low') // probe-less
    expect(result.score).toBe(95) // perfect service, redistributed × 0.95
  })

  it('ignores negative probe values (falls back to probe-less scoring)', () => {
    const result = calculateAIWatchScore(makeSvc({
      uptime30d: 100,
      probeSummary: { p50: -100, p95: 400, cvCombined: 0.3 },
    }))
    expect(result.breakdown.responsiveness).toBeNull()
    expect(result.confidence).toBe('low')
  })

  it('ignores Infinity probe values (falls back to probe-less scoring)', () => {
    const result = calculateAIWatchScore(makeSvc({
      uptime30d: 100,
      probeSummary: { p50: Infinity, p95: 400, cvCombined: 0.3 },
    }))
    expect(result.breakdown.responsiveness).toBeNull()
  })
})
