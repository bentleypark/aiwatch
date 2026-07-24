// #1106 Part 5 — the durable record that a withdrawal HAPPENED.
//
// Every other trace of a withdrawal is short-lived by design: the `incidents:withdrawn` tombstone
// roster is 6d, `alerted:wd:{incId}` is 7d, `alert:feed:recent` is 2h, and Workers Logs are ~3d on
// the free plan. The accumulator row is gone by definition — its prune is what starts all of this —
// so `archive:monthly:{month}` is structurally missing the incident too. Past a week, nothing in KV
// can answer "did the ⚪ path ever fire, how often, and did the thread actually close?".
//
// That matters because #1106's own exit condition is a PRODUCTION OBSERVATION, and one we cannot
// schedule: it needs a provider to delete an announced incident. A `verify-after` date would fire on
// an absence and prove nothing, and a Tier-A `assert:` had nothing to read. With no durable record,
// the honest answer months later is "we don't know" — so the instrumentation IS the deliverable.
//
// Deliberately NOT WAE: withdrawals are single digits per MONTH, not traffic-proportional, and the
// question asked of them is "show me the rows", not "aggregate a rate" (#518/#548's split). One
// month-keyed KV value, upserted only when an entry's OUTCOME changes, keeps the write budget in the
// noise. The shape mirrors `growth-series.ts` (#986): a volatile signal promoted to a durable series.
//
// Two write points, and only two:
//   1. the prune (`accumulateIncidentsOnlyIfChanged`) records the row with `announcedAt` ABSENT;
//   2. the cron's `alerted:wd:` dedup write stamps `announcedAt`.
// A row still missing `announcedAt` once its send deadline has passed is therefore a thread that
// was opened and never closed — the #1106 failure recurring — and it is DERIVED, not separately
// wired. Holds are not rows on purpose: `withdrawalHold` re-evaluates every 5 minutes, so a held
// notice is a STATE, not an event, and one row per evaluation would turn a bounded log into a
// per-cycle write. A hold that never clears simply leaves the row un-announced, which is the fact
// worth keeping; the reason is in the cron log line for as long as logs live.

import { WITHDRAWN_TTL_S, type WithdrawnIncident } from './withdrawn'
// ALERTED_NEW_TTL_S only — the second of the two clocks that bound a sendable notice. No cycle:
// alerts.ts imports withdrawn.ts, not this module.
import { ALERTED_NEW_TTL_S } from './alerts'
import { kvPut } from './utils'
import type { KVLike } from './utils'

/** One provider-withdrawn incident, and whether its closing notice actually went out. */
export interface WithdrawalLogEntry {
  svcId: string
  incId: string
  title: string
  /** ISO — the incident's own start, as the provider last published it. */
  startedAt: string
  /** ISO — when the prune removed the accumulator row, i.e. when AIWatch learned of the withdrawal. */
  prunedAt: string
  /** ISO — when the ⚪ notice was accepted by the OPERATOR Discord webhook. Absent means it was not:
   *  either still held / never announced, or (once its send deadline has passed)
   *  permanently so.
   *
   *  Scoped to the operator send on purpose, because that is the only dispatch whose result is known
   *  at the stamp point. The #486 per-user relay and the `alert:feed` projection are built from the
   *  same alert but fan out AFTER the send loop, so a row can read un-announced while subscribers
   *  did receive the notice. The error direction is the safe one — it over-reports a failure, loudly
   *  — but it means `neverClosed` is "no operator notice went out", not "nobody was told". */
  announcedAt?: string
}

/** Month-keyed so the value stays small and a month can be read without scanning the others.
 *  Written with NO expirationTtl — this is the durable half of the feature; the whole point is that
 *  it outlives every other trace. A month of withdrawals is a few hundred bytes. */
export function withdrawalLogKey(month: string): string {
  return `incidents:withdrawn:log:${month}`
}

/** `YYYY-MM` from an ISO timestamp, or `null` when it is not parseable as one. Sliced rather than
 *  taken from `Date`, so the month is the one written in the string and not a local-timezone
 *  re-derivation of it; the parse is only there to reject garbage. */
export function monthOfIso(iso: string): string | null {
  if (typeof iso !== 'string' || Number.isNaN(Date.parse(iso))) return null
  const m = iso.slice(0, 7)
  return /^\d{4}-\d{2}$/.test(m) ? m : null
}

/** `[month, month-1, …]` for `count` months ending at `from` (UTC). The read surface needs it because
 *  the log is month-keyed with no index: the question it exists to answer — "did the ⚪ path EVER
 *  fire?" — is not a single-month question, and a caller who checks only the current month gets
 *  `count: 0`, indistinguishable from "nothing ever happened". */
