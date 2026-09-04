// Better Stack RSS Feed Parser — for HuggingFace, Together, Modal, xAI (fireworks left this group in #1198)

import type { TimelineEntry, Incident, DailyImpactLevel, ServiceComponent } from '../types'
import { formatDuration, displayedMinutes } from '../utils'

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
// Treating "down" as major over-penalizes monitor-flap services (Together is 20/20 "went
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
// Exported for reuse by the OnlineOrNot parser (#896) as a title backstop — a completed
// maintenance is relocated out of OnlineOrNot's `scheduledMaintenance` group, so the #894
// structural filter can't catch it, but this title shape still does.
export const MAINTENANCE_TITLE = /scheduled\s+(?:\w+\s+)?maintenance|maintenance[^a-z]{0,20}scheduled|\bmaintenance\s*$/i
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
  // - Together/HuggingFace: <link> is just homepage, guid hash is per-incident → use full guid
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

    // Parsed BEFORE the timeline because the timeline needs it — see the stage note below. The
    // `isNaN` re-check is the same one the `resolvedAt` binding further down applies.
    const resolvedDate = resolvedMatch ? new Date(resolvedMatch[1].trim()) : null
    const resolvedIso = resolvedDate && !isNaN(resolvedDate.getTime()) ? resolvedDate.toISOString() : null

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
      // #1337 — the RESOLUTION update is identified by the provider's own `Resolved:` marker, not by
      // reading its prose. xAI writes the `<h3>` heading free-form, so the substring ladder below
      // mislabels every wording it does not enumerate. "Traffic is healthy again" is the one that
      // produced this bug report: the 2026-09-03 Grok and API outages rendered a row headed
      // "Investigating" whose own text read "We have resolved the situation, and traffic is healthy
      // again."
      //
      // Adding more substrings would repeat the mistake — the provider's wording is not ours to
      // predict. `Status: RESOLVED` + `Resolved: <date>` are machine-readable and this function
      // already reads both, so the entry whose instant IS the resolution instant is the resolution,
      // whatever it calls itself. The ladder still handles every OTHER entry.
      //
      // Deliberately narrow. It fires only when the provider marked the incident RESOLVED and gave a
      // parseable date, so an item whose `Resolved:` lines up with no update keeps today's behaviour
      // and no unresolved incident is touched.
      //
      // `stage` is not display-only. It is part of the merge's timeline dedupe key; several callers
      // fall back to the last `resolved` timeline entry when an incident carries no `resolvedAt`
      // (`resolvedAtOf` in incident-history.ts, `getResolvedTime` in src/utils/incidentSort.js), which
      // a partially-resolved surface group is — held closed only by those callers' own
      // `status === 'resolved'` gate, which this change relies on and does not own; and
      // `ai-analysis.ts` renders it into the model prompt, so such a group hands the model a
      // `[resolved]` row for an incident it is simultaneously told is investigating.
      const stage = (isResolved && resolvedIso && at === resolvedIso) ? 'resolved' as const
        : titleMatch?.[1]?.toLowerCase().includes('resolved') ? 'resolved' as const
        : titleMatch?.[1]?.toLowerCase().includes('monitor') ? 'monitoring' as const
        : titleMatch?.[1]?.toLowerCase().includes('identif') ? 'identified' as const
        : 'investigating' as const
      const text = textMatch?.map(p => decodeXmlEntities(p.replace(/<[^>]*>/g, ''))).join(' ').trim() || null
      return [{ stage, text, at }]
    }).reverse() // oldest first

    const startedAt = timeline.length > 0 ? timeline[0].at : new Date().toISOString()
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
    attributes?: {
      aggregate_state?: string
      /** #1292 — the status page's display timezone, which the per-day `status_history` buckets are
       *  cut on. A Rails/ActiveSupport zone NAME, not necessarily an IANA id — see
       *  `resolveBetterStackTimeZone`. */
      timezone?: string
    }
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

/** section id → section (group) display name. */
function betterStackSectionNames(data: BetterStackIndex): Map<string, string> {
  const sections = new Map<string, string>()
  for (const s of data.included ?? []) {
    if (s.type === 'status_page_section' && s.id && s.attributes?.name) sections.set(s.id, s.attributes.name)
  }
  return sections
}

type BetterStackResource = NonNullable<BetterStackIndex['included']>[number]

/** The section (group) label a resource belongs to, if any. */
function betterStackResourceGroup(r: BetterStackResource, sections: Map<string, string>): string | undefined {
  const sectionId = r.attributes?.status_page_section_id
  return sectionId != null ? sections.get(String(sectionId)) : undefined
}

