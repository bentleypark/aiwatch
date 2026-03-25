// Better Stack RSS Feed Parser — for HuggingFace, Together, xAI

import type { TimelineEntry, Incident } from '../types'
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

  // Group by guid (same guid = same incident)
  const groups = new Map<string, Array<{ title: string; date: string; desc: string }>>()
  for (const item of items) {
    const guid = item.match(/<guid>(.*?)<\/guid>/)?.[1]
    if (!guid) continue // skip items without guid
    const date = item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] ?? ''
    if (!isValidDate(date)) continue // skip malformed dates
    const title = decodeXmlEntities(item.match(/<title>(.*?)<\/title>/)?.[1] ?? '')
    const desc = decodeXmlEntities(item.match(/<description>(.*?)<\/description>/)?.[1] ?? '')
    if (!groups.has(guid)) groups.set(guid, [])
    groups.get(guid)!.push({ title, date, desc })
  }

  // Convert each group to an Incident (limit to 20)
  const incidents: Incident[] = []
  for (const [guid, events] of groups) {
    if (incidents.length >= 20) break
    events.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
    const first = events[0]
    const last = events[events.length - 1]
    const isResolved = last.title.toLowerCase().includes('recovered')
    const startedAt = new Date(first.date).toISOString()
    const duration = isResolved
      ? formatDuration(new Date(first.date), new Date(last.date))
      : null
    const component = first.title.replace(/ went down$/i, '').replace(/ recovered$/i, '')

    incidents.push({
      id: guid.split('#')[1] ?? guid,
      title: `${component} — ${isResolved ? 'recovered' : 'down'}`,
      status: isResolved ? 'resolved' : 'investigating',
      impact: null,
      startedAt,
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

    incidents.push({
      id: guid,
      title,
      status: isResolved ? 'resolved' : 'investigating',
      impact: null,
      startedAt,
      duration,
      timeline,
    })
  }
  return incidents
}

export interface BetterStackIndex {
  data?: {
    attributes?: { aggregate_state?: string }
  }
  included?: Array<{
    type: string
    attributes?: { availability?: number }
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
      const downCount = resources.filter((r) => r.attributes.status === 'downtime').length
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
