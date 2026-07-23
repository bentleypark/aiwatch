// Flashduty status-page parser (#618). DeepSeek migrated its status page to Flashduty
// (status.deepseek.com, #507), whose host blocks non-browser TLS fingerprints — a Cloudflare
// Worker `fetch()` is reset at the TLS layer regardless of egress IP (verified 2026-06-12: a real
// Chromium from the SAME IP succeeds where curl/fetch are reset). So the Worker cannot read it
// directly; instead a scheduled GitHub Action renders the page in a real browser, fetches the
// (clean JSON) Flashduty API, and POSTs the raw payload to /api/internal/deepseek-feed, which caches
// it in KV. This module normalizes that raw payload into AIWatch's ServiceStatus shape.
//
// Flashduty data model (status.deepseek.com/api/status-page/{pageId}/...):
//   summary/active      → { page:{ components[] }, active_changes[] }   (currently-open incidents)
//   change/list         → { items[] }                                  (full incidents incl. timeline)
//   summary/structure   → { component_impacts[], component_uptimes[] } (per-component outage windows + uptime%)
import type { Incident, TimelineEntry, ServiceComponent, DailyImpactLevel } from '../types'
import { formatDuration } from '../utils'
import { MAJOR_WEIGHT, MINOR_WEIGHT } from './impact-weights'
import { weightedDowntimeSeconds, type OutageInterval } from './uptime-interval'

// ── Raw Flashduty payload shapes (only the fields we consume) ──
export interface FlashdutyComponent {
  component_id: string
  name: string
  description?: string
  order_id?: number
}
interface FlashdutyComponentChange {
  component_id: string
  component_name?: string
  status: string
}
interface FlashdutyUpdate {
  update_id?: string
  at_seconds: number
  status: string
  description?: string
  component_changes?: FlashdutyComponentChange[]
}
export interface FlashdutyChange {
  change_id: number
  type?: string
  title: string
  description?: string
  status: string
  affected_components?: Array<{ component_id: string; name: string; status: string }>
  start_at_seconds: number
  close_at_seconds?: number
  updates?: FlashdutyUpdate[]
}
interface FlashdutyComponentImpact {
  component_id: string
  change_id: number
  start_at_seconds: number
  end_at_seconds: number
  status: string
}
interface FlashdutyComponentUptime {
  component_id: string
  uptime: number
}

/** #1006 — trailing-30-day uptime from the feed's outage intervals, weighted per /methodology.
 *  `component_uptimes` is used only as the component ROSTER (which components the feed tracks) — a
 *  component absent from it is one Flashduty doesn't monitor, and an empty roster yields null rather
 *  than a fabricated 100%: absence of impact records is not evidence of absence of downtime (#713).
 *  Worst-of across the roster. Times are unix SECONDS on this feed. */
export function computeFlashdutyUptime(
  impacts: FlashdutyComponentImpact[],
  roster: FlashdutyComponentUptime[],
  nowMs: number,
  windowDays = 30,
): number | null {
  if (roster.length === 0) return null
  const windowStart = nowMs - windowDays * 86_400_000
  const windowSec = windowDays * 86_400

  let worst: number | null = null
  for (const component of roster) {
    // Collect (start, end, weight) in ms and let the shared accumulator clamp open impacts (0/absent
    // end) to now and merge overlaps (worst-weight-wins) so an escalation isn't summed on top of itself.
    const intervals: OutageInterval[] = []
    for (const impact of impacts) {
      if (impact.component_id !== component.component_id) continue
      const weight = flashdutyImpactWeight(impact.status)
      if (weight === 0) continue
      intervals.push({
        start: (impact.start_at_seconds ?? NaN) * 1000,
        end: impact.end_at_seconds ? impact.end_at_seconds * 1000 : null, // 0/absent = still open
        weight,
      })
    }
    const weightedSec = weightedDowntimeSeconds(intervals, windowStart, nowMs)
    const pct = Math.max(0, Math.floor((1 - weightedSec / windowSec) * 10000) / 100)
    if (worst === null || pct < worst) worst = pct
  }
  return worst
}

