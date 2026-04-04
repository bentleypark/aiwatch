// Better Stack RSS Feed Parser — for HuggingFace, Together, xAI

import type { TimelineEntry, Incident, DailyImpactLevel } from '../types'
import { formatDuration } from '../utils'

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/<[^>]*>/g, '') // strip HTML tags
}

function isValidDate(s: string): boolean {
  return !isNaN(new Date(s).getTime())
}

export function parseRssIncidents(xml: string): Incident[] {
  const items = xml.match(/<item>([\s\S]*?)<\/item>/g)
  if (!items) return []

  // Group by incident key: use <link> if available (stable per incident),
  // fall back to guid prefix before '#' (Modal uses per-update hashes in guid)
  const groups = new Map<string, Array<{ title: string; date: string; desc: string }>>()
  for (const item of items) {
    const guid = item.match(/<guid[^>]*>(.*?)<\/guid>/)?.[1]
    if (!guid) continue // skip items without guid
    const link = item.match(/<link>(.*?)<\/link>/)?.[1]
    const groupKey = link || guid.split('#')[0] || guid
    const date = item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] ?? ''
    if (!isValidDate(date)) continue // skip malformed dates
    const title = decodeXmlEntities(item.match(/<title>(.*?)<\/title>/)?.[1] ?? '')
    const desc = decodeXmlEntities(item.match(/<description>(.*?)<\/description>/)?.[1] ?? '')
    if (!groups.has(groupKey)) groups.set(groupKey, [])
    groups.get(groupKey)!.push({ title, date, desc })
  }

  // Convert each group to an Incident (limit to 20)
  const incidents: Incident[] = []
  for (const [groupKey, events] of groups) {
    if (incidents.length >= 20) break
    events.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
    const first = events[0]
    const last = events[events.length - 1]
    const lastText = `${last.title} ${last.desc}`.toLowerCase()
    const isResolved = lastText.includes('recovered') || lastText.includes('resolved')
    const startMs = new Date(first.date).getTime()
    const endMs = new Date(last.date).getTime()

    // Filter out micro-incidents (resolved in < 60s) — automated monitoring noise
    if (isResolved && (endMs - startMs) >= 0 && (endMs - startMs) < 60_000) {
      console.debug(`[parseRssIncidents] filtered micro-incident ${groupKey} (${endMs - startMs}ms)`)
      continue
    }

    const startedAt = new Date(first.date).toISOString()
    const duration = isResolved
      ? formatDuration(new Date(first.date), new Date(last.date))
      : null
    const component = first.title.replace(/ went down$/i, '').replace(/ recovered$/i, '')

    incidents.push({
      id: groupKey.split('/').pop() ?? groupKey,
      title: `${component} — ${isResolved ? 'recovered' : 'down'}`,
      status: isResolved ? 'resolved' : 'investigating',
      impact: null,
      startedAt,
      resolvedAt: isResolved ? new Date(last.date).toISOString() : null,
      duration,
      timeline: events.map((e, idx) => ({
        stage: (isResolved && idx === events.length - 1) ? 'resolved' as const : 'investigating' as const,
        text: e.desc || e.title,
        at: new Date(e.date).toISOString(),
      })),
    })
  }
  return incidents
}

// xAI RSS Feed Parser — custom format with HTML description containing updates
// Each <item> is a single incident with all updates in the description.
// Title format: "[Component] incident title"

export function parseXaiRssIncidents(xml: string): Incident[] {
  const items = xml.match(/<item>([\s\S]*?)<\/item>/g)
  if (!items) return []

  const incidents: Incident[] = []
  for (const item of items) {
    const title = item.match(/<title>(.*?)<\/title>/)?.[1] ?? ''
    const guid = item.match(/<guid[^>]*>(.*?)<\/guid>/)?.[1] ?? ''
    if (!guid) continue

    // Extract status and resolved date from description
    const desc = item.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/)?.[1] ?? ''
    const statusMatch = desc.match(/Status:\s*(\w+)/)
    const resolvedMatch = desc.match(/Resolved:\s*([^<]+)/)
    const isResolved = statusMatch?.[1] === 'RESOLVED'

    // Extract timeline updates from description HTML (assumes flat <div> structure)
    const updateBlocks = desc.match(/<div>([\s\S]*?)<\/div>/g) ?? []
    const timeline: TimelineEntry[] = updateBlocks.flatMap((block) => {
      const dateMatch = block.match(/<strong>(.*?)<\/strong>/)
      const titleMatch = block.match(/<h3>(.*?)<\/h3>/)
      const textMatch = block.match(/<p>(?!<strong>)(.*?)<\/p>/g)
      if (!dateMatch) return []
      const parsedDate = new Date(dateMatch[1])
      if (isNaN(parsedDate.getTime())) return []
      const at = parsedDate.toISOString()
      const stage = titleMatch?.[1]?.toLowerCase().includes('resolved') ? 'resolved' as const
        : titleMatch?.[1]?.toLowerCase().includes('monitor') ? 'monitoring' as const
        : titleMatch?.[1]?.toLowerCase().includes('identif') ? 'identified' as const
        : 'investigating' as const
      const text = textMatch?.map(p => decodeXmlEntities(p.replace(/<[^>]*>/g, ''))).join(' ').trim() || null
      return [{ stage, text, at }]
    }).reverse() // oldest first

    const startedAt = timeline.length > 0 ? timeline[0].at : new Date().toISOString()
    const resolvedDate = resolvedMatch ? new Date(resolvedMatch[1].trim()) : null
    const resolvedAt = (resolvedDate && !isNaN(resolvedDate.getTime())) ? resolvedDate : null
    const duration = (isResolved && resolvedAt && timeline.length > 0)
      ? formatDuration(new Date(startedAt), resolvedAt)
      : null

    // Filter out micro-incidents (resolved in < 60s) — automated monitoring noise
    if (isResolved && resolvedAt) {
      const durationMs = resolvedAt.getTime() - new Date(startedAt).getTime()
      if (durationMs > 0 && durationMs < 60_000) {
        console.debug(`[parseXaiRssIncidents] filtered micro-incident ${guid} (${durationMs}ms)`)
        continue
      }
    }

    incidents.push({
      id: guid,
      title,
      status: isResolved ? 'resolved' : 'investigating',
      impact: null,
      startedAt,
      resolvedAt: resolvedAt ? resolvedAt.toISOString() : null,
      duration,
      timeline,
    })
  }
  return incidents
}

