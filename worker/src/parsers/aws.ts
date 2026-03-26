// AWS Health Dashboard RSS Parser — for Amazon Bedrock

import type { Incident, TimelineEntry } from '../types'
import { formatDuration } from '../utils'

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/<[^>]*>/g, '') // strip HTML tags
}

function stripCdata(text: string): string {
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
}

function isValidDate(s: string): boolean {
  return !isNaN(new Date(s).getTime())
}

/** Map AWS RSS title keywords to AIWatch incident status */
function classifyAwsStatus(title: string): 'investigating' | 'identified' | 'monitoring' | 'resolved' {
  const lower = title.toLowerCase()
  if (lower.includes('[resolved]') || lower.includes('service is operating normally')) return 'resolved'
  if (lower.includes('[monitoring]')) return 'monitoring'
  if (lower.includes('[identified]')) return 'identified'
  return 'investigating'
}

/** Map AWS RSS title keywords to AIWatch impact */
function classifyAwsImpact(title: string): 'minor' | 'major' | 'critical' | null {
  const lower = title.toLowerCase()
  if (lower.includes('disruption') || lower.includes('outage')) return 'critical'
  if (lower.includes('degraded') || lower.includes('elevated') || lower.includes('increased')) return 'major'
  if (lower.includes('informational')) return 'minor'
  return null
}

/** Derive overall service status from active (unresolved) incidents */
export function deriveAwsStatus(incidents: Incident[]): 'operational' | 'degraded' | 'down' {
  const active = incidents.filter((i) => i.status !== 'resolved')
  if (active.length === 0) return 'operational'
  const hasCritical = active.some((i) => i.impact === 'critical')
  return hasCritical ? 'down' : 'degraded'
}

/**
 * Parse AWS Health Dashboard RSS feed into normalized Incidents.
 * Empty RSS (no <item> elements) = operational (returns []).
 * Each <item> is treated as a separate incident (AWS does not use guid grouping).
 */
export function parseAwsRssIncidents(xml: string): Incident[] {
  const items = xml.match(/<item>([\s\S]*?)<\/item>/g)
  if (!items) return []

  const incidents: Incident[] = []
  for (const item of items) {
    if (incidents.length >= 20) break

    const title = decodeXmlEntities(stripCdata(item.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? ''))
    const desc = decodeXmlEntities(stripCdata(item.match(/<description>([\s\S]*?)<\/description>/)?.[1] ?? ''))
    const pubDate = item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] ?? ''
    const guid = item.match(/<guid[^>]*>(.*?)<\/guid>/)?.[1] ?? ''

    if (!title || !isValidDate(pubDate)) continue

    const status = classifyAwsStatus(title)
    const impact = classifyAwsImpact(title)
    const startedAt = new Date(pubDate).toISOString()

    const timeline: TimelineEntry[] = [{
      stage: status,
      text: desc || title,
      at: startedAt,
    }]

    // For resolved incidents, estimate duration as 0 (single update point)
    const duration = status === 'resolved' ? formatDuration(new Date(pubDate), new Date(pubDate)) : null

    incidents.push({
      id: guid || `aws-${new Date(pubDate).getTime()}`,
      title,
      status,
      impact,
      startedAt,
      // AWS RSS has one pubDate per item — for resolved items this is the resolution time,
      // not the true start. Both startedAt and resolvedAt reflect the last-update timestamp.
      resolvedAt: status === 'resolved' ? startedAt : null,
      duration,
      timeline,
    })
  }

  return incidents
}