/** Every `status_page_resource` display name on the page, denylist NOT applied. #1292 attribution
 *  reads this: the denylist governs which resources are SYNTHESIZED, not which feed titles can be
 *  recognised. Filtering it would make a `"Website went down"` item match no name, fall through to
 *  the catch-all, and suppress synthesis for every OTHER resource that day. */
export function betterStackResourceNames(data: BetterStackIndex): string[] {
  const names: string[] = []
  for (const r of data.included ?? []) {
    if (r.type === 'status_page_resource' && r.attributes?.public_name) names.push(r.attributes.public_name)
  }
  return names
}

/** `componentDenylist` membership by resource name OR its section label. Shared by the component
 *  breakdown and the #1292 status_history synthesis so the two cannot drift into denying different
 *  sets — a second copy of this rule is what would let a denied surface reappear as an incident. */
function isDeniedBetterStackResource(
  r: BetterStackResource,
  sections: Map<string, string>,
  deny: Set<string>,
): boolean {
  const name = r.attributes?.public_name
  if (!name) return true
  const group = betterStackResourceGroup(r, sections)
  return deny.has(name.toLowerCase()) || (group != null && deny.has(group.toLowerCase()))
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
  const sections = betterStackSectionNames(data)
  const deny = new Set((opts.denylist ?? []).map((n) => n.toLowerCase()))
  const out: ServiceComponent[] = []
  for (const r of inc) {
    if (r.type !== 'status_page_resource') continue
    const name = r.attributes?.public_name
    if (!name) continue
    const group = betterStackResourceGroup(r, sections)
    if (isDeniedBetterStackResource(r, sections, deny)) continue
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

// #722 — resource-level threshold: below this fraction of non-operational resources the service
// badge collapses to `operational` (single-model churn ≠ service-level degradation, #159).
//
// History: introduced at 10% (#159/#160), then escalated 10→15→30% (#161/#162/#163) chasing
// recurring false-degraded alerts — but #162 found the REAL cause was the Cloudflare Workers
// connection limit (fixed in #164), NOT aggregate_state sensitivity. The 30% value was the residue
// of that misdiagnosis and was never re-validated post-#164. #722 returns it to the #159-justified
// ~10% so a genuine MULTI-model outage (≥10%, e.g. 3/29) registers as `degraded`, while a single
// model down (e.g. 1/29 = 3.4%) stays `operational` — and the #722 "Partial" display state (driven
// by `parseBetterStackPartialCount`, decoupled from this status) surfaces that single-model case
// without a Score penalty. RSS incidents still take priority in services.ts derivedStatus.
export const BETTERSTACK_DEGRADE_THRESHOLD = 0.1

export function parseBetterStackStatus(data: BetterStackIndex): 'operational' | 'degraded' | 'down' | null {
  const state = data.data?.attributes?.aggregate_state
  if (!state) return null
  if (state === 'operational') return 'operational'

  const resources = (data.included ?? []).filter(
    (r) => r.type === 'status_page_resource' && r.attributes?.status
  )
  const nonOpCount = resources.filter((r) => r.attributes?.status !== 'operational').length

  if (state === 'maintenance') {
    // Planned maintenance is not an outage on its own — escalate to `degraded` only when real
    // unplanned issues (degraded/downtime resources) coexist AND those issues exceed the
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
    if (realIssues / nonMaintenanceTotal < BETTERSTACK_DEGRADE_THRESHOLD) return 'operational'
    return 'degraded'
  }
  if (state === 'degraded') {
    if (resources.length > 0 && nonOpCount / resources.length < BETTERSTACK_DEGRADE_THRESHOLD) return 'operational'
    return 'degraded'
  }
  if (state === 'downtime') {
    if (resources.length > 0 && nonOpCount / resources.length < BETTERSTACK_DEGRADE_THRESHOLD) return 'operational'
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
 *
 * #731 — gate on the provider roll-up: when `aggregate_state === 'operational'` BetterStack's
 * own page header is all-green (no incident), so a stray resource-level degraded/downtime is a
 * transient model-monitor blip, NOT a partial outage. Surfacing the yellow Partial pill here would
 * contradict the provider's own all-clear (phantom Partial — Together AI, 2026-06-21, flapping
 * in/out per 60s `/api/status` poll). The intended #722 Partial case (provider shows "Some
 * services are down" while AIWatch's threshold collapses the badge to operational) ALWAYS has a
 * non-operational aggregate_state, so it's preserved. Only `operational` is gated: a `maintenance`
 * aggregate deliberately falls through (a real degraded/downtime resource during a maintenance
 * window is still a partial), diverging from `parseBetterStackStatus`'s collapse-to-operational.
 */
export function parseBetterStackPartialCount(data: BetterStackIndex): number {
  if (data.data?.attributes?.aggregate_state === 'operational') return 0
  return (data.included ?? []).filter(
    (r) =>
      r.type === 'status_page_resource' &&
      (r.attributes?.status === 'degraded' || r.attributes?.status === 'downtime')
  ).length
}

/** #1006 — the availability % the BetterStack page itself DISPLAYS (`attributes.availability`, averaged
 *  across resources, over the page's own ~90-day render window). This is the pre-#1006 number; it is no
 *  longer the metric (we compute 30 days from status_history), but it is shown beside ours on the detail
 *  page when they differ — the same disclosure every other source gets. null when no resource exposes it. */
export function parseBetterStackReportedUptime(data: BetterStackIndex): number | null {
  const resources = (data.included ?? []).filter(
    (r) => r.type === 'status_page_resource' && r.attributes?.availability != null,
  )
  if (resources.length === 0) return null
  const sum = resources.reduce((acc, r) => acc + r.attributes!.availability! * 100, 0)
  const avg = Math.round((sum / resources.length) * 100) / 100
  return avg >= 0 && avg <= 100 ? avg : null
}

/** #1006 — AIWatch's own trailing-30-day uptime for a BetterStack page.
 *
 *  The old path copied `attributes.availability` — a single float whose period the API never states
 *  (the page renders 90 days). Every other source was moved to a computed 30-day figure in #1006, and
 *  leaving this one on an unknown period would keep the Reliability Ranking comparing incomparable
 *  numbers, which is the whole bug.
 *
 *  The raw material was already here: `status_history` carries 90 entries of
 *  `{day, status, downtime_duration, maintenance_duration}` — the same per-day-seconds shape Atlassian
 *  publishes — and `parseBetterStackDailyImpact` has been reading it for the calendar all along. Uptime
 *  just never used it.
 *
 *  Per resource: 1 − Σ downtime_duration / (days × 86400) over the trailing `windowDays`.
 *  `maintenance_duration` is EXCLUDED — announced maintenance is not downtime, and penalising a provider
 *  for announcing its windows would invert the incentive (same rule as every other source, /methodology).
 *  `not_monitored` days are dropped from the denominator rather than scored as perfect.
 *  Then AVERAGED across resources, preserving the pre-#1006 avg-of-resources convention that the
 *  `platform_avg` label describes. Returns null when no resource carries a usable history. */
export function parseBetterStackUptime(data: BetterStackIndex, windowDays = 30): number | null {
  const resources = (data.included ?? []).filter(
    (r) => r.type === 'status_page_resource' && Array.isArray(r.attributes?.status_history),
  )
  if (resources.length === 0) return null

  const perResource: number[] = []
  for (const resource of resources) {
    // status_history is chronological (oldest first) — the trailing window is the tail.
    const days = resource.attributes!.status_history!.slice(-windowDays).filter((d) => d.status !== 'not_monitored')
    if (days.length === 0) continue
    const downSec = days.reduce((acc, d) => acc + (d.downtime_duration ?? 0), 0)
    const pct = (1 - downSec / (days.length * 86_400)) * 100
    if (pct < 0 || pct > 100) {
      console.warn(`[parseBetterStackUptime] ${resource.attributes?.public_name}: computed ${pct}% — history shape may have changed`)
      continue
    }
    perResource.push(pct)
  }
  if (perResource.length === 0) return null

  const avg = perResource.reduce((a, b) => a + b, 0) / perResource.length
  // Floor, like every other source: never round 99.998% up to a clean 100%.
  return Math.floor(avg * 100) / 100
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

// ── #1292 — incidents synthesized from index.json `status_history` ───────────────────
//
// BetterStack stopped publishing its monitor auto-events ("<resource> went down" / "recovered") to
// `/feed`. Services whose incident stream was ENTIRELY monitor-derived therefore publish zero
// incidents while `index.json` still records the downtime, and `score.ts` pays out Incidents 25/25 +
// Recovery 15/15 because both derive from `service.incidents`. This is NOT the #1199/#1234 class: the
// scrape is a healthy 200 with well-formed XML, so nothing books a failure anywhere.
//
// Measured 2026-08-28 against a 2026-07 baseline, the loss is not uniform — a service that DECLARES
// incidents by hand keeps them, while a monitor-derived one loses everything. So this synthesizes
// only to FILL GAPS; `services.ts` keeps RSS authoritative wherever the feed still speaks.

/** ActiveSupport zone NAME → IANA id. BetterStack publishes `timezone` as a Rails zone name, which is
 *  only sometimes an IANA id: `together` reads 'Pacific Time (US & Canada)' and `modal`/`huggingface`
 *  'Eastern Time (US & Canada)' as of 2026-08-28. V8/ICU rejects a non-IANA name with
 *  `RangeError: Invalid time zone specified` — in workerd and in Node alike (the workerd half checked
 *  in `wrangler dev` on 2026-08-28). Without a mapping those pages fall through to the UTC fallback:
 *  no crash, but every boundary shifts by the true offset, which is enough to move an incident onto
 *  the adjacent day and so into the wrong `affectedDays` bucket.
 *
 *  Rails names most of the world as a BARE CITY ('Berlin', 'Tokyo', 'Seoul'), and ICU rejects all of
 *  those too — so the table is not a US convenience, it is what keeps a European or Asian status page
 *  from silently computing in UTC. It is a fixed vocabulary (`ActiveSupport::TimeZone::MAPPING`), not
 *  a rotating one, so listing it here does not rot the way naming today's users would. */
/** Zones already reported this isolate. Keeps the warn above at effectively zero volume on a
 *  per-request path without demoting it to a level nothing reads. */
const WARNED_ZONES = new Set<string>()

const RAILS_ZONE_ALIASES: Record<string, string> = {
  // North America — the offset-style names, which no other Rails region uses.
  'pacific time (us & canada)': 'America/Los_Angeles',
  'mountain time (us & canada)': 'America/Denver',
  'central time (us & canada)': 'America/Chicago',
  'eastern time (us & canada)': 'America/New_York',
  'atlantic time (canada)': 'America/Halifax',
  'alaska': 'America/Anchorage', 'hawaii': 'Pacific/Honolulu', 'arizona': 'America/Phoenix',
  'newfoundland': 'America/St_Johns', 'saskatchewan': 'America/Regina',
  'indiana (east)': 'America/Indiana/Indianapolis', 'tijuana': 'America/Tijuana',
  // Europe / Africa
  'london': 'Europe/London', 'dublin': 'Europe/Dublin', 'edinburgh': 'Europe/London',
  'lisbon': 'Europe/Lisbon', 'amsterdam': 'Europe/Amsterdam', 'berlin': 'Europe/Berlin',
  'paris': 'Europe/Paris', 'madrid': 'Europe/Madrid', 'rome': 'Europe/Rome',
  'stockholm': 'Europe/Stockholm', 'copenhagen': 'Europe/Copenhagen', 'brussels': 'Europe/Brussels',
  'vienna': 'Europe/Vienna', 'bern': 'Europe/Zurich', 'zurich': 'Europe/Zurich',
  'prague': 'Europe/Prague', 'warsaw': 'Europe/Warsaw', 'budapest': 'Europe/Budapest',
  'helsinki': 'Europe/Helsinki', 'athens': 'Europe/Athens', 'istanbul': 'Europe/Istanbul',
  'kyiv': 'Europe/Kyiv', 'moscow': 'Europe/Moscow', 'casablanca': 'Africa/Casablanca',
  'cairo': 'Africa/Cairo', 'nairobi': 'Africa/Nairobi', 'jerusalem': 'Asia/Jerusalem',
  // Asia / Pacific
  'dubai': 'Asia/Dubai', 'karachi': 'Asia/Karachi', 'new delhi': 'Asia/Kolkata',
  'mumbai': 'Asia/Kolkata', 'chennai': 'Asia/Kolkata', 'kolkata': 'Asia/Kolkata',
  'bangkok': 'Asia/Bangkok', 'jakarta': 'Asia/Jakarta', 'hanoi': 'Asia/Bangkok',
  'beijing': 'Asia/Shanghai', 'hong kong': 'Asia/Hong_Kong', 'singapore': 'Asia/Singapore',
  'taipei': 'Asia/Taipei', 'seoul': 'Asia/Seoul', 'tokyo': 'Asia/Tokyo', 'osaka': 'Asia/Tokyo',
  'perth': 'Australia/Perth', 'adelaide': 'Australia/Adelaide', 'brisbane': 'Australia/Brisbane',
  'sydney': 'Australia/Sydney', 'melbourne': 'Australia/Melbourne', 'auckland': 'Pacific/Auckland',
  'wellington': 'Pacific/Auckland', 'fiji': 'Pacific/Fiji', 'guam': 'Pacific/Guam',
  'vladivostok': 'Asia/Vladivostok',
  // Latin America
  'mexico city': 'America/Mexico_City', 'bogota': 'America/Bogota', 'lima': 'America/Lima',
  'santiago': 'America/Santiago', 'brasilia': 'America/Sao_Paulo',
  'buenos aires': 'America/Argentina/Buenos_Aires',
}

/** Rails zone name / IANA id → an id this runtime accepts.
 *
 *  An unrecognised zone falls back to UTC. That is a real loss — every day boundary below is then off
 *  by the true offset — but it is NOT separately counted: this runs on the `/api/status` request path,
 *  where a permanent page-config condition would produce a traffic-shaped counter. The alias table
 *  covers the common `ActiveSupport::TimeZone::MAPPING` names, not all ~150 of them. */
export function resolveBetterStackTimeZone(tz: string | undefined): { tz: string } {
  const trimmed = (tz ?? '').trim()
  if (!trimmed || /^(utc|gmt)$/i.test(trimmed)) return { tz: 'UTC' }
  const alias = RAILS_ZONE_ALIASES[trimmed.toLowerCase()]
  if (alias) return { tz: alias }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed })
    return { tz: trimmed }
  } catch (err) {
    // WARN, once per zone per isolate. `debug` answered the RATE objection — `fetchService` resolves
    // the zone on every `/api/status` request — by dropping to a level nothing reads: there are a
    // handful of console.debug calls in the whole worker and the monitoring vocabulary is warn/error.
    // Keying the log answers the rate objection without hiding the condition, and the condition is
    // worth seeing: the consequence is not silence but MIS-BUCKETING — `derivedDay` shifts by the true
    // offset, moving an incident into the adjacent affectedDays bucket and, past ±12h, the adjacent
    // month. Nobody would ever trace an off-by-one-day incident date back to a timezone table.
    if (!WARNED_ZONES.has(trimmed)) {
      WARNED_ZONES.add(trimmed)
      console.warn(`[betterstack] #1292 unrecognized status-page timezone "${trimmed}" — computing day boundaries in UTC, which shifts them by the true offset:`, err instanceof Error ? err.message : err)
    }
    return { tz: 'UTC' }
  }
}

/** Offset (ms) of `tz` from UTC at the given instant. DST-correct because it asks the formatter. */
function zoneOffsetMs(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs))
  const p: Record<string, string> = {}
  for (const { type, value } of parts) p[type] = value
  // en-US + hour12:false renders midnight as '24' in some ICU builds — normalize before arithmetic.
  const hour = p.hour === '24' ? 0 : Number(p.hour)
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hour, Number(p.minute), Number(p.second)) - utcMs
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/** `Intl.DateTimeFormat` construction is the expensive part, and the claim walk in `services.ts`
 *  calls `zonedDayOf` twice per day of every feed incident's span, for all 45 services, on the
 *  `/api/status` request path. One formatter per zone, reused. Bounded by the alias table's size. */
