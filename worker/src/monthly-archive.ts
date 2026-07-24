// Monthly Archive — permanent per-month service reliability snapshot
// Triggered on 1st of each month (cron), aggregates previous month's daily data.
// Stored as archive:monthly:{YYYY-MM} with NO TTL (permanent).
//
// Incident data: accumulated daily via accumulateMonthlyIncidents() in daily summary cron,
// stored in incidents:monthly:{YYYY-MM} KV key (60d TTL). This ensures accurate monthly
// incident counts, unlike services:latest which is a point-in-time snapshot.

import type { ProbeDailyData } from './probe-archival'
import { summariesFromDailyData } from './probe-archival'
import type { ServiceStatus, Incident, ServiceConfig, ProbeSummary } from './types'
import { calculateAIWatchScore, classifyProbe } from './score'
import { resolveProbeId, PROBE_TARGETS } from './probe'
import type { OsvTimeline, OsvTimelineEntry } from './security-monitor'
import { osvTimelineKey, isPubliclyVerifiedAlert } from './security-monitor'
import { generateMonthlyNarrative, type MonthlyNarrativeDraft, type NarrativeAiOptions } from './monthly-narrative'
import { SERVICE_ADDED_AT, SERVICES, existedInMonth } from './services'
import { readIncidentHistory, summarizeAccuracy, type AccuracyStats, type IncidentHistoryRecord } from './incident-history'
import { readSuppressionsFresh, readSuppressionsFreshOrNull, isSuppressedByIdTitle, type SuppressionEntry } from './suppression'
import { readOverridesFresh, applyDurationOverrides } from './overrides'
import { kvPut, isNonReliabilityAdvisory } from './utils'
import { diffPrunedIncidents, appendWithdrawn, type WithdrawnIncident } from './withdrawn'
import { recordWithdrawalsPruned } from './withdrawal-log'

export type ScoreGrade = 'excellent' | 'good' | 'fair' | 'degrading' | 'unstable'
// #951 — mirrors AIWatchScore.confidence. 'high' ⟺ the service had an official uptime% at score
// time, i.e. the Score included the 40-pt uptime component (`score.ts` `hasUptime`).
export type ScoreConfidence = 'high' | 'medium' | 'low'

/** Per-incident snapshot kept in the permanent monthly archive (#375).
 *  Sourced from accumulated incidents:monthly:{period} at archive build time, before its
 *  60d TTL lapses — so the archive becomes a long-window incident-list source for the
 *  dashboard's 90-day filter when the upstream status pages only return ~5-30 days. */
export interface MonthlyIncidentEntry {
  id: string                     // status-page incident id (deduped during accumulation)
  title: string
  startedAt: string              // ISO
  resolvedAt: string | null      // ISO; null if still open at archive time
  durationMin: number            // last-known duration in minutes (0 if unresolved)
  // Last-seen status from the most recent accumulation that touched this entry.
  // Equals the resolution status once the incident is `resolved`; otherwise the most-recent
  // in-progress state (`investigating` / `identified` / `monitoring`).
  finalStatus: 'resolved' | 'monitoring' | 'investigating' | 'identified'
  // #653 — persisted so estimate-uptime services (bedrock/azureopenai) can compute an impact-weighted
  // uptime over the 90-day archive set, not just the short live RSS window. Optional/absent on archives
  // written before #653 → consumers treat missing as null (informational), i.e. conservatively
  // contributes no downtime (won't fabricate an outage from pre-#653 data).
  impact?: 'minor' | 'major' | 'critical' | null
  // #989 — persisted so `computeMonthlyScore` excludes provider auto-monitor machine-noise from the
  // MONTHLY Score too (parity with the live path, which reads the tag off fetchService). It CANNOT be
  // re-derived at score time like #1021's advisory titles: `autoMonitorTitles` matches the ORIGINAL
  // (e.g. Chinese) title, but the archive stores the English `titleMap` output. Absent on pre-#989
  // archives → treated as false (those blips count, same transition behaviour as #653/#1021).
  autoMonitor?: boolean
  // #975 — consecutive accumulation runs this UNRESOLVED entry has been confidently missing from the
  // upstream feed (see `prunePhantomIncidents`). Absent means zero: the field exists only while an
  // entry is in the missing state, so a resolved or currently-present entry serializes exactly as
  // before and the every-5-min write-skip guard in `accumulateIncidentsOnlyIfChanged` still
  // short-circuits. Deleted the moment the entry reappears, and gone with the entry once pruned.
  //
  // One state DOES add writes: an unresolved incident that flaps in and out of the feed each cycle
  // (the Instatus/Nuxt publish→delete pattern, #929) toggles the field, so each transition persists.
  // Bounded and self-limiting — it stops once the incident resolves or reaches the prune threshold —
  // and only on services that are already the noisy ones. Accepted, not overlooked.
  missedRuns?: number
}

export interface MonthlyServiceData {
  uptime: number | null          // AIWatch-measured uptime% from daily ok/total counters — feeds the Score (null if no data)
  officialUptime: number | null  // #586 — the rolling-30d official uptime (month-end daily snapshot) for the "Official Uptime" DISPLAY table; separate from the daily-counter `uptime` that feeds the Score. #951 — emitted ONLY when the Score actually consumed an official uptime (scoreConfidence 'high'); null otherwise. #1006 — this is AIWatch's OWN computation over the provider's published records, NOT a copy of the % on the provider's page; the report's table caption must say so, and the old "the window varies by page — 30 or 90 days" caveat is now false. #1110 — the Official path is a trailing 30 days with the 1.0/0.3 weighting (except the Instatus Next.js path, which honours a provider-published `customImpactPercentage`), and `platform_avg` is neither (see the `uptimeSource` note below), so do not caption it as one formula for every service
  /** #1006 — WHERE the records `officialUptime` was computed from came from: 'official' = the provider's
   *  own incident/outage records; 'platform_avg' = the status-page platform's own monitors (Better
   *  Stack), which is a measurement rather than the provider declaring an incident. #1110 — the two are
   *  NOT the same computation: `platform_avg` applies no severity weighting and drops unmonitored days
   *  from its window, so a report must not present the two columns as like-for-like. Absent on archives written
   *  before #1006, and on a service with no uptime at all. The report's "Uptime Source" column reads this
   *  instead of inferring the taxonomy from a hand-maintained service list (which drifted, aiwatch#951). */
  uptimeSource?: 'official' | 'platform_avg'
  score: number | null           // AIWatch Score at archive time (null if unavailable)
  grade: ScoreGrade | null       // Score grade (null if score unavailable)
  // #993 — Score computed over THIS CALENDAR MONTH (score.ts run on the month's incidents + monthly
  // probe summary), as opposed to `score` which is a build-day snapshot of the rolling live Score.
  // The report's trend chart + Notable Movers read this so the Score delta shares the month window
  // with the MTTR/downtime deltas. CAVEAT: only the Incidents (25) and Recovery (15) components are
  // truly calendar-windowed; the 40-pt Uptime component still uses the month-END rolling-30d
  // official-uptime snapshot (status pages expose no calendar-month uptime), and Responsiveness uses
  // the month's probe summary. Still a strict improvement over the build-day `score`. Absent on
  // archives built before #993 → consumers fall back to `score`.
  monthlyScore?: number | null
  monthlyGrade?: ScoreGrade | null
  monthlyScoreConfidence?: ScoreConfidence | null
  scoreConfidence?: ScoreConfidence | null // #951 — 'high' = the Score included the 40-pt uptime component; the report labels the uptime source from this instead of a hardcoded service list
  incidents: number              // incident count for the month (from accumulated data)
  avgResolutionMin: number | null // average resolution time in minutes (null if no resolved incidents)
  totalDowntimeMin: number | null // sum of all incident durations for the month (null if no resolved incidents — unresolved durations are tracked as 0 upstream)
  longestIncidentMin: number | null // max single-incident duration for the month (null if no resolved incidents)
  avgLatencyMs: number | null    // average probe RTT p75 in ms (null if no probe data)
  p95LatencyMs: number | null    // mean of daily probe RTT p95 in ms (#17 — null if no valid p95 data)
  latencySpikes: number | null   // total RTT spikes this month (rtt>3×median or failed probe; #17 — null if no probe data)
  /** #1002 / aiwatch-reports#76 — the two figures **`monthlyScore`'s** Responsiveness component (20 pts)
   *  was scored on: `computeResponsiveness` reads p50 (the `speed` axis) + cvCombined (`stability`).
   *  Both are computed at build time to derive `monthlyScore`, and were then discarded — so a reader
   *  told Responsiveness is 20% of the Score could see neither. Null when it scored no Responsiveness;
   *  ABSENT on archives written before this (a reader must treat both as "—", i.e. test `!= null`).
   *  Not interchangeable with `avgLatencyMs`/`p95LatencyMs` above — see resolveArchiveProbeSummary for
   *  why, and for the display ≡ score rule that decides when these are populated. */
  p50LatencyMs: number | null    // median probe RTT (ms) the Responsiveness `speed` axis scored
  cvCombined: number | null      // combined RTT variance the Responsiveness `stability` axis scored
  // Per-incident detail (#375). Capped at MAX_INCIDENTS_PER_SERVICE_IN_ARCHIVE to bound KV size;
  // when the cap is hit, oldest entries are truncated (the most-recent-N policy keeps the
  // dashboard's 30-90d filter useful even on high-frequency services like Together AI).
  // Optional/null for archives written before this feature shipped — frontend must handle absence.
  incidentList?: MonthlyIncidentEntry[]
  // #591 — the service's incident source was known-stale (frozen feed, e.g. DeepSeek → Flashduty)
  // when this archive was built. The report generator excludes such services from the Score ranking
  // (their empty incident window would inflate the Score). Absent when false / pre-#591 archives.
  incidentSourceStale?: boolean
  // #605 Phase 2 — per-component monthly uptime% (from the accumulated daily component counters),
  // sorted least-reliable first. Present only for multi-component services with accumulated data;
  // absent for single-component services and pre-#605 archives. Feeds the report's per-component
  // reliability table / "weakest component this month" ranking (Phase 3).
  components?: Array<{ id: string; name: string; uptime: number }>
  // #809 — static `addedAt` ISO date (from ServiceConfig), for services that carry one. Lets the
  // report-side coverage gate (aiwatch-reports#45) detect a service added mid-month by comparing this
  // date to the report month. Absent = established service (full coverage). NOT `coverageDays` (live,
  // now-relative → wrong for a historical month).
  addedAt?: string
}

