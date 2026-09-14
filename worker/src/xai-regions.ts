// Shared xAI per-region incident helpers (#686 alert merge + #703 AI-analysis dedup + #940 source merge).
//
// xAI publishes the SAME event in multiple regions as SEPARATE incidents with distinct guids but
// near-identical titles differing only by a `[API (<region>.api.x.ai)] ` prefix (live: us-east-1 +
// eu-west-1). Two surfaces must collapse these to one:
//   • #686 — the Discord/Slack alert merge (mergeXaiRegionalAlerts in alerts.ts).
//   • #703 — the AI analysis: refreshOrReanalyze otherwise analyzes each region separately, so the
//     Analyze modal shows one xAI card with two region-duplicate analysis entries + burns a 2nd
//     Gemma/Sonnet call.
// This module is the single source of the region regex + the helpers, so the two surfaces can't
// drift on what a region IS. The region-tag-stripped title alone is NOT an event identity, though —
// xAI reuses API titles — so deciding whether two incidents are ONE event needs
// `groupXaiRegionalIncidents` (#1349), which also bounds a group in time and refuses a region it
// already holds. xAI-only by design (other SERVICE_REGIONS feeds aren't verified to split
// incidentIds per region).
//
// #1337 adds the SECOND axis on the same page: xAI files one Grok app outage as a separate incident per
// SURFACE, tagged `[Grok (<surface>)] `. Same failure, different prefix — see `mergeXaiGrokSurfaceIncidents`
// for why it needs a time window. #1349 later applied the same bounded grouping discipline to the
// region axis after xAI reused an API title for separate outages.

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
 * Collapse xAI per-region incidents of the SAME EVENT to ONE — keeping the first occurrence per
 * group. Non-region-tagged incidents (and every incident of a non-xAI service, since only xAI titles
 * carry the `[API (<region>.api.x.ai)]` prefix) pass through untouched, so this is a safe no-op on
 * any other service's incident list. Used by the AI-analysis path (#703) so a 2-region xAI event is
 * analyzed once.
 *
 * **"Same event" is `groupXaiRegionalIncidents`'s rule, not the stripped title (#1349.)** It used to
 * be the title alone, across the whole list, which was harmless only while the source merge
 * guaranteed one incident per title. #1349 removed that guarantee on purpose — two same-title
 * outages more than `REGION_WINDOW_MS` apart are now two incidents — and a title-only rule here
 * would have dropped one of them, re-fusing on this surface what the merge had just split — costing
 * the dropped incident its AI analysis for as long as both were open.
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
export function collapseXaiRegionalIncidents<T extends { title: string; startedAt: string }>(incidents: T[]): T[] {
  const groupOfIndex = groupXaiRegionalIncidents(incidents)
  // Keep the FIRST incident per group; for a MULTI-region group, return a copy whose title names all
  // affected regions, so the downstream AI analysis reflects EVERY region (not just the first one
  // analyzed — #703, the "only us-east-1 shown" gap). Single-region + non-tagged: unchanged.
  const emitted = new Set<RegionGroup<T>>()
  const out: T[] = []
  incidents.forEach((inc, idx) => {
    const group = groupOfIndex.get(idx)
    if (!group) { out.push(inc); return }
    if (emitted.has(group)) return // a duplicate region of an already-kept event → drop
    emitted.add(group)
    out.push(group.regions.size > 1
      ? { ...inc, title: `${group.key} (regions: ${[...group.regions].join(', ')})` }
      : inc)
  })
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
 * The time bound on a region group (#1349). Before it, the region merge grouped on the stripped
 * title across the whole feed, and xAI reuses API titles: `Models unavailable` covers a 2026-01-14
 * outage and a separate 2026-01-21 one, which fused into a single fabricated 162-hour incident whose
 * `duration` fed MTTR.
 *
 * 30 min is a bound, not a fitted constant, and it is the same number the surface axis uses. It sits
 * above the widest spread between the regions of ONE event in the live feed (2026-09-14, 115 items):
 * 4m 52s — `Imagine Video 1.5 …` on 2026-07-07, us-east-1 15:35:34 → us-west-2 15:40:26. Tighten it
 * only against an event it would have split.
 */
const REGION_WINDOW_MS = 30 * 60 * 1000

interface RegionGroup<T> {
  key: string
  /** the EARLIEST member's start — see the ordering note in `groupXaiRegionalIncidents`. */
  anchorMs: number
  regions: Set<string>
  members: T[]
}

/**
 * The region-grouping rule for `mergeXaiRegionalIncidents` and `collapseXaiRegionalIncidents`. One
 * copy, because the drift has a direction: whichever copy kept the old title-only rule would
 * silently re-fuse what the other one deliberately split. (`mergeXaiRegionalAlerts` cannot use this
 * — an `AlertCandidate` carries no `startedAt` — so it bounds its buckets by region alone.)
 *
 * Three conditions, all required: the same region-stripped title, a start within
 * `REGION_WINDOW_MS` of the group's anchor, and a region the group does not already hold (two
 * incidents in ONE region cannot be one event).
 *
 * Grouping walks the incidents in START order, not input order, so the anchor is always the group's
 * earliest member. Input order alone decided the partition before: three regions of one key at
 * t=0/25/50 min group as `{0,25}+{50}` when listed ascending and as one group of three when the
 * middle one comes first — different rows AND different ids for one input set.
 */
function groupXaiRegionalIncidents<T extends { title: string; startedAt: string }>(
  incidents: T[],
): Map<number, RegionGroup<T>> {
  const groups: RegionGroup<T>[] = []
  const groupOfIndex = new Map<number, RegionGroup<T>>()

  const byStart = incidents
    .map((inc, idx) => ({ inc, idx, startedMs: Date.parse(inc.startedAt) }))
    .filter(({ inc, startedMs }) => {
      if (!xaiRegionOf(inc.title)) return false
      if (Number.isNaN(startedMs)) {
        // `Incident.startedAt` is a required string, so this is a parser defect, not normal input.
        // The resulting pass-through is byte-identical to a healthy no-match, so log it — mirrors the
        // #983 warn on this same field in `alerts.ts` and the one in `upstream-link.ts`.
        console.warn('[xai-regions] #1349 unparseable startedAt — leaving incident unmerged:', inc.startedAt)
        return false
      }
      return true
    })
    .sort((a, b) => (a.startedMs - b.startedMs) || (a.idx - b.idx))

  for (const { inc, idx, startedMs } of byStart) {
    const region = xaiRegionOf(inc.title)!
    const key = xaiEventKey(inc.title)
    // `startedMs >= anchorMs` always, since the walk is ascending — no `Math.abs` needed.
    const group = groups.find((g) =>
      g.key === key && !g.regions.has(region) && startedMs - g.anchorMs <= REGION_WINDOW_MS)
    if (group) {
      group.regions.add(region)
      group.members.push(inc)
      groupOfIndex.set(idx, group)
    } else {
      const created: RegionGroup<T> = { key, anchorMs: startedMs, regions: new Set([region]), members: [inc] }
      groups.push(created)
      groupOfIndex.set(idx, created)
    }
  }
  return groupOfIndex
}

/** The earliest `startedAt` in a group, compared as an INSTANT and re-emitted in one normalized
 *  spelling. `utils.ts` (`isTimeOrderImpossible`) records why these payloads are never string-compared:
 *  they mix fractional-second precision, and within one second lexical order is wrong in both
 *  directions (`…03.123Z` sorts below `…03Z` because `.` < `Z`). That mattered for display before; it
 *  decides IDENTITY now that the id hashes this value, and hashing the raw string would additionally
 *  give two spellings of one instant two different ids.
 *
 *  Every caller drops an unparseable `startedAt` before grouping, so no member here can yield `NaN`.
 *  This deliberately carries no guard for that: an unparseable value would throw on the `Date`
 *  construction, which is the right outcome — a silent fallback would mint a WRONG identity. */
function earliestStartedAt(members: Incident[]): string {
  return new Date(Math.min(...members.map((m) => Date.parse(m.startedAt)))).toISOString()
}

/**
 * #940 — collapse xAI per-region incidents to ONE canonical incident **at the source**
 * (`services.ts`, right after `parseXaiRssIncidents`), so EVERY downstream surface — dashboard list,
 * Analyze modal, RSS/Slack `/feed`, Discord new+resolved alerts — sees a single incident. The old
 * per-surface merges (`mergeXaiRegionalAlerts` #686, `collapseXaiRegionalIncidents` #703) were
 * cycle-local: they only collapsed within one cron batch, so regions that surfaced/resolved in
 * different cycles leaked as duplicate messages/cards. This is the single, source-level fix.
 *
 * Non-region-tagged incidents (and every incident of any non-xAI service, since only xAI titles carry
 * the `[API (<region>.api.x.ai)]` prefix) pass through untouched → safe no-op elsewhere.
 *
 * Per-field merge semantics are `mergeXaiEventGroup`'s, shared with the surface merge. This function
 * owns only the GROUPING and the IDENTITY:
 *  - **grouping**: `groupXaiRegionalIncidents`'s rule, shared with `collapseXaiRegionalIncidents`.
 *    Emission follows FEED order, so a merged incident keeps its first member's position.
 *  - **id**: a canonical `xai-evt:<fnv1a(eventKey|startedAt)>`, so recurrences cannot collide in the
 *    SPA's raw-id dedupe. It is stable across a partial resolution and across a late *later-starting*
 *    region joining. It re-keys once when the group's EARLIEST member changes — a late member with an
 *    earlier start, or the anchor ageing out of the feed window — because a pure snapshot merge has no
 *    durable first-seen identity; that would need KV. Bounded (one duplicate Discord alert, one extra
 *    additive `incidents:monthly` row), and preferable to fusing distinct outages.
 *  - **title**: single region keeps its original `[API (<region>)] …`; multi-region →
 *    `[API] <eventKey> (regions: a, b, …)` — see the `[API]` marker note at the title itself.
 */
export function mergeXaiRegionalIncidents(incidents: Incident[]): Incident[] {
  const groupOfIndex = groupXaiRegionalIncidents(incidents)

  // `uniqueId` completes the same-region rule, exactly as on the surface axis: two groups that rule
  // split apart can still share a `(key, startedAt)` and would then hash to one id, which the SPA's
  // raw-id dedupe re-fuses into a single row. Suffixing by emission order keeps them distinct.
  const emitted = new Set<RegionGroup<Incident>>()
  const usedIds = new Set<string>()
  const uniqueId = (id: string): string => {
    if (!usedIds.has(id)) { usedIds.add(id); return id }
    for (let n = 2; ; n++) {
      const candidate = `${id}-${n}`
      if (!usedIds.has(candidate)) { usedIds.add(candidate); return candidate }
    }
  }
  const out: Incident[] = []
  incidents.forEach((inc, idx) => {
    const group = groupOfIndex.get(idx)
    if (!group) { out.push(inc); return }
    if (emitted.has(group)) return
    emitted.add(group)
    const members = collapseCrossMemberEchoes(group.members)
    // `anchorMs` IS the group's earliest start — the walk that built it is ascending — so the id
    // names the same instant `mergeXaiEventGroup` will emit as `startedAt`, without re-deriving it.
    out.push(mergeXaiEventGroup(members, {
      id: uniqueId(`xai-evt:${fnv1aHex(`${group.key}|${new Date(group.anchorMs).toISOString()}`)}`),
      // A single-region event keeps its original `[API (<region>.api.x.ai)] …` title; a multi-region
      // event drops the per-region prefixes for `<eventKey> (regions: …)` — but MUST retain an `[API]`
      // marker so it still passes `filterIncidents`, which keeps an xAI incident only when its title
      // carries the `api` keyword (xAI incidents have no componentNames to match on). Without it a real
      // multi-region outage would be silently filtered out → the service would read operational (#940 review).
      title: members.length === 1 ? members[0].title : `[API] ${group.key} (regions: ${[...group.regions].join(', ')})`,
    }))
  })
  return out
}

/**
 * Merge one group of same-event incidents into a single `Incident`, given the identity (id + title)
 * the caller decides. Shared by BOTH xAI axes — the region merge above (#940) and the Grok surface
 * merge below (#1337) — because the two differ only in how they GROUP and what they NAME the result;
 * the per-field worst-of semantics are identical, and a second copy of them would be free to drift.
 *
 *  - **status**: worst-of — `resolved` only when ALL members are resolved; otherwise the most-active
 *    non-resolved stage.
 *  - **impact**: worst-of (critical > major > minor > null).
 *  - **startedAt**: earliest; **resolvedAt/duration**: only when all resolved (latest resolvedAt).
 *  - **timeline**: union, sorted oldest-first, with one announcement per member — see the note at the
 *    dedupe itself for why the member boundary is the thing that separates an echo from a repeat.
 */
function mergeXaiEventGroup(members: Incident[], identity: { id: string; title: string }): Incident {
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

  const startedAt = earliestStartedAt(members)
  const resolvedAt = allResolved
    ? members.reduce<string | null>((max, m) => {
        const r = m.resolvedAt ?? null
        return r && (!max || r > max) ? r : max
      }, null)
    : null

  // Timeline: the union of every member's updates, oldest-first, deduped on (at, stage, text) — i.e.
  // byte-identical rows only. Callers that also want to collapse the SAME announcement published at
  // different instants must do it before calling, on members they know to be contemporaneous; see
  // `collapseCrossMemberEchoes`.
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
    id: identity.id,
    title: identity.title,
    status,
    impact,
    startedAt,
    resolvedAt,
    duration: allResolved && resolvedAt ? formatDuration(new Date(startedAt), new Date(resolvedAt)) : null,
    timeline,
  }
}

// ─── #1337 — the SURFACE axis ────────────────────────────────────────────────────────────────────
//
// status.x.ai tags every Grok app incident `[Grok (<surface>)] ` and files ONE outage once PER
// SURFACE. Observed 2026-09-03: four incidents (`INCc33a8af` iOS / `INC3b127ff3` Android /
// `INC25664c15` Web / `INC4d558447` Office/Workspace Plugins), all titled `Models outage`, all
// `startedAt` 13:30:00.000Z, alongside the API side's already-merged
// `[API] Models outage (regions: us-east-1, us-west-2)`. Un-merged, one outage cost four rows on the
// Grok card, four Discord new + four resolved alerts, four `ai:analysis:grok:*` keys and four rows in
// `incidents:monthly` (which the monthly report counts).

/** The surface tag shape. Matched by SHAPE, not by a list of known surfaces: #1165 enumerated three
 *  (iOS / Android / Web) and 2026-09-03 introduced a fourth, `Office/Workspace Plugins`. `[^)]+` also
 *  keeps this from matching xAI's paren-less `[Grok in X]` tag. */
export const XAI_GROK_SURFACE_RE = /^\[Grok \(([^)]+)\)\]\s*/i

