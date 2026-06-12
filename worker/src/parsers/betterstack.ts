// Better Stack RSS Feed Parser — for HuggingFace, Together, Fireworks, Modal, xAI

import type { TimelineEntry, Incident, DailyImpactLevel, ServiceComponent } from '../types'
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

// #564 — derive incident impact from BetterStack title/update text. BetterStack exposes no structured
// per-incident severity (the RSS <item> carries only title/description; index.json affected_resources
// read 'resolved' at rest, losing the historical severity), so the wording is the only signal — and it
// is NOT reliable for severity: BetterStack's automated monitors emit a generic "<X> went down" for
// ANY failed check (a single model/endpoint flap), so "down" does NOT mean a declared major outage.
// Treating "down" as major over-penalizes monitor-flap services (Together/Fireworks are 20/20 "went
// down") vs services with human-written titles (Modal). So we map MAJOR only on explicit broad-outage
// wording ("outage"/"unavailable"/"offline") and everything else (down/went down/degraded/...) → MINOR.
// This is the conservative default and is SYMMETRIC with the Instatus fix (#556, which resolved to all
// minor on uniform severity). The key bug fix is non-null impact: any value lets score.ts count the
// incident in affected-days (the old hardcoded `null` dropped it via the #261 filter). Planned
// maintenance is filtered UPSTREAM (MAINTENANCE_TITLE + index.json report_type), so it never reaches here.
const BS_MAJOR = /\b(?:outage|unavailable|offline)\b/i
export function mapBetterStackImpact(text: string): Incident['impact'] {
  return BS_MAJOR.test(text || '') ? 'major' : 'minor'
}

// #331 / #503: BetterStack RSS carries planned-maintenance announcements alongside real incidents.
// Detect and skip them via three signals (any one is sufficient):
//   1. Title pattern — three alternations:
//      a) "scheduled ... maintenance" (e.g., "Scheduled Network Maintenance")
//      b) "maintenance ... scheduled" (e.g., "Maintenance — scheduled for tonight")
//      c) title ENDS with "maintenance" (e.g., "Network maintenance", "Volume version 2 maintenance")
//      Deliberately does NOT match "Stuck in maintenance mode" or "Planned maintenance window exceeded"
//      — those describe real incidents where a maintenance-labeled state caused unexpected degradation.
//   2. Future pubDate — structurally impossible for a real incident (recovered/went down).
//   3. index.json report_type === 'maintenance' — used in services.ts after index.json parse.
//      Handles custom-titled events like "Authorization System Restart" (#503) where no title
//      keyword is present.
const MAINTENANCE_TITLE = /scheduled\s+(?:\w+\s+)?maintenance|maintenance[^a-z]{0,20}scheduled|\bmaintenance\s*$/i
const FUTURE_PUBDATE_BUFFER_MS = 60_000  // clock-skew tolerance
// #602 — an unresolved Better Stack incident with no RSS activity for this long is treated as a
// stale monitor post. Better Stack feeds with human-written titles (Luma's "Ray3 service degraded")
// don't pair a "down"/"recovered" cycle, so an old incident never flips to resolved and lingers as a
// perpetual `investigating` even while the page is operational. 7 days: real ongoing incidents emit
// updates far sooner; the rare genuine multi-day outage gets an explicit resolution post anyway.
const STALE_ONGOING_MS = 7 * 86_400_000