const DAY_FORMATTERS = new Map<string, Intl.DateTimeFormat>()
function dayFormatter(tz: string): Intl.DateTimeFormat {
  let f = DAY_FORMATTERS.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    DAY_FORMATTERS.set(tz, f)
  }
  return f
}

/** The calendar date `at` falls on IN `tz` — NOT `toISOString().slice(0,10)`, which is the UTC date.
 *  Every other day string here is a page-local `status_history` day, and mixing the two made a page
 *  west of UTC compare against a midnight in the future. */
export function zonedDayOf(at: number, tz: string): string {
  return dayFormatter(tz).format(new Date(at))
}

/** The FIRST instant of local day `day` in `tz`, as UTC epoch ms.
 *
 *  Usually local midnight, but in a spring-forward-AT-midnight zone (`America/Santiago`,
 *  `America/Havana` — both reachable through `RAILS_ZONE_ALIASES`) 00:00 does not exist that day and
 *  the first instant is the transition itself. Correcting by the post-transition offset then lands on
 *  23:00 of the PREVIOUS day, which buckets the incident under the wrong `affectedDays`. So both
 *  candidate offsets are tried and the earliest one that actually falls on `day` wins; when local
 *  midnight exists (the ordinary case, and either side of an ordinary 02:00 transition) both agree. */