export interface BetterStackStatusHistory {
  day: string
  status: string
  downtime_duration: number
  maintenance_duration: number
}

export interface BetterStackIndex {
  data?: {
    attributes?: { aggregate_state?: string }
  }
  included?: Array<{
    type: string
    attributes?: {
      availability?: number
      status?: string
      status_history?: BetterStackStatusHistory[]
    }
  }>
}

export function parseBetterStackStatus(data: BetterStackIndex): 'operational' | 'degraded' | 'down' | null {
  const state = data.data?.attributes?.aggregate_state
  if (!state) return null
  if (state === 'operational') return 'operational'
  if (state === 'degraded' || state === 'maintenance') return 'degraded'
  if (state === 'downtime') {
    // Check resource-level status: if majority is operational, treat as degraded not down
    const resources = (data.included ?? []).filter(
      (r) => r.type === 'status_page_resource' && r.attributes?.status
    )
    if (resources.length > 0) {
      const downCount = resources.filter((r) => r.attributes?.status === 'downtime').length
      return downCount > resources.length / 2 ? 'down' : 'degraded'
    }
    return 'down'
  }
  console.warn(`[parseBetterStackStatus] unknown aggregate_state: "${state}" — treating as degraded`)
  return 'degraded'
}

export function parseBetterStackUptime(data: BetterStackIndex): number | null {
  const resources = (data.included ?? []).filter(
    (r) => r.type === 'status_page_resource' && r.attributes?.availability != null
  )
  if (resources.length === 0) return null

  const sum = resources.reduce((acc, r) => acc + (r.attributes!.availability! * 100), 0)
  const avg = Math.round((sum / resources.length) * 100) / 100

  if (avg < 0 || avg > 100) {
    console.warn(`[parseBetterStackUptime] computed ${avg}% out of range — API format may have changed`)
    return null
  }
  return avg
}

/**
 * Extract daily impact from BetterStack status_history across all resources.
 * Uses 2-pass aggregation to avoid worst-case bias: first collects per-day stats
 * (max downtime + affected resource count), then classifies using combined criteria.
 * Skips `not_monitored` status (not actual downtime).
 * Returns Record<YYYY-MM-DD, 'critical' | 'major' | 'minor'> for non-operational days.
 */
const KNOWN_STATUSES = new Set(['operational', 'not_monitored', 'downtime', 'degraded', 'maintenance', 'under_maintenance', 'recovered'])

export function parseBetterStackDailyImpact(data: BetterStackIndex): Record<string, DailyImpactLevel> | null {
  const resources = (data.included ?? []).filter(
    (r) => r.type === 'status_page_resource' && Array.isArray(r.attributes?.status_history)
  )
  if (resources.length === 0) return null

  // Pass 1: collect per-day stats across all resources (per-day resource count for accurate ratios)
  const dayStats: Record<string, { maxDownSec: number; affectedCount: number; totalForDay: number }> = {}
  for (const resource of resources) {
    for (const day of resource.attributes!.status_history!) {
      if (!dayStats[day.day]) {
        dayStats[day.day] = { maxDownSec: 0, affectedCount: 0, totalForDay: 0 }
      }
      const stat = dayStats[day.day]
      if (day.status === 'not_monitored') continue
      if (!KNOWN_STATUSES.has(day.status)) {
        console.warn(`[parseBetterStackDailyImpact] unknown status "${day.status}" on ${day.day} — treating as downtime`)
      }
      stat.totalForDay++
      if (day.status === 'operational') continue
      // Non-operational with actual downtime (maintenance with 0 downtime is intentionally skipped)
      const downSec = day.downtime_duration ?? 0
      if (downSec === 0) continue
      if (downSec > stat.maxDownSec) stat.maxDownSec = downSec
      stat.affectedCount++
    }
  }

  // Pass 2: classify using combined thresholds (duration + affected ratio)
  const dailyImpact: Record<string, DailyImpactLevel> = {}
  for (const [day, stat] of Object.entries(dayStats)) {
    const affectedRatio = stat.totalForDay > 0 ? stat.affectedCount / stat.totalForDay : 0
    let impact: DailyImpactLevel
    if (stat.maxDownSec >= 14400 || affectedRatio >= 0.25) {
      impact = 'critical'   // 4h+ single resource OR 25%+ resources affected
    } else if (stat.maxDownSec >= 3600 || affectedRatio >= 0.12) {
      impact = 'major'      // 1h+ single resource OR 12%+ resources affected
    } else if (stat.maxDownSec >= 600) {
      impact = 'minor'      // 10min+ single resource
    } else {
      continue              // negligible downtime, skip
    }
    dailyImpact[day] = impact
  }

  return Object.keys(dailyImpact).length > 0 ? dailyImpact : null
}
