// Daily Summary — expanded Discord report at UTC 09:00 (KST 18:00)

import type { ServiceStatus } from './types'
import type { ProbeSnapshot } from './probe'
import type { VitalsDaily } from './vitals'
import { formatVitalsSection } from './vitals'
import { aggregateProbeDaily } from './probe-archival'
import { formatReportCountsSection } from './report'

// #679 — the "detection lead" (faster-than-official) metric was removed (structurally null — status-page
// polling is always later than the official publish; #464 already retired the framing). The RTT-degradation
// classifier below is the KEPT, separate part: it flags probe-spike degradations the official pages miss.
export type DegradationOutcome = 'degradation' | 'degradation_nostatus'

/** Classify a probe-spike degradation by whether the service's official status already reflects it.
 *  svcStatusOperational === true → the status page shows nothing → 'degradation_nostatus' (our edge).
 *  Pure + side-effect-free so the rising-edge decision is unit-testable; KV I/O stays in index.ts. */
export function classifyDegradation(svcStatusOperational: boolean): DegradationOutcome {
  return svcStatusOperational ? 'degradation_nostatus' : 'degradation'
}

export interface DailySummaryData {
  services: ServiceStatus[]
  aiUsage: { calls: number; success: number; failed: number; gemma?: number; sonnet?: number } | null
  latencySnapshots: Array<{ t: string; data: Record<string, number> }>
  incidentCountToday: { newCount: number; resolvedCount: number }
  alertCounts?: { incidents: number; resolved: number; down: number; degraded: number; recovered: number } | null
  // Discord-only since #467 — Slack moved to native /feed RSS (no per-user webhook registered or proxied).
  // #548 — newToday is the signed day-over-day delta of confirmed subscribers (null = no prior baseline).
  webhookCounts?: { discord: number; newToday?: number | null }
  deliveryCounts?: { discord: number; failed: number } | null
  redditCount: number
  securityCount?: number
  vitals?: VitalsDaily | null
  probeSnapshots?: ProbeSnapshot[]
  fetchFailureCounts?: Record<string, number>   // svcId → times degraded threshold hit today
  crossValidSuppressed?: Record<string, number> // svcId → times probe overrode to operational
  degradationCounts?: Record<string, number>          // svcId → RTT degradation spikes today (#464)
  degradationNoStatusCounts?: Record<string, number>  // svcId → degradations NOT on official status page
  // #518 — public API (/api/v1) traffic: last-24h counts (from WAE) + the running cumulative total
  // (folded into a permanent KV counter once/day). Absent (null) when the SQL API isn't configured.
  v1Traffic?: {
    today: { all: number; service: number; total: number }
    cumulative: number
    since: string
  } | null
  // #548 — feed-poll volume (last-24h, from WAE): the consent-free retention proxy. Absent (null)
  // when the SQL API isn't configured. No cumulative — the daily value (a post-outage step-up) is the signal.
  // `newItems` (#748) — incidents AIWatch first-detected in the 24h window (alert-worthy events),
  // distinct from the mostly-empty poll volume; absent when the KV read failed.
  feedTraffic?: { all: number; service: number; total: number; newItems?: number } | null
  // #575 Phase A — crowd "Report an issue" counts today (svcId → count). Internal demand signal
  // only (coverage priority); never a public "N reporting" verdict. Empty/absent → section omitted.
  reportCounts?: Record<string, number>
}