export function zonedDayStartMs(day: string, tz: string): number {
  const [y, m, d] = day.split('-').map(Number)
  const guess = Date.UTC(y, m - 1, d)
  const first = guess - zoneOffsetMs(guess, tz)
  const second = guess - zoneOffsetMs(first, tz)
  const onDay = [first, second].filter((c) => zonedDayOf(c, tz) === day)
  return onDay.length > 0 ? Math.min(...onDay) : first
}


/** `day` shifted by `n` calendar days, still YYYY-MM-DD. */
function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

/** A day's downtime is at least this long before it can become an incident. Aligned with
 *  `parseBetterStackDailyImpact`'s 600s floor for `minor` — below it the calendar already treats the
 *  day as negligible, so synthesizing an incident there would make the two signals disagree in the
 *  opposite direction. It also keeps the monitor flaps these pages emit out of affectedDays (helicone
 *  recorded a 43-second and a 5-minute one in August 2026), which every one of these services already
 *  asks for via `flapSuppression`. */
export const BS_HISTORY_MIN_DOWNTIME_SEC = 600

/** Default window, in `status_history` ROWS. The live pages serve one row per day ending with today,
 *  and today is then dropped as still-accruing — so this is ~29 completed days in practice, matching
 *  the Score's own trailing window closely enough for its purpose, rather than the 90 the page
 *  serves: `together` exposes a per-model resource each, so a 90-day sweep can add hundreds of rows to
 *  `svc.incidents` → `services:latest` → `incidents:monthly`, whose per-service cap truncates OLDEST
 *  first and would let synthesized history evict real incidents. */
