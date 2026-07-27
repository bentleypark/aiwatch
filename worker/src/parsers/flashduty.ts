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
import { weightedDowntimeSeconds, startOfTodayUTC, type OutageInterval } from './uptime-interval'

// ── Raw Flashduty payload shapes (only the fields we consume) ──
export interface FlashdutyComponent {
  component_id: string
  name: string
  description?: string
  order_id?: number
  /** #1171 — present when the provider groups this component under a named section on the status
   *  page (e.g. DeepSeek's "对话服务(Chat Service)" wraps Instant/Expert/Vision Mode, File Upload,
   *  Search). Absent for standalone top-level components (DeepSeek's 2 API components have none). */
  section_id?: string
}
interface FlashdutySection {
  section_id: string
  name: string
}
interface FlashdutySectionUptime {
  section_id: string
  uptime: number
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
export interface FlashdutyUptime {
  pct: number
  /** #1017 — worst-of independently of `pct` (the most-affected-TODAY component can differ from the
   *  30-day-worst one, same reasoning as the incident-io / Statuspage / Instatus aggregations). */
  todayWeightedOutageSec: number
}

export function computeFlashdutyUptime(
  impacts: FlashdutyComponentImpact[],
  roster: FlashdutyComponentUptime[],
  nowMs: number,
  windowDays = 30,
): FlashdutyUptime | null {
  if (roster.length === 0) return null
  const windowStart = nowMs - windowDays * 86_400_000
  const windowSec = windowDays * 86_400
  const todayStart = startOfTodayUTC(nowMs)

  let worst: FlashdutyUptime | null = null
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
    // #1017 — cheap second call over the SAME intervals, today's window instead of the trailing one.
    const todayWeightedOutageSec = weightedDowntimeSeconds(intervals, todayStart, nowMs)
    if (worst === null) worst = { pct, todayWeightedOutageSec }
    else worst = { pct: Math.min(worst.pct, pct), todayWeightedOutageSec: Math.max(worst.todayWeightedOutageSec, todayWeightedOutageSec) }
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
  active?: { page?: { components?: FlashdutyComponent[]; sections?: FlashdutySection[] }; active_changes?: FlashdutyChange[] }
  changeList?: { items?: FlashdutyChange[] }
  structure?: {
    component_impacts?: FlashdutyComponentImpact[]
    component_uptimes?: FlashdutyComponentUptime[]
    section_uptimes?: FlashdutySectionUptime[]
  }
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
  /** #1017 — pct + today's weighted outage seconds, ALWAYS both present or both absent (a single
   *  `computeFlashdutyUptime()` call produces them together) — kept as one field rather than two
   *  independently-optional ones so a future edit can't update one half without the other. Null when
   *  there's no roster / no scoped component. */
  flashdutyUptime: FlashdutyUptime | null
  /** #1171 — the feed's OWN published uptime% for the scoped roster (status.deepseek.com's own
   *  ~90-day figure) — separate from `flashdutyUptime` (AIWatch's 30-day recompute). When the scope
   *  exactly covers one of the provider's named SECTIONS (e.g. DeepSeek's "对话服务/Chat Service",
   *  which groups 5 leaf components), this is that section's own published `section_uptimes` value —
   *  NOT a worst-of the leaves, because the provider computes the section figure from its own
   *  `section_impacts` log and it does not equal min(leaf uptimes) (observed live: section 99.74% vs.
   *  leaf-worst 99.73%). Otherwise (standalone components with no grouping section, e.g. DeepSeek's 2
   *  API components) it's worst-of the scoped `component_uptimes`. Null when there's no roster, same
   *  condition as `flashdutyUptime`. */
  reportedUptime: number | null
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

// #1171 — component NAMES are bilingual on ONE line, not two paragraphs like descriptions
// (cleanText above): "DeepSeek V4 Pro API服务(API Service)", "快速模式(Instant Mode)". Scoping to an
// array of component ids (this issue) is what first makes a Flashduty component breakdown reach
// ServiceDetails at all for deepseek/deepseekapp (previously suppressed — the single stale id matched
// 0 components), so unlike cleanText's fallback-to-whole-string, this always strips CJK: a name that's
// ALL CJK-wrapped-in-English-parens (the App-side pattern) reduces to just the parenthetical; a MIXED
// name (the API-side pattern, already-English text before a CJK suffix) keeps its English prefix and
// gets a space inserted before the trailing "(...)" for readability.
function cleanComponentName(name: string): string {
  const stripped = name.replace(/[一-鿿]+/g, '').replace(/\s+/g, ' ').trim()
  if (!stripped) return name
  const fullyWrapped = stripped.match(/^\((.+)\)$/)
  return fullyWrapped ? fullyWrapped[1] : stripped.replace(/([^\s(])\(/g, '$1 (')
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
  // #618 option A — scope the badge/incidents/uptime/dailyImpact to a SET of Flashduty components
  // (e.g. DeepSeek's API-side components, excluding its Web Chat consumer-app surface — same
  // api-vs-app split AIWatch applies to OpenAI API vs ChatGPT). When set: status/uptime/incidents/
  // impacts derive only from these components (worst-of across the set — #1171, DeepSeek's V4 status-
  // page reorg split what was one "API Service" component into "V4 Pro API" + "V4 Flash API"), and
  // `components` collapses to just them (so the ≥2-gated breakdown is suppressed unless the set itself
  // has ≥2). When absent, the whole feed is in-scope (all components, worst-of badge). A bare string is
  // accepted for the common single-component case; normalized to an array internally.
  primaryComponentId?: string | [string, ...string[]]
  /** #1006 — override 'now' so the trailing-30-day uptime is deterministic in tests. */
  nowMs?: number
}

/** Whether a change touched any of the given components (in its affected_components or any update). */
function changeAffectsComponent(c: FlashdutyChange, compIds: string[]): boolean {
  if ((c.affected_components ?? []).some((a) => compIds.includes(a.component_id))) return true
  return (c.updates ?? []).some((u) => (u.component_changes ?? []).some((cc) => compIds.includes(cc.component_id)))
}

/** #1171 — resolve the feed's own published uptime% for the scoped roster. When `primaryIds` exactly
 *  covers one of the provider's named sections — every member of that section is in scope, AND no
 *  in-scope component is outside it (neither a different section NOR a standalone/unsectioned one) —
 *  use that section's own `section_uptimes` value. The provider computes it from its own
 *  `section_impacts` log, not from the leaf components, so it is not equal to worst-of the leaves
 *  (DeepSeek: section 99.74% vs. leaf-worst 99.73%, observed live). A partial slice of a section, a mix
 *  of sectioned + standalone components, or a section with no published `section_uptimes` entry all
 *  fall back to worst-of the leaf `component_uptimes` roster — the same computation this replaced. */
function reportedUptimeFor(feed: FlashdutyFeed, primaryIds: string[] | null, scopedRoster: FlashdutyComponentUptime[]): number | null {
  if (scopedRoster.length === 0) return null
  if (primaryIds) {
    const pageComponents = feed.active?.page?.components ?? []
    const matched = pageComponents.filter((pc) => primaryIds.includes(pc.component_id))
    const sectionIds = new Set(matched.map((pc) => pc.section_id).filter((id): id is string => !!id))
    if (sectionIds.size === 1 && matched.length === primaryIds.length) {
      const [sectionId] = sectionIds
      const sectionMembers = pageComponents.filter((pc) => pc.section_id === sectionId)
      // Exact correspondence, not just sectionMembers ⊆ matched: `sectionIds.size === 1` alone lets a
      // STANDALONE (no-section) component sneak into `matched` without adding a second section id, so
      // without this length check a scope of "all 5 section members + 1 unrelated standalone id" wrongly
      // passed (verified against the real fixture) — the length equality forces matched === sectionMembers.
      if (sectionMembers.length === matched.length && sectionMembers.every((pc) => primaryIds.includes(pc.component_id))) {
        const sectionUptime = feed.structure?.section_uptimes?.find((s) => s.section_id === sectionId)
        if (sectionUptime) return sectionUptime.uptime
      }
    }
  }
  return Math.min(...scopedRoster.map((u) => u.uptime))
}

/**
 * Normalize a raw Flashduty feed payload into AIWatch's ServiceStatus fields.
 * Pure — no I/O. `incidentKeywords` is intentionally NOT applied; scoping (when needed) is by
 * component id via `opts.primaryComponentId`, not keyword matching.
 */
export function parseFlashdutyFeed(feed: FlashdutyFeed, opts: ParseFlashdutyOptions = {}): ParsedFlashduty {
  const primaryIds = opts.primaryComponentId == null
    ? null
    : Array.isArray(opts.primaryComponentId) ? opts.primaryComponentId : [opts.primaryComponentId]
  const nowMs = opts.nowMs ?? Date.now() // #1006 — injectable for deterministic uptime tests
  const pageComponents = (feed.active?.page?.components ?? []).filter((pc) => !primaryIds || primaryIds.includes(pc.component_id))
  // #1171 — a scoped id (or every id in the array) matching NONE of the feed's current components is
  // exactly how this issue's bug reached production silently: the provider reorganized its status page,
  // the configured ids went stale, and `flashdutyUptime`/`components` quietly degraded to null/empty
  // with nothing logged. A real feed always has ≥1 component, so 0 matches on a non-empty feed means
  // the CONFIG drifted, not that the service has no components — warn once per call so a future reorg
  // shows up in Worker logs instead of waiting for someone to notice a null uptime.
  if (primaryIds && pageComponents.length === 0 && (feed.active?.page?.components?.length ?? 0) > 0) {
    console.warn(`[flashduty] primaryComponentId matched 0 of ${feed.active!.page!.components!.length} feed components — stale config? uptime/incidents/status will be empty`)
  }
  const activeChanges = (feed.active?.active_changes ?? []).filter((c) => mapStage(c.status) !== 'resolved')

  // Current per-component status: worst non-resolved active impact on that component, else operational.
  const liveStatusByComp = new Map<string, 'operational' | 'degraded' | 'down'>()
  const rank = { operational: 0, degraded: 1, down: 2 } as const
  for (const c of activeChanges) {
    for (const a of c.affected_components ?? []) {
      if (primaryIds && !primaryIds.includes(a.component_id)) continue
      const s = compStatus(a.status)
      const prev = liveStatusByComp.get(a.component_id) ?? 'operational'
      if (rank[s] > rank[prev]) liveStatusByComp.set(a.component_id, s)
    }
  }

  const components: ServiceComponent[] = pageComponents.map((pc) => ({
    id: pc.component_id,
    name: cleanComponentName(pc.name),
    status: liveStatusByComp.get(pc.component_id) ?? 'operational',
  }))

  // Overall badge = worst (scoped) component status.
  let status: 'operational' | 'degraded' | 'down' = 'operational'
  for (const c of components) if (rank[c.status] > rank[status]) status = c.status

  // History incidents (change/list) + any active ones not already in history, scoped to the primary
  // component set when set, newest first.
  const historyItems = feed.changeList?.items ?? []
  const seen = new Set(historyItems.map((i) => i.change_id))
  const allChanges = [...historyItems, ...activeChanges.filter((c) => !seen.has(c.change_id))]
    .filter((c) => !primaryIds || changeAffectsComponent(c, primaryIds))
  const incidents = allChanges
    .map(toIncident)
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())

  // #1006 — uptime30d (`flashdutyUptime`) is COMPUTED over the trailing 30 days from
  // `component_impacts` (the same start/end intervals this parser already turns into `dailyImpact`
  // below) rather than copied from the feed's published `component_uptimes` aggregate, so every AIWatch
  // uptime figure sits on the SAME 30-day/1.0-0.3-weighted basis (comparable across services) — DO NOT
  // generalise that to every source: `platform_avg` (Better Stack) applies no severity weighting at all
  // and narrows its window per resource, and Instatus's Next.js path honours a provider-published
  // `customImpactPercentage`. Worst-of across components when the service isn't scoped to one: a
  // multi-component service's availability is gated by its weakest surface.
  const flashdutyUptime = computeFlashdutyUptime(
    (feed.structure?.component_impacts ?? []).filter((imp) => !primaryIds || primaryIds.includes(imp.component_id)),
    (feed.structure?.component_uptimes ?? []).filter((u) => !primaryIds || primaryIds.includes(u.component_id)),
    nowMs,
  )
  const dailyImpact = buildDailyImpact(
    (feed.structure?.component_impacts ?? []).filter((imp) => !primaryIds || primaryIds.includes(imp.component_id)),
  )

  // #1171 — the feed's OWN uptime% (the number status.deepseek.com's "System status" page itself
  // displays, over its own ~90-day window) is otherwise discarded — `component_uptimes` above is used
  // only as a ROSTER for `flashdutyUptime`. Surface it as `reportedUptime`, mirroring the
  // BetterStack/Instatus `uptimeReported` pattern, so the detail page can show "(status page shows X%
  // over 90d)" the same way it does for those sources.
  const scopedRoster = (feed.structure?.component_uptimes ?? []).filter((u) => !primaryIds || primaryIds.includes(u.component_id))
  const reportedUptime = reportedUptimeFor(feed, primaryIds, scopedRoster)

  return { status, incidents, flashdutyUptime, reportedUptime, dailyImpact, components }
}