export function monthsBackFrom(from: string, count: number): string[] {
  const start = monthOfIso(from)
  if (!start) return []
  const [y, m] = start.split('-').map(Number)
  const out: string[] = []
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1))
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`)
  }
  return out
}

/** Response/value-size guard. A withdrawal is rare (single digits per month), so this only bounds a
 *  pathological provider that mass-deletes its incident history — the same posture as the tombstone
 *  roster's own cap. Oldest rows are evicted first. */
export const WITHDRAWAL_LOG_MAX = 200

/** Is this a row we wrote? A durable value outlives any number of deploys, so a shape change leaves
 *  the OLD shape readable forever — unlike the 6d tombstone roster, this one never ages out of the
 *  problem. A malformed element is dropped rather than allowed to reach a consumer half-built. */
function isLogEntry(v: unknown): v is WithdrawalLogEntry {
  if (!v || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  const required = (['svcId', 'incId', 'title', 'startedAt', 'prunedAt'] as const)
    .every((k) => typeof r[k] === 'string' && r[k] !== '')
  if (!required) return false
  return r.announcedAt === undefined || (typeof r.announcedAt === 'string' && r.announcedAt !== '')
}

/**
 * Merge freshly-pruned tombstones into a month's rows. FIRST write wins per `(svcId, incId)`.
 *
 * First-write-wins is what makes the prune's call idempotent, and it is not merely tidy: a re-prune
 * (or a second accumulator pass over the same cycle) would otherwise move `prunedAt` forward, and
 * `prunedAt` is the clock the "never closed" reading is derived from — a moving one would keep
 * resetting the roster window and make a permanently-lost notice look perpetually pending. It also
 * protects an already-stamped `announcedAt` from being erased by a later prune of the same id.
 */
export function upsertPrunedRows(
  existing: WithdrawalLogEntry[],
  fresh: WithdrawnIncident[],
): WithdrawalLogEntry[] {
  const seen = new Set(existing.map((e) => `${e.svcId}:${e.incId}`))
  const merged = [...existing]
  for (const w of fresh) {
    const key = `${w.svcId}:${w.incId}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push({ svcId: w.svcId, incId: w.incId, title: w.title, startedAt: w.startedAt, prunedAt: w.prunedAt })
  }
  if (merged.length > WITHDRAWAL_LOG_MAX) {
    // Name what is being erased, and single out the rows that were never announced: those are
    // never-closed threads, the one fact this module exists to preserve, and eviction is their
    // permanent deletion from the only durable record. `console.error`, not `warn` — the cap only
    // trips on the pathological mass-deletion it was added for, i.e. exactly when the rows matter.
    const evicted = merged.slice(0, merged.length - WITHDRAWAL_LOG_MAX)
    const open = evicted.filter((e) => !e.announcedAt).length
    console.error(
      `[withdrawal-log] month over ${WITHDRAWAL_LOG_MAX} rows — evicting ${evicted.length} oldest (${open} never announced, permanently lost):`,
      evicted.map((e) => `${e.svcId}/${e.incId}${e.announcedAt ? '' : ' (open)'}`).join(', '),
    )
  }
  return merged.slice(-WITHDRAWAL_LOG_MAX)
}

/**
 * Stamp `announcedAt` on the rows whose incident id just had its ⚪ notice dispatched.
 *
 * Also first-write-wins: the notice is sent once per id (the `alerted:wd:` key is the dedup), but a
 * lost dedup write re-sends it every cycle for as long as the tombstone lives, and the useful fact
 * is WHEN THE THREAD CLOSED, not when we last repeated ourselves.
 *
 * Returns `changed` so the caller can skip the KV write in the overwhelmingly common case where this
 * month holds no row for the id (the row lives in the PREVIOUS month, or predates this feature).
 */
export function markRowsAnnounced(
  rows: WithdrawalLogEntry[],
  incIds: ReadonlySet<string>,
  at: string,
): { rows: WithdrawalLogEntry[]; changed: boolean; stamped: string[]; matched: string[] } {
  const stamped: string[] = []
  const matched: string[] = []
  const out = rows.map((r) => {
    if (!incIds.has(r.incId)) return r
    // MATCHED covers "a row for this id exists here", stamped or not. The two must not be conflated:
    // a re-fired notice (a lost `alerted:wd:` write, or a dedup read that errored) finds the row
    // ALREADY stamped, which is the system working — reading that as "no row was stamped" would make
    // the caller's under-report alarm fire on the healthy path, and an alarm that fires on the normal
    // case is a dead alarm.
    matched.push(r.incId)
    if (r.announcedAt) return r
    stamped.push(r.incId)
    return { ...r, announcedAt: at }
  })
  const changed = stamped.length > 0
  // `stamped` (not the caller's whole `incIds`) is what a failure log must name: with a multi-surface
  // provider or two concurrent withdrawals, the other ids live in the other month and were stamped
  // fine, and naming them sends whoever reads the line hunting a corruption that is not there.
  return { rows: changed ? out : rows, changed, stamped, matched }
}