const BS_HISTORY_WINDOW_DAYS = 30

/** Row-level BACKSTOP, not the working bound — the window is. Deliberately set where real data does
 *  not reach it, because the previous value (20, taken by analogy to `parseRssIncidents`' per-service
 *  feed cap) was dimensioned in the wrong unit and quietly defeated the fix.
 *
 *  A row here is one (resource, DAY); `affectedDays` — the metric this synthesis exists to restore —
 *  counts DAYS. A page with many resources spends the row budget on resource multiplicity, not on
 *  history, so the row cap truncates the WINDOW. Measured against `status.together.ai` on 2026-08-30
 *  (22 monitored resources): 41 rows over 22 downtime days became 20 rows over **10** days, dropping
 *  12 days and 73% of the downtime — oldest-first, i.e. toward a BETTER score, the same direction as
 *  the bug being fixed. The other four BetterStack services produced ≤9 rows, which is why a
 *  helicone-only check missed it.
 *
 *  Size, which is what 20 was protecting: the theoretical worst case is `resources × windowDays`
 *  (`resources × windowDays`, ~660 rows ≈ 165KB for one service) against a 25MB KV value limit, so it
 *  was never the binding constraint. Set above that worst case on purpose: a page that reaches it is
 *  in total outage across every resource for a month, and under-reporting THAT is academic. If it ever
 *  binds it is logged, never silent. */