export interface MonthlyArchive {
  period: string                 // YYYY-MM
  generatedAt: string            // ISO timestamp
  daysCollected: number          // number of days with actual uptime data
  services: Record<string, MonthlyServiceData>
  // Optional — null for months before this feature shipped (or no detections).
  // Sourced from security:monthly:{period} at archive build time before its 60d TTL lapses (#290).
  security?: MonthlySecuritySummary | null
  // #679 — the detection-lead (faster-than-official) summary was removed (structurally null).
  // Optional — null for months before this feature shipped (or no degradations recorded).
  // Sourced from probe-degradation:monthly:{period} (60d TTL accumulator, #511) — RTT latency
  // degradations the official status pages often don't report. The `noStatus*` figures are the
  // headline differentiator: degradations flagged while the service's official status was still ok.
  degradation?: MonthlyDegradationSummary | null
  // Optional — AI-generated retrospective draft for the report's Notable Incidents
  // + Observations sections (#426 / aiwatch-reports#4 Phase 3). Generated at archive
  // build time from the incidentList data. null when AI is unavailable, the call
  // failed, or the archive predates this feature — aiwatch-reports generate-report.js
  // must handle absence (falls back to the hand-written placeholder).
  narrative?: MonthlyNarrativeDraft | null
  // #827 Feature 3 — AI recovery-prediction accuracy for the month (predicted vs actual, aggregated
  // from the durable incident:history corpus filtered to this period). null when no predicted+resolved
  // incident fell in the month (or the archive predates this feature) — the report site
  // (aiwatch-reports) renders the "AI Prediction Accuracy" section only when present.
  predictionAccuracy?: AccuracyStats | null
}

// ── Monthly security summary ─────────────────────────────────────────
//
// Shape stored in security:monthly:{YYYY-MM} (60d TTL) by the hourly security cron.
// The archive snapshots this into a permanent summary before TTL expiry (#290).

export type SecuritySeverityBucket = 'critical' | 'high' | 'medium' | 'low'

export interface MonthlySecurityEntry {
  title: string
  url: string
  source: 'osv' | 'hackernews' | 'nvd'
  severity?: string
  service?: string
  detectedAt: string             // ISO 8601
}

export interface MonthlySecurityTopFinding extends MonthlySecurityEntry {
  // #291: optional per-alert timeline ("detected → fix_released → severity_changed").
  // Populated only for OSV findings that have a permanent security:timeline:osv:{id} KV
  // entry at archive build time; HN findings never carry this field.
  timeline?: OsvTimelineEntry[]
}

export interface MonthlySecuritySummary {
  totalAlerts: number
  bySource: { osv: number; hackernews: number; nvd: number }
  bySeverity: Record<SecuritySeverityBucket, number>
  byService: Record<string, number>                // service name → count
  topFindings: MonthlySecurityTopFinding[]         // sorted by severity desc, max 10
}

// ── Monthly RTT degradation summary (#511, follow-up to #464) ───────
//
// Accumulated from probe-degradation:monthly:{YYYY-MM} (60d TTL) — incremented on each
// probe-spike rising edge alongside the daily counter so the archive cron on the 1st can carry
// month-complete figures past the 48h TTL on the per-day keys.
// `noStatus*` = degradations flagged while the service's official status was still
// operational (NOT on the status page) — the headline differentiator from #464.

/** Raw monthly accumulator shape stored at probe-degradation:monthly:{period}. */
export interface DegradationMonthly {
  byService: Record<string, number>          // svcId → total RTT-degradation rising edges this month
  noStatusByService: Record<string, number>  // svcId → subset not reflected on the official status page
}

export interface MonthlyDegradationSummary {
  total: number                              // all RTT degradations this month
  noStatusTotal: number                      // subset not on the official status page (headline)
  byService: Record<string, number>          // svcId → total
  noStatusByService: Record<string, number>  // svcId → not-on-status count
}

/** Monthly degradation accumulator key (60d TTL) — written alongside the daily counter so the
 *  archive cron can read month-complete figures past the daily 48h TTL (mirrors the security:monthly pattern). */
export function degradationMonthlyKey(date: Date = new Date()): string {
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  return `probe-degradation:monthly:${date.getUTCFullYear()}-${m}`
}

export const DEGRADATION_MONTHLY_TTL_SECONDS = 60 * 86400 // 60 days — covers archive cron + late catch-up

/** Pure: fold one rising-edge degradation into the monthly accumulator. Returns a NEW object
 *  (input not mutated). `existing` null/garbage → start fresh. Increments byService always; also
 *  noStatusByService when the degradation wasn't on the official status page. Unit-testable so the
 *  index.ts read-modify-write stays a thin I/O wrapper. */
export function addDegradationToMonthly(
  existing: DegradationMonthly | null | undefined,
  svcId: string,
  isNoStatus: boolean,
): DegradationMonthly {
  const byService = { ...(existing?.byService ?? {}) }
  const noStatusByService = { ...(existing?.noStatusByService ?? {}) }
  byService[svcId] = (byService[svcId] ?? 0) + 1
  if (isNoStatus) noStatusByService[svcId] = (noStatusByService[svcId] ?? 0) + 1
  return { byService, noStatusByService }
}

/** Coerce an unknown parsed value into a well-formed DegradationMonthly, keeping only finite
 *  non-negative integer counts (disposable accumulator — corrupt/foreign value → empty, never throws). */
export function normalizeDegradationMonthly(parsed: unknown): DegradationMonthly {
  const out: DegradationMonthly = { byService: {}, noStatusByService: {} }
  if (!parsed || typeof parsed !== 'object') return out
  for (const field of ['byService', 'noStatusByService'] as const) {
    const m = (parsed as Record<string, unknown>)[field]
    if (!m || typeof m !== 'object') continue
    for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[field][k] = Math.floor(v)
    }
  }
  return out
}

/** Aggregate the raw monthly accumulator into a permanent archive summary. Returns null on empty
 *  input — caller decides whether to attach `degradation: null`, mirroring how security is handled. */
export function summarizeDegradation(raw: DegradationMonthly | null | undefined): MonthlyDegradationSummary | null {
  if (!raw) return null
  const byService = raw.byService ?? {}
  const noStatusByService = raw.noStatusByService ?? {}
  const total = Object.values(byService).reduce((a, b) => a + b, 0)
  if (total === 0) return null
  const noStatusTotal = Object.values(noStatusByService).reduce((a, b) => a + b, 0)
  return { total, noStatusTotal, byService, noStatusByService }
}

// ── Incident accumulation (written daily by daily summary cron) ──────
//
// NOTE: a stale duplicate `MonthlyIncidentEntry` interface used to sit here
// (shape `{ title, startedAt, status, durationMin }`). It was superseded by the
// canonical archive-snapshot shape at the top of this file (#375 — adds `id`,
// `resolvedAt`, `finalStatus`) but never removed. TypeScript declaration-merged
// the two, and the merge stayed latent only because no cross-module import
// forced full resolution. #426's `import type { MonthlyIncidentEntry }` in
// monthly-narrative.ts surfaced it as a TS2345 error. The accumulator pushes the
// canonical shape (see accumulateMonthlyIncidents) so the duplicate was pure
// dead code — removed. `incidents` below reuses the single canonical interface.

export interface MonthlyIncidentServiceData {
  count: number
  totalMinutes: number
  longestMinutes: number
  dates: string[]                // unique affected dates (YYYY-MM-DD)
  incidentIds: string[]          // for dedup
  durations: Record<string, number> // incidentId → last known duration in minutes (for delta updates)
  // Per-incident detail accumulated alongside the aggregates so the permanent archive
  // can carry full incident lists past the upstream status-page response window (#375).
  // Optional for backward compat with existing KV entries written before this field shipped.
  incidents?: MonthlyIncidentEntry[]
}

/** Cap on incidents kept per service in the monthly accumulator (and thus in the archive).
 *  Services emit at most ~140 incidents/month in observed data (Together AI 139 in April).
 *  200 leaves headroom for outliers without inflating KV value size — at ~250B per entry
 *  it caps each service at ~50KB, and the full archive at ~1.5MB even when every service
 *  is at the cap. KV value limit is 25MB, so this is comfortable. */
export const MAX_INCIDENTS_PER_SERVICE_IN_ARCHIVE = 200

export interface MonthlyIncidents {
  lastUpdated: string
  services: Record<string, MonthlyIncidentServiceData>
}

/** #975 — consecutive runs an unresolved entry must be *confidently* missing before it is pruned.
 *  The accumulator runs on the every-5-minute cron, so 3 runs is about 15 minutes: long enough that a
 *  single malformed upstream response can't delete real data, short enough that a phantom doesn't sit
 *  in the dashboard's 30/90-day list for hours. Raising it only delays cleanup; lowering it to 1 would
 *  make one bad parse destructive. */
export const PHANTOM_PRUNE_AFTER_MISSED_RUNS = 3

/** #975 — copy an accumulator entry for PUBLIC emission, dropping bookkeeping that exists only to
 *  drive the phantom prune. Both emit sites are trust boundaries: `buildPartialIncidentArchive` feeds
 *  `/api/report` for the current month, and `buildMonthlyArchive` bakes the PERMANENT
 *  `archive:monthly:{YYYY-MM}` the reports site reads. A phantom sitting at `missedRuns: 2` at month
 *  rollover would otherwise freeze an internal counter into an immutable public snapshot forever. */
export function stripInternalFields(e: MonthlyIncidentEntry): MonthlyIncidentEntry {
  const { missedRuns: _missedRuns, ...rest } = e
  return rest
}

/** Is this a value we may order lexicographically as an ISO instant? Guards the #975 watermark
 *  comparison: `'2026-01-01T00:00:00Z' < 'pending'` is `true`, so an unvalidated non-ISO string would
 *  satisfy guard 3 and enable a prune. Anything that isn't a 4-digit-year ISO prefix is untrusted. */
function isIsoish(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)
}

