// Statuspage API Parser (Atlassian format)

import type { TimelineEntry, Incident, DailyImpactLevel } from '../types'
import { formatDuration } from '../utils'

export interface StatuspageResponse {
  status: { indicator: string; description: string }
  components?: Array<{ name: string; status: string }>
  incidents?: Array<{
    id: string
    name: string
    status: string
    impact: string
    created_at: string
    resolved_at: string | null
    shortlink?: string
    components?: Array<{ name: string }>
    incident_updates?: Array<{
      status: string; body: string; created_at: string; display_at?: string
      affected_components?: Array<{ code: string; name: string; new_status: string }>
    }>
  }>
}

export function normalizeStatus(indicator: string): 'operational' | 'degraded' | 'down' {
  switch (indicator) {
    case 'none':
    case 'operational':
      return 'operational'
    case 'minor':
    case 'degraded_performance':
    case 'partial_outage':
      return 'degraded'
    case 'major':
    case 'critical':
    case 'major_outage':
      return 'down'
    default:
      return 'operational'
  }
}

export function parseIncidents(data: StatuspageResponse): Incident[] {
  return (data.incidents ?? []).map((inc) => {
    const duration = inc.resolved_at
      ? formatDuration(new Date(inc.created_at), new Date(inc.resolved_at))
      : null
    const rawTimeline: TimelineEntry[] = (inc.incident_updates ?? [])
      .map((u) => ({
        stage: u.status === 'resolved' ? 'resolved' as const
          : u.status === 'monitoring' ? 'monitoring' as const
          : u.status === 'identified' ? 'identified' as const
          : 'investigating' as const,
        text: u.body || null,
        at: u.display_at ?? u.created_at,
      }))
      .reverse() // oldest first
    // Deduplicate: keep one entry per stage+time (removes duplicate updates)
    const seen = new Set<string>()
    const timeline = rawTimeline.filter((t) => {
      const key = `${t.stage}:${t.at}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    const impact = inc.impact === 'critical' ? 'critical' as const
      : inc.impact === 'major' ? 'major' as const
      : inc.impact === 'minor' ? 'minor' as const
      : null

    const componentNames = inc.components?.map((c) => c.name) ?? []

    return {
      id: inc.id,
      title: inc.name,
      status: (inc.status === 'resolved' || inc.status === 'postmortem') ? 'resolved'
        : inc.status === 'monitoring' ? 'monitoring'
        : inc.status === 'identified' ? 'identified'
        : 'investigating',
      impact,
      ...(componentNames.length > 0 ? { componentNames } : {}),
      startedAt: inc.created_at,
      resolvedAt: inc.resolved_at ?? null,
      duration,
      timeline,
    }
  })
}

interface UptimeDayEntry {
  date: string
  outages?: { p?: number; m?: number }
  related_events?: Array<{ name: string }>
}


export interface UptimeDataResult {
  dailyImpact: Record<string, DailyImpactLevel>
  uptimePercent: number | null
}

export function parseUptimeData(html: string, componentId: string): UptimeDataResult {
  const result: UptimeDataResult = { dailyImpact: {}, uptimePercent: null }
  // Find "var uptimeData = " then extract JSON by brace counting (50KB+ object)
  const prefix = 'var uptimeData = '
  const startIdx = html.indexOf(prefix)
  if (startIdx === -1) return result
  const jsonStart = startIdx + prefix.length
  let depth = 0
  let jsonEnd = -1
  for (let i = jsonStart; i < html.length; i++) {
    if (html[i] === '{') depth++
    else if (html[i] === '}') { depth--; if (depth === 0) { jsonEnd = i + 1; break } }
  }
  if (jsonEnd === -1) return result
  try {
    // Structure: { componentId: { component: {...}, days: [{date, outages: {p, m}}] } }
    const data = JSON.parse(html.substring(jsonStart, jsonEnd)) as Record<string, { days?: UptimeDayEntry[] }>
    const comp = data[componentId]
    if (!comp?.days || !Array.isArray(comp.days)) return result

    let totalWeightedSec = 0
    let validDays = 0

    for (const day of comp.days) {
      if (!day.date) continue
      // Days with outages property defined (even if empty) count as valid data points
      if (day.outages !== undefined) validDays++
      if (!day.outages) continue
      const m = day.outages.m ?? 0
      const p = day.outages.p ?? 0
      // Statuspage weights: major=100%, partial=30% (Atlassian default)
      totalWeightedSec += m + 0.3 * p
      if (m > 0 && m > p) result.dailyImpact[day.date] = 'critical'  // major outage dominant → red
      else if (p > 0 || m > 0) result.dailyImpact[day.date] = 'major'  // partial outage dominant → orange
    }

    // Compute uptime%: (1 - weightedOutage / totalWindow) × 100
    // Use floor to avoid overstating uptime (e.g. 99.998% should not round to 100%)
    if (validDays > 0) {
      result.uptimePercent = Math.floor((1 - totalWeightedSec / (validDays * 86400)) * 10000) / 100
    }
  } catch (err) {
    console.warn('[parseUptimeData] failed to parse uptimeData:', err instanceof Error ? err.message : err)
  }
  return result
}
