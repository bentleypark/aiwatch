// Daily Summary — expanded Discord report at UTC 09:00 (KST 18:00)

import type { ServiceStatus } from './types'
import type { ProbeSnapshot } from './probe'
import type { VitalsDaily } from './vitals'
import type { DetectionLeadEntry } from './detection-lead-log'
import { formatVitalsSection } from './vitals'
import { aggregateProbeDaily } from './probe-archival'
import { formatDetectionLeadSection } from './detection-lead-log'

export interface DailySummaryData {
  services: ServiceStatus[]
  aiUsage: { calls: number; success: number; failed: number; gemma?: number; sonnet?: number } | null
  latencySnapshots: Array<{ t: string; data: Record<string, number> }>
  incidentCountToday: { newCount: number; resolvedCount: number }
  alertCounts?: { incidents: number; resolved: number; down: number; degraded: number; recovered: number } | null
  webhookCounts?: { discord: number; slack: number }
  deliveryCounts?: { discord: number; slack: number; failed: number } | null
  redditCount: number
  securityCount?: number
  vitals?: VitalsDaily | null
  probeSnapshots?: ProbeSnapshot[]
  detectionLeadEntries?: DetectionLeadEntry[]
}

export function buildDailySummary(data: DailySummaryData): string {
  const { services, aiUsage, latencySnapshots, incidentCountToday, alertCounts, webhookCounts, deliveryCounts, redditCount, vitals, detectionLeadEntries } = data
  const total = services.length
  const operational = services.filter(s => s.status === 'operational').length
  const degraded = services.filter(s => s.status === 'degraded').length
  const down = services.filter(s => s.status === 'down').length

  const lines: string[] = []

  // Section 1: Service overview
  const statusParts = [`${operational} operational`]
  if (degraded > 0) statusParts.push(`${degraded} degraded`)
  if (down > 0) statusParts.push(`${down} down`)
  lines.push(`📡 **Services**: ${total} monitored · ${statusParts.join(' · ')}`)

  // Section 2: Active issues
  const activeIssues = services.filter(s => s.status !== 'operational')
  if (activeIssues.length > 0) {
    const issueList = activeIssues.map(s => {
      const activeInc = (s.incidents ?? []).find(i => i.status !== 'resolved')
      const status = activeInc ? activeInc.status : s.status
      const duration = activeInc ? formatDurationFromStart(activeInc.startedAt) : ''
      return `${s.status === 'down' ? '🔴' : '🟡'} ${s.name} (${status}${duration ? `, ${duration}` : ''})`
    }).join('\n')
    lines.push(`\n🔔 **Active Issues**\n${issueList}`)
  }

  // Section 3: AI Analysis usage
  if (aiUsage && aiUsage.calls > 0) {
    const gemma = aiUsage.gemma ?? 0
    const sonnet = aiUsage.sonnet ?? 0
    const sonnetCost = (sonnet * 0.006).toFixed(3)
    const modelBreakdown = gemma || sonnet ? ` (Gemma: ${gemma}, Sonnet: ${sonnet})` : ''
    lines.push(`\n🤖 **AI Analysis Usage**\n   Today: ${aiUsage.calls} calls (${aiUsage.success} success, ${aiUsage.failed} failed)${modelBreakdown}\n   Est. cost: $${sonnetCost} (Sonnet only)`)
  }

  // Section 4: Uptime Best/Worst (exclude estimate-only services — misleading 100%)
  const withUptime = services.filter(s => s.uptime30d != null && !isNaN(s.uptime30d!) && !(s.uptimeSource === 'estimate' && (s.incidents ?? []).length === 0))
  if (withUptime.length >= 3) {
    const sorted = [...withUptime].sort((a, b) => (b.uptime30d ?? 0) - (a.uptime30d ?? 0))
    const best = sorted.slice(0, 2).map(s => `${s.name} ${s.uptime30d!.toFixed(2)}%`).join(' · ')
    const worst = sorted.slice(-2).reverse().map(s => `${s.name} ${s.uptime30d!.toFixed(2)}%`).join(' · ')
    lines.push(`\n📈 **Uptime (30d)**\n   Best: ${best}\n   Worst: ${worst}`)
  }

  // Section 5: Probe RTT (24h) — replaces status page latency with direct API endpoint measurement
  const probeSnaps = data.probeSnapshots ?? []
  if (probeSnaps.length > 0) {
    // TODO(#132): pass incident windows to exclude RTT during outages — see probe-archival.ts:202
    const probeDaily = aggregateProbeDaily(probeSnaps)
    const probeEntries = Object.entries(probeDaily).filter(([, v]) => v.p75 > 0)
    if (probeEntries.length >= 3) {
      const sorted = probeEntries.sort((a, b) => a[1].p75 - b[1].p75)
      const nameMap = new Map(services.map(s => [s.id, s.name]))
      const fastest = sorted.slice(0, 3).map(([id, s]) => `${nameMap.get(id) ?? id} ${s.p75}ms`).join(' · ')
      const slowest = sorted.slice(-2).reverse().map(([id, s]) => `${nameMap.get(id) ?? id} ${s.p75}ms`).join(' · ')
      const spikeServices = probeEntries.filter(([, s]) => s.spikes > 0)
      const spikeLine = spikeServices.length > 0
        ? `\n   Spikes: ${spikeServices.map(([id, s]) => `${nameMap.get(id) ?? id} (${s.spikes})`).join(', ')}`
        : ''
      lines.push(`\n⚡ **API Response Time (p75)**\n   Fastest: ${fastest}\n   Slowest: ${slowest}${spikeLine}`)
    }
  } else {
    // Fallback to status page latency if no probe data
    const latencyAvg = computeLatencyAvg(latencySnapshots)
    const latencyEntries = Object.entries(latencyAvg).filter(([, v]) => v > 0)
    if (latencyEntries.length >= 3) {
      const sorted = latencyEntries.sort((a, b) => a[1] - b[1])
      const nameMap = new Map(services.map(s => [s.id, s.name]))
      const fastest = sorted.slice(0, 2).map(([id, ms]) => `${nameMap.get(id) ?? id} ${Math.round(ms)}ms`).join(' · ')
      const slowest = sorted.slice(-2).reverse().map(([id, ms]) => `${nameMap.get(id) ?? id} ${Math.round(ms)}ms`).join(' · ')
      lines.push(`\n⚡ **Latency (24h avg)**\n   Fastest: ${fastest}\n   Slowest: ${slowest}`)
    }
  }

  // Section 6: Daily alert count + Reddit
  if (alertCounts) {
    const total = alertCounts.incidents + alertCounts.resolved + alertCounts.down + alertCounts.degraded + alertCounts.recovered
    if (total > 0) {
      const parts: string[] = []
      if (alertCounts.incidents > 0) parts.push(`${alertCounts.incidents} incidents`)
      if (alertCounts.resolved > 0) parts.push(`${alertCounts.resolved} resolved`)
      if (alertCounts.down > 0) parts.push(`${alertCounts.down} down`)
      if (alertCounts.degraded > 0) parts.push(`${alertCounts.degraded} degraded`)
      if (alertCounts.recovered > 0) parts.push(`${alertCounts.recovered} recovered`)
      lines.push(`\n📬 **Alerts Sent Today**: ${total} (${parts.join(', ')})`)
    }
  } else {
    // Fallback: use current cron cycle counts
    const incParts: string[] = []
    if (incidentCountToday.newCount > 0) incParts.push(`${incidentCountToday.newCount} new`)
    if (incidentCountToday.resolvedCount > 0) incParts.push(`${incidentCountToday.resolvedCount} resolved`)
    if (incParts.length > 0) lines.push(`\n📬 **Alerts Sent Today**: ${incParts.join(' · ')}`)
  }
  if (deliveryCounts && (deliveryCounts.discord > 0 || deliveryCounts.slack > 0 || deliveryCounts.failed > 0)) {
    const parts: string[] = []
    if (deliveryCounts.discord > 0) parts.push(`${deliveryCounts.discord} Discord`)
    if (deliveryCounts.slack > 0) parts.push(`${deliveryCounts.slack} Slack`)
    const failText = deliveryCounts.failed > 0 ? ` (${deliveryCounts.failed} failed)` : ''
    lines.push(`📨 **User Webhook Delivery**: ${parts.join(', ')}${failText}`)
  }
  if (webhookCounts) {
    const total = webhookCounts.discord + webhookCounts.slack
    if (total > 0) {
      const parts: string[] = []
      if (webhookCounts.discord > 0) parts.push(`${webhookCounts.discord} Discord`)
      if (webhookCounts.slack > 0) parts.push(`${webhookCounts.slack} Slack`)
      lines.push(`🔗 **Active Webhooks**: ${parts.join(', ')}`)
    } else {
      lines.push(`🔗 **Active Webhooks**: 0`)
    }
  }
  if (redditCount > 0) lines.push(`📢 **Reddit**: ${redditCount} posts detected`)
  if (data.securityCount && data.securityCount > 0) lines.push(`🔒 **Security**: ${data.securityCount} alerts detected`)

  // Section: Web Vitals
  if (vitals && vitals.count > 0) {
    lines.push(formatVitalsSection(vitals))
  }

  // Section: Detection Lead audit log (today's events) — verifies the feature is working day-to-day
  if (detectionLeadEntries && detectionLeadEntries.length > 0) {
    const nameMap = new Map(services.map(s => [s.id, s.name]))
    const section = formatDetectionLeadSection(detectionLeadEntries, nameMap)
    if (section) lines.push(section)
  }

  return lines.join('\n')
}

