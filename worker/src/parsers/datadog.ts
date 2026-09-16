// Datadog Status Page parser — reads the page's own `config.json` (#1403).
//
// The hosted page is a client-rendered app shell (a plain `fetch()` of the HTML returns ~600 bytes
// with no embedded data), but it hydrates from ONE unauthenticated static document:
// `https://<page>/config.json`. That document is the whole page — components, incidents and
// maintenances — so there is no second endpoint to poll and no browser to drive, unlike the Rootly
// migration (#1381) which needed a headed scraper.
//
// UPTIME IS NOT PUBLISHED AS A NUMBER ANYWHERE. The 30/60/90-day bars and the "% uptime" label the
// rendered page shows are computed IN THE BROWSER from the incident timelines in this same document
// (verified 2026-09-15 by reading the page's own bundle). So `uptime30d` here is AIWatch's own
// computation over the provider's published records — the #1006 'official' path — not a copy of a
// figure the provider states. Two deliberate differences from the page's own arithmetic:
//
//   - Datadog counts only `partial_outage` + `major_outage` as downtime and ignores `degraded`
//     entirely; AIWatch weights degraded at 0.3 per /methodology. Our figure can therefore read
//     LOWER than the page's own. That divergence is the documented, disclosed AIWatch policy
//     (CLAUDE.md, "Uptime is COMPUTED by AIWatch, not copied") and not a bug to reconcile.
//   - The page's window is the reach of its own records capped by a viewport-dependent 30/60/90
//     (the cap is in the page's JS bundle, not in `config.json`); ours is that same reach capped at
//     30. See {@link recordReachDays}.

import type { Incident, TimelineEntry } from '../types'
import { formatDuration } from '../utils'
import { MAJOR_WEIGHT, MINOR_WEIGHT } from './impact-weights'
import { weightedDowntimeSeconds, startOfTodayUTC, type OutageInterval } from './uptime-interval'

/**
 * Structural exits — we could not read this page. Distinct from "this page genuinely publishes no
 * incidents", which is `ok: true` with an empty array (#1089/#1123 — conflating the two is what
 * publishes a green badge off a dead read).
 *
 * Values are PERSISTED as KV counter buckets by `recordParseFailure`, so they are a vocabulary, not
 * free text (docs/reference/kv-schema.md). The `dd-` prefix keeps them disjoint from every other
 * parser's reasons, so an operator aggregating one reason across services never sums two parsers'
 * failures — they take different fixes.
 */
export type DatadogParseFailure =
  | 'dd-envelope-unreadable'         // not a `config.json` shape at all
  | 'dd-components-unreadable'       // the component tree is absent, or yielded no leaf component
  | 'dd-component-status-unreadable' // a component carries a status word this parser does not know
  | 'dd-incident-unreadable'         // an incident's shape or severity could not be read
  | 'dd-component-missing'           // the configured component group is gone from the page
  | 'dd-fetch-unreadable'            // set by the CALLER: the config.json fetch returned a non-OK

export interface DatadogStatusPage {
  status: 'operational' | 'degraded' | 'down'
  incidents: Incident[]
  /** `null` when the page's records do not establish a window at all — #713's rule: AIWatch invents
   *  no uptime value. The caller must leave `uptime30d` unset rather than publish a figure. */
  uptime30d: number | null
  /** Days `uptime30d` covers, when the page's records reach back less than 30 (#1004). */
  uptimeWindowDays: number | null
  /** #1017 — today's UTC-day weighted outage seconds, over the SAME intervals as `uptime30d`. */
  todayWeightedOutageSec: number
}

export type DatadogParseResult =
  | { ok: true; page: DatadogStatusPage }
  | { ok: false; reason: DatadogParseFailure }

/** The component-status vocabulary this platform publishes (read off the page's own bundle, which
 *  validates against exactly this list). An unknown word is refused rather than defaulted — a new
 *  state defaulting to "fine" is the silent fail-open every source here has been bitten by. */
const COMPONENT_STATUS = ['operational', 'degraded', 'partial_outage', 'major_outage', 'maintenance'] as const
type ComponentStatus = (typeof COMPONENT_STATUS)[number]

/** Severity weight per component status. Announced maintenance is 0, matching `impact-weights.ts`
 *  ("planned maintenance is not downtime") and every other source in this directory. */
