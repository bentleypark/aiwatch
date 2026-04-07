// AIWatch Score — service reliability composite score (0-100)

import type { ServiceStatus } from './types'

// Responsiveness reference values (calibrated against 4-day probe data 2026-04-02~05)
export const REFERENCE_MS = 400   // p50 RTT reference for exponential decay
export const REFERENCE_CV = 0.5   // combined CV reference for stability decay

export interface AIWatchScore {
  score: number
  grade: 'excellent' | 'good' | 'fair' | 'degrading' | 'unstable'
  confidence: 'high' | 'medium' | 'low'
  breakdown: {
    uptime: number | null
    incidents: number
    recovery: number
    responsiveness: number | null
  }
  metrics: {
    uptimePct: number | null
    incidents30d: number
    affectedDays30d: number
    mttrHours: number | null
  }
}

function parseDurationMin(d: string): number {
  if (!d) return 0
  const h = d.includes('h') ? parseInt(d.split('h')[0]) : 0
  const afterH = d.includes('h') ? d.split('h')[1]?.trim() : d
  const m = afterH && afterH.includes('m') ? parseInt(afterH.replace('m', '').trim()) : 0
  return h * 60 + m
}

function scoreToGrade(score: number): 'excellent' | 'good' | 'fair' | 'degrading' | 'unstable' {
  if (score >= 85) return 'excellent'
  if (score >= 70) return 'good'
  if (score >= 55) return 'fair'
  if (score >= 40) return 'degrading'
  return 'unstable'
}

export function calculateAIWatchScore(service: ServiceStatus, cutoffDays = 30): AIWatchScore {
  const cutoff = new Date(Date.now() - cutoffDays * 86_400_000).toISOString()
  const incidents30d = (service.incidents ?? []).filter((i) => i.startedAt >= cutoff)
  const incidentCount = incidents30d.length

  // Affected days: unique dates with incidents (component-structure agnostic)
  const affectedDays = new Set(incidents30d.map((i) => i.startedAt.slice(0, 10))).size

  // MTTR calculation (resolved incidents with positive duration only)
  const durations = incidents30d
    .filter((i) => i.status === 'resolved' && i.duration)
    .map((i) => parseDurationMin(i.duration!))
    .filter((m) => m > 0)

  let mttrHours: number | null = null
  if (durations.length >= 3) {
    // Median for 3+ samples (reduces outlier influence)
    durations.sort((a, b) => a - b)
    mttrHours = durations[Math.floor(durations.length / 2)] / 60
  } else if (durations.length > 0) {
    mttrHours = (durations.reduce((s, v) => s + v, 0) / durations.length) / 60
  }

  // uptime_score (0-40): 95% baseline (was 0-50, redistributed for Responsiveness)
  const hasUptime = service.uptime30d != null
  let uptimeScore: number | null = null
  if (hasUptime) {
    uptimeScore = Math.max(0, Math.min(40, (service.uptime30d! / 100 - 0.95) / 0.05 * 40))
  }

  // incident_score (0-25): exponential decay based on affected days (was 0-30)
  const incidentScore = 25 * Math.exp(-affectedDays / 10)

  // recovery_score (0-15): exponential decay, divisor 4h (was 0-20)
  const recoveryScore = mttrHours != null
    ? 15 * Math.exp(-mttrHours / 4)
    : incidentCount > 0 ? 0 : 15 // Unresolved incidents = no recovery credit

  // responsiveness_score (0-20): probe-based speed + stability
  const probe = service.probeSummary
  let responsivenessScore: number | null = null
  if (probe) {
    const p50 = Number.isFinite(probe.p50) && probe.p50 >= 0 ? probe.p50 : null
    const cv = Number.isFinite(probe.cvCombined) && probe.cvCombined >= 0 ? probe.cvCombined : null
    if (p50 !== null && cv !== null) {
      // Speed (0-10): exponential decay — lower RTT = higher score
      const speedScore = 10 * Math.exp(-p50 / REFERENCE_MS)
      // Stability (0-10): exponential decay — lower CV = higher score
      const stabilityScore = 10 * Math.exp(-cv / REFERENCE_CV)
      responsivenessScore = Math.round((speedScore + stabilityScore) * 10) / 10
    }
  }

  // Total score
  let score: number
  let confidence: 'high' | 'medium' | 'low'

  const isEstimate = service.uptimeSource === 'estimate'
  const baseScore = (uptimeScore ?? 0) + incidentScore + recoveryScore

  if (probe && responsivenessScore != null) {
    // Full formula: all 4 components
    const raw = baseScore + responsivenessScore
    if (hasUptime && !isEstimate) {
      score = raw
      confidence = 'high'
    } else if (hasUptime && isEstimate) {
      score = raw * 0.9
      confidence = 'medium'
    } else {
      const assumedUptime = 36 // (0.995 - 0.95) / 0.05 * 40
      score = (assumedUptime + incidentScore + recoveryScore + responsivenessScore) * 0.9
      confidence = 'medium'
    }
  } else {
    // No probe data — redistribute 80→100 with 5% cap penalty (max 95)
    // Prevents score inversion where probe-less services outscore probed ones
    const maxWithoutProbe = 40 + 25 + 15 // = 80
    const NO_PROBE_PENALTY = 0.95
    if (hasUptime && !isEstimate) {
      score = (baseScore / maxWithoutProbe) * 100 * NO_PROBE_PENALTY
      confidence = 'low'
    } else if (hasUptime && isEstimate) {
      score = (baseScore / maxWithoutProbe) * 100 * 0.9 * NO_PROBE_PENALTY
      confidence = 'low'
    } else {
      const assumedUptime = 36
      score = ((assumedUptime + incidentScore + recoveryScore) / maxWithoutProbe) * 100 * 0.9 * NO_PROBE_PENALTY
      confidence = 'low'
    }
  }

  // Post-processing
  score = Math.round(Math.max(0, Math.min(100, score)))
  if (score < 1) score = 0

  return {
    score,
    grade: scoreToGrade(score),
    confidence,
    breakdown: {
      uptime: uptimeScore != null ? Math.round(uptimeScore * 10) / 10 : null,
      incidents: Math.round(incidentScore * 10) / 10,
      recovery: Math.round(recoveryScore * 10) / 10,
      responsiveness: responsivenessScore,
    },
    metrics: {
      uptimePct: service.uptime30d ?? null,
      incidents30d: incidentCount,
      affectedDays30d: affectedDays,
      mttrHours: mttrHours != null ? Math.round(mttrHours * 10) / 10 : null,
    },
  }
}
