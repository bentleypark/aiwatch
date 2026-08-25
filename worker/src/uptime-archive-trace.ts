// #1017 follow-up — the durable trace that the archive RESTORE path actually fired in production.
//
// Why this module exists. #1017's original production check was "look at langsmith's calendar for
// days only the archive could have supplied". On 2026-08-25 that check turned out to be
// unperformable, for two independent reasons:
//
//   1. No service carried `uptimeWindowDays` any more (langsmith's window had widened back), so the
//      gate could not fire for anyone — and there was no second short-window service to substitute.
//   2. langsmith could never have demonstrated it even while short-windowed: every archived day in
//      its gap window was `weightedOutageSec: 0` (it had been clean), and `mergeArchivedDailyImpact`
//      contributes no entry for a clean day. Eligibility alone was never sufficient.
//
// Both facts were invisible after the fact because the restore path leaves no trace: it mutates
// `dailyImpact` in place and the next cycle overwrites the snapshot. A status-page migration is an
// EXTERNAL event on nobody's schedule, so a dated reminder cannot be aimed at it — the remedy is a
// permanent record that whenever the event does happen, the answer is already written down. Same
// It has no TTL and a fail-closed container read, so an unreadable value is a PERMANENT wedge rather
// than a self-clearing one — see `recordRestoreObservations` for why that is the right way round.
//
// KNOWN LIMITATION: absence is not evidence. A key appears only for a service that passed
// `isArchiveRestoreEligible`, which needs BOTH a disclosed `uptimeWindowDays` and a calendar wider
// than it — so a service can lose its history and still leave no key.
//
// The record deliberately separates ELIGIBLE from RESTORED, because that is exactly the distinction
// whose absence forced the 2026-08-25 investigation.

/** No TTL — see kv-schema.md. A migration may be a year away, and the value has to still be there. */
export const ARCHIVE_RESTORE_TRACE_KEY = 'uptime-archive:restored'

export interface ArchiveRestoreRecord {
  /** First cycle this service passed `isArchiveRestoreEligible`. Set once. */
  firstEligibleAt: string
  /** First cycle a merge actually added at least one day. `null` = eligible but nothing to restore
   *  (langsmith's real state for weeks), which is a DIFFERENT fact from never being eligible — the
   *  latter has no record here at all. */
  firstRestoredAt: string | null
  /** UTC `YYYY-MM-DD` of the most recent cycle in which this service was eligible, restoring or not.
   *  Without it a record reaches a fixed point after its first cycle, and "eligible once, then the
   *  window widened" is indistinguishable from "eligible every day for a year" — the motivating
   *  service's exact state. It is also what makes a stalled instrument self-evident: a date stuck in
   *  the past while the service is eligible today says the trace is no longer being written. */
  lastObservedDate: string

  /** UTC `YYYY-MM-DD` of the most recent cycle whose restore THREW, or `null`.
   *  Without it, "eligible, the archive had nothing" and "eligible, the restore path is broken" are
   *  byte-identical records (`firstRestoredAt: null, maxDaysRestored: 0`) — and those carry opposite
   *  diagnoses. The console line that would otherwise distinguish them expires in days, against a key
   *  whose whole purpose is being read a year later. */
  lastRestoreErrorDate: string | null

  /** UTC `YYYY-MM-DD` of the most recent restoring cycle. Day-granular ON PURPOSE: a full timestamp
   *  would differ every cycle and force a KV write every ~10 minutes for as long as a service stays
   *  short-windowed (~4k writes/month for a single one). */
  lastRestoredDate: string | null
  /** High-water mark of days filled in a single cycle. A gap shrinks as the live window catches up,
   *  so the latest count understates what the path achieved; the maximum is the honest figure. */
  maxDaysRestored: number
  /** The NARROWEST window observed while eligible — a low-water mark, not the latest value.
   *
   *  Last-write-wins would defeat the field's whole purpose: after a migration the window WIDENS
   *  daily (incident.io reports `days: Math.floor(covered)`, Statuspage `trailing.length`), and
   *  eligibility only ends at `>= calendarDays` — so the final stored value would always be
   *  `calendarDays - 1`, the widest and least informative window the service ever had. The low-water
   *  mark keeps what a later reader actually needs: how short the history got. Monotone, so it also
   *  cannot churn the write bound. */
  uptimeWindowDays: number
}

