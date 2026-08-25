// #1017 — reconstruct a lost pre-migration calendar window from the durable per-day archive
// (`daily:{date}` / `history:{date}`'s `weightedOutageSec`, folded in by index.ts's `cacheWrite`,
// see DailyCounters). A provider status-page migration resets the LIVE source's per-day records
// (#1004) — `ServiceStatus.uptimeWindowDays` is the disclosed signal that happened. This module
// fills the resulting calendar gap from
// AIWatch's own archive instead of leaving it silently blank, gated so the extra KV reads are paid
// ONLY by a service actually flagged short — never on the common path.

import type { DailyImpactLevel } from './types'

/** Approximate severity from a day's total weighted outage seconds (0.3/1.0-weighted per
 *  impact-weights.ts). NOT a reconstruction of the original incident's severity/duration — that
 *  detail doesn't survive being folded into one number — just "roughly how bad was this day",
 *  which is strictly better than the blank cell the day would otherwise render as. Thresholds are
 *  fractions of a day: 4h+ weighted seconds reads as critical, 30min+ as major, any positive amount
 *  as minor (mirrors the minor/major/critical vocabulary every live source already produces). */
export const ARCHIVE_CRITICAL_THRESHOLD_SEC = 4 * 3600
export const ARCHIVE_MAJOR_THRESHOLD_SEC = 30 * 60

/** Pure. `null` for a non-positive value (a clean day — omitted from dailyImpact, matching how live
 *  sources only add entries for affected days). */
export function classifyArchivedDay(weightedOutageSec: number): DailyImpactLevel | null {
  if (!(weightedOutageSec > 0)) return null
  if (weightedOutageSec >= ARCHIVE_CRITICAL_THRESHOLD_SEC) return 'critical'
  if (weightedOutageSec >= ARCHIVE_MAJOR_THRESHOLD_SEC) return 'major'
  return 'minor'
}

/** Every UTC date string (`YYYY-MM-DD`) in the gap the live source can't see: `today − calendarDays`
 *  (exclusive — that day and everything older is outside the calendar entirely) up to and INCLUDING
 *  `today − uptimeWindowDays` (the oldest day the live window covers is where the gap ends; the live
 *  window already has everything more recent than that, down to today). Pure. Empty when the window
 *  isn't actually narrower than the calendar (caller should gate on this before reading the archive
 *  at all). Options object (not positional) for the same reason as `RestoreArchivedCalendarArgs` below
 *  — `calendarDays`/`uptimeWindowDays` are adjacent same-typed numbers a positional signature wouldn't
 *  protect against swapping. */
export interface ArchiveGapDatesArgs {
  todayISO: string
  calendarDays: number
  uptimeWindowDays: number
}