/** The surface label (e.g. 'iOS') from a Grok incident title, or null when not surface-tagged. */
export function xaiGrokSurfaceOf(title: string): string | null {
  return XAI_GROK_SURFACE_RE.exec(title)?.[1] ?? null
}

/** The surface-tag-stripped grouping key. Lowercased and whitespace/trailing-punctuation normalized
 *  because xAI's own copy drifts across the surfaces of ONE event — 2026-01-23/24 published
 *  `Grok is Temporarily Unavailable.` (Web, Android) beside `Grok is Temporarily Unavailable` (iOS).
 *  A key that kept the period would leave that outage split. NOT usable as display text (see
 *  `xaiGrokDisplayTitle`). */
export function xaiGrokEventKey(title: string): string {
  return xaiGrokDisplayTitle(title).toLowerCase()
}

/** The same normalization with the provider's casing preserved — what a merged title reads as. */
export function xaiGrokDisplayTitle(title: string): string {
  return title.replace(XAI_GROK_SURFACE_RE, '').trim().replace(/[.\s]+$/, '').replace(/\s+/g, ' ')
}

/**
 * The time bound on a surface group. Both axes are bounded now — #1349 gave the region merge the
 * same construction after xAI reused an API title for separate outages — so this is `REGION_WINDOW_MS`'s
 * sibling, not a divergence from it. It is kept a separate constant because the two are derived
 * against different evidence, and either could move without the other.
 *
 * The window is what separates the recurrences — Grok's titles RECUR, `Grok is Temporarily
 * Unavailable` covering many separate outages months apart. Removing it fuses events weeks apart whose surface
 * sets happen not to overlap, and the 2026-03-10 and 2026-02-12 outages of that title are one such
 * pair. Comparing group COUNTS hides this — the count is unchanged — so compare the emitted groups'
 * surfaces and start instants.
 *
 * 30 min is a bound, not a fitted constant. It sits above the widest spread observed within one event
 * (7.5 min, 2026-01-26: Web 19:52:10 → iOS 19:59:39). Tighten it only against an event it would have
 * split.
 */