const MAX_SYNTHESIZED_INCIDENTS = 1000

/** The bound that actually matters, in the unit that matters. Equal to the window by construction —
 *  every emitted day is already inside it — so this cannot bind today; it exists so the truncation is
 *  expressed in DAYS and a future window change cannot silently re-introduce the row-cap defect. */
const MAX_SYNTHESIZED_DAYS = BS_HISTORY_WINDOW_DAYS

/** #1292 — one incident per DOWNTIME DAY, synthesized from each resource's `status_history`.
 *
 *  **Exact:** the day, and that day's downtime seconds (the `duration`).
 *
 *  **Inferred:** where inside the day the downtime sat. `status_history` is per-DAY, so `4h 58m` on
 *  one day could be one outage or six and carries no time-of-day. Each incident therefore carries its day
 *  in `derivedDay` and is tagged `derived: 'status_history'`. That tag is READ, not decorative: the
 *  SPA's `formatDate({ dayOnly })` and the is-down template both drop the time of day for it, and
 *  `carriesRecoveryTime` (score.ts) keeps its duration out of every MTTR consumer.
 *
 *  **Deliberately NOT joined across midnight.** An earlier design merged consecutive days into runs so
 *  a multi-day outage read as one incident, and reconstructed its true boundaries from the first and
 *  last day's partial seconds — which reproduced helicone's Jul 2-4 outage to the minute. It was
 *  removed because the id has to key on something, a run's extent is a function of the window, the
 *  RSS claim set AND the not-yet-closed day, and all three of those move: across three review rounds
 *  every key derived from a run renamed itself in production, and `incidents:monthly` accumulates BY
 *  id — so one 59h outage banked as three rows totalling 113h, and `prunePhantomIncidents` reads a
 *  vanished id as a provider WITHDRAWAL and announces it publicly. A per-day id is a function of one
 *  closed, immutable `status_history` row and nothing else.
 *
 *  The cost is real and one-directional: a multi-day outage is published as N day-sized incidents, so
 *  the count is the number of downtime DAYS and `affectedDays` counts each of them. Total downtime is
 *  unaffected. Two adjacent partial days were never disambiguable anyway — helicone's Jul 23 (4.97h) +
 *  Jul 24 (16.30h) WAS one incident while together's Gemma Jul 27-30 was four separate blips, and the
 *  daily totals do not separate those shapes — so the join was always guessing on exactly the input it
 *  was least able to read.
 *
 *  **The current local day is excluded** — still accruing, so its seconds are a partial read and its
 *  incident would have to invent a start time. Everything emitted is closed and immutable, which also
 *  keeps synthesis off the alert path: the new-incident branch never sees a resolved incident, and the
 *  resolved branch is gated on the `alertedNewMap` marker a new alert would have written.
 */