/**
 * #975 — remove entries stranded by an upstream **delete + re-publish**, and recompute the affected
 * service's aggregates. Pure; the input is not mutated.
 *
 * The accumulator is additive and keyed on the upstream incident id: it only ever *updates* a stored
 * entry while that same id is still in the live feed. When a provider retires an id — Pinecone
 * deleted `xqp5fkvlyg6t` and re-published the same outage as `m3wrr6csl9jm` with a reworded title and
 * a backdated start — the old entry is never resolved and never removed. It sits in the dashboard's
 * 30/90-day list forever as `finalStatus: 'monitoring'`, `resolvedAt: null`, `durationMin: 0`, i.e.
 * an eternal "Ongoing" row, and its `count++` inflates the month's incident total. Live-wins-on-id
 * dedup can't help: the ids differ, so the phantom and its replacement never collide.
 *
 * An entry is pruned only when ALL of these hold, re-checked every run:
 *   1. it is UNRESOLVED — a resolved entry is never touched. Resolved incidents legitimately age out
 *      of the upstream feed window, so their absence tells us nothing.
 *   2. its id is absent from the service's live incident list.
 *   3. the live list still contains an incident that started STRICTLY EARLIER. This is the load-bearing
 *      guard, and it is stronger than "the service reported at least one incident this cycle": it
 *      proves the feed window has not truncated *past* our entry, so absence means deletion rather
 *      than truncation. It is also vacuously false when the live list is empty, so a failed fetch —
 *      which yields no incidents — can never prune anything.
 *   4. 1-3 have held for `PHANTOM_PRUNE_AFTER_MISSED_RUNS` consecutive runs (`missedRuns`), so one
 *      transient hiccup cannot delete real data. The counter resets the moment the entry reappears.
 *
 * Entries that were TRUNCATED to `MAX_INCIDENTS_PER_SERVICE_IN_ARCHIVE` have no detail row, and this
 * only walks detail rows — so a counted-but-truncated incident is never mistaken for a phantom.
 * (Truncation drops the OLDEST entries; a phantom is by definition recent.)
 *
 * **Suppressed incidents are never pruned.** `fetchAllServices` returns lists that already had
 * `applySuppressions` applied (#904), so an operator-suppressed incident is missing from the live list
 * *by policy*, not because upstream deleted it. Without this carve-out an unresolved suppressed
 * incident (e.g. OpenAI's FedRAMP one) would be erased from the accumulator ~15 minutes after the
 * suppression is added, and removing the suppression would restore nothing — destroying the
 * reversibility that is the whole point of the suppression layer. `suppressions` is REQUIRED rather
 * than optional so the type-checker forces every call site to decide (an optional param would let a
 * future caller silently reintroduce this).
 *
 * `suppressions === null` means "the list could not be read" and **disables pruning entirely for this
 * run** — fail-closed. Collapsing an unreadable list to `[]` would be fail-open in the destructive
 * direction: three consecutive KV blips would be enough to erase a suppressed incident.
 *
 * Aggregate rollback mirrors `filterSuppressedFromMonthly` exactly — `durations` is the complete,
 * uncapped per-id map, so `count`/`totalMinutes`/`longestMinutes` recompute from it precisely.
 * `dates` is deliberately left alone, as it is there too: it has no consumer, and recomputing it from
 * the capped detail rows would silently drop the dates of truncated incidents.
 *
 * Scope: `accumulateMonthlyIncidents` only ever runs for the CURRENT month, so this self-heals the
 * current month's accumulator. A phantom already stranded in a past month stays until an operator
 * suppression drops it at archive-build time (#904).
 *
 * Known residual false-positive path, accepted: a still-open incident that keeps its upstream id but
 * gets its TITLE reworded such that `filterIncidents` keyword attribution (services.ts) stops
 * matching it would disappear from the live list exactly like a phantom, and could be pruned. It
 * needs a keyword-attributed service, a concurrent older live incident, and the mismatch to persist
 * past the miss threshold — and while it holds, the incident is already invisible on every live
 * surface, so the accumulator row is the lesser loss. The prune logs every deletion so this is
 * reconstructible rather than silent.
 *
 * #1106 raised the stakes of that residual: a prune now also emits a public WITHDRAWAL notice on
 * Discord and Slack/RSS, so a false positive is no longer a quiet internal data loss but a published
 * claim that the provider retracted an incident. `withdrawalHold` (`withdrawn.ts`) is what keeps that
 * in check — it withholds the notice while the service carries an unresolved live incident OR is
 * anything but cleanly `operational`. The second half is what covers THIS residual specifically: a
 * retitled incident is by definition absent from the incident list (that is why it was pruned), so
 * only the service's own status can still see it. The delete-plus-re-publish-under-a-new-id case
 * above is caught by the first half. The prune's own behaviour is unchanged; only the notice is gated.
 */
export function prunePhantomIncidents(
  data: MonthlyIncidents,
  services: ServiceStatus[],
  suppressions: SuppressionEntry[] | null,
): MonthlyIncidents {
  // Unreadable suppression list → we cannot tell "hidden by policy" from "deleted upstream". Hold.
  // Logged: otherwise the self-heal silently does nothing and no operator can tell it was skipped.
  if (suppressions === null) {
    console.warn('[monthly-archive] #975 phantom prune skipped — suppression list unreadable (fail-closed)')
    return data
  }
  if (!data?.services || typeof data.services !== 'object') return data

  const liveBySvc = new Map<string, Incident[]>()
  for (const svc of services) liveBySvc.set(svc.id, svc.incidents ?? [])

  let touched = false
  const nextServices: Record<string, MonthlyIncidentServiceData> = {}

  for (const [svcId, svc] of Object.entries(data.services)) {
    const details = svc.incidents
    const live = liveBySvc.get(svcId)
    // A service absent from this cycle's list (removed, or a whole-fetch failure) is never pruned.
    if (!details?.length || !live?.length) { nextServices[svcId] = svc; continue }

    // `String(...)` on both sides: a strict-equality miss would read a PRESENT incident as absent and
    // eventually delete it, so the id comparison must not depend on a parser emitting the declared
    // `string` type. Falsy ids are dropped here and skipped below, never matched by accident.
    const liveIds = new Set(live.map((i) => i?.id).filter(Boolean).map(String))
    // Earliest start among live incidents — the truncation watermark for guard 3. Compared as ISO
    // strings, which sort lexicographically. Non-ISO values are ignored, which can only move the
    // watermark LATER, making guard 3 harder to satisfy — i.e. it fails toward not pruning.
    let oldestLiveStart: string | null = null
    for (const i of live) {
      const s = i?.startedAt
      if (isIsoish(s) && (oldestLiveStart === null || s < oldestLiveStart)) oldestLiveStart = s
    }

    const pruned = new Set<string>()
    const nextDetails: MonthlyIncidentEntry[] = []
    let svcTouched = false

    for (const entry of details) {
      const e = { ...entry }
      const seen = !e.id || liveIds.has(String(e.id))
      // Absent because an operator hid it, not because upstream deleted it — see the doc comment.
      const hidden = suppressions.length > 0 && isSuppressedByIdTitle(e.id, e.title, svcId, suppressions)
      // A malformed stored `startedAt` can't be ordered against the watermark. Holding here makes
      // "malformed → never pruned" TOTAL: without it, a value like `'pending'` sorts after any
      // `'2xxx-…'` ISO string, so guard 3 would pass and a real entry could be deleted.
      const orderable = isIsoish(e.startedAt)

      if (e.finalStatus === 'resolved' || seen || hidden || !orderable) {
        if (e.missedRuns !== undefined) { delete e.missedRuns; svcTouched = true }
        nextDetails.push(e)
        continue
      }
      // Guard 3 — can't tell "deleted upstream" from "fell off the end of the feed window", so hold.
      // Reset the counter too: the threshold means N runs of CONFIDENT absence, and a hold is not
      // one. Without the reset a phantom whose older live sibling ages out freezes mid-count forever.
      if (oldestLiveStart === null || !(oldestLiveStart < e.startedAt)) {
        if (e.missedRuns !== undefined) { delete e.missedRuns; svcTouched = true }
        nextDetails.push(e)
        continue
      }

      const misses = (e.missedRuns ?? 0) + 1
      if (misses >= PHANTOM_PRUNE_AFTER_MISSED_RUNS) {
        // This DELETES durable data — the one operation in this module that does. Log it, so a
        // false positive is reconstructible later instead of appearing as a row that silently
        // vanished from the 30/90-day list.
        console.log(`[monthly-archive] #975 pruning phantom ${svcId}/${e.id} after ${misses} confident misses — "${e.title}" (started ${e.startedAt}, oldest live ${oldestLiveStart})`)
        pruned.add(e.id)
        svcTouched = true
        continue // dropped — do not carry into nextDetails
      }
      console.log(`[monthly-archive] #975 phantom candidate ${svcId}/${e.id} missing ${misses}/${PHANTOM_PRUNE_AFTER_MISSED_RUNS} runs`)
      e.missedRuns = misses
      svcTouched = true
      nextDetails.push(e)
    }

    if (!svcTouched) { nextServices[svcId] = svc; continue }
    touched = true

    if (pruned.size === 0) { nextServices[svcId] = { ...svc, incidents: nextDetails }; continue }

    const incidentIds = svc.incidentIds.filter((id) => !pruned.has(id))
    const durations: Record<string, number> = {}
    for (const [id, dur] of Object.entries(svc.durations ?? {})) {
      if (!pruned.has(id)) durations[id] = dur
    }
    const durationVals = Object.values(durations)
    nextServices[svcId] = {
      ...svc,
      count: incidentIds.length,
      totalMinutes: durationVals.reduce((a, b) => a + b, 0),
      longestMinutes: durationVals.reduce((m, d) => Math.max(m, d), 0),
      incidentIds,
      durations,
      incidents: nextDetails,
    }
  }

  return touched ? { ...data, services: nextServices } : data
}

/** Accumulate current service incidents into monthly totals. Deduplicates by incident ID.
 *  `suppressions` is only consumed by the #975 phantom prune (an operator-hidden incident must never
 *  be pruned); accumulation itself needs no filtering, since `services` arrives already suppressed.
 *  `null` = the list could not be read → the prune is skipped for this run (fail-closed). */
export function accumulateMonthlyIncidents(
  existing: MonthlyIncidents | null,
  services: ServiceStatus[],
  period: string, // YYYY-MM
  suppressions: SuppressionEntry[] | null,
): MonthlyIncidents {
  const base: MonthlyIncidents = existing
    ? { lastUpdated: new Date().toISOString(), services: structuredClone(existing.services) }
    : { lastUpdated: new Date().toISOString(), services: {} }

  // #975 — reconcile BEFORE accumulating, and outside the per-service `continue` below: a phantom must
  // still be prunable on a cycle where the service reports no incident *for this period* (its only
  // remaining live incidents may be from an earlier month). The prune reads the service's FULL live
  // list, not the period-filtered one, because feed truncation is global rather than per-month.
  const result = prunePhantomIncidents(base, services, suppressions)

  for (const svc of services) {
    const incidents = (svc.incidents ?? []).filter(
      i => i.startedAt.startsWith(period),
    )
    if (incidents.length === 0) continue

    if (!result.services[svc.id]) {
      result.services[svc.id] = { count: 0, totalMinutes: 0, longestMinutes: 0, dates: [], incidentIds: [], durations: {}, incidents: [] }
    }
    const data = result.services[svc.id]
    // Ensure durations + incidents map/array exist (backward compat with pre-feature data)
    if (!data.durations) data.durations = {}
    if (!data.incidents) data.incidents = []

    for (const inc of incidents) {
      const dur = inc.duration ? parseDurationMin(inc.duration) : 0
      const finalStatus = mapIncidentStatus(inc.status)

      if (data.incidentIds.includes(inc.id)) {
        // Update duration delta if incident resolved since last accumulation
        const oldDur = data.durations[inc.id] ?? 0
        if (dur > oldDur) {
          data.totalMinutes += (dur - oldDur)
          data.durations[inc.id] = dur
          if (dur > data.longestMinutes) data.longestMinutes = dur
        }
        // Update detail entry (status / resolvedAt / durationMin) when the incident has progressed.
        // This lets a still-open incident get its resolvedAt + final status snapshotted on a later
        // accumulator run, without changing dedup behavior.
        const existingDetail = data.incidents.find(e => e.id === inc.id)
        if (existingDetail) {
          existingDetail.durationMin = dur
          existingDetail.finalStatus = finalStatus
          existingDetail.resolvedAt = inc.resolvedAt ?? existingDetail.resolvedAt
          existingDetail.impact = inc.impact ?? existingDetail.impact ?? null // #653 — snapshot/refresh impact
        }
        continue
      }

      // New incident
      data.incidentIds.push(inc.id)
      data.durations[inc.id] = dur
      data.count++
      data.totalMinutes += dur
      if (dur > data.longestMinutes) data.longestMinutes = dur
      data.incidents.push({
        id: inc.id,
        title: inc.title,
        startedAt: inc.startedAt,
        resolvedAt: inc.resolvedAt ?? null,
        durationMin: dur,
        finalStatus,
        impact: inc.impact ?? null, // #653 — for archive-window estimate-uptime weighting
        ...(inc.autoMonitor ? { autoMonitor: true } : {}), // #989 — so the monthly Score excludes it too
      })

      const date = inc.startedAt.slice(0, 10)
      if (!data.dates.includes(date)) data.dates.push(date)
    }

    // Cap incident detail to the most-recent N (oldest dropped first). Aggregate fields
    // (count / totalMinutes / longestMinutes) intentionally keep counting truncated entries
    // — only the per-incident detail loses tail items when the cap binds. dedup state in
    // incidentIds / durations is also preserved untruncated so a re-accumulation pass for an
    // already-counted-but-truncated incident still updates its aggregate, just without
    // re-adding it to the detail array.
    if (data.incidents.length > MAX_INCIDENTS_PER_SERVICE_IN_ARCHIVE) {
      data.incidents.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      data.incidents.splice(0, data.incidents.length - MAX_INCIDENTS_PER_SERVICE_IN_ARCHIVE)
    }
  }

  return result
}