/** How long after `prunedAt` the tombstone this row renders from ages out of `incidents:withdrawn`.
 *  DERIVED from that roster's own TTL rather than restated, so the two can never drift. It is only
 *  ONE of the two clocks that bound the notice — see `isPermanentlyUnclosed`. */
export const WITHDRAWN_LOG_UNCLOSED_AFTER_MS = WITHDRAWN_TTL_S * 1000

/** Was this row's 🔴 thread left permanently open? The verdict #1106 exists to make answerable — and
 *  the reason it is computed on READ rather than stored: it is a function of elapsed time, so a
 *  stored flag would need a writer to come back and flip it, which is exactly the extra wiring this
 *  design avoids.
 *
 *  Two independent clocks can each make the notice unsendable, so the deadline is the EARLIER of them
 *  (#1153 review): the tombstone ages out at `prunedAt + WITHDRAWN_LOG_UNCLOSED_AFTER_MS`, and the
 *  `alerted:new:{incId}` marker `buildWithdrawalAlerts` gates on expires at
 *  `startedAt + ALERTED_NEW_TTL_S` — after which the alert build skips the tombstone even while it
 *  still exists. When a provider withdraws well after the incident started, the marker binds first, so
 *  keying the verdict off `prunedAt` alone would report a row that is ALREADY lost as `pending` for up
 *  to a day — the exact under-reporting #1153 widened the roster and thereby exposed. */
export function isPermanentlyUnclosed(row: WithdrawalLogEntry, nowMs: number): boolean {
  if (row.announcedAt) return false
  const pruned = Date.parse(row.prunedAt)
  const started = Date.parse(row.startedAt)
  // An unparseable `prunedAt` cannot be aged. Do NOT claim a permanent loss from it — the row is
  // reported as pending and its malformed timestamp is visible in the row itself.
  if (Number.isNaN(pruned)) return false
  const rosterDeadline = pruned + WITHDRAWN_LOG_UNCLOSED_AFTER_MS
  // A malformed `startedAt` just drops the marker clock (its absence can only push the deadline
  // LATER, i.e. toward reporting pending — the safe direction, matching the prunedAt guard above).
  const deadline = Number.isNaN(started)
    ? rosterDeadline
    : Math.min(rosterDeadline, started + ALERTED_NEW_TTL_S * 1000)
  return nowMs > deadline
}

/**
 * Read one month's rows.
 *
 * `readable` is the load-bearing part. Unlike the tombstone roster — where an empty read only ever
 * costs a notification — an empty read HERE is a REPORTING answer, and `[]` would read as "no
 * provider ever withdrew an incident", the exact false negative this module exists to remove. Every
 * caller must consume the flag: both writers refuse to write on `false` (an empty start would
 * republish the month and erase its history), and the admin endpoint 502s rather than answering zero.
 *
 * `droppedMalformed` is the same distinction one level down. A partially-eaten value is still
 * `readable: true`, so without it a month that lost half its rows would answer 200 with a confident,
 * silently reduced count.
 *
 * **An unreadable month is a PERMANENT state, not a transient one.** Because every writer refuses to
 * start from `[]`, a corrupt value is never repaired by the next write: that month stops recording
 * for good, and the only escape is repairing or deleting the KV value by hand. That is the deliberate
 * trade (freezing a month beats silently truncating it), but it is a trade an operator has to be told
 * about — hence the log lines below carry the raw value, and the endpoint says so in its 502.
 */