const STATUS_WEIGHT: Record<ComponentStatus, number> = {
  operational: 0,
  degraded: MINOR_WEIGHT,
  partial_outage: MINOR_WEIGHT,
  major_outage: MAJOR_WEIGHT,
  maintenance: 0,
}

/** Incident `impact` label per component status. A Record, not a ternary: adding a word to
 *  {@link COMPONENT_STATUS} must fail the type-check here too, not silently land `impact: null`. */
const STATUS_IMPACT: Record<ComponentStatus, Incident['impact']> = {
  operational: null,
  degraded: 'minor',
  partial_outage: 'minor',
  major_outage: 'major',
  maintenance: null,
}

/** Card status per component status. `maintenance` is `operational` for the same reason
 *  `cloudflare-status.ts` maps it there: a scheduled window must not answer "yes" on /is-X-down,
 *  fire a status-edge alert, or pull fallback recommendations. */
const STATUS_VERDICT: Record<ComponentStatus, 'operational' | 'degraded' | 'down'> = {
  operational: 'operational',
  degraded: 'degraded',
  partial_outage: 'degraded',
  major_outage: 'down',
  maintenance: 'operational',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function asComponentStatus(value: unknown): ComponentStatus | null {
  return typeof value === 'string' && (COMPONENT_STATUS as readonly string[]).includes(value)
    ? (value as ComponentStatus)
    : null
}

/** Incidents carry their own status word for the update STAGE. `resolved` is decided by the
 *  record's own `resolved` boolean instead (see {@link parseIncident}), so an unrecognised stage
 *  here costs a label, never a resolution. */
function incidentStage(value: unknown): TimelineEntry['stage'] {
  if (value === 'resolved') return 'resolved'
  if (value === 'monitoring') return 'monitoring'
  if (value === 'identified') return 'identified'
  return 'investigating'
}

/** A leaf plus the id of the `ComponentGroup` it sits under (`null` for a top-level leaf). The group
 *  is what the SCOPE names — see {@link parseDatadogStatusPage}. */
type Leaf = { id: string; name: string; status: ComponentStatus; groupId: string | null }

type FlattenResult =
  | { ok: true; leaves: Leaf[] }
  | { ok: false; reason: Extract<DatadogParseFailure, 'dd-components-unreadable' | 'dd-component-status-unreadable'> }


/**
 * Flatten `components[]` into its leaf `Component` entries.
 *
 * A `ComponentGroup` carries child `components` and NO status of its own (the group row on the
 * rendered page is a collapsible header over its children). Only leaves are read, so a group that
 * ever grows a status field cannot double-count against its own children.
 *
 * A tree that yields zero leaves is refused, not read as "nothing is wrong": that is what a
 * wholesale shape change looks like, and it would otherwise publish `operational` with a spotless
 * 100% uptime off a document we did not understand.
 */
function flattenComponents(raw: unknown): FlattenResult {
  if (!Array.isArray(raw)) return { ok: false, reason: 'dd-components-unreadable' }
  const leaves: Leaf[] = []

  type ComponentFailure = Extract<DatadogParseFailure, 'dd-components-unreadable' | 'dd-component-status-unreadable'>
  const walk = (entries: unknown[], groupId: string | null): ComponentFailure | null => {
    for (const entry of entries) {
      if (!isRecord(entry)) return 'dd-components-unreadable'
      if (entry.type === 'ComponentGroup') {
        if (!Array.isArray(entry.components)) return 'dd-components-unreadable'
        if (typeof entry.id !== 'string') return 'dd-components-unreadable'
        // The OUTERMOST group wins, so a leaf nested in a sub-group still belongs to the scope its
        // ancestor names. Rebinding to the innermost group dropped such a leaf silently — unbadged
        // and uncounted — which is the same one-directional failure the member list had.
        const failure = walk(entry.components, groupId ?? entry.id)
        if (failure) return failure
        continue
      }
      if (entry.type !== 'Component') return 'dd-components-unreadable'
      if (typeof entry.id !== 'string' || typeof entry.name !== 'string') return 'dd-components-unreadable'
      const status = asComponentStatus(entry.status)
      if (!status) return 'dd-component-status-unreadable'
      leaves.push({ id: entry.id, name: entry.name, status, groupId })
    }
    return null
  }

  const failure = walk(raw, null)
  if (failure) return { ok: false, reason: failure }
  if (leaves.length === 0) return { ok: false, reason: 'dd-components-unreadable' }
  return { ok: true, leaves }
}

function worstVerdict(statuses: ComponentStatus[]): 'operational' | 'degraded' | 'down' {
  const verdicts = statuses.map((status) => STATUS_VERDICT[status])
  if (verdicts.includes('down')) return 'down'
  if (verdicts.includes('degraded')) return 'degraded'
  return 'operational'
}

/**
 * What one update's `componentsAffected` says, PER COMPONENT.
 *
 * It does not collapse to a single status. Collapsing makes the published figure depend on the
 * ORDER of `componentsAffected`, because a component whose status loses the comparison is scored as
 * if it carried the winner's. Keeping the per-component statuses means no cross-component collapse
 * happens at all, and the worst-of runs where it belongs — across each component's OWN window.
 *
 * `'unknown'` is distinct from `'absent'` because a vocabulary change must refuse the read; skipping
 * it would let a readable sibling update paper over it.
 */
type AffectedRead = 'absent' | 'unknown' | Array<{ id: string; status: ComponentStatus }>

function readAffected(raw: unknown): AffectedRead {
  if (!Array.isArray(raw)) return 'absent'
  const out: Array<{ id: string; status: ComponentStatus }> = []
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    const status = asComponentStatus(entry.status)
    if (!status) return 'unknown'
    if (typeof entry.id !== 'string') continue
    out.push({ id: entry.id, status })
  }
  return out.length === 0 ? 'absent' : out
}