const SURFACE_WINDOW_MS = 30 * 60 * 1000

interface SurfaceGroup {
  key: string
  /** the FIRST member's startedAt — the match anchor, fixed at group creation so a long chain of
   *  near-misses cannot drift a group past the window one member at a time. */
  anchorMs: number
  surfaces: Set<string>
  members: Incident[]
}

/**
 * #1337 — collapse xAI per-SURFACE Grok incidents to ONE canonical incident at the source, the same
 * placement and for the same reason as the region merge (`services.ts`, right after
 * `parseXaiRssIncidents`): a per-surface merge would be cycle-local and leak duplicates across cron
 * cycles.
 *
 * Non-surface-tagged incidents pass through untouched, so this is a safe no-op on the xAI API feed
 * (no `[API …]` title can match `XAI_GROK_SURFACE_RE`, which is `^`-anchored on `[Grok (`) and on
 * every non-xAI service.
 *
 * Grouping — all three conditions:
 *   1. the same `xaiGrokEventKey`;
 *   2. within `SURFACE_WINDOW_MS` of the group's anchor;
 *   3. a surface the group does not already hold. Two incidents on the SAME surface cannot be one
 *      event, so this refuses to fuse them. Defensive: no group in the live feed has needed it, since
 *      the window already separates every observed recurrence. Splitting the groups is only half of
 *      keeping both incidents — two groups that also share a `startedAt` would hash to one id and be
 *      re-fused by the SPA's raw-id dedupe — so `uniqueId` below completes it.
 *
 * Deliberately NOT merged, and this is the case #1165 named when it declined a surface merge: an
 * outage xAI describes per platform. 2025-03-10 published `Partial Outage of Grok iOS App`,
 * `Partial Outage of Grok Android App` and `Partial Outage of grok.com` — three DIFFERENT stripped
 * titles, so keying on the title leaves them three rows without needing a special case. The same
 * holds for 2026-03-10's iOS-specific `Grok on iOS is Temporarily Unavailable`, which stays split
 * from its Web/Android siblings.
 *
 * The id is `xai-grok:<fnv1a(eventKey|startedAt)>`. Both halves are load-bearing, and both were
 * established against the live feed rather than assumed:
 *   • the KEY alone collides — `Grok is Temporarily Unavailable` is many separate outages in one
 *     feed, and the SPA's raw-id dedupe (`Incidents.jsx`) would render them as a single row;
 *   • the key plus a UTC DAY still collides, on 2026-01-27, which carries two of those events (03:33
 *     and 14:10).
 * `xai-grok:` namespaces the axis. Since #1349 both axes hash `<key>|<startedAt>`, and the keys
 * differ only in normalization — this one lowercases, the region merge keeps the provider's casing —
 * so the prefix is what guarantees they cannot collide however either normalization changes. A shared
 * id would have joined the xAI API and Grok cards into one row by accident, whichever service is
 * processed first silently winning the title; joining those two cards is a separate, deliberate
 * change (#1338).
 *
 * **The id is NOT stable against a member arriving late with an earlier start.** `startedAt` is the
 * minimum over the members present in THIS snapshot, so a surface that shows up in a later cron cycle
 * carrying an earlier `startedAt` moves the minimum and re-keys the incident — one duplicate Discord
 * "new incident" alert and one extra row in the additive `incidents:monthly`. Since #1349 the region
 * merge carries the identical exposure for the identical reason; neither is a pure function of one
 * snapshot that can close it, and a durable first-seen id would have to live in KV. An earlier draft
 * claimed this could not happen, citing a replay of the feed in `startedAt` order — an ordering that
 * cannot exhibit the failure by construction, since arrival order is exactly what the archived feed
 * does not record. Bounded, and still far fewer alerts than the pre-#1337 behaviour of four separate
 * incidents alerting four times.
 *
 * Like #940, an incident already active at DEPLOY re-keys once from its RSS guid, and the monthly
 * accumulator is additive — it keeps the pre-merge rows until they are pruned.
 */