export function parseRssIncidents(xml: string, now = Date.now()): Incident[] {
  const items = xml.match(/<item>([\s\S]*?)<\/item>/g)
  if (!items) return []

  // Group by incident key:
  // - Modal: <link> has unique incident URL (/incident/ID) → use link
  // - Together/HuggingFace/Fireworks: <link> is just homepage, guid hash is per-incident → use full guid
  // - Modal guid has per-update hashes (incident/ID#updateHash) → split('#')[0] groups correctly
  const groups = new Map<string, Array<{ title: string; date: string; desc: string }>>()
  for (const item of items) {
    const guid = item.match(/<guid[^>]*>(.*?)<\/guid>/)?.[1]
    if (!guid) continue // skip items without guid
    const link = item.match(/<link>(.*?)<\/link>/)?.[1]
    // Only use <link> if it points to a specific incident (has path beyond /)
    const linkIsIncident = link ? !/^https?:\/\/[^/]+\/?$/.test(link) : false
    const groupKey = linkIsIncident ? link! : guid
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
    const isResolved = /\brecover(?:ed)?\b|\bresolved\b|\bfixed\b|\brestor(?:ed)?\b|\bmitigated\b|\bhealthy again\b|\bis back\b|\bback to normal\b|\bback up\b|\boperational\b/.test(lastText)
    const startMs = new Date(first.date).getTime()
    const endMs = new Date(last.date).getTime()
    // Stale-ongoing guard (#602): an unresolved incident untouched for STALE_ONGOING_MS is treated as
    // resolved (resolvedAt = last-seen), so a months-old monitor post doesn't show as a live incident.
    const resolved = isResolved || (now - endMs) > STALE_ONGOING_MS

    // #331 / #503: planned-maintenance title filter (signal 1 of 3).
    // Signal 2 (future pubDate) and signal 3 (index.json report_type) are below.
    if (MAINTENANCE_TITLE.test(first.title)) {
      console.debug(`[parseRssIncidents] skipped maintenance title (#331/#503): ${groupKey} ("${first.title}")`)
      continue
    }
    if (startMs > now + FUTURE_PUBDATE_BUFFER_MS) {
      console.debug(`[parseRssIncidents] skipped future-dated announcement: ${groupKey} ("${first.title}" at ${new Date(startMs).toISOString()})`)
      continue
    }

    // Filter out micro-incidents (resolved in < 60s) — automated monitoring noise
    if (isResolved && (endMs - startMs) >= 0 && (endMs - startMs) < 60_000) {
      console.debug(`[parseRssIncidents] filtered micro-incident ${groupKey} (${endMs - startMs}ms)`)
      continue
    }

    const startedAt = new Date(first.date).toISOString()
    const duration = resolved
      ? formatDuration(new Date(first.date), new Date(last.date))
      : null
    const component = first.title.replace(/ went down$/i, '').replace(/ recovered$/i, '')
    // #564 — map impact from the RAW event text (titles + descriptions), NOT the reconstructed
    // display title below (which normalizes every incident to "— down/recovered", erasing severity).
    const severityText = events.map((e) => `${e.title} ${e.desc}`).join(' ')

    incidents.push({
      id: groupKey.split('/').pop() ?? groupKey,
      title: `${component} — ${resolved ? 'recovered' : 'down'}`,
      status: resolved ? 'resolved' : 'investigating',
      impact: mapBetterStackImpact(severityText),
      startedAt,
      resolvedAt: resolved ? new Date(last.date).toISOString() : null,
      duration,
      timeline: events.map((e, idx) => ({
        stage: (resolved && idx === events.length - 1) ? 'resolved' as const : 'investigating' as const,
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

    // #564 — the RSS path filters planned maintenance (MAINTENANCE_TITLE) before assigning impact;
    // the xAI path has no betterStackUrl, so the index.json `report_type === 'maintenance'` filter in
    // services.ts is skipped for it. Apply the same title filter here so a maintenance entry isn't
    // mapped to a non-null impact and counted toward the score (it was score-neutral as `null` before).
    if (MAINTENANCE_TITLE.test(title)) {
      console.debug(`[parseXaiRssIncidents] skipped maintenance title (#564): "${title}"`)
      continue
    }

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
      // #564 — map impact from the title + the tag-STRIPPED description (not the raw CDATA `desc`,
      // whose markup like class="offline-banner" would false-match the regex). Stripping the desc
      // directly (rather than reading `timeline`) keeps the severity signal even when an update's
      // date fails to parse and the timeline ends up empty.
      impact: mapBetterStackImpact(`${title} ${desc.replace(/<[^>]*>/g, ' ')}`),
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
    id?: string
    attributes?: {
      availability?: number
      status?: string
      status_history?: BetterStackStatusHistory[]
      aggregate_state?: string
      report_type?: string  // 'manual' | 'maintenance' | 'calculated' (#503)
      title?: string
      starts_at?: string
      // #606 Cat C — status_page_resource: per-resource display name + its section (group) link.
      // status_page_section: the section's display name (the group label).
      public_name?: string
      status_page_section_id?: string | number
      name?: string
    }
  }>
}

/** #606 Cat C — normalize a BetterStack resource status to the component union. */
function normalizeBetterStackComponentStatus(status: string | undefined): ServiceComponent['status'] {
  switch (status) {
    case 'downtime': return 'down'
    case 'degraded': return 'degraded'
    // 'operational', 'maintenance' (planned, not an outage), and unknowns → operational
    default: return 'operational'
  }
}

/**
 * #606 Cat C — extract the per-component breakdown from a BetterStack status page index.json.
 * Each `status_page_resource` becomes a ServiceComponent; its `status_page_section_id` maps to the
 * `status_page_section` name → `group`, so the UI collapses each section (e.g. "Inference - Chat")
 * like the Atlassian Models grouping. `denylist` (case-insensitive) drops resources/sections by
 * name (e.g. "Website"). Preserves index order. Returns `[]` for <2 survivors (caller omits).
 */
export function parseBetterStackComponents(
  data: BetterStackIndex,
  opts: { denylist?: string[] } = {},
): ServiceComponent[] {
  const inc = data.included ?? []
  const sections = new Map<string, string>()
  for (const s of inc) {
    if (s.type === 'status_page_section' && s.id && s.attributes?.name) sections.set(s.id, s.attributes.name)
  }
  const deny = new Set((opts.denylist ?? []).map((n) => n.toLowerCase()))
  const out: ServiceComponent[] = []
  for (const r of inc) {
    if (r.type !== 'status_page_resource') continue
    const name = r.attributes?.public_name
    if (!name) continue
    const sectionId = r.attributes?.status_page_section_id
    const group = sectionId != null ? sections.get(String(sectionId)) : undefined
    if (deny.has(name.toLowerCase()) || (group && deny.has(group.toLowerCase()))) continue
    out.push({
      id: r.id ?? name,
      name,
      status: normalizeBetterStackComponentStatus(r.attributes?.status),
      ...(group ? { group } : {}),
    })
  }
  // A section with a single member needn't be a collapsible group — demote it to an
  // individual surface row (clear `group`) so the UI shows it inline, not behind a toggle.
  const groupCounts = new Map<string, number>()
  for (const c of out) if (c.group) groupCounts.set(c.group, (groupCounts.get(c.group) ?? 0) + 1)
  for (const c of out) if (c.group && (groupCounts.get(c.group) ?? 0) < 2) delete c.group
  return out.length >= 2 ? out : []
}

/**
 * Extract IDs of planned-maintenance reports from index.json status_reports.
 * BetterStack sets report_type='maintenance' for maintenance windows. These are
 * passed to parseRssIncidents so custom-titled maintenance events (e.g. "Authorization
 * System Restart") are filtered out even when their title contains no maintenance keyword.
 */
export function parseBetterStackMaintenanceIds(data: BetterStackIndex): Set<string> {
  const ids = new Set<string>()
  for (const r of data.included ?? []) {
    if (r.type === 'status_report' && r.attributes?.report_type === 'maintenance' && r.id) {
      ids.add(r.id)
    }
  }
  return ids
}

/** Extract resolved incident IDs from index.json status_reports */
export function parseBetterStackResolvedIds(data: BetterStackIndex): Set<string> {
  const resolved = new Set<string>()
  for (const r of data.included ?? []) {
    if (r.type === 'status_report' && r.attributes?.aggregate_state === 'resolved' && r.id) {
      resolved.add(r.id)
    }
  }
  return resolved
}

export function parseBetterStackStatus(data: BetterStackIndex): 'operational' | 'degraded' | 'down' | null {
  const state = data.data?.attributes?.aggregate_state
  if (!state) return null
  if (state === 'operational') return 'operational'

  // Resource-level threshold: if <30% of resources are non-operational, treat as operational
  // BetterStack services (Together, Fireworks, HuggingFace, Modal) have many individual monitors.
  // Individual model churn (e.g., 5/28 = 17%) ≠ service-level degradation.
  // This is a backup signal — RSS incidents take priority in services.ts derivedStatus.
  const resources = (data.included ?? []).filter(
    (r) => r.type === 'status_page_resource' && r.attributes?.status
  )
  const nonOpCount = resources.filter((r) => r.attributes?.status !== 'operational').length

  if (state === 'maintenance') {
    // Planned maintenance is not an outage on its own — escalate to `degraded` only when real
    // unplanned issues (degraded/downtime resources) coexist AND those issues exceed the 30%
    // threshold against the *non-maintenance* fleet. Counting against `resources.length`
    // would let widespread maintenance (e.g. 25/31 in maintenance) dilute a coexisting real
    // outage to a noise-band ratio. The intent — treat planned maintenance as not-an-outage —
    // matches `parseBetterStackDailyImpact` which separately excludes zero-downtime maintenance
    // from per-day impact totals (different signal, same product principle).
    // Closes #349 — Together AI was misclassified as degraded during pure-maintenance windows.
    const realIssues = resources.filter(
      (r) => r.attributes?.status === 'degraded' || r.attributes?.status === 'downtime'
    ).length
    if (realIssues === 0) return 'operational'
    const maintenanceCount = resources.filter(
      (r) => r.attributes?.status === 'maintenance'
    ).length
    const nonMaintenanceTotal = resources.length - maintenanceCount
    // Defensive: realIssues > 0 implies nonMaintenanceTotal > 0 (a resource can't be both
    // maintenance and downtime simultaneously). Explicit guard makes the safety obvious.
    if (nonMaintenanceTotal === 0) return 'operational'
    if (realIssues / nonMaintenanceTotal < 0.3) return 'operational'
    return 'degraded'
  }
  if (state === 'degraded') {
    if (resources.length > 0 && nonOpCount / resources.length < 0.3) return 'operational'
    return 'degraded'
  }
  if (state === 'downtime') {
    if (resources.length > 0 && nonOpCount / resources.length < 0.3) return 'operational'
    if (resources.length > 0) {
      const downCount = resources.filter((r) => r.attributes?.status === 'downtime').length
      return downCount > resources.length / 2 ? 'down' : 'degraded'
    }
    return 'down'
  }
  console.warn(`[parseBetterStackStatus] unknown aggregate_state: "${state}" — treating as degraded`)
  return 'degraded'
}

/**
 * Count resources reporting a real issue (degraded or downtime), excluding planned
 * maintenance and operational ones. Surfaced as `partialCount` so the UI can show a
 * "N affected" badge when `parseBetterStackStatus` collapses a partial outage to
 * `operational` via the <30% threshold (#447) — closes the perception gap between
 * BetterStack's "Some services are down" header and the AIWatch card without
 * reintroducing the per-model flap noise the threshold deliberately suppresses.
 */
export function parseBetterStackPartialCount(data: BetterStackIndex): number {
  return (data.included ?? []).filter(
    (r) =>
      r.type === 'status_page_resource' &&
      (r.attributes?.status === 'degraded' || r.attributes?.status === 'downtime')
  ).length
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
