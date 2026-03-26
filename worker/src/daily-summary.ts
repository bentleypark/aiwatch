// Daily Summary — expanded Discord report at UTC 09:00 (KST 18:00)

import type { ServiceStatus } from './types'

export interface DailySummaryData {
  services: ServiceStatus[]
  aiUsage: { calls: number; success: number; failed: number } | null
  latencySnapshots: Array<{ t: string; data: Record<string, number> }>
  incidentCountToday: { newCount: number; resolvedCount: number }
  redditCount: number
}

export function buildDailySummary(data: DailySummaryData): string {
  const { services, aiUsage, latencySnapshots, incidentCountToday, redditCount } = data
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
    const cost = (aiUsage.calls * 0.006).toFixed(3)
    lines.push(`\n🤖 **AI Analysis Usage**\n   Today: ${aiUsage.calls} calls (${aiUsage.success} success, ${aiUsage.failed} failed)\n   Est. cost: $${cost}`)
  }

  // Section 4: Uptime Best/Worst
  const withUptime = services.filter(s => s.uptime30d != null && !isNaN(s.uptime30d!))
  if (withUptime.length >= 3) {
    const sorted = [...withUptime].sort((a, b) => (b.uptime30d ?? 0) - (a.uptime30d ?? 0))
    const best = sorted.slice(0, 2).map(s => `${s.name} ${s.uptime30d!.toFixed(2)}%`).join(' · ')
    const worst = sorted.slice(-2).reverse().map(s => `${s.name} ${s.uptime30d!.toFixed(2)}%`).join(' · ')
    lines.push(`\n📈 **Uptime (30d)**\n   Best: ${best}\n   Worst: ${worst}`)
  }

  // Section 5: Latency Best/Worst (24h avg)
  const latencyAvg = computeLatencyAvg(latencySnapshots)
  const latencyEntries = Object.entries(latencyAvg).filter(([, v]) => v > 0)
  if (latencyEntries.length >= 3) {
    const sorted = latencyEntries.sort((a, b) => a[1] - b[1])
    const nameMap = new Map(services.map(s => [s.id, s.name]))
    const fastest = sorted.slice(0, 2).map(([id, ms]) => `${nameMap.get(id) ?? id} ${Math.round(ms)}ms`).join(' · ')
    const slowest = sorted.slice(-2).reverse().map(([id, ms]) => `${nameMap.get(id) ?? id} ${Math.round(ms)}ms`).join(' · ')
    lines.push(`\n⚡ **Latency (24h avg)**\n   Fastest: ${fastest}\n   Slowest: ${slowest}`)
  }

  // Section 6: Incidents + Reddit
  const incParts: string[] = []
  if (incidentCountToday.newCount > 0) incParts.push(`${incidentCountToday.newCount} new`)
  if (incidentCountToday.resolvedCount > 0) incParts.push(`${incidentCountToday.resolvedCount} resolved`)
  if (incParts.length > 0) lines.push(`\n🔔 **Alerts Sent**: ${incParts.join(' · ')}`)
  if (redditCount > 0) lines.push(`📢 **Reddit**: ${redditCount} posts detected`)

  return lines.join('\n')
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