export function buildDailySummary(data: DailySummaryData): string {
  const { services, aiUsage, latencySnapshots, incidentCountToday, alertCounts, webhookCounts, deliveryCounts, redditCount, vitals, fetchFailureCounts, crossValidSuppressed, degradationCounts, degradationNoStatusCounts } = data
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

  // Section 4: Uptime Best/Worst — only services that report an official uptime%. #713: services with
  // no official uptime now leave `uptime30d` null (no estimate), so the null check alone excludes them.
  const withUptime = services.filter(s => s.uptime30d != null && !isNaN(s.uptime30d!))
  if (withUptime.length >= 3) {
    const sorted = [...withUptime].sort((a, b) => (b.uptime30d ?? 0) - (a.uptime30d ?? 0))
    const best = sorted.slice(0, 2).map(s => `${s.name} ${s.uptime30d!.toFixed(2)}%`).join(' · ')
    const worst = sorted.slice(-2).reverse().map(s => `${s.name} ${s.uptime30d!.toFixed(2)}%`).join(' · ')
    lines.push(`\n📈 **Uptime**\n   Best: ${best}\n   Worst: ${worst}`)
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
  if (deliveryCounts && (deliveryCounts.discord > 0 || deliveryCounts.failed > 0)) {
    const failText = deliveryCounts.failed > 0 ? ` (${deliveryCounts.failed} failed)` : ''
    lines.push(`📨 **User Webhook Delivery**: ${deliveryCounts.discord} Discord${failText}`)
  }
  if (webhookCounts) {
    lines.push(`🔗 **Active Discord Webhooks**: ${webhookCounts.discord}${formatSubscriberDelta(webhookCounts.newToday)}`)
  }
  if (redditCount > 0) lines.push(`📢 **Reddit**: ${redditCount} posts detected`)
  if (data.securityCount && data.securityCount > 0) lines.push(`🔒 **Security**: ${data.securityCount} alerts detected`)

  // Section: Web Vitals
  if (vitals && vitals.count > 0) {
    lines.push(formatVitalsSection(vitals))
  }

  // Section: Status page fetch failures (#500) — surfaces structural URL blocks early.
  // fetch-fail:daily = times the degraded threshold was hit today (transient: 1-2, structural: 5+).
  // cross-valid:suppressed = subset where probe confirmed the API was healthy (false positives caught).
  if (fetchFailureCounts && Object.keys(fetchFailureCounts).length > 0) {
    const nameMap = new Map(services.map(s => [s.id, s.name]))
    const items = Object.entries(fetchFailureCounts)
      .sort(([, a], [, b]) => b - a)
      .map(([id, total]) => {
        const suppressed = crossValidSuppressed?.[id] ?? 0
        const real = Math.max(0, total - suppressed)
        const detail = suppressed === total
          ? `all false positives — probe healthy`
          : suppressed > 0
            ? `${real} real, ${suppressed} probe-suppressed`
            : `${real} real`
        return `   ${nameMap.get(id) ?? id}: ${total}× threshold hit (${detail})`
      })
      .join('\n')
    lines.push(`\n⚠️ **Status Page Fetch Failures Today** (#500)\n${items}`)
  }

  // Section: RTT degradation detection (#464) — the honest differentiator that replaced the
  // unverifiable "faster than official" claim. probe-degradation:daily = every probe RTT spike;
  // :nostatus = the subset where the official status page showed nothing (our edge).
  const degSection = formatDegradationSection(degradationCounts, degradationNoStatusCounts, services)
  if (degSection) lines.push(degSection)

  // Section: public API (/api/v1) traffic (#518) — usage leading indicator for product decisions.
  const v1Section = formatV1TrafficSection(data.v1Traffic)
  if (v1Section) lines.push(v1Section)

  // Section: feed-poll volume (#548) — consent-free retention proxy (post-outage step-up = retained subs).
  const feedSection = formatFeedTrafficSection(data.feedTraffic)
  if (feedSection) lines.push(feedSection)

  // Section: crowd "Report an issue" counts (#575 Phase A) — internal demand signal only.
  if (data.reportCounts) {
    const nameOf = new Map(services.map((s) => [s.id, s.name]))
    const reportSection = formatReportCountsSection(data.reportCounts, (id) => nameOf.get(id) ?? id)
    if (reportSection) lines.push(reportSection)
  }

  return lines.join('\n')
}

// #548 — render the signed day-over-day subscriber delta as a compact suffix on the webhook line.
// Empty when null (no baseline) or 0 (no change) so the line stays clean. Unicode minus to match the
// brand's status-hint style and avoid an ASCII hyphen reading as a list bullet in Discord.
export function formatSubscriberDelta(newToday: number | null | undefined): string {
  if (newToday == null || newToday === 0) return ''
  return newToday > 0 ? ` (+${newToday} today)` : ` (−${Math.abs(newToday)} today)`
}

/**
 * Format the feed-poll volume as a Discord section (#548). Empty string when unavailable (SQL API not
 * configured) so the caller skips it. The per-service split shares the v1 caveat (counts include any
 * malformed /feed/:slug path), so it's shown with `~`. Both counts are WAE sampling estimates
 * (SUM(_sample_interval)); the day-over-day *step-up* is the signal, not the absolute precision.
 * #748 — appends "· N new items": incidents AIWatch first-detected in the window (the alert-worthy
 * event count), so the poll volume isn't misread as "alerts sent" (polls are mostly empty no-ops).
 */
export function formatFeedTrafficSection(
  feed: DailySummaryData['feedTraffic'],
): string {
  if (!feed) return ''
  const newItems = feed.newItems != null
    ? ` · ${feed.newItems} new item${feed.newItems === 1 ? '' : 's'}`
    : ''
  return (
    `\n📡 **Feed Polls (RSS/Slack)**\n` +
    `   Last 24h: ${feed.total} polls (all-feed ${feed.all} · per-service ~${feed.service})${newItems}`
  )
}

/**
 * Format the /api/v1 traffic counters as a Discord section (#518).
 * Returns empty string when traffic data is unavailable (SQL API not configured) so the caller
 * skips the section. Shows the last-24h total (with the all-vs-per-service split) and the running
 * cumulative since first measurement. Two approximations are surfaced honestly with `~`:
 *  - per-service counts include malformed/404 per-service paths (recorded before handler validation),
 *  - the cumulative is a once/day snapshot of a 24h rolling window, so it can drift or miss a skipped day.
 * The 24h total (the clean signal) is shown without `~`.
 */
export function formatV1TrafficSection(
  v1: DailySummaryData['v1Traffic'],
): string {
  if (!v1) return ''
  const { today, cumulative, since } = v1
  return (
    `\n🔌 **Public API (/api/v1)**\n` +
    `   Last 24h: ${today.total} (all-services ${today.all} · per-service ~${today.service})\n` +
    `   Cumulative: ~${cumulative} (since ${since})`
  )
}

/**
 * Format the RTT-degradation daily counters as a Discord section (#464).
 * Returns empty string when no degradations were recorded (caller skips the section).
 * The `not on official status page` total is the headline differentiator — degradations status
 * pages never report. Per-service breakdown sorted by total spikes descending.
 */
export function formatDegradationSection(
  degradationCounts: Record<string, number> | undefined,
  degradationNoStatusCounts: Record<string, number> | undefined,
  services: ServiceStatus[],
): string {
  if (!degradationCounts || Object.keys(degradationCounts).length === 0) return ''
  const nameMap = new Map(services.map(s => [s.id, s.name]))
  const totalSpikes = Object.values(degradationCounts).reduce((a, b) => a + b, 0)
  const totalNoStatus = Object.values(degradationNoStatusCounts ?? {}).reduce((a, b) => a + b, 0)
  const items = Object.entries(degradationCounts)
    .sort(([, a], [, b]) => b - a)
    .map(([id, total]) => {
      const ns = degradationNoStatusCounts?.[id] ?? 0
      const detail = ns > 0 ? `${ns} not on official status page` : 'all reflected on status page'
      return `   ${nameMap.get(id) ?? id}: ${total} RTT spike${total === 1 ? '' : 's'} (${detail})`
    })
    .join('\n')
  return `\n📈 **RTT Degradations (~48h)** — ${totalSpikes} total · ${totalNoStatus} not on official status pages\n${items}`
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