export async function readWithdrawalLog(
  kv: KVLike | KVNamespace,
  month: string,
): Promise<{ rows: WithdrawalLogEntry[]; readable: boolean; droppedMalformed: number }> {
  const unreadable = { rows: [], readable: false, droppedMalformed: 0 }
  let raw: string | null
  try {
    raw = await kv.get(withdrawalLogKey(month))
  } catch (err) {
    console.error('[withdrawal-log] read failed:', month, err instanceof Error ? err.message : String(err))
    return unreadable
  }
  if (!raw) return { rows: [], readable: true, droppedMalformed: 0 }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Log the value: nothing will repair this month automatically (every writer aborts on an
    // unreadable read), so this line is the only reconstructible trace of what it held.
    console.error('[withdrawal-log] value is CORRUPT — this month is frozen (no writer will overwrite it); repair or delete the key by hand to resume recording:', month, raw.slice(0, 300))
    return unreadable
  }
  if (!Array.isArray(parsed)) {
    // Valid JSON of the wrong shape — a `{rows:[…]}` migration, a rollback, a hand-edit. Same class
    // and same frozen consequence as the branch above, so it gets the same treatment; leaving it
    // silent (as the 6d roster can afford to) would make the freeze undiagnosable.
    console.error('[withdrawal-log] value is not an array — this month is frozen; repair or delete the key by hand:', month, raw.slice(0, 300))
    return unreadable
  }
  const valid = parsed.filter(isLogEntry)
  const droppedMalformed = parsed.length - valid.length
  if (droppedMalformed > 0) {
    // NOT just a count, and NOT a `warn`. The next `recordWithdrawalsPruned` writes the filtered
    // array back, permanently deleting these rows from the only durable record — so unlike the 6d
    // roster this borrows from, the drop is destructive and this is the last chance to reconstruct it.
    console.error(
      `[withdrawal-log] dropping ${droppedMalformed} malformed row(s) in ${month} (shape drift across a rollback?) — the next write erases them permanently:`,
      JSON.stringify(parsed.filter((p) => !isLogEntry(p))).slice(0, 500),
    )
  }
  return { rows: valid, readable: true, droppedMalformed }
}

/**
 * Write point 1 — record freshly-pruned incidents, un-announced.
 *
 * Best-effort in both directions: a read failure ABORTS this month's write rather than starting from
 * `[]`, because an empty start would overwrite the month's accumulated history on a single transient
 * blip (the same reasoning `accumulateIncidentsOnlyIfChanged` applies to its own read). A write
 * failure only costs the record, never the accumulation this rides on.
 *
 * Grouped by the month of each tombstone's own `prunedAt`, not by "now": a prune late on the last day
 * of a month must land in that month, and a caller re-recording an older tombstone must not smear it
 * into the current one.
 */
export async function recordWithdrawalsPruned(
  kv: KVLike | KVNamespace,
  tombstones: WithdrawnIncident[],
): Promise<void> {
  const byMonth = new Map<string, WithdrawnIncident[]>()
  for (const w of tombstones) {
    const month = monthOfIso(w.prunedAt)
    if (!month) {
      console.warn('[withdrawal-log] tombstone has an unusable prunedAt — not recorded:', `${w.svcId}/${w.incId}`, JSON.stringify(w.prunedAt))
      continue
    }
    const list = byMonth.get(month)
    if (list) list.push(w)
    else byMonth.set(month, [w])
  }
  for (const [month, fresh] of byMonth) {
    const { rows, readable } = await readWithdrawalLog(kv, month)
    if (!readable) {
      // Name the tombstones, not just the month: this is the LAST moment their identities exist
      // outside the 6d roster. The accumulator row is already pruned, so `diffPrunedIncidents` can
      // never re-derive them on a later cycle — `existing` will no longer contain the id.
      console.error(
        '[withdrawal-log] skipping write — the existing value could not be read, and an empty start would erase the month:',
        month, fresh.map((w) => `${w.svcId}/${w.incId}`).join(', '),
      )
      continue // per-month, NOT return: an unreadable June must not stop July from being written
    }
    // Skip the write when every id is already recorded. Compared by IDENTITY, not by length: the cap
    // can evict as many rows as it adds, so equal lengths do not mean equal contents.
    const known = new Set(rows.map((r) => `${r.svcId}:${r.incId}`))
    if (fresh.every((w) => known.has(`${w.svcId}:${w.incId}`))) continue
    const merged = upsertPrunedRows(rows, fresh)
    const ok = await kvPut(kv, withdrawalLogKey(month), JSON.stringify(merged))
    if (!ok) console.error('[withdrawal-log] write FAILED — these withdrawals leave no durable record:', fresh.map((w) => `${w.svcId}/${w.incId}`).join(', '))
  }
}

/**
 * Write point 2 — stamp the rows whose ⚪ notice was just dispatched.
 *
 * Checks the CURRENT month and the PREVIOUS one. A tombstone lives 6d, so an incident pruned on the
 * last day of a month can legitimately have its notice sent in the next one, and looking only at the
 * current month would leave that row permanently reading "never closed" — the exact false positive
 * this log exists to make trustworthy. Two months is sufficient: 6d cannot cross two month boundaries
 * (the shortest month is 28 days), so a tombstone never reaches a third month.
 *
 * There is exactly ONE attempt to stamp any given id, ever: the cron's dedup loop skips an alert once
 * `alerted:wd:{incId}` exists, and the tombstone it renders from dies at 6d. So every way this can
 * fail to stamp is PERMANENT, and each one leaves the row asserting `neverClosed` for a notice that
 * did go out — the only place in the module whose failure direction is "claim something false"
 * rather than "stay silent". That is why every branch below is logged with identity.
 */
