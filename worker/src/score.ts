// AIWatch Score — service reliability composite score (0-100)

import type { ServiceStatus } from './types'

export interface AIWatchScore {
  score: number | null
  grade: 'excellent' | 'good' | 'fair' | 'degrading' | 'unstable' | null
  confidence: 'high' | 'medium' | 'low'
  breakdown: {
    uptime: number | null
    incidents: number
    recovery: number
  }
  metrics: {
    uptimePct: number | null
    incidents30d: number
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

  // No data at all → score unavailable
  if (incidentCount === 0 && mttrHours === null && service.uptime30d == null) {
    return {
      score: null, grade: null, confidence: 'low',
      breakdown: { uptime: null, incidents: 30, recovery: 20 },
      metrics: { uptimePct: null, incidents30d: 0, mttrHours: null },
    }
  }

  // uptime_score (0-50): 95% baseline
  const hasUptime = service.uptime30d != null
  let uptimeScore: number | null = null
  if (hasUptime) {
    uptimeScore = Math.max(0, Math.min(50, (service.uptime30d! / 100 - 0.95) / 0.05 * 50))
  }

  // incident_score (0-30): exponential decay, divisor 15
  const incidentScore = 30 * Math.exp(-incidentCount / 15)

  // recovery_score (0-20): exponential decay, divisor 4h
  const recoveryScore = mttrHours != null
    ? 20 * Math.exp(-mttrHours / 4)
    : incidentCount > 0 ? 0 : 20 // Unresolved incidents = no recovery credit

  // Total score
  let score: number
  let confidence: 'high' | 'medium' | 'low'

  if (hasUptime) {
    score = uptimeScore! + incidentScore + recoveryScore
    confidence = 'high'
  } else {
    // No uptime data → assume industry average (99.5% = 45pts) + 10% penalty
    const assumedUptime = 45 // 99.5% baseline assumption
    score = (assumedUptime + incidentScore + recoveryScore) * 0.9
    confidence = 'medium'
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
    },
    metrics: {
      uptimePct: service.uptime30d ?? null,
      incidents30d: incidentCount,
      mttrHours: mttrHours != null ? Math.round(mttrHours * 10) / 10 : null,
    },
  }
}