/** #587 — read `incidents:monthly:{month}`, accumulate the current services onto it, and write
 *  back ONLY when the incident data actually changed.
 *
 *  Designed to run on the every-5-minute alert cron (not just the daily summary), so a short-lived
 *  or RSS-sourced incident (Azure/Bedrock) that fires an alert is captured before it ages out of
 *  the upstream feed — the daily-only cadence missed those, leaving the dashboard 90-day filter +
 *  monthly archive blind to an incident that AIWatch alerted on.
 *
 *  Write-budget guard: `accumulateMonthlyIncidents` always stamps a fresh `lastUpdated`, so a full
 *  JSON compare would never match. We compare the `services` payload only — when no incident data
 *  changed (the overwhelmingly common 5-min case) we skip the write entirely. dedup-by-id inside
 *  `accumulateMonthlyIncidents` keeps it idempotent, so repeated 5-min runs never double-count. */
export async function accumulateIncidentsOnlyIfChanged(
  kv: KVNamespace,
  services: ServiceStatus[],
  month: string, // YYYY-MM
): Promise<'unchanged' | 'written' | 'failed'> {
  const incKey = `incidents:monthly:${month}`
  // #975 — a THROWN KV get must not be collapsed into "no accumulator yet". `existing = null` makes
  // `accumulateMonthlyIncidents` rebuild the month from this cycle alone, and since the JSON compare
  // then differs, that stripped object is WRITTEN — silently destroying the month's history on a
  // single transient read blip. Only a genuinely absent key (null, first write of the month) may
  // legitimately start from scratch; a read error aborts the cycle and retries in 5 minutes.
  let existingRaw: string | null
  try {
    existingRaw = await kv.get(incKey)
  } catch (err) {
    console.error(`[monthly-archive] ${incKey} read failed — skipping accumulation this cycle:`, err instanceof Error ? err.message : String(err))
    return 'failed'
  }
  let existing: MonthlyIncidents | null = null
  if (existingRaw) {
    try { existing = JSON.parse(existingRaw) } catch { existing = null /* corrupt → rebuild from current */ }
  }
  // #975 — a suppressed-but-unresolved incident is absent from `services` by policy (fetchAllServices
  // applies suppressions), and the prune must not mistake that for an upstream deletion and erase it.
  // `…OrNull` rather than `readSuppressions`/`readSuppressionsFresh` NOT for freshness — the prune
  // needs 3 runs (~15 min) to act, so a 60s-cached list is current enough — but because both siblings
  // collapse a KV read/parse failure to `[]` (or a stale cache), i.e. to "nothing is hidden". A
  // destructive caller must be able to tell that apart, and `null` disables the prune for this run.
  const suppressions = await readSuppressionsFreshOrNull(kv)
  const updated = accumulateMonthlyIncidents(existing, services, month, suppressions)
  // Compare incident payload only — `lastUpdated` is bumped every call, so a whole-object compare
  // would always differ. No service-payload change → nothing to persist → skip the write.
  const existingServices = existing ? JSON.stringify(existing.services) : null
  if (existingServices === JSON.stringify(updated.services)) return 'unchanged'
  const ok = await kvPut(kv, incKey, JSON.stringify(updated), { expirationTtl: 60 * 86400 })
  if (!ok) return 'failed'
  // #1106 — the prune above is the LAST moment we hold a provider-deleted incident's title + start
  // time, so record a tombstone for the notification channels that already announced it (Discord had
  // no resolved branch to take, and the RSS `:resolved` item has no live incident to render from).
  // Only after the accumulator write LANDED. Not a double-announce guard — `alerted:wd:{incId}` (7d)
  // already prevents that — but a consistency one: an unpersisted prune leaves the incident still
  // present in the accumulator, so `/api/report` and the dashboard's 30/90-day list would keep
  // rendering it as an ongoing row while Discord and Slack announced it withdrawn.
  // Hoisted out of the try so the catch can NAME what was affected. After this cycle those ids exist
  // nowhere else — the accumulator row is already pruned, so `diffPrunedIncidents` can never
  // re-derive them — and a bare "capture failed" would leave the loss unreconstructible.
  let tombstones: WithdrawnIncident[] = []
  try {
    tombstones = diffPrunedIncidents(existing, updated, new Date().toISOString())
    if (tombstones.length > 0) {
      await appendWithdrawn(kv, tombstones)
      // #1106 Part 5 — the tombstone above is 6d; this is the durable record that the withdrawal
      // happened at all. Written AFTER the roster so a KV failure here can never cost the notice
      // itself, and unconditionally on the roster's own outcome: a withdrawal that failed to notify
      // is precisely the case the log has to preserve.
      await recordWithdrawalsPruned(kv, tombstones)
    }
  } catch (err) {
    // Never let the notification-side bookkeeping fail the accumulation it rides on. Both stages are
    // named because either can throw and the consequences differ — a roster failure costs the ⚪
    // notice itself, a durable-log failure costs only the record of it.
    console.error(
      '[monthly-archive] #1106 withdrawal bookkeeping failed (tombstone roster and/or durable log):',
      tombstones.map((w) => `${w.svcId}/${w.incId}`).join(', ') || '(ids unavailable — the diff itself threw)',
      err instanceof Error ? err.message : err,
    )
  }
  return 'written'
}

/** #587 mid-month — synthesize a PARTIAL archive (incidentList only) from the live
 *  `incidents:monthly:{month}` accumulator. Lets the dashboard 90-day filter show a CURRENT-month
 *  incident that already rolled out of the upstream live feed, BEFORE the real archive is built
 *  (cron, 1st of next month). Read-only over the accumulator — does NOT write/rebuild
 *  archive:monthly, so it cannot race the daily-summary accumulator write (the reason the frontend
 *  historically excluded the current month). The accumulator already stores per-service
 *  MonthlyIncidentEntry[], so the emitted incidentList shape matches buildMonthlyArchive verbatim
 *  (frontend `mergeArchiveIntoMap` reads `archive.services[id].incidentList`; live wins on id
 *  collision, so an active incident still shown by /api/status is never double-rendered). */
export function buildPartialIncidentArchive(
  period: string,
  incidentData: MonthlyIncidents | null,
): { period: string; partial: true; services: Record<string, { incidentList: MonthlyIncidentEntry[] }> } {
  const services: Record<string, { incidentList: MonthlyIncidentEntry[] }> = {}
  for (const [id, svc] of Object.entries(incidentData?.services ?? {})) {
    if (svc?.incidents && svc.incidents.length > 0) {
      services[id] = { incidentList: svc.incidents.map(stripInternalFields) }
    }
  }
  return { period, partial: true, services }
}

/** Map a runtime ServiceStatus.incidents[].status to the archive's finalStatus enum.
 *  Defaults to 'investigating' when the upstream emits a value the archive doesn't
 *  recognize (defensive against future status-page schema additions). */
function mapIncidentStatus(s: Incident['status']): MonthlyIncidentEntry['finalStatus'] {
  if (s === 'resolved' || s === 'monitoring' || s === 'identified' || s === 'investigating') return s
  return 'investigating'
}

// ── Duration parsing ──────────────────────────────────────────────────

/** Parse duration string (e.g., "2h 30m", "45m", "3h") to minutes. Exported for testing. */
export function parseDurationMin(d: string): number {
  if (!d) return 0
  const h = d.includes('h') ? parseInt(d.split('h')[0]) : 0
  const afterH = d.includes('h') ? d.split('h')[1]?.trim() : d
  const m = afterH && afterH.includes('m') ? parseInt(afterH.replace('m', '').trim()) : 0
  const result = (isNaN(h) ? 0 : h) * 60 + (isNaN(m) ? 0 : m)
  return result
}

// ── Uptime / Latency computation ─────────────────────────────────────

// #605 — the live daily:{date} value also carries per-component daily counters (index.ts
// accumulateComponentCounters); Phase 2 reads them into per-component monthly uptime.
type DailyCounters = Record<string, {
  ok: number
  total: number
  officialUptime?: number | null
  components?: Record<string, { ok: number; total: number; name: string }>
}>

/** How many of the month's FINAL days may supply the "as of month end" official uptime. A value last
 *  observed earlier than this is not month-end data — it is residue (#951). Three days tolerates a
 *  transient status-page fetch failure on the last day (the snapshot is the day's last cron cycle)
 *  without tolerating a source that went away mid-month. */
export const OFFICIAL_UPTIME_TAIL_DAYS = 3

/** #586 — per-service "Official Uptime" for the month: the status-page rolling-30d value as of the
 *  LATEST day in the window (≈ the month, since uptime30d trails 30 days). Reads the per-cycle daily
 *  snapshots (DailyCounters.officialUptime) rather than a one-shot build-time snapshot, so it stays
 *  month-accurate and survives a later rebuild. Omits a service when no day carried a value (months
 *  before this shipped, or a service that publishes no metric) → the caller falls back to null.
 *
 *  #951 — "as of the LATEST day" is now what the code actually does. It used to scan every day and keep
 *  the last NON-NULL value, so a figure last seen on the 17th was still reported as the month's official
 *  uptime even though the source published nothing for the final two weeks. That is how the pre-#713
 *  incident-derived ESTIMATE (removed 2026-06-19; the daily counter stores `uptime30d` without its
 *  `uptimeSource`, so an estimate is indistinguishable from an official %) stamped a fabricated
 *  "Official · 100.00%" on Stability/ElevenLabs/Replicate for all of June 2026 — and how Character.AI
 *  kept a real-but-dead 99.58% after its status page was deactivated (#689/#800). Only the final
 *  OFFICIAL_UPTIME_TAIL_DAYS days with data can supply the value now. */
export function computeMonthlyOfficialUptime(
  dailyData: Record<string, DailyCounters>,
): Record<string, number> {
  const result: Record<string, number> = {}
  const dates = Object.keys(dailyData).sort()
  const tail = dates.slice(-OFFICIAL_UPTIME_TAIL_DAYS)
  for (const date of tail) { // ascending → later dates overwrite (most-recent wins)
    for (const [id, c] of Object.entries(dailyData[date])) {
      if (c.officialUptime !== null && c.officialUptime !== undefined) result[id] = c.officialUptime
    }
  }
  return result
}

