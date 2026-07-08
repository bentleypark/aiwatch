// Shared xAI per-region incident helpers (#686 alert merge + #703 AI-analysis dedup + #940 source merge).
//
// xAI publishes the SAME event in multiple regions as SEPARATE incidents with distinct guids but
// near-identical titles differing only by a `[API (<region>.api.x.ai)] ` prefix (live: us-east-1 +
// eu-west-1). Two surfaces must collapse these to one:
//   • #686 — the Discord/Slack alert merge (mergeXaiRegionalAlerts in alerts.ts).
//   • #703 — the AI analysis: refreshOrReanalyze otherwise analyzes each region separately, so the
//     Analyze modal shows one xAI card with two region-duplicate analysis entries + burns a 2nd
//     Gemma/Sonnet call.
// Both key on the region-tag-STRIPPED title, so the SAME event across regions collapses while DISTINCT
// events (e.g. image-gen vs grok-code-fast-1) stay separate. This module is the single source of that
// regex + the helpers, so the two surfaces can't drift. xAI-only by design (other SERVICE_REGIONS feeds
// aren't verified to split incidentIds per region).

import type { Incident, TimelineEntry } from './types'
import { formatDuration } from './utils'

export const XAI_REGION_RE = /^\[API \(([a-z0-9-]+)\.api\.x\.ai\)\]\s*/i

/** The region label (e.g. 'us-east-1') from an xAI incident title, or null when not region-tagged. */
export function xaiRegionOf(title: string): string | null {
  return XAI_REGION_RE.exec(title)?.[1] ?? null
}

/** The region-tag-stripped event key used to group same-event-different-region incidents. A
 *  non-region-tagged title returns itself (so it never collapses with anything). */
export function xaiEventKey(title: string): string {
  return title.replace(XAI_REGION_RE, '').trim()
}

/**
 * Collapse xAI per-region incidents (same region-stripped title) to ONE — keeping the FIRST
 * occurrence per event. Non-region-tagged incidents (and every incident of a non-xAI service, since
 * only xAI titles carry the `[API (<region>.api.x.ai)]` prefix) pass through untouched, so this is a
 * safe no-op on any other service's incident list. Used by the AI-analysis path (#703) so a 2-region
 * xAI event is analyzed once. Generic over the incident shape — only `title` is read.
 *
 * "First kept" is intentionally aligned with `mergeXaiRegionalAlerts`'s `arr[0]` anchor (both walk
 * `svc.incidents` order), so the region whose analysis the initial path wrote is the one the refresh
 * path keeps refreshing — keep them in sync if either's ordering changes.
 *
 * NOTE the dedup is EVENTUAL, not instant: it only stops NEW/refresh writes for the dropped region.
 * A stale `ai:analysis:xai:{droppedIncId}` from a pre-#703 cron cycle (or within its 1h TTL) still
 * surfaces in `/api/status` until it expires — so the Analyze modal can briefly show 2 entries right
 * after deploy if a 2-region xAI incident is already active. It self-heals within ~1h (the dropped
 * region's key is never re-bumped).
 */
export function collapseXaiRegionalIncidents<T extends { title: string }>(incidents: T[]): T[] {
  // Pass 1 — collect the affected regions per event (in first-seen order, deduped).
  const regionsByEvent = new Map<string, string[]>()
  for (const inc of incidents) {
    if (!XAI_REGION_RE.test(inc.title)) continue
    const key = xaiEventKey(inc.title)
    const region = xaiRegionOf(inc.title)
    if (!region) continue
    const arr = regionsByEvent.get(key)
    if (arr) { if (!arr.includes(region)) arr.push(region) }
    else regionsByEvent.set(key, [region])
  }
  // Pass 2 — keep the FIRST incident per event; for a MULTI-region event, return a copy whose title
  // names all affected regions, so the downstream AI analysis reflects EVERY region (not just the
  // first one analyzed — #703, the "only us-east-1 shown" gap). Single-region + non-tagged: unchanged.
  const kept = new Set<string>()
  const out: T[] = []
  for (const inc of incidents) {
    if (!XAI_REGION_RE.test(inc.title)) { out.push(inc); continue }
    const key = xaiEventKey(inc.title)
    if (kept.has(key)) continue // a duplicate region of an already-kept event → drop
    kept.add(key)
    const regions = regionsByEvent.get(key) ?? []
    out.push(regions.length > 1 ? { ...inc, title: `${key} (regions: ${regions.join(', ')})` } : inc)
  }
  return out
}

// Active-stage severity order (lower = more active) — used to pick the merged status among
// non-resolved regions. xAI's parser only ever emits 'investigating' for an active incident, but
// rank the full active set so the merge stays correct if that ever changes.
const ACTIVE_STAGE_RANK: Record<string, number> = { investigating: 0, identified: 1, monitoring: 2 }
const IMPACT_RANK: Record<string, number> = { critical: 3, major: 2, minor: 1 }

/** FNV-1a 32-bit hash (base36) — same construction as rss.ts `weakFeedEtag`. Pure/deterministic so
 *  a given event key always yields the same canonical incident id. */
function fnv1aHex(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36)
}