export async function markWithdrawalsAnnounced(
  kv: KVLike | KVNamespace,
  incIds: ReadonlySet<string>,
  now: Date,
): Promise<void> {
  if (incIds.size === 0) return
  const at = now.toISOString()
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString()
  const months = [...new Set([monthOfIso(at), monthOfIso(prev)].filter((m): m is string => m !== null))]
  const matchedAll: string[] = []
  let anyRowsDropped = false
  let anyUnreadable = false
  for (const month of months) {
    const { rows, readable, droppedMalformed } = await readWithdrawalLog(kv, month)
    // Split from the empty-month case: an unreadable month is a stamp we will never get to retry,
    // and collapsing the two into one silent `continue` is what would let the endpoint report a
    // fabricated #1106 regression with nothing in the logs to contradict it.
    if (!readable) {
      anyUnreadable = true
      console.error('[withdrawal-log] announce stamp SKIPPED — month unreadable; any row here will read as never-closed although the notice WAS sent:', month, [...incIds].join(', '))
      continue
    }
    if (droppedMalformed > 0) anyRowsDropped = true
    if (rows.length === 0) continue
    const { rows: updated, changed, stamped, matched } = markRowsAnnounced(rows, incIds, at)
    // A row that MATCHED counts as recorded whether or not this cycle stamped it — an already-stamped
    // row is the re-fire case, not a loss — so `matched` is what the discrepancy check below reads.
    matchedAll.push(...matched)
    if (!changed) continue
    // The write-back persists the FILTERED array, so any row `isLogEntry` rejected is erased here as
    // surely as in `recordWithdrawalsPruned`. `readWithdrawalLog` already logged those with their
    // payload; this is the second place that erasure happens.
    const ok = await kvPut(kv, withdrawalLogKey(month), JSON.stringify(updated))
    // The write failed, so these rows will read `neverClosed` — but they DO exist, so they are not a
    // durable-log under-report and must not also trip the line below. The two failures are different:
    // this one over-reports `neverClosed`, that one loses the withdrawal entirely.
    if (!ok) console.error('[withdrawal-log] announce stamp FAILED — these rows exist but will read as never-closed:', month, stamped.join(', '))
  }
  // A notice went out for an id no month holds a row for: the durable log is UNDER-REPORTING a
  // withdrawal that happened and was announced. The prune records before the cron reads the roster,
  // so the row should be there.
  //
  // The claim is deliberately narrow, and was narrowed twice. It fires ONLY when every month was
  // legible — an unreadable month already printed its own line above, and "we could not open the
  // month" is not evidence that no row exists; asserting a loss from it would send the operator at a
  // healthy prune path. Same reason it names no single cause: a lost write, cap eviction and a
  // whole-month shape-check wipe are indistinguishable from here, so the line reports the
  // DISCREPANCY it can prove and points at the earlier lines for the cause.
  const missed = anyUnreadable ? [] : [...incIds].filter((id) => !matchedAll.includes(id))
  if (missed.length > 0) {
    console.error(
      '[withdrawal-log] ⚪ notice sent but NO durable row was matched — the log under-reports these withdrawals:',
      missed.join(', '), `months checked: ${months.join(', ')}${anyRowsDropped ? ' (a month had rows dropped by the shape check — see above)' : ''}`,
    )
  }
}

/**
 * The incident ids to stamp, extracted from a cron cycle's just-written dedup keys.
 *
 * Extracted from `index.ts` so the extraction itself is BEHAVIOURALLY tested rather than only
 * source-pinned: a source pin can assert the `alerted:wd:` filter but not that the slice takes the
 * right offset, and an off-by-one there yields `wd:aud-1`, matches no row, and makes every withdrawal
 * report as never-closed — the module's headline verdict inverted, silently. (`fix_the_called_path`:
 * pin the call graph, unit-test the logic.)
 */
export function withdrawalIdsFromAlertKeys(keys: readonly string[]): Set<string> {
  const prefix = 'alerted:wd:'
  const ids = new Set<string>()
  for (const k of keys) {
    if (!k.startsWith(prefix)) continue
    const id = k.slice(prefix.length)
    if (id) ids.add(id) // a bare `alerted:wd:` would stamp nothing and match nothing — drop it
  }
  return ids
}