/** #951 — SECOND line of defence, after `computeMonthlyOfficialUptime` narrowed the value to the
 *  month's final days. The archive's "Official Uptime" DISPLAY must agree with what the Score actually
 *  consumed, or the report prints "Official · 100.00%" beside a score rescaled over /60 as if no
 *  uptime existed. `scoreConfidence === 'high'` ⟺ `score.ts` `hasUptime` ⟺ the 40-pt uptime component
 *  was included.
 *
 *  The two signals can legitimately disagree, and the disagreement is worth surfacing rather than
 *  silently resolving. The month-end value comes from the daily snapshots; `scoreConfidence` comes from
 *  ONE read of `services:latest` on build day. If a status-page fetch happened to fail on that read,
 *  a service that published uptime all month reads `medium` and loses its figure. That is a real way to
 *  discard correct data, so we warn — the same class of silent drop this whole issue is about. We still
 *  withhold the number (a displayed uptime beside a `/60` score is the contradiction #951 exists to
 *  remove), but the operator can see it happened; the archived `score` is wrong in that case too.
 *
 *  `scoreSvc === undefined` means `services:latest` was unreadable (index.ts logs the parse failure and
 *  passes an empty scoreData). Do NOT null everything then: the month-end daily snapshots stand on their
 *  own, and there is no score to contradict. This is what the pre-#951 code did — tying officialUptime
 *  to scoreData would let one parse failure erase every service's uptime from an archive the cron never
 *  rebuilds (it only builds when the entry is absent).
 *
 *  Historical archives written before this shipped still carry the contaminated values and are corrected
 *  out-of-band — do NOT reach for `/api/admin/rebuild-archive`. It is not idempotent (it re-snapshots
 *  `score` from the CURRENT `services:latest`), and because this gate reads that same current confidence,
 *  rebuilding a month whose service has since LOST its source (Character.AI, #689/#800) also withholds the
 *  uptime it genuinely published back then. Patch the `archive:{period}` KV entry directly instead. */
export function resolveArchiveOfficialUptime(
  monthEndValue: number | undefined,
  scoreSvc: ArchiveScoreInput | undefined,
): number | null {
  if (!scoreSvc) return monthEndValue ?? null
  // #1016 — emit the MONTH-END daily snapshot ONLY; never fall back to a live `services:latest` value.
  // The rebuild path re-snapshots today's `uptime30d` into a frozen month, so a null month-end value used
  // to fall back to today's LIVE figure — "Official · 100%" beside a monthlyScore that had dropped the
  // uptime component (openrouter, June 2026). A month with no snapshot now correctly reads null.
  if (scoreSvc.scoreConfidence == null) {
    // Both production callers pass it; this only guards an external caller. Confidence unknown → we can't
    // confirm the Score consumed an uptime, so surface the month-end snapshot at most (never a live value).
    console.warn(`[monthly-archive] ${scoreSvc.id}: scoreData omits scoreConfidence — emitting the month-end snapshot only`)
    return monthEndValue ?? null
  }
  if (scoreSvc.scoreConfidence !== 'high') {
    if (monthEndValue != null) {
      console.warn(
        `[monthly-archive] ${scoreSvc.id}: withholding month-end official uptime ${monthEndValue} — ` +
        `build-time scoreConfidence=${scoreSvc.scoreConfidence} (uptime30d was null when the Score was ` +
        `snapshotted, so the archived score is a /60 rescale). Transient status-page failure on build day?`,
      )
    }
    return null
  }
  return monthEndValue ?? null
}

/** Compute per-service uptime% from daily counters */
export function computeMonthlyUptime(
  dailyData: Record<string, DailyCounters>,
): Record<string, number> {
  const totals: Record<string, { ok: number; total: number }> = {}
  for (const counters of Object.values(dailyData)) {
    for (const [id, { ok, total }] of Object.entries(counters)) {
      if (!totals[id]) totals[id] = { ok: 0, total: 0 }
      totals[id].ok += ok
      totals[id].total += total
    }
  }
  const result: Record<string, number> = {}
  for (const [id, { ok, total }] of Object.entries(totals)) {
    result[id] = total > 0 ? Math.round((ok / total) * 10000) / 100 : 0
  }
  return result
}

/** #605 Phase 2 — per-component monthly uptime%, per service, from the accumulated daily
 *  component counters. Sorted **least-reliable first** (the report's "which component was the
 *  weakest link this month" angle). Services with no per-component data are omitted. */
export function computeMonthlyComponentUptime(
  dailyData: Record<string, DailyCounters>,
): Record<string, Array<{ id: string; name: string; uptime: number }>> {
  // svcId → compId → accumulated {ok,total,name}
  const totals: Record<string, Record<string, { ok: number; total: number; name: string }>> = {}
  for (const counters of Object.values(dailyData)) {
    for (const [svcId, entry] of Object.entries(counters)) {
      if (!entry.components) continue
      const svc = (totals[svcId] ??= {})
      for (const [compId, c] of Object.entries(entry.components)) {
        const cc = (svc[compId] ??= { ok: 0, total: 0, name: c.name })
        cc.ok += c.ok
        cc.total += c.total
        cc.name = c.name // latest display name
      }
    }
  }
  const result: Record<string, Array<{ id: string; name: string; uptime: number }>> = {}
  for (const [svcId, comps] of Object.entries(totals)) {
    const arr = Object.entries(comps)
      // Drop zero-sample components (unlike computeMonthlyUptime's `total===0 → 0`): a component with
      // no samples shouldn't appear as a misleading 0% in the "weakest component" table.
      .filter(([, c]) => c.total > 0)
      .map(([id, c]) => ({ id, name: c.name, uptime: Math.round((c.ok / c.total) * 10000) / 100 }))
      .sort((a, b) => a.uptime - b.uptime || a.name.localeCompare(b.name)) // ties → name asc (stable)
    if (arr.length > 0) result[svcId] = arr
  }
  return result
}

/** #605 Phase 3 — curate the aggregated per-component uptime down to the service's DISPLAY set,
 *  applying the SAME selection `resolveSvcComponents` uses live (services.ts): `displayAllComponents`
 *  → all minus `componentDenylist` (by name); else the `displayComponentIds` / `statusComponentIds`
 *  allowlist. So the report shows only reliability-relevant surfaces, NOT billing/compliance noise
 *  (e.g. OpenAI's FedRAMP component at 42% would otherwise read as "OpenAI 42% uptime"). Returns
 *  `undefined` (→ the `components` field is omitted) when there's no display config or <2 survive —
 *  a one-row breakdown adds nothing. Pure + unit-tested; keeps the least-reliable-first order. */
// Pick (not a hand-written struct) so a rename of any of these fields on ServiceConfig breaks
// the build here instead of silently diverging the report's curation from the dashboard's
// (mirrors StatusResolverConfig in services.ts). #605 Phase 3.
type ComponentDisplayConfig = Pick<ServiceConfig, 'displayComponentIds' | 'statusComponentIds' | 'displayAllComponents' | 'componentDenylist'>
export function curateComponentUptime(
  components: Array<{ id: string; name: string; uptime: number }> | undefined,
  config: ComponentDisplayConfig | undefined,
): Array<{ id: string; name: string; uptime: number }> | undefined {
  if (!components || components.length === 0 || !config) return undefined
  let kept: typeof components
  if (config.displayAllComponents) {
    const deny = new Set((config.componentDenylist ?? []).map((n: string) => n.toLowerCase()))
    kept = components.filter((c) => !deny.has(c.name.toLowerCase()))
  } else {
    const ids = config.displayComponentIds ?? config.statusComponentIds
    if (!ids || ids.length === 0) return undefined
    const idSet = new Set(ids)
    kept = components.filter((c) => idSet.has(c.id))
  }
  return kept.length >= 2 ? kept : undefined
}

const PROBED_IDS = new Set(PROBE_TARGETS.map((t) => t.id))

/**
 * PURE. #1002 / aiwatch-reports#76 — the Responsiveness inputs **`monthlyScore` was computed from**, or
 * null when it scored no Responsiveness component. The canonical rationale for both new fields.
 *
 * WHY NOT the sibling latency fields. `computeMonthlyLatency`/`computeMonthlyLatencyStats` mean every
 * day's p75/p95, dropping only days with a non-positive value, and key by the service's OWN id. The
 * Score never sees those. Responsiveness reads `summariesFromDailyData`, which first drops partial days
 * (<200 snapshots), spike-dominated days (≥50%) and extreme-spread days (p95/p50 > 10×), needs ≥2
 * survivors, and is keyed by the PROBE's id. So the two genuinely differ, and publishing the mean as
 * "the Responsiveness input" — aiwatch-reports#76's original proposal — would relabel a figure the
 * Score never read, which is the defect that issue exists to fix.
 *
 * WHY DELEGATE to `classifyProbe` rather than re-derive "is this probe scorable?" from PROBED_IDS +
 * validDays + p50: the predicate is subtle ('insufficient' means probed-but-unscorable — it costs a
 * confidence penalty yet yields NO component), and computeMonthlyScore asks the identical question
 * further down this file. A second copy would drift silently into publishing a p50 the Score ignored.
 * Sharing it makes display ≡ score true by construction.
 *
 * The anchor is **`monthlyScore`, not `score`** — the archive carries both, and `score` is a build-day
 * snapshot of the LIVE rolling-30d figure whose Responsiveness came from a different (7-day) summary
 * with a different p50. So this is #951's display ≡ score rule pointed at the month-scoped score. It
 * holds for the report only because #993 moved it onto `monthlyScore` — adopted reports-side in
 * aiwatch-reports PR #82, which resolves it at each of the THREE archive-load paths that read services
 * raw. So a fourth read path added later would skip the normalization and render these beside a raw
 * `score`, quietly breaking the guarantee.
 *
 * `resolveProbeId` (#883): an inheriting service (claudecode→claude, codex→openai) is scored on its
 * PARENT's probe, so that is the p50 that moved its Score — even though its own `avgLatencyMs`, keyed
 * by its own id, is null. A consumer filtering the table on `avgLatencyMs` therefore drops the very
 * services this inheritance exists to serve; filter on this field instead.
 */
export function resolveArchiveProbeSummary(
  serviceId: string,
  monthlySummaries: Map<string, ProbeSummary>,
): { p50LatencyMs: number; cvCombined: number } | null {
  const probeId = resolveProbeId(serviceId)
  const probe = classifyProbe(probeId, PROBED_IDS.has(probeId), monthlySummaries)
  if (probe.kind !== 'available') return null
  return { p50LatencyMs: probe.summary.p50, cvCombined: probe.summary.cvCombined }
}

/** Format integer minutes back to the "Xh Ym" string score.ts's MTTR parser expects (lossless). */
function minutesToDurationString(mins: number): string {
  return `${Math.floor(mins / 60)}h ${mins % 60}m`
}

/**
 * A calendar-month AIWatch Score (#993). PURE. Runs the SAME `calculateAIWatchScore` the live path
 * uses, but over an explicit month window: the month's incidents (adapted from the archived
 * per-incident entries), the month's official uptime, and a month-scoped probe summary. This makes
 * the archived Score share the calendar-month window with the MTTR/downtime aggregates beside it, so
 * the report's Notable Movers stops juxtaposing two different windows. Reuses score.ts as the single
 * source of the formula — no reimplementation. (Uptime input is the month-END rolling official
 * uptime, not a calendar-month figure — status pages expose none; incidents + recovery are the
 * calendar-windowed parts.) Returns null when there is nothing to score.
 */