export type ArchiveRestoreTrace = Record<string, ArchiveRestoreRecord>

/** One service's outcome for one cycle. Only ELIGIBLE services produce one — a service that never
 *  passed the gate must leave no key behind, so that "absent" keeps meaning "never eligible". */
export interface RestoreObservation {
  serviceId: string
  uptimeWindowDays: number
  /** Days the merge actually added. `0` = eligible but nothing was added — which is why `failed`
   *  has to be carried separately; the count alone cannot say why. */
  daysRestored: number
  /** True when `restoreArchivedCalendar` threw for this service this cycle. */
  failed: boolean
}

/** Pure. Folds this cycle's observations into the stored trace.
 *
 *  Returns `null` when nothing changed — the caller MUST skip the write on `null`. That is what keeps
 *  the write count bounded: in steady state (a service stays eligible, restoring the same days) every
 *  field is already at its final value and no write is issued. */
/** Coercion, not validation. A stored field of the wrong type is treated as absent and rebuilt from
 *  this cycle's truth, so one corrupt record self-heals for its own service instead of freezing the
 *  whole key for every service. Validating instead — rejecting the read and refusing to write — was
 *  tried and is worse: the blast radius of one bad record became the entire permanent key, the frozen
 *  value still LOOKED healthy to a human reading it, and any non-additive schema change (including a
 *  required field added by this repo's own next commit) wedged the key on its own deploy.
 *  #1256's rule is preserved where it actually applies — the CONTAINER level, below, where nothing
 *  could be salvaged. A single unreadable field carries no information worth protecting. */
const asString = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const asFinite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export function foldRestoreObservations(
  prev: ArchiveRestoreTrace,
  observations: RestoreObservation[],
  nowISO: string,
): ArchiveRestoreTrace | null {
  const today = nowISO.slice(0, 10)
  const next: ArchiveRestoreTrace = { ...prev }
  let changed = false

  for (const o of observations) {
    // Read from `next`, not `prev`: two observations for the same service in one batch must
    // accumulate rather than the later one discarding the earlier one's high-water mark. Unreachable
    // today (service ids are unique in SERVICES) but the parameter is an array, so uniqueness would
    // otherwise be an unstated precondition.
    const cur = next[o.serviceId]
    const restoredNow = o.daysRestored > 0
    const record: ArchiveRestoreRecord = {
      // Spread first so a field written by a NEWER worker survives an older one folding onto it.
      // Without this, a deploy->rollback silently deletes that field from a permanent, no-recovery key.
      ...cur,
      firstEligibleAt: asString(cur?.firstEligibleAt) ?? nowISO,
      firstRestoredAt: asString(cur?.firstRestoredAt) ?? (restoredNow ? nowISO : null),
      lastObservedDate: today,
      lastRestoredDate: restoredNow ? today : asString(cur?.lastRestoredDate),
      lastRestoreErrorDate: o.failed ? today : asString(cur?.lastRestoreErrorDate),
      maxDaysRestored: Math.max(asFinite(cur?.maxDaysRestored) ?? 0, o.daysRestored),
      uptimeWindowDays: Math.min(asFinite(cur?.uptimeWindowDays) ?? Infinity, o.uptimeWindowDays),
    }
    if (JSON.stringify(prev[o.serviceId]) !== JSON.stringify(record)) {
      next[o.serviceId] = record
      changed = true
    }
  }

  return changed ? next : null
}