/** Flashduty component status → the weights on /methodology. Unknown → counted as a partial outage and
 *  warned about, never as zero downtime (a new status must not silently inflate the service to 100%). */
function flashdutyImpactWeight(status: string): number {
  const s = (status ?? '').toLowerCase()
  if (s.includes('major') || s.includes('full') || s.includes('down') || s.includes('outage')) {
    return s.includes('partial') ? MINOR_WEIGHT : MAJOR_WEIGHT
  }
  if (s.includes('degrad') || s.includes('partial') || s.includes('minor')) return MINOR_WEIGHT
  if (s.includes('maintenance') || s.includes('operational') || s === '') return 0
  console.warn(`[flashduty] unknown component_impacts status "${status}" — counted as a partial outage`)
  return MINOR_WEIGHT
}

/** The payload the GitHub Action POSTs — the three Flashduty `data` objects, verbatim. */
export interface FlashdutyFeed {
  active?: { page?: { components?: FlashdutyComponent[] }; active_changes?: FlashdutyChange[] }
  changeList?: { items?: FlashdutyChange[] }
  structure?: { component_impacts?: FlashdutyComponentImpact[]; component_uptimes?: FlashdutyComponentUptime[] }
}

/** KV envelope: the raw feed + when the scraper captured it. */
export interface StoredFlashdutyFeed {
  fetchedAt: string
  feed: FlashdutyFeed
}

// KV key the scraper (via /api/internal/deepseek-feed) writes and fetchService('deepseek') reads.
export const DEEPSEEK_FEED_KV_KEY = 'deepseek:feed'
// KV TTL. The scraper runs ~every 10 min; a 3h TTL tolerates ~18 consecutive missed runs before the
// key expires and fetchService falls back to the frozen Atlassian mirror (with incidentSourceStale).
export const DEEPSEEK_FEED_TTL_S = 3 * 60 * 60
// Soft-staleness gate: a feed older than this still SERVES (badge/incidents stay live) but re-asserts
// incidentSourceStale so the aging snapshot is excluded from Score ranking until a fresh push lands.
// Graded degradation between "fresh → ranked" (≤1h) and "expired → frozen mirror" (>3h TTL).
export const DEEPSEEK_FEED_SOFT_STALE_S = 60 * 60

export interface ParsedFlashduty {
  status: 'operational' | 'degraded' | 'down'
  incidents: Incident[]
  uptime30d: number | null
  dailyImpact: Record<string, DailyImpactLevel>
  components: ServiceComponent[]
}

// Flashduty component status → AIWatch badge status. partial_outage is a degradation (not a full
// down); maintenance is treated as operational (planned, not an availability incident).
const COMPONENT_STATUS: Record<string, 'operational' | 'degraded' | 'down'> = {
  operational: 'operational',
  degraded: 'degraded',
  degraded_performance: 'degraded',
  partial_outage: 'degraded',
  maintenance: 'operational',
  under_maintenance: 'operational',
  full_outage: 'down',
  major_outage: 'down',
}
function compStatus(s: string | undefined): 'operational' | 'degraded' | 'down' {
  return COMPONENT_STATUS[(s ?? '').toLowerCase()] ?? 'operational'
}

// Flashduty component status → AIWatch DailyImpactLevel (for the Score's Atlassian-weighted affected
// days, #260/#261). full_outage dominates (critical/red), partial_outage = major/orange,
// degraded = minor. operational/maintenance contribute no impact.
function impactLevelOf(s: string | undefined): DailyImpactLevel | null {
  switch ((s ?? '').toLowerCase()) {
    case 'full_outage':
    case 'major_outage':
      return 'critical'
    case 'partial_outage':
      return 'major'
    case 'degraded':
    case 'degraded_performance':
      return 'minor'
    default:
      return null
  }
}

const STAGE_ORDER: Record<DailyImpactLevel, number> = { minor: 1, major: 2, critical: 3 }