/**
 * Check if the current time falls within a daily summary window.
 * Normal window: UTC 09:00-09:04. Catch-up window: UTC 10:00-10:04.
 * Pure function — KV dedup is handled separately by the caller.
 */
export function isInSummaryWindow(
  utcHours: number,
  utcMinutes: number,
): { inWindow: boolean; isCatchUp: boolean } {
  const isNormalWindow = utcHours === 9 && utcMinutes < 5
  const isCatchUpWindow = utcHours === 10 && utcMinutes < 5
  if (!isNormalWindow && !isCatchUpWindow) return { inWindow: false, isCatchUp: false }
  return { inWindow: true, isCatchUp: !isNormalWindow }
}

function formatDurationFromStart(startedAt: string): string {
  const diff = Date.now() - new Date(startedAt).getTime()
  if (isNaN(diff) || diff < 0) return ''
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  const days = Math.floor(hrs / 24)
  return `${days}d`
}

export function computeLatencyAvg(snapshots: Array<{ t: string; data: Record<string, number> }>): Record<string, number> {
  const sums: Record<string, number> = {}
  const counts: Record<string, number> = {}
  for (const snap of snapshots) {
    for (const [id, ms] of Object.entries(snap.data)) {
      sums[id] = (sums[id] ?? 0) + ms
      counts[id] = (counts[id] ?? 0) + 1
    }
  }
  const avg: Record<string, number> = {}
  for (const id of Object.keys(sums)) {
    avg[id] = sums[id] / counts[id]
  }
  return avg
}