/**
 * An update's event instant. `startedAt` ONLY — `createdAt` is the filing time, and on a backfilled
 * incident every update shares it. Falling back to it was a silent 100%: with `startedAt` renamed
 * away, every update collapsed onto one instant, every segment became zero-length, and the page
 * published `uptime30d: 100` with `uptimeSource: 'official'` on four rendered incidents. An update
 * with no `startedAt` is a shape change, so the incident is refused instead.
 */
function entryInstant(entry: Record<string, unknown>): string | null {
  return typeof entry.startedAt === 'string' ? entry.startedAt : null
}

/** One component's outage window. Per COMPONENT because the page publishes a percentage per
 *  component and no page-level aggregate at all, so the figure is a worst-of across components
 *  rather than a pool. */
type OutageSegment = { componentId: string; start: number; end: number | null; status: ComponentStatus }

type ParsedIncident = {
  incident: Incident
  segments: OutageSegment[]
  /** Every (component, instant) this record's timeline named. The uptime window is bounded by the
   *  earliest of these that is IN SCOPE, so the denominator rests on the same evidence as the
   *  numerator (see {@link recordReachDays}). */
  componentInstants: Array<{ id: string; at: number }>
}

const toIntervals = (segments: OutageSegment[], weights: Record<ComponentStatus, number>): OutageInterval[] =>
  segments.map((seg) => ({ start: seg.start, end: seg.end, weight: weights[seg.status] }))

/**
 * One incident record → the display `Incident` plus the outage intervals its timeline describes.
 *
 * Severity comes from the TIMELINE, never from the incident-level `componentsAffected`: that array
 * holds each component's CURRENT status, which on a resolved incident is `operational` for every
 * entry. Reading severity there would score every resolved outage at weight 0 and publish a
 * spotless 100% with `uptimeSource: 'official'` attached — the exact fail-open shape of #1123.
 *
 * So an incident whose timeline names no readable component status at all is REFUSED (`null`), not
 * scored as zero downtime. An incident whose timeline does name components and says every one of
 * them is `operational` is a real, legitimate zero — a notice that degraded nothing — and is kept.
 */