// Flashduty incident status → AIWatch Incident.status. Unknown phases default to 'investigating'
// (the safest "open" stage) so a renamed phase never silently reads as resolved.
function mapStage(s: string | undefined): Incident['status'] {
  switch ((s ?? '').toLowerCase()) {
    case 'investigating':
      return 'investigating'
    case 'identified':
      return 'identified'
    case 'monitoring':
      return 'monitoring'
    case 'resolved':
      return 'resolved'
    default:
      return 'investigating'
  }
}

// Flashduty descriptions are bilingual ("中文\n\nEnglish"). Keep the English half when present
// (after the blank-line separator) so AIWatch surfaces read in English; fall back to the whole
// string. Trim to a single line for timeline display.
function cleanText(desc: string | undefined): string | null {
  if (!desc) return null
  const parts = desc.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  if (parts.length === 0) return null
  const english = parts.find((p) => /[A-Za-z]/.test(p) && !/[一-鿿]/.test(p))
  return (english ?? parts[parts.length - 1]).replace(/\s+/g, ' ').trim() || null
}

function toIncident(c: FlashdutyChange): Incident {
  const updates = [...(c.updates ?? [])].sort((a, b) => a.at_seconds - b.at_seconds)
  const timeline: TimelineEntry[] = updates.map((u) => ({
    stage: mapStage(u.status),
    text: cleanText(u.description),
    at: new Date(u.at_seconds * 1000).toISOString(),
  }))
  // Worst component status seen across the incident → impact severity.
  const statuses = [
    ...updates.flatMap((u) => (u.component_changes ?? []).map((cc) => cc.status)),
    ...(c.affected_components ?? []).map((a) => a.status),
  ]
  let impact: Incident['impact'] = null
  for (const s of statuses) {
    const lvl = impactLevelOf(s)
    if (lvl && (impact === null || STAGE_ORDER[lvl] > STAGE_ORDER[impact])) impact = lvl
  }
  const status = mapStage(c.status)
  const resolved = status === 'resolved'
  const startMs = c.start_at_seconds * 1000
  const endMs = c.close_at_seconds ? c.close_at_seconds * 1000 : null
  return {
    id: `flashduty:${c.change_id}`,
    title: c.title,
    status,
    impact,
    componentNames: (c.affected_components ?? []).map((a) => a.name),
    startedAt: new Date(startMs).toISOString(),
    resolvedAt: resolved && endMs ? new Date(endMs).toISOString() : null,
    duration: resolved && endMs ? formatDuration(new Date(startMs), new Date(endMs)) : null,
    timeline,
  }
}

// Per-day worst impact across all component outage windows → the Score's dailyImpact map.
function buildDailyImpact(impacts: FlashdutyComponentImpact[]): Record<string, DailyImpactLevel> {
  const out: Record<string, DailyImpactLevel> = {}
  for (const imp of impacts) {
    const lvl = impactLevelOf(imp.status)
    if (!lvl) continue
    const start = new Date(imp.start_at_seconds * 1000)
    const end = new Date((imp.end_at_seconds || imp.start_at_seconds) * 1000)
    // Walk each UTC day the window touches.
    for (let t = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()); t <= end.getTime(); t += 86_400_000) {
      const day = new Date(t).toISOString().slice(0, 10)
      if (!out[day] || STAGE_ORDER[lvl] > STAGE_ORDER[out[day]]) out[day] = lvl
    }
  }
  return out
}

export interface ParseFlashdutyOptions {
  // #618 option A — scope the badge/incidents/uptime/dailyImpact to a SINGLE Flashduty component
  // (e.g. DeepSeek's API Service, excluding its Web Chat consumer-app surface — same api-vs-app split
  // AIWatch applies to OpenAI API vs ChatGPT). When set: status/uptime/incidents/impacts derive only
  // from this component, and `components` collapses to just it (so the ≥2-gated breakdown is
  // suppressed). When absent, the whole feed is in-scope (all components, worst-of badge).
  primaryComponentId?: string
  /** #1006 — override 'now' so the trailing-30-day uptime is deterministic in tests. */
  nowMs?: number
}

