// Alert detection logic — pure functions for testability
// Used by cronAlertCheck in index.ts

import { getFallbacks, buildFallbackText } from './fallback'
import { sanitize } from './utils'
import type { ServiceStatus } from './services'

export interface AlertCandidate {
  key: string
  title: string
  description: string
  color: number
  url: string
}

export interface ScoredService extends ServiceStatus {
  aiwatchScore?: number | null
  scoreGrade?: string | null
}

/**
 * Build incident alerts (new + resolved) from service data.
 * Does NOT check KV dedup — caller is responsible for filtering already-sent alerts.
 * @param alertedNewIds Set of incident IDs that were previously alerted as new
 */
export function buildIncidentAlerts(
  services: ScoredService[],
  alertedNewIds: Set<string>,
  now: number = Date.now(),
): AlertCandidate[] {
  const alerts: AlertCandidate[] = []

  for (const svc of services) {
    for (const inc of svc.incidents ?? []) {
      const incAge = now - new Date(inc.startedAt).getTime()
      if (incAge > 86_400_000) continue

      if (inc.status !== 'resolved' && !alertedNewIds.has(inc.id)) {
        alerts.push({
          key: `alerted:new:${inc.id}`,
          title: `🔴 ${svc.name} — New Incident`,
          description: `${sanitize(inc.title)}\n${buildFallbackText(getFallbacks(svc.id, svc.category, services))}`,
          color: 0xED4245,
          url: `https://ai-watch.dev/#${svc.id}`,
        })
      } else if (inc.status === 'resolved' && alertedNewIds.has(inc.id)) {
        const durationText = inc.duration ? ` (${inc.duration})` : ''
        alerts.push({
          key: `alerted:res:${inc.id}`,
          title: `🟢 ${svc.name} — Incident Resolved${durationText}`,
          description: sanitize(inc.title),
          color: 0x57F287,
          url: `https://ai-watch.dev/#${svc.id}`,
        })
      }
    }
  }

  return alerts
}

/**
 * Build service status change alerts (degraded/down/recovered).
 * Suppresses status alerts when ongoing incidents already cover the service.
 * @param alertedDownIds Set of service IDs previously alerted as down
 * @param alertedDegradedIds Set of service IDs previously alerted as degraded
 */
export function buildServiceAlerts(
  services: ScoredService[],
  alertedDownIds: Set<string>,
  alertedDegradedIds: Set<string> = new Set(),
): AlertCandidate[] {
  const alerts: AlertCandidate[] = []

  for (const svc of services) {
    // Suppress status alerts if ongoing incidents exist (incident alert already covers it)
    const hasOngoingIncident = (svc.incidents ?? []).some((i) => i.status !== 'resolved')

    if (svc.status === 'down' && !hasOngoingIncident) {
      alerts.push({
        key: `alerted:down:${svc.id}`,
        title: `🔴 ${svc.name} — Service Down`,
        description: `**${svc.name}** (${svc.provider})`,
        color: 0xED4245,
        url: `https://ai-watch.dev/#${svc.id}`,
      })
    }
    if (svc.status === 'degraded' && !hasOngoingIncident) {
      alerts.push({
        key: `alerted:degraded:${svc.id}`,
        title: `🟠 ${svc.name} — Partially Degraded`,
        description: `**${svc.name}** (${svc.provider})`,
        color: 0xE86235,
        url: `https://ai-watch.dev/#${svc.id}`,
      })
    }
    if (svc.status === 'operational' && (alertedDownIds.has(svc.id) || alertedDegradedIds.has(svc.id))) {
      alerts.push({
        key: `alerted:recovered:${svc.id}`,
        title: `🟢 ${svc.name} — Service Recovered`,
        description: `**${svc.name}** is back to operational`,
        color: 0x57F287,
        url: `https://ai-watch.dev/#${svc.id}`,
      })
    }
  }

  return alerts
}