export function mergeXaiGrokSurfaceIncidents(incidents: Incident[]): Incident[] {
  const groups: SurfaceGroup[] = []
  // Keyed by the incident's POSITION, never by `inc.id`. Nothing guarantees the feed's guids are
  // unique — `parseXaiRssIncidents` passes `<guid>` through unchecked — and an id-keyed map silently
  // loses a whole group when two same-surface incidents share one: the second `set` overwrites the
  // first, and the emit loop then never reaches the orphaned group. The emit loop already walks by
  // position, so the index costs nothing and removes the drop.
  const groupOfIndex = new Map<number, SurfaceGroup>()

  incidents.forEach((inc, idx) => {
    const surface = xaiGrokSurfaceOf(inc.title)
    if (!surface) return
    const key = xaiGrokEventKey(inc.title)
    const startedMs = Date.parse(inc.startedAt)
    if (Number.isNaN(startedMs)) {
      // `Incident.startedAt` is a required string, so this is a parser defect, not normal input. The
      // resulting pass-through is byte-identical to a healthy no-match, so log it — mirrors the #983
      // warn on this same field in `alerts.ts` and the one in `upstream-link.ts`.
      console.warn('[xai-regions] #1337 unparseable startedAt — leaving incident unmerged:', inc.startedAt)
      return
    }
    const group = groups.find((g) =>
      g.key === key && !g.surfaces.has(surface) && Math.abs(startedMs - g.anchorMs) <= SURFACE_WINDOW_MS)
    if (group) {
      group.surfaces.add(surface)
      group.members.push(inc)
      groupOfIndex.set(idx, group)
    } else {
      const created: SurfaceGroup = { key, anchorMs: startedMs, surfaces: new Set([surface]), members: [inc] }
      groups.push(created)
      groupOfIndex.set(idx, created)
    }
  })

  // Emit each merged incident at the position of its FIRST member, so feed order is preserved.
  //
  // `uniqueId` completes grouping condition 3. Two groups the same-surface rule split apart can still
  // share a `(key, startedAt)` — `startedAt` ties are ordinary here, the whole 2026-09-03 quartet
  // shares `13:30:00.000Z` — and would then hash to one id, which the SPA's raw-id dedupe re-fuses
  // into a single row and which would collapse their `ai:analysis:grok:*` keys and alert-dedupe
  // entries onto one another. Suffixing by emission order keeps them distinct. It never fires on the
  // live feed (no group there collides), so it does not perturb any existing id.
  const emitted = new Set<SurfaceGroup>()
  const usedIds = new Set<string>()
  const uniqueId = (id: string): string => {
    if (!usedIds.has(id)) { usedIds.add(id); return id }
    for (let n = 2; ; n++) {
      const candidate = `${id}-${n}`
      if (!usedIds.has(candidate)) { usedIds.add(candidate); return candidate }
    }
  }
  const out: Incident[] = []
  incidents.forEach((inc, idx) => {
    const group = groupOfIndex.get(idx)
    if (!group) { out.push(inc); return }
    if (emitted.has(group)) return
    emitted.add(group)
    const merged = mergeSurfaceGroup(group)
    out.push({ ...merged, id: uniqueId(merged.id) })
  })
  return out
}