/**
 * #940 — collapse xAI per-region incidents to ONE canonical incident **at the source**
 * (`services.ts`, right after `parseXaiRssIncidents`), so EVERY downstream surface — dashboard list,
 * Analyze modal, RSS/Slack `/feed`, Discord new+resolved alerts — sees a single incident. The old
 * per-surface merges (`mergeXaiRegionalAlerts` #686, `collapseXaiRegionalIncidents` #703) were
 * cycle-local: they only collapsed within one cron batch, so regions that surfaced/resolved in
 * different cycles leaked as duplicate messages/cards. This is the single, source-level fix; the two
 * older helpers become no-ops (kept as cheap defense).
 *
 * Non-region-tagged incidents (and every incident of any non-xAI service, since only xAI titles carry
 * the `[API (<region>.api.x.ai)]` prefix) pass through untouched → safe no-op elsewhere.
 *
 * Merge semantics per event:
 *  - **id**: a canonical `xai-evt:<fnv1a(eventKey)>` derived from the region-stripped title, so the id
 *    survives partial resolution (region A resolves while B is active) AND a single→multi-region
 *    transition WITHOUT re-keying → no phantom re-alert mid-incident. Two accepted re-key cases, each
 *    still far fewer alerts than the pre-#940 per-region behavior: (a) an xAI incident already active at
 *    DEPLOY re-keys once from its RSS guid (deploy while xAI is clean to avoid it); (b) if xAI EDITS an
 *    active incident's summary text the eventKey changes → one duplicate "new incident" alert.
 *  - **status**: worst-of — `resolved` only when ALL regions are resolved; otherwise the most-active
 *    non-resolved stage.
 *  - **impact**: worst-of (critical > major > minor > null).
 *  - **startedAt**: earliest; **resolvedAt/duration**: only when all resolved (latest resolvedAt).
 *  - **title**: single region keeps its original `[API (<region>)] …`; multi-region →
 *    `[API] <eventKey> (regions: a, b, …)` — the `[API]` marker is REQUIRED so the merged incident
 *    still matches xAI's `api` `incidentKeywords` filter (see the title comment below).
 *  - **timeline**: union, sorted oldest-first, deduped by (at, stage, text).
 */
export function mergeXaiRegionalIncidents(incidents: Incident[]): Incident[] {
  const groups = new Map<string, Incident[]>()
  for (const inc of incidents) {
    if (!XAI_REGION_RE.test(inc.title)) continue
    const key = xaiEventKey(inc.title)
    const arr = groups.get(key)
    if (arr) arr.push(inc)
    else groups.set(key, [inc])
  }
  const emitted = new Set<string>()
  const out: Incident[] = []
  for (const inc of incidents) {
    if (!XAI_REGION_RE.test(inc.title)) { out.push(inc); continue }
    const key = xaiEventKey(inc.title)
    if (emitted.has(key)) continue
    emitted.add(key)
    out.push(mergeXaiEventGroup(key, groups.get(key)!))
  }
  return out
}

function mergeXaiEventGroup(key: string, members: Incident[]): Incident {
  const regions = [...new Set(members.map(m => xaiRegionOf(m.title)).filter((r): r is string => !!r))]
  const allResolved = members.every(m => m.status === 'resolved')

  let status: Incident['status']
  if (allResolved) {
    status = 'resolved'
  } else {
    const active = members.filter(m => m.status !== 'resolved')
    status = active.reduce<Incident['status']>(
      (best, m) => ((ACTIVE_STAGE_RANK[m.status] ?? 0) < (ACTIVE_STAGE_RANK[best] ?? 0) ? m.status : best),
      active[0].status,
    )
  }

  const impact = members.reduce<Incident['impact']>(
    (best, m) => ((IMPACT_RANK[m.impact ?? ''] ?? 0) > (IMPACT_RANK[best ?? ''] ?? 0) ? m.impact : best),
    null,
  )

  const startedAt = members.reduce((min, m) => (m.startedAt < min ? m.startedAt : min), members[0].startedAt)
  const resolvedAt = allResolved
    ? members.reduce<string | null>((max, m) => {
        const r = m.resolvedAt ?? null
        return r && (!max || r > max) ? r : max
      }, null)
    : null

  const seen = new Set<string>()
  const timeline: TimelineEntry[] = members
    .flatMap(m => m.timeline)
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    .filter(t => {
      const k = `${t.at}|${t.stage}|${t.text ?? ''}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })

  return {
    id: `xai-evt:${fnv1aHex(key)}`,
    // A single-region event keeps its original `[API (<region>.api.x.ai)] …` title; a multi-region
    // event drops the per-region prefixes for `<eventKey> (regions: …)` — but MUST retain an `[API]`
    // marker so it still passes `filterIncidents`, which keeps an xAI incident only when its title
    // carries the `api` keyword (xAI incidents have no componentNames to match on). Without it a real
    // multi-region outage would be silently filtered out → the service would read operational (#940 review).
    title: members.length === 1 ? members[0].title : `[API] ${key} (regions: ${regions.join(', ')})`,
    status,
    impact,
    startedAt,
    resolvedAt,
    duration: allResolved && resolvedAt ? formatDuration(new Date(startedAt), new Date(resolvedAt)) : null,
    timeline,
  }
}