function parseIncident(raw: unknown, nowMs: number): ParsedIncident | null {
  if (!isRecord(raw)) return null
  if (typeof raw.id !== 'string' || typeof raw.title !== 'string') return null
  if (typeof raw.publishedDate !== 'string') return null
  const startedAt = raw.publishedDate
  const startMs = Date.parse(startedAt)
  if (Number.isNaN(startMs)) return null

  // Shape-checked like every other field on this record. `=== true` treated a RENAMED field as
  // "still open", which published `status: 'resolved'` beside `resolvedAt: null` on every closed
  // incident and left the final segment unbounded.
  if (typeof raw.resolved !== 'boolean') return null
  const resolved = raw.resolved
  const resolvedAt = resolved && typeof raw.resolvedDate === 'string' ? raw.resolvedDate : null
  const resolvedMs = resolvedAt ? Date.parse(resolvedAt) : NaN
  // A `resolved: true` record whose stamp we cannot read is a contradiction we must not average
  // over: treating it as open would accrue downtime to now, treating it as instant would accrue
  // none. Refuse and let the caller route the whole page to the source-unknown path.
  if (resolved && Number.isNaN(resolvedMs)) return null

  if (!Array.isArray(raw.timeline)) return null
  const entries = raw.timeline
    .filter(isRecord)
    .map((entry) => ({ entry, at: entryInstant(entry) }))
    .filter((e): e is { entry: Record<string, unknown>; at: string } => e.at !== null && !Number.isNaN(Date.parse(e.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  if (entries.length === 0) return null

  // Read every update first, so a segment can end at the next update that actually NAMES its
  // component. Ending it at the next update of any kind made a component-less "still working on it"
  // note freeze accrual on a LIVE outage — 96.66% became 99.86% — which is the opposite of what
  // `'absent'` means (it says nothing about a component, not that the component recovered).
  const reads: Array<{ at: number; affected: Array<{ id: string; status: ComponentStatus }> }> = []
  for (const { entry, at } of entries) {
    const read = readAffected(entry.componentsAffected)
    if (read === 'unknown') return null // vocabulary change — never let a readable sibling mask it
    if (read === 'absent') continue
    reads.push({ at: Date.parse(at), affected: read })
  }
  if (reads.length === 0) return null

  const segments: OutageSegment[] = []
  let worstStatus: ComponentStatus | null = null
  for (let i = 0; i < reads.length; i++) {
    for (const { id, status } of reads[i].affected) {
      if (worstStatus === null || STATUS_WEIGHT[status] > STATUS_WEIGHT[worstStatus]) worstStatus = status
      if (STATUS_WEIGHT[status] <= 0) continue
      const next = reads.slice(i + 1).find((r) => r.affected.some((a) => a.id === id))
      // Open (`null`) only on a live incident — the shared accumulator clamps that to now, so
      // downtime accrues DURING an outage, which is exactly when uptime is consulted. On a resolved
      // incident every segment is clamped to the published resolution: a post-resolution postmortem
      // entry must not charge downtime the incident's own `duration` does not claim.
      const rawEnd = next ? next.at : (resolved ? resolvedMs : null)
      const end = resolved ? Math.min(rawEnd ?? resolvedMs, resolvedMs) : rawEnd
      segments.push({ componentId: id, start: reads[i].at, end, status })
    }
  }

  const affected = Array.isArray(raw.componentsAffected) ? raw.componentsAffected.filter(isRecord) : []
  const componentNames = affected.map((c) => c.name).filter((n): n is string => typeof n === 'string')
  const componentIds = affected.map((c) => c.id).filter((id): id is string => typeof id === 'string')

  const timeline: TimelineEntry[] = entries.map(({ entry, at }) => ({
    stage: incidentStage(entry.status),
    text: typeof entry.description === 'string' ? entry.description : null,
    at,
  }))

  return {
    incident: {
      id: `datadog:${raw.id}`,
      title: raw.title,
      status: resolved ? 'resolved' : incidentStage(raw.currentStatus),
      impact: worstStatus === null ? null : STATUS_IMPACT[worstStatus],
      ...(componentNames.length > 0 ? { componentNames } : {}),
      ...(componentIds.length > 0 ? { componentIds } : {}),
      startedAt,
      resolvedAt,
      duration: resolvedAt ? formatDuration(new Date(startedAt), new Date(resolvedAt)) : null,
      timeline,
    },
    segments,
    componentInstants: reads.flatMap((r) => r.affected.map((a) => ({ id: a.id, at: r.at }))),
  }
}

/** Incidents returned for DISPLAY. Uptime is computed over the FULL list, before this cap — the cap
 *  is newest-first, so computing over it would drop older incidents still inside the window and
 *  publish an inflated figure with `uptimeSource: 'official'` attached (#1123 review). */
const DISPLAY_LIMIT = 25

/** Fixed, not a parameter: the field is named `uptime30d` and is consumed as a 30-day figure
 *  everywhere, so a caller-supplied window would make that name a lie (#1123 review). */
const WINDOW_DAYS = 30

/**
 * Parse a Datadog status page's `config.json`.
 *
 * `ok: true` with `incidents: []` and `uptime30d: 100` is a REAL clean window. `ok: false` means the
 * document could not be read, and the caller must NOT publish that as "operational, no incidents" —
 * route it through the source-unknown path instead.
 *
 * `maintenances` is a SEPARATE top-level array and is never read here, so the "scheduled maintenance
 * leaks in as an incident" class that hit the previous OpenRouter parser twice (#894 structural,
 * #896 the completed-window backstop) has no path into this one — there is no shared container to
 * disambiguate. It is also legitimately `null` rather than `[]` when a page has none, which is why
 * nothing in this file indexes it.
 *
 * The uptime window is bounded by {@link recordReachDays}, and a short one is disclosed as
 * `uptimeWindowDays` (#1004) rather than published as a confident 30-day figure.
 */
export function parseDatadogStatusPage(
  raw: unknown,
  componentGroupId: string,
  nowMs: number = Date.now(),
): DatadogParseResult {
  if (!isRecord(raw)) return { ok: false, reason: 'dd-envelope-unreadable' }
  // `incidents` must be an ARRAY, not merely present: an error envelope or a redesigned document
  // would otherwise read as a page with nothing wrong.
  if (!Array.isArray(raw.incidents)) return { ok: false, reason: 'dd-envelope-unreadable' }

  const flattened = flattenComponents(raw.components)
  if (!flattened.ok) {
    console.warn(`[datadog] component tree unreadable (${flattened.reason}) — shape changed?`)
    return { ok: false, reason: flattened.reason }
  }

  // #1006 invariant — the badge and the uptime figure run on the SAME configured scope. Without it
  // this page's non-API `Web & Application Services` leaf drove both: a
  // website outage answered "yes" on /is-openrouter-down with the API healthy, and 15h28m of website
  // degradation was the whole of openrouter's published uptime deficit.
  //
  // The scope is the PROVIDER'S OWN GROUP, not a list of member ids. An enumeration has to be
  // maintained by hand against a page that changes without telling us, and this path has none of the
  // machinery the Atlassian arm uses to catch that (`buildPageComponents` keys on `apiUrl`, which is
  // null here, so `diffPageComponents` and `trackComponentMiss` can never fire for this page). A
  // member list therefore fails in BOTH directions and is only loud in one: a retired component
  // blacks the service out, while a NEW API component is silently unbadged and uncounted. Naming the
  // container the provider maintains removes the enumeration instead of adding a seventh guard to
  // it — the same reason the retired OnlineOrNot parser trusted `scheduledMaintenance` grouping over
  // a title regex.
  //
  // The scope follows the provider's grouping in BOTH directions, including a leaf they move INTO the
  // group, and this path has no drift detector to notice either. An empty group is refused.
  const scoped = flattened.leaves.filter((leaf) => leaf.groupId === componentGroupId)
  if (scoped.length === 0) {
    console.warn(`[datadog] component group ${componentGroupId} absent or empty — page restructured?`)
    return { ok: false, reason: 'dd-component-missing' }
  }

  const parsed: ParsedIncident[] = []
  for (const entry of raw.incidents) {
    const incident = parseIncident(entry, nowMs)
    // Refuse the whole read rather than publish a shorter list: downstream, a dropped incident is
    // indistinguishable from a quiet period, and this source feeds both the uptime figure and the
    // incident count. Same treatment the component path above gives a renamed status word.
    if (!incident) {
      const id = isRecord(entry) && typeof entry.id === 'string' ? entry.id : '<no id>'
      console.warn(`[datadog] incident ${id} unreadable — shape changed?`)
      return { ok: false, reason: 'dd-incident-unreadable' }
    }
    parsed.push(incident)
  }

  // One bucket per CONFIGURED component. Downtime on a component outside the scope (the website) is
  // not dropped from the incident LIST below — the provider published it and it stays visible — it
  // simply does not move the API's badge or its uptime.
  const byComponent = new Map<string, OutageSegment[]>(scoped.map((leaf) => [leaf.id, []]))
  for (const seg of parsed.flatMap((p) => p.segments)) byComponent.get(seg.componentId)?.push(seg)
  // Non-empty: the scope check above returns early on an empty `scoped`, so there is always at least
  // one bucket for the reducers below. (Before the group scope this was asserted against a type that
  // did not carry the guarantee, and an empty list published `Math.min(...[])` — `Infinity` — as an
  // `official` uptime.)
  const perComponent = [...byComponent.values()]

  // Bounded by the SCOPED records, so the denominator rests on the same evidence as the numerator.
  // Reading every incident let an out-of-scope component's older record widen the API's window,
  // which both raised the figure and suppressed the #1004 disclosure — less evidence producing a
  // more confident number, the direction this file refuses everywhere else. The figures are in
  // `datadog.test.ts`, where they are checked.
  const reachDays = recordReachDays(parsed, new Set(scoped.map((leaf) => leaf.id)), raw.created, nowMs)
  // The denominator is what the records actually cover. Asserting a flat 30 days on a page whose
  // history reaches back five would publish a confident figure over a window that does not exist —
  // and `uptimeWindowDays` is the signal the rest of the system already reads for that (#1004).
  // An unestablished reach is NOT the full 30 days: mapping it there made LESS evidence produce a
  // MORE confident, HIGHER figure with the #1004 disclosure suppressed (a 2-hour-old page read 99.86
  // over 30 days while a 1-day-old page correctly read 95.83 over 1). No window, no uptime — #713's
  // rule, and what `statuspage.ts` does when it holds no day-buckets.
  const windowDays = reachDays === null ? null : Math.min(WINDOW_DAYS, reachDays)
  const windowStart = windowDays === null ? nowMs : nowMs - windowDays * 86_400_000
  // Worst single component, never a pool across components — the rule `statuspage.ts` already
  // applies to a multi-component scope ("the impact CALENDAR is the union … while the PERCENT is the
  // worst single component"). Pooling here published a figure that appears on no component's row.
  const uptime30d = windowDays === null ? null : Math.min(...perComponent.map((segs) =>
    pct(weightedDowntimeSeconds(toIntervals(segs, STATUS_WEIGHT), windowStart, nowMs), windowDays)))
  // Worst-of independently, like statuspage.ts's `Math.max(...todaySecs)`: the most-affected
  // component TODAY need not be the 30-day-worst one.
  const todayWeightedOutageSec = Math.max(...perComponent.map((segs) =>
    weightedDowntimeSeconds(toIntervals(segs, STATUS_WEIGHT), startOfTodayUTC(nowMs), nowMs)))

  const incidents = parsed
    .map((p) => p.incident)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, DISPLAY_LIMIT)

  return {
    ok: true,
    page: {
      status: worstVerdict(scoped.map((leaf) => leaf.status)),
      incidents,
      uptime30d,
      uptimeWindowDays: windowDays !== null && windowDays < WINDOW_DAYS ? windowDays : null,
      todayWeightedOutageSec,
    },
  }
}

/** Floor, like every other source — never round 99.998% up to a clean 100%. */
function pct(weightedSec: number, days: number): number {
  return Math.max(0, Math.floor((1 - weightedSec / (days * 86_400)) * 10000) / 100)
}

/** Whole days the records reach back: the earlier of `created` and the earliest IN-SCOPE update
 *  instant. `null` when neither is readable. Two reasons neither half alone is the bound — a
 *  BACKFILLED page's records can predate `created`, and a record outside the configured scope says
 *  nothing about the scoped figure's window. */
function recordReachDays(
  parsed: ParsedIncident[],
  scopedIds: Set<string>,
  created: unknown,
  nowMs: number,
): number | null {
  const createdMs = typeof created === 'string' ? Date.parse(created) : NaN
  const reaches = parsed.flatMap((p) => p.componentInstants.filter((c) => scopedIds.has(c.id)).map((c) => c.at))
  if (!Number.isNaN(createdMs)) reaches.push(createdMs)
  if (reaches.length === 0) return null
  const days = Math.floor((nowMs - Math.min(...reaches)) / 86_400_000)
  // A reach under one whole day cannot carry a daily-resolution percentage. `null` here means "no
  // window", which the caller must publish as NO uptime — never as the full 30.
  return days > 0 ? days : null
}