export function computeMonthlyScore(
  id: string,
  monthIncidents: MonthlyIncidentEntry[] | undefined,
  officialUptime: number | null,
  monthlySummaries: Map<string, ProbeSummary>,
  window: { startISO: string; endISO: string },
  svcConfig: ServiceConfig | undefined,
): { score: number | null; grade: ScoreGrade | null; confidence: ScoreConfidence } {
  // Adapt the archived incident entries to the minimal Incident shape calculateAIWatchScore reads
  // (startedAt, impact, status, duration). finalStatus → status; durationMin → the "Xh Ym" string
  // its MTTR parser expects (lossless for integer minutes); missing impact → null (informational).
  const incidents: Incident[] = (monthIncidents ?? []).map((e) => ({
    id: e.id,
    title: e.title,
    status: e.finalStatus,
    // #1021 — down-classify a non-reliability advisory (usage-limits/quota/billing/…) to null impact here
    // too, so the monthly Score excludes it (calculateAIWatchScore filters impact == null per #707/#261)
    // over the SAME title-keyed population aggregateIncidentDurations excludes from downtime. Keyed on the
    // TITLE, not stored impact: a REBUILD of a pre-#1021 month (stored impact 'minor') — or an advisory
    // open across the deploy boundary, whose stored 'minor' a later live null never overwrites
    // (accumulateMonthlyIncidents nullish-coalesces impact) — would otherwise drop the advisory from
    // downtime yet still count it in the Score, an internally-contradictory report (the Codex June case).
    impact: isNonReliabilityAdvisory(e.title ?? '') ? null : (e.impact ?? null),
    // #989 — carry the persisted auto-monitor tag through so isReliabilityIncident excludes it from the
    // monthly Score exactly as on the live path (a pre-#989 archive has it absent → counts, as before).
    autoMonitor: e.autoMonitor,
    startedAt: e.startedAt,
    resolvedAt: e.resolvedAt,
    duration: e.finalStatus === 'resolved' ? minutesToDurationString(e.durationMin) : null,
    timeline: [],
  }))
  const service: ServiceStatus = {
    id,
    name: svcConfig?.name ?? id,
    provider: svcConfig?.provider ?? '',
    category: svcConfig?.category ?? 'api',
    status: 'operational', // unread by calculateAIWatchScore; the window + incidents drive the score
    latency: null,
    uptime30d: officialUptime, // month official uptime — null drops the Uptime component (as live)
    lastChecked: window.endISO,
    incidents,
  }
  const probeId = resolveProbeId(id) // #883 — inheriting services score against the parent's probe
  const probe = classifyProbe(probeId, PROBED_IDS.has(probeId), monthlySummaries)
  const r = calculateAIWatchScore(service, 30 /* unused when window is set */, probe, window)
  return { score: r.score, grade: r.grade, confidence: r.confidence }
}

/** Compute per-service average probe RTT (p75) from daily probe summaries */
export function computeMonthlyLatency(
  probeData: Record<string, ProbeDailyData>,
): Record<string, number> {
  const sums: Record<string, number> = {}
  const counts: Record<string, number> = {}
  for (const daily of Object.values(probeData)) {
    for (const [id, stat] of Object.entries(daily)) {
      if (stat.p75 <= 0) continue
      sums[id] = (sums[id] ?? 0) + stat.p75
      counts[id] = (counts[id] ?? 0) + 1
    }
  }
  const result: Record<string, number> = {}
  for (const id of Object.keys(sums)) {
    result[id] = Math.round(sums[id] / counts[id])
  }
  return result
}

/**
 * Monthly p95 (mean of valid daily p95) + total spike count per service (#17 follow-up).
 * Same daily probe source as computeMonthlyLatency; kept separate so the existing p75 callers
 * and tests are unaffected. p95 is null when no day had a valid (>0) p95 — a probe-failure-only
 * day stores p95=0, which would otherwise render a misleading "0 ms" in the report. Spikes
 * accumulate across all days (a failed-probe day contributes spikes even with p95=0).
 */
export function computeMonthlyLatencyStats(
  probeData: Record<string, ProbeDailyData>,
): Record<string, { p95: number | null; spikes: number }> {
  const p95Sums: Record<string, number> = {}
  const p95Counts: Record<string, number> = {}
  const spikeTotals: Record<string, number> = {}
  for (const daily of Object.values(probeData)) {
    for (const [id, stat] of Object.entries(daily)) {
      if (stat.p95 > 0) {
        p95Sums[id] = (p95Sums[id] ?? 0) + stat.p95
        p95Counts[id] = (p95Counts[id] ?? 0) + 1
      }
      if (typeof stat.spikes === 'number' && stat.spikes > 0) {
        spikeTotals[id] = (spikeTotals[id] ?? 0) + stat.spikes
      }
    }
  }
  const result: Record<string, { p95: number | null; spikes: number }> = {}
  const ids = new Set([...Object.keys(p95Sums), ...Object.keys(spikeTotals)])
  for (const id of ids) {
    result[id] = {
      p95: p95Counts[id] ? Math.round(p95Sums[id] / p95Counts[id]) : null,
      spikes: spikeTotals[id] ?? 0,
    }
  }
  return result
}

// ── Security summary builder ─────────────────────────────────────────

const SEVERITY_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 }

function normalizeSeverity(raw: string | undefined): SecuritySeverityBucket | null {
  if (!raw) return null
  const lower = raw.toLowerCase()
  return lower === 'critical' || lower === 'high' || lower === 'medium' || lower === 'low'
    ? lower
    : null
}

/**
 * Summarize a month's accumulated security alerts into the permanent archive shape.
 * Pure function — takes the parsed `security:monthly:{period}` contents, returns the summary.
 *
 * Top findings are sorted by severity descending (critical → low); unknown severities rank
 * below "low". Max 10 entries. Stable tie-breaker on detectedAt (more recent first) so a
 * re-generation of the same month always yields the same archive.
 */
export function summarizeSecurityAlerts(entries: MonthlySecurityEntry[]): MonthlySecuritySummary {
  const bySource: MonthlySecuritySummary['bySource'] = { osv: 0, hackernews: 0, nvd: 0 }
  const bySeverity: MonthlySecuritySummary['bySeverity'] = { critical: 0, high: 0, medium: 0, low: 0 }
  const byService: Record<string, number> = {}

  for (const e of entries) {
    if (e.source === 'osv') bySource.osv++
    else if (e.source === 'hackernews') bySource.hackernews++
    else if (e.source === 'nvd') bySource.nvd++
    const sev = normalizeSeverity(e.severity)
    if (sev) bySeverity[sev]++
    if (e.service) byService[e.service] = (byService[e.service] ?? 0) + 1
  }

  const topFindings = [...entries]
    .sort((a, b) => {
      const rankA = SEVERITY_RANK[normalizeSeverity(a.severity) ?? ''] ?? 0
      const rankB = SEVERITY_RANK[normalizeSeverity(b.severity) ?? ''] ?? 0
      if (rankA !== rankB) return rankB - rankA
      return b.detectedAt.localeCompare(a.detectedAt) // recent first on severity tie
    })
    .slice(0, 10)

  return { totalAlerts: entries.length, bySource, bySeverity, byService, topFindings }
}

/**
 * Extract the OSV vuln ID (GHSA-* or CVE-*) from a finding URL.
 * Works for the two shapes our writer currently produces: osv.dev/vulnerability/{id}
 * and github.com/advisories/{id}. Returns null if the URL doesn't carry a recognizable id.
 */
export function extractOsvVulnId(url: string | undefined): string | null {
  if (!url) return null
  const m = url.match(/(GHSA-[a-z0-9-]+|CVE-\d{4}-\d+)/i)
  return m ? m[1] : null
}

/**
 * For each OSV top finding, attach its permanent timeline (#291) when a
 * security:timeline:osv:{id} KV entry exists. HN findings and findings without a
 * resolvable vuln id pass through unchanged.
 */
export async function enrichTopFindingsWithTimelines(
  kv: KVNamespace,
  summary: MonthlySecuritySummary,
): Promise<MonthlySecuritySummary> {
  const enrichedTop = await Promise.all(
    summary.topFindings.map(async (f): Promise<MonthlySecurityTopFinding> => {
      if (f.source !== 'osv') return f
      const vulnId = extractOsvVulnId(f.url)
      if (!vulnId) return f
      const raw = await kv.get(osvTimelineKey(vulnId)).catch(() => null)
      if (!raw) return f
      try {
        const timeline = JSON.parse(raw) as OsvTimeline
        if (Array.isArray(timeline.entries) && timeline.entries.length > 0) {
          return { ...f, timeline: timeline.entries }
        }
      } catch { /* malformed timeline — skip enrichment, don't fail archive */ }
      return f
    }),
  )
  return { ...summary, topFindings: enrichedTop }
}

/** Get all dates in a given month (YYYY-MM-DD strings) */
export function getMonthDates(year: number, month: number): string[] {
  const dates: string[] = []
  const daysInMonth = new Date(year, month, 0).getDate()
  for (let d = 1; d <= daysInMonth; d++) {
    const mm = String(month).padStart(2, '0')
    const dd = String(d).padStart(2, '0')
    dates.push(`${year}-${mm}-${dd}`)
  }
  return dates
}

// ── Archive builder ──────────────────────────────────────────────────

export interface ArchiveScoreInput {
  id: string
  aiwatchScore?: number | null
  scoreGrade?: ScoreGrade | null
  // #951 — the confidence the Score was computed at. 'high' ⟺ an official uptime% was available and
  // the 40-pt uptime component was included. This is what gates the archived `officialUptime` display.
  scoreConfidence?: ScoreConfidence | null
  // #1006 — provenance of the uptime figure ('official' = the provider's own records; 'platform_avg' =
  // the status-page platform's monitors). Carried into the archive so the report labels the source from
  // the data rather than a hand-maintained list.
  uptimeSource?: 'official' | 'platform_avg'
  // #591 — the service's incident source is known-stale (frozen feed). Threaded into the archive so
  // the report generator can exclude it from the Score ranking, parity with the live dashboard.
  incidentSourceStale?: boolean
}

/** Build monthly archive from daily KV data + accumulated incident data */
/**
 * #827 Feature 3 — aggregate AI recovery-prediction accuracy for a month. Reads each service's
 * durable `incident:history` corpus, keeps records whose `resolvedAt` falls in `period` (YYYY-MM),
 * and runs `summarizeAccuracy`. Returns null when no PREDICTED+resolved incident landed in the month
 * (the caller sets `MonthlyArchive.predictionAccuracy` to null — the key is still present — and the
 * report site shows nothing rather than "0%").
 *
 * Caveat: the corpus is a rolling per-service cap (HISTORY_CAP), not month-bucketed — a service with
 * a very high incident volume could age old records out before its month is archived. Acceptable for
 * v1 (the archive runs at month-end; the just-completed month's records are recent → present). The
 * sharper case is an `/api/admin/rebuild-archive` of an OLD month: it recomputes from the CURRENT
 * corpus, so a high-volume service's older records may already be gone → the rebuilt value can shrink
 * or go null (same not-time-machine class as that handler's Score caveat).
 */
