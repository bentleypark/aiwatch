// Alert detection logic — pure functions for testability
// Used by cronAlertCheck in index.ts

import { getFallbacks, buildFallbackText } from './fallback'
import { sanitize, formatDuration } from './utils'
import { computeLeadMs } from './detection-lead-log'
import type { ServiceStatus } from './services'
import type { Incident } from './types'

// #283: Discord alert flap suppression for BetterStack auto-recovery noise.
// BetterStack-backed feeds emit paired "<model> — down" / "<model> — recovered" incidents
// per transient blip; a single model can produce ~2 Discord alerts × 10-14 flaps/day.
// Opt-in per ServiceConfig (flapSuppression: true). Tier-1 services (claude/openai/gemini)
// are excluded as defense-in-depth — their alert volume is low and suppressing a real
// outage would be costly.
//
// Flow: first flap's down + res alerts both fire normally; flap KV key is written when
// the first flap's res alert fires. Subsequent flaps (same normalized title, within 60min)
// are suppressed on both down and res via suppressedIncIds passed to buildIncidentAlerts.
const TIER1_IDS = new Set(['claude', 'openai', 'gemini'])

// BetterStack emits the literal em-dash (U+2014); guard against both "— recovered" and
// "— down" since a flap cycle can be caught mid-state, and the suppression window should
// cover both halves.
const FLAP_TITLE_RE = /\s*—\s*(down|recovered)\s*$/

/** Matches either half of a BetterStack flap cycle. Null-impact only — real incidents tagged with severity are never treated as flaps. */
export function isFlapNotice(inc: Incident): boolean {
  if (inc.impact != null) return false
  return FLAP_TITLE_RE.test(inc.title)
}

export function normalizeFlapTitle(title: string): string {
  return title.replace(FLAP_TITLE_RE, '').trim()
}

/** KV key for a 60-min suppression window, scoped to svcId + normalized title. */
export function flapSuppressionKey(svcId: string, inc: Incident): string {
  return `alerted:flap:${svcId}:${normalizeFlapTitle(inc.title)}`
}

/**
 * Whether this incident should be considered for flap suppression.
 * Returning true means: caller should check the KV key; if the key exists, skip the
 * Discord alert; if not, send the alert AND write the key to start the window.
 */
export function isFlapSuppressible(
  svcId: string,
  config: { flapSuppression?: boolean },
  inc: Incident,
): boolean {
  if (TIER1_IDS.has(svcId)) return false
  if (!config.flapSuppression) return false
  return isFlapNotice(inc)
}

export interface AlertCandidate {
  key: string
  title: string
  description: string
  fallbackText?: string
  color: number
  url: string
  /** When alerts are merged (e.g., Together AI), contains all original dedup keys */
  _mergedKeys?: string[]
}

export interface ScoredService extends ServiceStatus {
  aiwatchScore?: number | null
  scoreGrade?: string | null
}

/**
 * Build incident alerts (new + resolved) from service data.
 * Does NOT check KV dedup — caller is responsible for filtering already-sent alerts.
 * @param alertedNewIds Set of incident IDs that were previously alerted as new
 * @param suppressedIncIds Set of incident IDs to silently drop (both new and resolved paths).
 *                        Used by #283 flap suppression to skip a repeat flap within the window.
 */
export function buildIncidentAlerts(
  services: ScoredService[],
  alertedNewIds: Set<string>,
  now: number = Date.now(),
  suppressedIncIds: Set<string> = new Set(),
): AlertCandidate[] {
  // Group services by incidentId to show all affected services in one alert
  const newIncidents = new Map<string, { names: string[]; ids: string[]; inc: Incident; category: string; firstSvc: ScoredService }>()
  const resolvedIncidents = new Map<string, { names: string[]; ids: string[]; inc: Incident; firstSvc: ScoredService }>()

  for (const svc of services) {
    for (const inc of svc.incidents ?? []) {
      if (suppressedIncIds.has(inc.id)) continue // #283 flap suppression — skip both new + resolved
      const incAge = now - new Date(inc.startedAt).getTime()
      if (incAge > 86_400_000) continue

      if (inc.status !== 'resolved' && !alertedNewIds.has(inc.id)) {
        const existing = newIncidents.get(inc.id)
        if (existing) {
          if (!existing.names.includes(svc.name)) existing.names.push(svc.name)
          if (!existing.ids.includes(svc.id)) existing.ids.push(svc.id)
        } else {
          newIncidents.set(inc.id, { names: [svc.name], ids: [svc.id], inc, category: svc.category, firstSvc: svc })
        }
      } else if (inc.status === 'resolved' && alertedNewIds.has(inc.id)) {
        const existing = resolvedIncidents.get(inc.id)
        if (existing) {
          if (!existing.names.includes(svc.name)) existing.names.push(svc.name)
          if (!existing.ids.includes(svc.id)) existing.ids.push(svc.id)
        } else {
          resolvedIncidents.set(inc.id, { names: [svc.name], ids: [svc.id], inc, firstSvc: svc })
        }
      }
    }
  }

  const alerts: AlertCandidate[] = []

  for (const [incId, { names, ids, inc, category, firstSvc }] of newIncidents) {
    const displayName = names.length > 1 ? `${firstSvc.provider} (${names.join(', ')})` : names[0]
    const fallbackText = firstSvc.status !== 'operational'
      ? buildFallbackText(getFallbacks(firstSvc.id, category, services))
      : ''
    alerts.push({
      key: `alerted:new:${incId}`,
      title: `🔴 ${displayName} — New Incident`,
      description: sanitize(inc.title),
      fallbackText,
      color: 0xED4245,
      url: `https://ai-watch.dev/#${ids[0]}`,
    })
  }

  for (const [incId, { names, ids, inc, firstSvc }] of resolvedIncidents) {
    const displayName = names.length > 1 ? `${firstSvc.provider} (${names.join(', ')})` : names[0]
    const durationText = inc.duration ? ` (${inc.duration})` : ''
    alerts.push({
      key: `alerted:res:${incId}`,
      title: `🟢 ${displayName} — Incident Resolved${durationText}`,
      description: sanitize(inc.title),
      color: 0x57F287,
      url: `https://ai-watch.dev/#${ids[0]}`,
    })
  }

  return alerts
}

