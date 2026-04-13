import { describe, it, expect } from 'vitest'
import { calculateAIWatchScore } from '../score'
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
  it('returns 100 for perfect service (100% uptime, 0 incidents)', () => {
    const result = calculateAIWatchScore(makeSvc({ uptime30d: 100 }))
    expect(result.score).toBe(100)
    expect(result.grade).toBe('excellent')
    expect(result.confidence).toBe('high')
  })

  it('calculates uptime_score with 95% baseline', () => {
    const r100 = calculateAIWatchScore(makeSvc({ uptime30d: 100 }))
    const r99 = calculateAIWatchScore(makeSvc({ uptime30d: 99 }))
    const r95 = calculateAIWatchScore(makeSvc({ uptime30d: 95 }))
    const r90 = calculateAIWatchScore(makeSvc({ uptime30d: 90 }))

    expect(r100.breakdown.uptime).toBe(50)
    expect(r99.breakdown.uptime).toBe(40)
    expect(r95.breakdown.uptime).toBe(0)
    expect(r90.breakdown.uptime).toBe(0) // clamped
  })

  it('calculates incident_score based on affected days (not raw count)', () => {
    const r0 = calculateAIWatchScore(makeSvc())
    // 5 incidents on 5 different days
    const r5days = calculateAIWatchScore(makeSvc({ incidents: Array.from({ length: 5 }, (_, i) => makeIncident(i + 1)) }))
    // 5 incidents on same day → 1 affected day
    const r5same = calculateAIWatchScore(makeSvc({ incidents: Array.from({ length: 5 }, () => makeIncident(1)) }))

    expect(r0.breakdown.incidents).toBe(30)
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

    expect(noUptime.confidence).toBe('medium')
    expect(noUptime.breakdown.uptime).toBeNull()
    expect(noUptime.score!).toBeLessThan(withUptime.score!)
  })

  it('returns estimated score when no uptime and no incidents (assumed industry average)', () => {
    const result = calculateAIWatchScore(makeSvc({ uptime30d: null, incidents: [] }))
    // (45 + 30 + 20) * 0.9 = 85.5 → 86
    expect(result.score).toBe(86)
    expect(result.grade).toBe('excellent')
    expect(result.confidence).toBe('medium')
    expect(result.breakdown.uptime).toBeNull()
  })

  it('applies 0.9 penalty for estimate uptimeSource', () => {
    const official = calculateAIWatchScore(makeSvc({ uptime30d: 99.5 }))
    const estimate = calculateAIWatchScore(makeSvc({ uptime30d: 99.5, uptimeSource: 'estimate' }))

    expect(estimate.confidence).toBe('medium')
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

  it('recovery_score is 20 when no resolved incidents', () => {
    const result = calculateAIWatchScore(makeSvc({ incidents: [] }))
    expect(result.breakdown.recovery).toBe(20)
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
})