export function parseBetterStackDowntimeIncidents(
  data: BetterStackIndex,
  opts: {
    denylist?: string[]
    windowDays?: number
    now?: number
    minDowntimeSec?: number
    /** Days the RSS feed already accounts for, per resource. */
    isClaimed?: (resourceName: string, day: string) => boolean
    /** Oldest page-local day the feed can still speak for. Days older than this are skipped: the
     *  feed's silence there means "the item aged out of what we parse", not "there was no incident",
     *  and the accumulator may already hold an RSS row for that outage under a different id. */
    notBefore?: string
  } = {},
): Incident[] {
  const {
    windowDays = BS_HISTORY_WINDOW_DAYS, now = Date.now(),
    minDowntimeSec = BS_HISTORY_MIN_DOWNTIME_SEC, isClaimed, notBefore,
  } = opts
  const { tz } = resolveBetterStackTimeZone(data.data?.attributes?.timezone)
  const sections = betterStackSectionNames(data)
  const deny = new Set((opts.denylist ?? []).map((n) => n.toLowerCase()))
  const today = zonedDayOf(now, tz)
  const windowFrom = addDays(today, -windowDays)
  const out: Incident[] = []

  for (const resource of data.included ?? []) {
    if (resource.type !== 'status_page_resource') continue
    const name = resource.attributes?.public_name
    if (!name || isDeniedBetterStackResource(resource, sections, deny)) continue
    const history = resource.attributes?.status_history
    if (!Array.isArray(history)) continue

    for (const d of history) {
      if (!DAY_RE.test(d.day ?? '')) {
        console.warn(`[betterstack] #1292 ${name}: unusable status_history day "${d.day}" — skipping the row`)
        continue
      }
      if (d.day >= today) continue                 // still accruing — see the doc comment
      if (d.day < windowFrom) continue
      // The feed's reach is NOT the synthesis window. `parseRssIncidents` caps at 20 groups, drops
      // maintenance titles and sub-60s blips, and only sees whatever `/feed` still serves — so for a
      // day older than the oldest surviving feed item we cannot read silence as absence. Synthesizing
      // there re-banks an outage the accumulator already holds from RSS, under a second id that
      // nothing dedups (both rows are `resolved`, so `prunePhantomIncidents` skips them).
      if (notBefore && d.day < notBefore) continue
      if (d.status === 'not_monitored') continue
      // Excluded to match how the INCIDENT path has always treated maintenance: `parseRssIncidents`
      // drops `MAINTENANCE_TITLE` items and `services.ts` drops `index.json` `report_type:
      // 'maintenance'` ids. Note the two OTHER readers of this same field do NOT — measured
      // 2026-08-29, a `status: 'maintenance'` day with non-zero `downtime_duration` scores identically
      // to a `downtime` day in `parseBetterStackUptime` (91.66 either way) and reddens
      // `parseBetterStackDailyImpact`. So a maintenance day shows on the calendar and in uptime while
      // carrying no incident — a deliberate divergence inherited from the incident path, not an
      // oversight, and NOT something this parser is making consistent.
      if (d.status === 'maintenance' || d.status === 'under_maintenance') continue
      if ((d.maintenance_duration ?? 0) > 0 && (d.downtime_duration ?? 0) <= (d.maintenance_duration ?? 0)) continue
      const sec = d.downtime_duration ?? 0
      // A row that DECLARES downtime but reports none is self-contradictory — a schema signal, not a
      // quiet day, and it must not fall through the same floor as a genuine 3-minute blip. This is the
      // #1292 failure mode returning by another door: the three readers of this payload
      // (`parseBetterStackUptime`, `parseBetterStackDailyImpact`, and this one) all key on
      // `downtime_duration`, so renaming that ONE subfield yields uptime 100.00%, an empty calendar and
      // zero incidents — the exact production signature, now with a plausible uptime instead of a null.
      if ((d.status === 'downtime' || d.status === 'degraded') && sec === 0) {
        console.warn(`[betterstack] #1292 ${name}: status="${d.status}" on ${d.day} but downtime_duration is ${d.downtime_duration === undefined ? 'absent' : '0'} — status_history shape may have changed`)
        continue
      }
      if (sec < minDowntimeSec) continue
      if (isClaimed?.(name, d.day)) continue

      // An anchor INSIDE the day, not a claim about the time of day — which `status_history` does not
      // state. The day itself travels as `derivedDay` (see `types.ts`), because no instant can encode
      // it for consumers that slice in different zones: local noon reads back as the previous UTC day
      // on a page past UTC+12 (`Auckland` in NZDT, aliased here), and as the next one for a viewer far
      // enough east of the page. Noon is chosen only so the anchor sits inside its own local day.
      const startMs = zonedDayStartMs(d.day, tz) + 12 * 3_600_000
      out.push({
        // A function of ONE closed `status_history` row: the resource and the day. Nothing about the
        // window, the RSS claim set, or a run's extent can move it. See the doc comment for why that
        // matters — `incidents:monthly` accumulates by id, and a vanished id reads as a withdrawal.
        id: `bs-hist:${resource.id ?? name}:${d.day}`,
        title: `${name} — recovered`,
        status: 'resolved',
        // The RSS monitor posts these replace carried no severity wording either, so
        // `mapBetterStackImpact` scored every one of them `minor`. Matching that keeps the monthly
        // series continuous — and it must be NON-null, or the #261 filter drops it from affectedDays.
        // Deliberately NOT `autoMonitor`: that flag makes `isReliabilityIncident` exclude the incident
        // from affectedDays/MTTR (#989), which would leave the Score exactly as broken as it is today.
        // These services carry no `autoMonitorTitles`, so their RSS incidents were untagged too.
        impact: 'minor',
        componentNames: [name],
        startedAt: new Date(startMs).toISOString(),
        resolvedAt: new Date(startMs + sec * 1000).toISOString(),
        duration: formatDuration(new Date(0), new Date(sec * 1000)),
        timeline: [],
        derived: 'status_history',
        derivedDay: d.day,
      })
    }
  }

  // Truncate by DAY, newest-first — never by row. See `MAX_SYNTHESIZED_INCIDENTS` for the measurement
  // that made this necessary. A whole day is kept or dropped together, so `affectedDays` can never be
  // halved by a page that simply has more resources than another.
  //
  // WITHIN a day every row shares one anchor, so `startedAt` ties and a bare date sort leaves the order
  // to however the resources happened to appear in `included`. The is-down card renders this array's
  // order directly, so that order is published: state it — longest first, then resource name, the same
  // rule `compareIncidents` applies on the SPA (pinned by `derived-same-day-order.test.js`). Compared
  // at the MINUTE each row displays, so two rows reading "11h 36m" fall to the name instead of being
  // split by the sub-second float in `downtime_duration`.
  const spanMin = (i: Incident) =>
    displayedMinutes(Date.parse(i.resolvedAt ?? '') - Date.parse(i.startedAt))
  out.sort((a, b) =>
    b.startedAt.localeCompare(a.startedAt)
    || (a.derivedDay === b.derivedDay ? spanMin(b) - spanMin(a) || a.title.localeCompare(b.title) : 0))
  const kept: Incident[] = []
  const keptDays = new Set<string>()
  for (const inc of out) {
    const day = inc.derivedDay!
    if (!keptDays.has(day) && keptDays.size >= MAX_SYNTHESIZED_DAYS) break
    if (kept.length >= MAX_SYNTHESIZED_INCIDENTS) {
      // The one branch that knowingly discards MEASURED downtime. Never silent: an under-reported
      // `affectedDays` is indistinguishable from a healthier service, which is the whole #1292 bug.
      console.warn(`[betterstack] #1292 synthesis hit the row backstop: ${out.length} rows over ${new Set(out.map((i) => i.derivedDay)).size} days capped to ${MAX_SYNTHESIZED_INCIDENTS} — affectedDays is UNDER-reported`)
      break
    }
    keptDays.add(day)
    kept.push(inc)
  }
  return kept
}