/**
 * Merge concurrent Together AI model-level alerts into single grouped alerts.
 * Together AI reports individual model incidents (e.g., "FLUX.1 Krea [dev] — down").
 * When multiple models go down/recover in the same cron cycle, merge into one alert.
 * Non-Together alerts pass through unchanged.
 */
export function mergeTogetherAlerts(alerts: AlertCandidate[]): AlertCandidate[] {
  const together: AlertCandidate[] = []
  const rest: AlertCandidate[] = []

  for (const a of alerts) {
    if (a.title.startsWith('🔴 Together AI — New Incident') || a.title.startsWith('🟢 Together AI — Incident Resolved')) {
      together.push(a)
    } else {
      rest.push(a)
    }
  }

  if (together.length <= 1) return alerts

  // Group by alert type (new vs resolved)
  const newAlerts = together.filter(a => a.key.startsWith('alerted:new:'))
  const resAlerts = together.filter(a => a.key.startsWith('alerted:res:'))

  const merged: AlertCandidate[] = []

  if (newAlerts.length > 1) {
    const descriptions = newAlerts.map(a => a.description)
    merged.push({
      key: newAlerts[0].key,
      title: `🔴 Together AI — ${newAlerts.length} New Incidents`,
      description: descriptions.join('\n'),
      fallbackText: newAlerts[0].fallbackText,
      color: 0xED4245,
      url: 'https://ai-watch.dev/#together',
      _mergedKeys: newAlerts.map(a => a.key),
    })
  } else {
    merged.push(...newAlerts)
  }

  if (resAlerts.length > 1) {
    const descriptions = resAlerts.map(a => a.description)
    merged.push({
      key: resAlerts[0].key,
      title: `🟢 Together AI — ${resAlerts.length} Incidents Resolved`,
      description: descriptions.join('\n'),
      color: 0x57F287,
      url: 'https://ai-watch.dev/#together',
      _mergedKeys: resAlerts.map(a => a.key),
    })
  } else {
    merged.push(...resAlerts)
  }

  return [...rest, ...merged]
}

/**
 * Build service status change alerts (degraded/down/recovered).
 * Suppresses status alerts when ongoing incidents already cover the service.
 * @param alertedDownMap Map of service ID → ISO timestamp when alerted as down
 * @param alertedDegradedMap Map of service ID → ISO timestamp when alerted as degraded
 */
export function buildServiceAlerts(
  services: ScoredService[],
  alertedDownMap: Map<string, string>,
  alertedDegradedMap: Map<string, string> = new Map(),
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
    if (svc.status === 'operational' && (alertedDownMap.has(svc.id) || alertedDegradedMap.has(svc.id))) {
      // Calculate downtime from stored timestamp
      const alertedAt = alertedDownMap.get(svc.id) ?? alertedDegradedMap.get(svc.id)
      let downtimeText = ''
      if (alertedAt && alertedAt.length > 10) {
        const start = new Date(alertedAt)
        if (!isNaN(start.getTime()) && start.getTime() > 1_700_000_000_000) {
          downtimeText = ` (${formatDuration(start, new Date())})`
        }
      }
      // Include recent incident title in recovery alert if available
      const recentInc = (svc.incidents ?? []).filter(i => i.status === 'resolved').sort((a, b) => (b.resolvedAt ?? '').localeCompare(a.resolvedAt ?? '')).at(0)
      const incTitle = recentInc ? `\n> ${sanitize(recentInc.title).slice(0, 120)}` : ''
      alerts.push({
        key: `alerted:recovered:${svc.id}`,
        title: `🟢 ${svc.name} — Service Recovered${downtimeText}`,
        description: `**${svc.name}** is back to operational${incTitle}`,
        color: 0x57F287,
        url: `https://ai-watch.dev/#${svc.id}`,
      })
    }
  }

  return alerts
}

/**
 * Compute Detection Lead text for Discord alerts.
 * Returns formatted string if AIWatch detected the issue before the official report (1-59 min lead).
 * Capped at 59 minutes — longer leads likely indicate stale detection data (#189).
 */
export function formatDetectionLead(detectedAt: string | null, incidentStartedAt: string): string {
  if (!detectedAt) return ''
  // Use computeLeadMs as single source of truth — guarantees Discord display + audit log share the same window.
  // Math.floor (not round) ensures display never claims 60m when leadMs is in [59m30s, 60m) — the cap is exclusive.
  const leadMs = computeLeadMs(detectedAt, incidentStartedAt)
  if (leadMs === null) return ''
  const mins = Math.floor(leadMs / 60_000)
  return `⚡ **Detection Lead: ${mins}m** — AIWatch detected this before the official report`
}

/** Detect service count drop — returns missing service IDs if below threshold */
export function detectServiceCountDrop(
  returnedIds: string[],
  expectedConfigs: Array<{ id: string }>,
  thresholdRatio = 0.8,
): { dropped: boolean; missing: string[] } {
  const threshold = Math.floor(expectedConfigs.length * thresholdRatio)
  if (returnedIds.length >= threshold) return { dropped: false, missing: [] }
  const returnedSet = new Set(returnedIds)
  const missing = expectedConfigs.filter(c => !returnedSet.has(c.id)).map(c => c.id)
  return { dropped: true, missing }
}