export async function buildMonthlyAccuracy(
  kv: KVNamespace,
  period: string,
  svcIds: string[],
): Promise<AccuracyStats | null> {
  const all: IncidentHistoryRecord[] = []
  await Promise.all(svcIds.map(async (id) => {
    const recs = await readIncidentHistory(kv, id)
    for (const r of recs) {
      if (typeof r.resolvedAt === 'string' && r.resolvedAt.slice(0, 7) === period) all.push(r)
    }
  }))
  const stats = summarizeAccuracy(all) // ignores prediction-less records in the denominator
  return stats.total > 0 ? stats : null
}

/** #904 — pure: drop operator-suppressed incidents from a stored monthly accumulator and recompute
 *  each affected service's aggregates (count / totalMinutes / longestMinutes) from the survivors.
 *  `durations` is the complete per-id map (uncapped), so totalMinutes = Σ durations and
 *  longestMinutes = max(durations) recompute exactly; a service with nothing suppressed is returned
 *  by identity. Titles for service-pattern matching come from the (capped) `incidents` detail array;
 *  incident-scope entries match by id even when a detail row is absent. */
export function filterSuppressedFromMonthly(
  data: MonthlyIncidents,
  list: SuppressionEntry[],
): MonthlyIncidents {
  // Identity for a no-op list OR a structurally-corrupt accumulator (parses but lacks `.services`) —
  // so a caller outside a try/catch (the /api/report partial) can't throw on `Object.entries(undefined)`.
  if (!list.length || !data?.services || typeof data.services !== 'object') return data
  const services: Record<string, MonthlyIncidentServiceData> = {}
  for (const [svcId, svc] of Object.entries(data.services)) {
    const details = svc.incidents ?? []
    const titleById = new Map(details.map((d) => [d.id, d.title]))
    const suppressed = new Set<string>()
    for (const id of svc.incidentIds) {
      if (isSuppressedByIdTitle(id, titleById.get(id) ?? '', svcId, list)) suppressed.add(id)
    }
    if (suppressed.size === 0) { services[svcId] = svc; continue }
    const incidentIds = svc.incidentIds.filter((id) => !suppressed.has(id))
    const durations: Record<string, number> = {}
    for (const [id, dur] of Object.entries(svc.durations ?? {})) {
      if (!suppressed.has(id)) durations[id] = dur
    }
    const durationVals = Object.values(durations)
    services[svcId] = {
      ...svc,
      count: incidentIds.length,
      totalMinutes: durationVals.reduce((a, b) => a + b, 0),
      longestMinutes: durationVals.reduce((m, d) => Math.max(m, d), 0),
      incidentIds,
      durations,
      incidents: details.filter((d) => !suppressed.has(d.id)),
    }
  }
  return { ...data, services }
}

/** #915 — the per-service monthly downtime aggregates. Sums/maxes the per-incident FINAL durations
 *  (`incidents[].durationMin`) rather than the accumulator's `totalMinutes`/`longestMinutes`, which
 *  grow MONOTONICALLY (`accumulateMonthlyIncidents`: `if (dur > oldDur)`) and so lock in a long-open
 *  incident's inflated open-window duration — never corrected down when it resolves shorter (Deepgram
 *  June: 176h42m/141h10m aggregate vs the real 45h33m/27h from the incident list). The per-incident
 *  detail IS updated to the final duration, so it's the source of truth. Falls back to the accumulator
 *  ONLY when the list was TRUNCATED to the per-service cap (`incidents.length < count`), where it is
 *  no longer the full population. Returns both null when there are no incidents. Pure — unit-tested. */
export function aggregateIncidentDurations(
  incidents: MonthlyIncidentEntry[] | undefined,
  count: number,
  accumulatorTotal: number,
  accumulatorLongest: number,
): { totalMin: number | null; longestMin: number | null; countedCount: number | null } {
  if (!incidents || incidents.length === 0 || incidents.length < count) {
    // Truncated (>MAX cap) or no detail — the accumulator is the only full-population source. It's a
    // pre-summed total that can't be re-filtered per-incident, so the #1021 advisory exclusion is
    // best-effort here; countedCount null tells the caller to keep the full-count avg-resolution divisor.
    return {
      totalMin: accumulatorTotal > 0 ? accumulatorTotal : null,
      longestMin: accumulatorLongest > 0 ? accumulatorLongest : null,
      countedCount: null,
    }
  }
  // #1021 — EXCLUDE non-reliability advisories (usage-limits / quota / billing / deprecation / model-access,
  // no outage signal) from the downtime aggregates: they carry a duration but are NOT availability downtime,
  // so summing one inflates totalDowntimeMin / longestIncidentMin (Codex's June "Usage Limits Depleting
  // Faster Than Expected" 72h was 79% of its archived downtime). Keyed on the TITLE classifier
  // (isNonReliabilityAdvisory — the same one the live path uses to down-classify impact→null for the Score),
  // NOT on `impact == null`: null is also the lazy default for plain informational entries, and a REBUILD of
  // stored data may carry a pre-down-classification `minor` impact — the title is the stable signal. An
  // OUTAGE_SIGNAL term in the title always wins, so a real fault is never dropped. countedCount → avg.
  let total = 0
  let longest = 0
  let countedCount = 0
  for (const e of incidents) {
    if (isNonReliabilityAdvisory(e.title ?? '')) continue
    countedCount++
    const d = typeof e.durationMin === 'number' && e.durationMin > 0 ? e.durationMin : 0
    total += d
    if (d > longest) longest = d
  }
  return { totalMin: total > 0 ? total : null, longestMin: longest > 0 ? longest : null, countedCount }
}