/** Read-modify-write the trace, FAIL-CLOSED on an unreadable prior value.
 *
 *  This rewrites the whole value, which is the shape that destroyed data in #1256. That issue's own
 *  correction is the thing to copy, not its original framing: replaying the defect showed FOUR stored
 *  states reached the destructive write — a `kv.get()` throw, `{}`, `{"snapshots":null}` and `''` —
 *  and *three of them parse successfully*, so "unparseable is the danger" was wrong. Parseability is
 *  not the test, and neither is the container's type. Exactly one case may start from `{}`:
 *
 *    - `raw === null` — the key genuinely does not exist. A SUCCESSFUL read of nothing, and the only
 *      way a first record ever lands. NOTE the strict `=== null`: `!raw` would also swallow a
 *      zero-byte value, which is the #1256 `''` input and must fail closed instead.
 *
 *  Everything else keeps whatever is stored and skips the write: a throw, a non-plain-object, an
 *  EMPTY object (`foldRestoreObservations` returns `null` when nothing changed, so a legitimate write
 *  is never empty — `{}` can only be corruption or a hand-edit),.
 *
 *  The cost of that strictness is a PERMANENT wedge: a value that stays unreadable stalls every future
 *  write until an operator intervenes. That is the right way round for a key with no TTL and no second
 *  chance — keeping a possibly-intact history beats resetting it — but it means the error lines below
 *  have to say WHICH situation occurred, because a wedge and a failed write have opposite remedies.
 *
 *  Never throws: an instrumentation failure must not break the cache-write cycle it rides on. */
export async function recordRestoreObservations(
  kv: KVNamespace,
  observations: RestoreObservation[],
  nowISO: string,
): Promise<void> {
  // The common path — nothing eligible — costs neither a read nor a write.
  if (observations.length === 0) return

  /** Every unreadable-prior-value path shares this: the remedy is a by-hand delete, and until then
   *  nothing is recorded. Naming that explicitly is the point — an operator on `wrangler tail` must be
   *  able to tell this (permanently wedged, needs intervention) from a failed `kv.put` (transient,
   *  self-heals next cycle). */
  const wedged = (detail: string, payload: string) => console.error(
    `[uptime-archive] ${ARCHIVE_RESTORE_TRACE_KEY} is WEDGED — ${detail}. Refusing to overwrite it; no restore will be recorded until an operator CAPTURES it (wrangler kv key get) and then deletes it: wrangler kv key delete "${ARCHIVE_RESTORE_TRACE_KEY}" --config worker/wrangler.toml --binding STATUS_CACHE --remote`,
    payload.slice(0, 500),
  )

  let prev: ArchiveRestoreTrace
  try {
    const raw = await kv.get(ARCHIVE_RESTORE_TRACE_KEY)
    if (raw === null) {
      // The ONLY start-from-empty case. Strict `=== null`, never `!raw` — see the doc above.
      prev = {}
    } else {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        wedged(`stored value parsed to ${Array.isArray(parsed) ? 'an array' : parsed === null ? 'null' : typeof parsed}, not an object`, raw)
        return
      }
      if (Object.keys(parsed).length === 0) {
        wedged('stored value is an empty object, which no legitimate write produces', raw)
        return
      }
      prev = parsed as ArchiveRestoreTrace
    }
  } catch (err) {
    wedged(`read/parse failed: ${err instanceof Error ? err.message : String(err)}`, '<unreadable>')
    return
  }

  const next = foldRestoreObservations(prev, observations, nowISO)
  if (!next) return

  try {
    await kv.put(ARCHIVE_RESTORE_TRACE_KEY, JSON.stringify(next))
  } catch (err) {
    // Transient, unlike every path above: the fold recomputes from scratch next cycle and self-heals.
    // Worded so an operator can tell it apart from a wedge at a glance.
    console.error(
      `[uptime-archive] ${ARCHIVE_RESTORE_TRACE_KEY} write failed (transient — the next cycle retries):`,
      err instanceof Error ? err.message : err,
    )
  }
}