/**
 * Drop each member's copy of an announcement another member already made, keeping the earliest.
 *
 * Only sound where the members are CONTEMPORANEOUS, which is why it lives here and not inside
 * `mergeXaiEventGroup`: the precondition belongs to the CALLER's grouping, not to the per-field
 * merge. Both callers satisfy it by being time-bounded — the surface merge to `SURFACE_WINDOW_MS`,
 * the region merge to `REGION_WINDOW_MS` since #1349 — so a sentence repeated across a group's
 * members is one announcement echoed. It was unsound on the region axis while that axis had no time
 * bound: a group could hold members from outages months apart, where the same boilerplate is two
 * separate announcements, and an earlier cut of this ran inside the shared merge and deleted a whole
 * later outage's rows. A future caller that groups without a time bound must not call this.
 *
 * A member repeating ITSELF is left alone: that is the provider saying it is still going, and the
 * per-member set is what tells the two apart.
 */
function collapseCrossMemberEchoes(members: Incident[]): Incident[] {
  // The member that says an announcement EARLIEST owns it, and keeps every one of its own copies —
  // including later repeats, which are the provider saying it is still going. Every other member's
  // copies of that announcement are echoes and are dropped, however many there are. Ownership is
  // per announcement, so members can each own different ones.
  //
  // Time order decides the owner, so the surviving row is the earliest rather than whichever member
  // the feed happened to list first.
  const ownerOf = new Map<string, number>()
  const order = members
    .flatMap((m, memberIdx) => m.timeline.map((t) => ({ t, memberIdx })))
    .sort((a, b) => (a.t.at < b.t.at ? -1 : a.t.at > b.t.at ? 1 : 0))
  const dropped = new Set<TimelineEntry>()
  for (const { t, memberIdx } of order) {
    const k = `${t.stage}|${t.text ?? ''}`
    const owner = ownerOf.get(k)
    if (owner === undefined) ownerOf.set(k, memberIdx)
    else if (owner !== memberIdx) dropped.add(t)
  }
  return dropped.size === 0 ? members : members.map(m => ({ ...m, timeline: m.timeline.filter(t => !dropped.has(t)) }))
}

function mergeSurfaceGroup(group: SurfaceGroup): Incident {
  const { surfaces } = group
  const members = collapseCrossMemberEchoes(group.members)
  const startedAt = earliestStartedAt(members)
  return mergeXaiEventGroup(members, {
    id: `xai-grok:${fnv1aHex(`${group.key}|${startedAt}`)}`,
    // A single-surface event keeps its original `[Grok (<surface>)] …` title untouched. A merged one
    // names every affected surface — and MUST keep the `Grok (` marker, because `filterIncidents`
    // matches Grok's `incidentKeywords: ['grok (']` as a lowercased TITLE substring (xAI incidents
    // carry no componentNames). Lose it and a real multi-surface outage is filtered out entirely and
    // the card reads operational — the #940 review's finding, on this axis.
    title: members.length === 1
      ? members[0].title
      : `[Grok (${[...surfaces].join(', ')})] ${xaiGrokDisplayTitle(members[0].title)}`,
  })
}