export async function buildMonthlyArchive(
  kv: KVNamespace,
  year: number,
  month: number,
  scoreData?: ArchiveScoreInput[],
  // When provided with an AI binding and/or API key, generate the retrospective
  // narrative draft and bake it into the archive (#426). Omitted/empty → archive
  // builds with `narrative: null`; the report falls back to its placeholder.
  narrativeOpts?: NarrativeAiOptions,
): Promise<MonthlyArchive> {
  const mm = String(month).padStart(2, '0')
  const period = `${year}-${mm}`
  const dates = getMonthDates(year, month)

  // Read daily uptime counters (history:{date} for past days)
  const uptimeResults = await Promise.all(
    dates.map(d => kv.get(`history:${d}`).catch(() => null)),
  )
  const dailyData: Record<string, DailyCounters> = {}
  let daysCollected = 0
  let parseErrors = 0
  uptimeResults.forEach((raw, i) => {
    if (raw) {
      try {
        dailyData[dates[i]] = JSON.parse(raw)
        daysCollected++
      } catch (err) {
        parseErrors++
        console.warn(`[monthly-archive] corrupt daily data for ${dates[i]}:`, err instanceof Error ? err.message : err)
      }
    }
  })
  if (parseErrors > 0) {
    console.error(`[monthly-archive] ${parseErrors} days had corrupt data for ${period}`)
  }

  // Read daily probe summaries (probe:daily:{date})
  const probeResults = await Promise.all(
    dates.map(d => kv.get(`probe:daily:${d}`).catch(() => null)),
  )
  const probeData: Record<string, ProbeDailyData> = {}
  probeResults.forEach((raw, i) => {
    if (raw) {
      try { probeData[dates[i]] = JSON.parse(raw) } catch (err) {
        console.warn(`[monthly-archive] corrupt probe data for ${dates[i]}:`, err instanceof Error ? err.message : err)
      }
    }
  })

  // Read accumulated incident data
  const incRaw = await kv.get(`incidents:monthly:${period}`).catch(() => null)
  let incidentData: MonthlyIncidents | null = null
  if (incRaw) {
    try { incidentData = JSON.parse(incRaw) } catch (err) {
      console.warn(`[monthly-archive] corrupt incident accumulation for ${period}:`, err instanceof Error ? err.message : err)
    }
  }

  // #904 — build-time suppression filter. The already-stored accumulator may contain incidents an
  // operator has since suppressed (e.g. OpenAI FedRAMP), so a rebuild-archive of a past month drops
  // them + recomputes count/downtime/longest from the survivors — WITHOUT deleting the accumulator KV
  // (rebuild-safe). The live path is already suppressed upstream in fetchAllServices.
  if (incidentData) {
    // Fresh read (bypass the isolate cache used on the hot /api/status path) — a rebuild is a rare,
    // manual, correctness-critical one-shot, so it must see a just-added suppression immediately.
    const suppressions = await readSuppressionsFresh(kv)
    if (suppressions.length) incidentData = filterSuppressedFromMonthly(incidentData, suppressions)
    // #1019 — build-time duration overrides: pin a paperwork-inflated incident's duration to the
    // operator value, recomputing downtime/longest from the survivors (rebuild-safe, no KV surgery).
    const overrides = await readOverridesFresh(kv)
    if (overrides.length) incidentData = applyDurationOverrides(incidentData, overrides)
  }

  // Snapshot accumulated security alerts before their 60d TTL lapses (#290). Missing
  // or malformed data must not fail the archive — security is optional enrichment.
  const secRaw = await kv.get(`security:monthly:${period}`).catch(() => null)
  let security: MonthlySecuritySummary | null = null
  if (secRaw) {
    try {
      const parsed = JSON.parse(secRaw) as MonthlySecurityEntry[]
      // #892 — the monthly archive is PUBLIC (/api/report → reports site), so gate it to
      // verified findings (OSV, or HN with a CVE id) exactly like the dashboard read;
      // unverified HN chatter must not surface (as a top finding OR in the counts) in the
      // public report either. Filtering the entries flows through to every derived figure.
      const verified = Array.isArray(parsed) ? parsed.filter(isPubliclyVerifiedAlert) : []
      if (verified.length > 0) {
        security = summarizeSecurityAlerts(verified)
        // Attach permanent per-alert timelines to OSV top findings (#291).
        security = await enrichTopFindingsWithTimelines(kv, security)
      }
    } catch (err) {
      console.warn(`[monthly-archive] corrupt security accumulation for ${period}:`, err instanceof Error ? err.message : err)
    }
  }

  // Snapshot RTT-degradation monthly accumulator before its 60d TTL lapses (#511). The per-day
  // probe-degradation:* keys carry only 48h TTL, so the archive reads the dedicated monthly
  // accumulator (built from the archive's own period string, not "now", so the cron archives the
  // *previous* month). Missing/malformed must not fail the archive.
  const degKey = `probe-degradation:monthly:${period}`
  const degRaw = await kv.get(degKey).catch(() => null)
  let degradation: MonthlyDegradationSummary | null = null
  if (degRaw) {
    try {
      degradation = summarizeDegradation(normalizeDegradationMonthly(JSON.parse(degRaw)))
    } catch (err) {
      console.warn(`[monthly-archive] corrupt degradation accumulation for ${period}:`, err instanceof Error ? err.message : err)
    }
  }

  const uptimeMap = computeMonthlyUptime(dailyData)
  const componentUptimeMap = computeMonthlyComponentUptime(dailyData) // #605 Phase 2 — per-component monthly uptime
  const officialUptimeMap = computeMonthlyOfficialUptime(dailyData) // #586 — month-end status-page value per service
  const latencyMap = computeMonthlyLatency(probeData)
  const latencyStats = computeMonthlyLatencyStats(probeData) // p95 + spikes (#17)

  // Guard: 0 days with data is almost certainly a KV failure
  if (daysCollected === 0) {
    console.error(`[monthly-archive] No daily data found for ${period} — possible KV read failure (checked ${dates.length} days)`)
  }

  // Build per-service archive
  const services: Record<string, MonthlyServiceData> = {}
  const allIds = new Set([...Object.keys(uptimeMap), ...Object.keys(latencyMap), ...Object.keys(latencyStats)])

  if (scoreData) {
    for (const svc of scoreData) allIds.add(svc.id)
  }
  if (incidentData) {
    for (const id of Object.keys(incidentData.services)) allIds.add(id)
  }

  // #909 — a REBUILD reads the current services:latest roster (scoreData), so a service added AFTER
  // this month would otherwise get a null-data entry that leaks into the report's monitored count /
  // "zero incidents" line / uptime+latency tables. Drop services added after the month's last day;
  // established + genuine mid-month adds are kept (the #802 ranking gate still handles partial coverage).
  const monthEnd = dates[dates.length - 1] // 'YYYY-MM-DD'

  // #993 — a month-scoped probe summary (same cvCombined logic as the live 7-day path) and the
  // calendar-month window, computed ONCE for the monthly-Score pass below. The window uses CLEAN DAY
  // boundaries ([month-01 00:00, next-month-01 00:00)) rather than `...T23:59:59.999Z`: incident
  // `startedAt` values are compared as STRINGS, and a mixed-precision compare ('…59Z' vs '…59.999Z')
  // wrongly excludes a last-second incident because 'Z' > '.' lexically. A next-day midnight bound
  // is precision-agnostic.
  const monthlySummaries = summariesFromDailyData(Object.values(probeData))
  const nextMonth = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 }
  const monthWindow = {
    startISO: `${period}-01T00:00:00.000Z`,
    endISO: `${nextMonth.y}-${String(nextMonth.m).padStart(2, '0')}-01T00:00:00.000Z`,
  }

  for (const id of allIds) {
    if (!existedInMonth(SERVICE_ADDED_AT[id], monthEnd)) continue
    const scoreSvc = scoreData?.find(s => s.id === id)
    const incSvc = incidentData?.services[id]

    // Snapshot per-incident detail (#375) so the dashboard's 90-day filter can read it
    // post-archive. accumulateMonthlyIncidents already enforces the per-service cap and
    // dedup, so we just defensively-clone the array (avoids accidental mutation downstream).
    const incidentList = incSvc?.incidents && incSvc.incidents.length > 0
      ? incSvc.incidents.map(stripInternalFields)
      : undefined

    // #915 — derive the downtime aggregates from the per-incident FINAL durations (incidentList),
    // NOT the accumulator's `totalMinutes`/`longestMinutes`, which grow monotonically and lock in a
    // long-open incident's inflated open-window duration (never corrected down when it resolves
    // shorter — Deepgram June read 176h42m/141h10m vs the real 45h33m/27h). The per-incident
    // durationMin is updated to the final value, so it's the source of truth; the accumulator is the
    // fallback only when the list was truncated (>MAX cap, no longer full-population).
    const { totalMin, longestMin, countedCount } = aggregateIncidentDurations(
      incidentList, incSvc?.count ?? 0, incSvc?.totalMinutes ?? 0, incSvc?.longestMinutes ?? 0,
    )
    const totalDowntimeMin = totalMin
    const longestIncidentMin = longestMin
    // #1021 — average over the COUNTED (non-advisory) incidents only: a quota advisory excluded from
    // downtime must not sit in the divisor either (it's what pushed Codex's June avg resolution to 11h25m).
    // Truncated detail (countedCount null) falls back to the full count, matching the accumulator numerator.
    const avgDivisor = countedCount ?? (incSvc?.count ?? 0)
    const probeSummary = resolveArchiveProbeSummary(id, monthlySummaries)
    const avgResolutionMin = avgDivisor > 0 && totalMin != null && totalMin > 0
      ? Math.round(totalMin / avgDivisor)
      : null

    services[id] = {
      uptime: uptimeMap[id] ?? null,
      // #586 — the daily-snapshot month-end value (month-accurate, rebuild-safe); a month with no daily
      // snapshot reads null (#1016 — no live/scoreData fallback; that leaked today's uptime into a frozen
      // month on rebuild). #951 — and only when the Score itself consumed an official uptime, so display ≡ score.
      officialUptime: resolveArchiveOfficialUptime(officialUptimeMap[id], scoreSvc),
      // #1006 — carry the provenance so the report can label Official vs Platform from the DATA rather
      // than from a hand-maintained list. Only meaningful when a figure was actually archived.
      ...(resolveArchiveOfficialUptime(officialUptimeMap[id], scoreSvc) != null && scoreSvc?.uptimeSource
        ? { uptimeSource: scoreSvc.uptimeSource }
        : {}),
      score: scoreSvc?.aiwatchScore ?? null,
      grade: scoreSvc?.scoreGrade ?? null,
      ...(scoreSvc?.scoreConfidence ? { scoreConfidence: scoreSvc.scoreConfidence } : {}),
      ...(() => { // #993 — calendar-month Score (window-aligned with the MTTR/downtime aggregates)
        const m = computeMonthlyScore(id, incSvc?.incidents, officialUptimeMap[id] ?? null, monthlySummaries, monthWindow, SERVICES.find((s) => s.id === id))
        return { monthlyScore: m.score, monthlyGrade: m.grade, ...(m.confidence ? { monthlyScoreConfidence: m.confidence } : {}) }
      })(),
      incidents: incSvc?.count ?? 0,
      avgResolutionMin,
      totalDowntimeMin,
      longestIncidentMin,
      avgLatencyMs: latencyMap[id] ?? null,
      p95LatencyMs: latencyStats[id]?.p95 ?? null,
      latencySpikes: latencyStats[id]?.spikes ?? null,
      // #1002 / aiwatch-reports#76 — the p50 + cvCombined monthlyScore's Responsiveness was computed
      // from, off the same `monthlySummaries` computeMonthlyScore reads. Null (not absent) when it
      // scored none, matching how every other later-added measurement here reports "no data"
      // (officialUptime #586, p95LatencyMs #17). See resolveArchiveProbeSummary.
      p50LatencyMs: probeSummary?.p50LatencyMs ?? null,
      cvCombined: probeSummary?.cvCombined ?? null,
      ...(incidentList ? { incidentList } : {}),
      ...(scoreSvc?.incidentSourceStale ? { incidentSourceStale: true } : {}),
      ...(() => { // #605 Phase 2 aggregate + Phase 3 curate to the display set (drops billing/compliance noise)
        const curated = curateComponentUptime(componentUptimeMap[id], SERVICES.find((s) => s.id === id))
        return curated ? { components: curated } : {}
      })(),
      ...(SERVICE_ADDED_AT[id] ? { addedAt: SERVICE_ADDED_AT[id] } : {}), // #809 — report-side coverage gate
    }
  }

  // #827 F3 — AI recovery-prediction accuracy for this month, from the durable incident:history
  // corpus filtered to `period`. Best-effort: a read hiccup must not fail the archive → null.
  const predictionAccuracy = await buildMonthlyAccuracy(kv, period, SERVICES.map(s => s.id))
    .catch((err) => { console.warn(`[monthly-archive] accuracy aggregate failed for ${period}:`, err instanceof Error ? err.message : err); return null })

  const archive: MonthlyArchive = {
    period,
    generatedAt: new Date().toISOString(),
    daysCollected,
    services,
    security,
    degradation,
    predictionAccuracy,
  }

  // AI retrospective narrative (#426). Best-effort — generateMonthlyNarrative
  // never throws (catches internally and returns null), but the extra guard
  // here is defense-in-depth: a narrative-generation hiccup must never lose the
  // deterministic archive. Only attempt when an AI binding or API key is given.
  if (narrativeOpts && (narrativeOpts.ai || narrativeOpts.apiKey)) {
    try {
      archive.narrative = await generateMonthlyNarrative(archive, narrativeOpts)
    } catch (err) {
      console.error(`[monthly-archive] narrative generation threw for ${period}:`, err instanceof Error ? err.message : err)
      archive.narrative = null
    }
  }

  return archive
}

/** Check if we should run monthly archive (1st of month, UTC 00:00-00:14 or catch-up 01:00-01:14) */
export function isInMonthlyArchiveWindow(
  utcDate: number,
  utcHours: number,
  utcMinutes: number,
): { inWindow: boolean; isCatchUp: boolean } {
  if (utcDate !== 1) return { inWindow: false, isCatchUp: false }
  const isNormal = utcHours === 0 && utcMinutes < 15
  const isCatchUp = utcHours === 1 && utcMinutes < 15
  if (!isNormal && !isCatchUp) return { inWindow: false, isCatchUp: false }
  return { inWindow: true, isCatchUp: !isNormal }
}

// ── Archive-ready Discord notification (aiwatch-reports#4) ───────────
//
// The aiwatch-reports `generate-report.yml` workflow is `workflow_dispatch`-only,
// so operators have to remember to click "Run workflow" on the 1st. This hook fires
// a one-shot Discord ping with the workflow URL the moment the monthly archive lands.

export const REPORTS_WORKFLOW_URL =
  'https://github.com/bentleypark/aiwatch-reports/actions/workflows/generate-report.yml'

export function archiveNotifiedKey(period: string): string {
  return `archive:notified:${period}`
}

/**
 * Build the Discord embed for "monthly archive ready — go generate the draft" pings.
 * Pure function for testability; the cron handler owns KV dedup + the send itself.
 *
 * `period` is the YYYY-MM covered by the archive (e.g. `"2026-04"` for April).
 * Invalid periods fall back to the raw string so a malformed call still produces a
 * readable embed rather than `"Invalid Date"`.
 */
export function buildArchiveReadyEmbed(
  period: string,
  serviceCount: number,
  daysCollected: number,
): { title: string; description: string; color: number } {
  let monthLabel = period
  const match = /^(\d{4})-(\d{2})$/.exec(period)
  if (match) {
    const y = Number(match[1])
    const m = Number(match[2])
    if (m >= 1 && m <= 12) {
      monthLabel = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', {
        month: 'long', year: 'numeric', timeZone: 'UTC',
      })
    }
  }
  const description = [
    `**${monthLabel}** archive is now available in KV (\`archive:monthly:${period}\`).`,
    ``,
    `• Services: ${serviceCount}`,
    `• Days collected: ${daysCollected}`,
    ``,
    `🚀 [**Generate report draft →**](${REPORTS_WORKFLOW_URL})`,
    ``,
    `*Click the link, press "Run workflow", enter month \`${period}\`, and a draft PR will open for review.*`,
  ].join('\n')
  return {
    title: `📦 Monthly Archive Ready — ${period}`,
    description,
    color: 0x9B59B6, // purple — consistent with daily summary / monthly ops
  }
}