export function archiveGapDates({ todayISO, calendarDays, uptimeWindowDays }: ArchiveGapDatesArgs): string[] {
  const dates: string[] = []
  for (let i = uptimeWindowDays; i < calendarDays; i++) {
    const d = new Date(`${todayISO}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() - i)
    dates.push(d.toISOString().split('T')[0])
  }
  return dates
}

/** True when `dailyImpact` already has an entry that covers `dateStr` (`YYYY-MM-DD`). Checks BOTH
 *  key forms this codebase's dailyImpact maps use (#693 follow-up, see ServiceStatus.dailyImpact):
 *  a bare date (Statuspage/Better Stack) matches exactly; a full ISO timestamp (incident.io) matches
 *  by prefix. Without the prefix check, an incident.io service's live coverage would look empty to
 *  this function even when it genuinely covers `dateStr`, and the archive would then incorrectly
 *  "restore" a day the live source already has — silently overwriting fresher data with stale. */
export function dailyImpactHasDate(dailyImpact: Record<string, DailyImpactLevel> | undefined, dateStr: string): boolean {
  if (!dailyImpact) return false
  return Object.keys(dailyImpact).some((k) => k === dateStr || k.startsWith(dateStr))
}

/** Pure merge: `archived` (dateStr → weightedOutageSec, from a `history:{date}` read) folded into
 *  `liveDailyImpact`, but ONLY for dates the live map doesn't already cover — live data for a day it
 *  DOES have always wins, this never overwrites. A day whose archived seconds classify to nothing
 *  (0 / cleanly operational) contributes no entry, same as every live source. */
export function mergeArchivedDailyImpact(
  liveDailyImpact: Record<string, DailyImpactLevel> | undefined,
  archived: Record<string, number>,
): Record<string, DailyImpactLevel> {
  const merged: Record<string, DailyImpactLevel> = { ...liveDailyImpact }
  for (const [dateStr, sec] of Object.entries(archived)) {
    if (dailyImpactHasDate(liveDailyImpact, dateStr)) continue
    const level = classifyArchivedDay(sec)
    if (level) merged[dateStr] = level
  }
  return merged
}

/** Read the archive for exactly the given dates (bounded — callers pass `archiveGapDates`'s output,
 *  at most `calendarDays` reads, only for a service already flagged short). Best-effort PER DAY: one
 *  day's read/parse failure is skipped, not fatal to the rest — consistent with #1017's "an archive
 *  problem never blocks serving" discipline. A day with no entry for `serviceId`, or a non-positive
 *  value, is simply absent from the result (not an error). */
export async function readArchivedWeightedOutageSec(
  kv: KVNamespace,
  serviceId: string,
  dates: string[],
): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  await Promise.all(dates.map(async (date) => {
    try {
      const raw = await kv.get(`history:${date}`)
      if (!raw) return
      const parsed = JSON.parse(raw) as Record<string, { weightedOutageSec?: number | null } | undefined>
      const sec = parsed[serviceId]?.weightedOutageSec
      if (typeof sec === 'number' && sec > 0) out[date] = sec
    } catch (err) {
      console.warn(`[uptime-archive] history:${date} read/parse failed for ${serviceId}:`, err instanceof Error ? err.message : err)
    }
  }))
  return out
}

/**
 * The orchestrator: for a service whose live window looks incomplete, fill the calendar gap from
 * the durable archive. Returns `liveDailyImpact` UNCHANGED (by reference — callers can `!==`-check
 * to skip a no-op write) when `uptimeWindowDays` is absent (the normal case — never pays the read
 * cost) or isn't actually narrower than `calendarDays`, or when the archive had nothing to add.
 *
 * NOT wired into the event-driven edge refreshes (`cache-refresh.ts`'s on-status-change /
 * on-live-edge paths, #488/#1057) — only the throttled `cacheWrite` cycle calls this. An edge
 * refresh can therefore briefly re-serve a service's live-only (gap still blank) dailyImpact until
 * the next throttled cycle re-applies the restore; acceptable since edge refreshes exist for
 * immediate STATUS visibility, not calendar completeness, and the throttle window is short (~10min).
 */
/** The ONE eligibility gate: is this service's live window actually narrower than the calendar we
 *  render, i.e. is there a gap only the archive can fill? A window at or wider than the calendar
 *  leaves nothing to restore.
 *
 *  ABSENT does NOT mean "full window" — only the Statuspage and incident.io paths emit
 *  `uptimeWindowDays` at all, so an Instatus / OnlineOrNot / Flashduty service publishes a short
 *  history silently and is never eligible here. That is a real coverage limit of this gate, not an
 *  all-clear.
 *
 *  Exported because `restoreArchivedCalendars` (index.ts) needs the SAME verdict to decide whether to
 *  record a trace observation (#1017 follow-up). Two copies of this predicate would drift the moment
 *  the gate changes, and the trace's whole purpose is saying whether the gate fired — a trace computed
 *  from a stale second copy would answer about a gate that no longer exists.
 *
 *  Returns a TYPE PREDICATE, not a bare `boolean`: both call sites rely on it to narrow
 *  `uptimeWindowDays` to `number`. Simplifying the return type to `boolean` looks like a free cleanup
 *  and breaks them. */
export function isArchiveRestoreEligible(
  calendarDays: number,
  uptimeWindowDays: number | undefined,
): uptimeWindowDays is number {
  return uptimeWindowDays != null && uptimeWindowDays < calendarDays
}

export interface RestoreArchivedCalendarArgs {
  serviceId: string
  liveDailyImpact: Record<string, DailyImpactLevel> | undefined
  calendarDays: number
  uptimeWindowDays: number | undefined
  todayISO: string
}

/** #1017 review — `serviceId`/`todayISO` are both plain `string`, and `calendarDays`/`uptimeWindowDays`
 *  are both plain `number`; as positional arguments nothing stops a future call site from swapping
 *  either same-typed pair (e.g. `calendarDays`/`uptimeWindowDays`) with no compile error. Named via
 *  this options object instead — TypeScript now rejects that swap (each value must land under its own
 *  key) even though the underlying values stay the same narrow primitives `restoreArchivedCalendar`
 *  deliberately takes (not the full `ServiceStatus`, which would over-couple this module to a shape it
 *  only needs 4 fields of). */
export async function restoreArchivedCalendar(
  kv: KVNamespace,
  { serviceId, liveDailyImpact, calendarDays, uptimeWindowDays, todayISO }: RestoreArchivedCalendarArgs,
): Promise<Record<string, DailyImpactLevel> | undefined> {
  if (!isArchiveRestoreEligible(calendarDays, uptimeWindowDays)) return liveDailyImpact
  const gapDates = archiveGapDates({ todayISO, calendarDays, uptimeWindowDays })
  if (gapDates.length === 0) return liveDailyImpact
  const archived = await readArchivedWeightedOutageSec(kv, serviceId, gapDates)
  if (Object.keys(archived).length === 0) return liveDailyImpact
  return mergeArchivedDailyImpact(liveDailyImpact, archived)
}