/** Whether a change touched the given component (in its affected_components or any update). */
function changeAffectsComponent(c: FlashdutyChange, compId: string): boolean {
  if ((c.affected_components ?? []).some((a) => a.component_id === compId)) return true
  return (c.updates ?? []).some((u) => (u.component_changes ?? []).some((cc) => cc.component_id === compId))
}

/**
 * Normalize a raw Flashduty feed payload into AIWatch's ServiceStatus fields.
 * Pure — no I/O. `incidentKeywords` is intentionally NOT applied; scoping (when needed) is by
 * component id via `opts.primaryComponentId`, not keyword matching.
 */
export function parseFlashdutyFeed(feed: FlashdutyFeed, opts: ParseFlashdutyOptions = {}): ParsedFlashduty {
  const primaryId = opts.primaryComponentId
  const nowMs = opts.nowMs ?? Date.now() // #1006 — injectable for deterministic uptime tests
  const pageComponents = (feed.active?.page?.components ?? []).filter((pc) => !primaryId || pc.component_id === primaryId)
  const activeChanges = (feed.active?.active_changes ?? []).filter((c) => mapStage(c.status) !== 'resolved')

  // Current per-component status: worst non-resolved active impact on that component, else operational.
  const liveStatusByComp = new Map<string, 'operational' | 'degraded' | 'down'>()
  const rank = { operational: 0, degraded: 1, down: 2 } as const
  for (const c of activeChanges) {
    for (const a of c.affected_components ?? []) {
      if (primaryId && a.component_id !== primaryId) continue
      const s = compStatus(a.status)
      const prev = liveStatusByComp.get(a.component_id) ?? 'operational'
      if (rank[s] > rank[prev]) liveStatusByComp.set(a.component_id, s)
    }
  }

  const components: ServiceComponent[] = pageComponents.map((pc) => ({
    id: pc.component_id,
    name: pc.name,
    status: liveStatusByComp.get(pc.component_id) ?? 'operational',
  }))

  // Overall badge = worst (scoped) component status.
  let status: 'operational' | 'degraded' | 'down' = 'operational'
  for (const c of components) if (rank[c.status] > rank[status]) status = c.status

  // History incidents (change/list) + any active ones not already in history, scoped to the primary
  // component when set, newest first.
  const historyItems = feed.changeList?.items ?? []
  const seen = new Set(historyItems.map((i) => i.change_id))
  const allChanges = [...historyItems, ...activeChanges.filter((c) => !seen.has(c.change_id))]
    .filter((c) => !primaryId || changeAffectsComponent(c, primaryId))
  const incidents = allChanges
    .map(toIncident)
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())

  // #1006 — uptime is COMPUTED over the trailing 30 days from `component_impacts` (the same start/end
  // intervals this parser already turns into `dailyImpact` below), not copied from the feed's published
  // `component_uptimes` aggregate. That aggregate's period is Flashduty's, not ours, so this feed is
  // computed over a trailing 30 days with the 1.0/0.3 weights. #1110 — do NOT generalise that to every
  // source: `platform_avg` (Better Stack) applies no severity weighting at all and narrows its window
  // per resource, and Instatus's Next.js path honours a provider-published `customImpactPercentage`. Worst-of across components when the service isn't scoped to
  // one: a multi-component service's availability is gated by its weakest surface.
  const uptime30d = computeFlashdutyUptime(
    (feed.structure?.component_impacts ?? []).filter((imp) => !primaryId || imp.component_id === primaryId),
    (feed.structure?.component_uptimes ?? []).filter((u) => !primaryId || u.component_id === primaryId),
    nowMs,
  )

  const dailyImpact = buildDailyImpact(
    (feed.structure?.component_impacts ?? []).filter((imp) => !primaryId || imp.component_id === primaryId),
  )

  return { status, incidents, uptime30d, dailyImpact, components }
}
