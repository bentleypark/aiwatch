// #1089 — a durable, per-service tally of status-source read failures.
//
// #1123 — no longer Instatus-only: the OnlineOrNot path books here too. The KV key is still literally
// `instatus-parse-fail:` (renaming it would strand 30 days of in-flight counters for no diagnostic
// gain), so the name is now HISTORICAL — read it as "source parse failures". `SourceParseFailure`
// below is the full persisted vocabulary; `docs/reference/kv-schema.md` carries the operator-facing
// copy of the same list.
//
// WHY THIS EXISTS SEPARATELY FROM `fetch-fail:daily:*`.
//
// #1089 shipped the guard that stops an unreadable incident list reading as a recovery, and routed
// failures through `trackFetchFailure` so they were at least counted. Then the counting turned out to
// answer a different question than the one the remaining decision needs:
//
//   1. `fetch-fail:daily:{svcId}:{date}` has a 48h TTL (`utils.ts`), so a check a week later sees only
//      the last two days and reports a quiet week as zero — the "empty result is an instrument
//      failure" trap, built into the verification plan itself.
//   2. It counts threshold CROSSINGS — it only increments when the failure count reaches 3, on the
//      rising edge. But a SINGLE failed cycle is already enough to drop a service out of
//      `/api/statusline/down` and make the plugin monitor emit a false "✅ recovered". So the metric
//      that matters is invisible to it by construction, not by retention.
//
// Both are correct for what `trackFetchFailure` is for (deciding when a source is structurally dead),
// and that primitive is shared by every monitored service — bending its TTL or its rising-edge semantics to
// suit one measurement would change the #500 persistent-failure alert and the daily summary too. So
// this is a separate, narrow counter rather than a modification of a shared one.
//
// Shape mirrors `ai:usage:{date}` (#995/#1080): one key per UTC day, 30d TTL, per-service attribution,
// read-modify-write. One key per day, written only on failure AND at most once per cron slot — so the
// write count tracks cron cycles, not dashboard traffic. That bound is the point, not a detail; the
// exact figure and its caveats live on `recordParseFailure`, rather than being restated here where a
// later correction would not reach them. (One deliberate second home: the `instatus-parse-fail` row in
// `docs/reference/kv-schema.md`, which is where an operator reading the KV actually looks. Two homes,
// so a future correction has to touch both — not one, despite what an earlier draft of this comment
// claimed.)
// Reason is kept alongside the count because it selects the fix: `scrape-unreadable` points at URL
// drift (a config change), while the payload reasons point at the provider changing its SSR shape (a
// parser change).

import { kvPut, type KVLike } from './utils'
import type { InstatusParseFailure } from './parsers/instatus'
import type { OnlineOrNotParseFailure } from './parsers/onlineornot'
import type { AwsRssParseFailure, AwsHealthParseFailure } from './parsers/aws'

/**
 * #1123 — the persisted reason vocabulary, joined in ONE place: the module that writes it. Typing
 * `recordParseFailure` with this (rather than a bare `string`) keeps the set of buckets that can
 * appear in KV enumerable and greppable, and forces a third source added later to join the union
 * instead of silently inventing a bucket nobody can interpret. Member names are unique across every
 * source's union on purpose, so an operator aggregating one reason over several services is never
 * summing two different parsers' failures — they take different fixes.
 */
export type SourceParseFailure = InstatusParseFailure | OnlineOrNotParseFailure | AwsRssParseFailure | AwsHealthParseFailure

/** 30d — long enough that a weekly check sees the whole window, unlike `fetch-fail:daily`'s 48h. */
export const PARSE_FAIL_TTL_S = 30 * 86400

export function parseFailKey(date: string): string {
  return `instatus-parse-fail:${date}`
}

/** `{ svcId: { reason: count } }` — attributed twice over, by service and by failure mode. */
export type ParseFailCounts = Record<string, Record<string, number>>

/**
 * A day's record. `slots` is what makes the counts mean CYCLES rather than invocations.
 *
 * `fetchService` runs on every `/api/status` request, not only the 5-minute cron (`utils.ts` says so
 * outright, and it is why #500 anchors on a timestamp instead of a count). A per-invocation counter
 * would therefore (a) issue a KV write per dashboard request for as long as the source stayed broken —
 * traffic-proportional writes, which `decision_wae_over_kv_for_traffic_counters` rules out and
 * `constraint_free_tier_budget` bounds — and (b) produce a number confounded with traffic, so "failed
 * every cycle for a week" and "failed during a traffic spike" would be indistinguishable. Since the
 * open decision is chosen by FREQUENCY, that number would read as data while being unusable as
 * evidence.
 *
 * So a failure is booked at most once per service per cron slot: writes track cron cycles rather than
 * request volume, and the tally answers the question actually being asked. For the resulting figure —
 * and why it is per colo rather than absolute — see `recordParseFailure`.
 */
export interface ParseFailDay {
  counts: ParseFailCounts
  /** svcId → the last 5-minute slot already booked for it. */
  slots: Record<string, number>
}

/** The 5-minute cron slot a timestamp falls in — the dedup unit. */
export function slotOf(nowMs: number): number {
  return Math.floor(nowMs / 300_000)
}

/**
 * Tolerant reader. Anything unusable reads as `{}` rather than throwing: this is a diagnostic, and a
 * corrupt value must not be able to take down the cron path that writes it.
 *
 * NOTE ON ABSENCE: a missing key for a date means "no failures recorded that day" only for dates AFTER
 * this counter deployed. Earlier dates are simply un-instrumented. The date is the discriminator —
 * there is no in-band flag — and it is deliberately NOT hardcoded anywhere, because a stale one makes
 * the counter misreadable in exactly the way this caveat exists to prevent. Recover it with
 * `git log --diff-filter=A -- worker/src/parse-failure-log.ts` (also noted in
 * `docs/reference/kv-schema.md`).
 */
export function parseParseFailDay(raw: string | null): ParseFailDay {
  const empty: ParseFailDay = { counts: {}, slots: {} }
  if (!raw) return empty
  try {
    const root = JSON.parse(raw) as unknown
    if (!root || typeof root !== 'object' || Array.isArray(root)) return empty
    const parsed = (root as { counts?: unknown }).counts
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty
    const slots: Record<string, number> = {}
    const rawSlots = (root as { slots?: unknown }).slots
    if (rawSlots && typeof rawSlots === 'object' && !Array.isArray(rawSlots)) {
      for (const [k, v] of Object.entries(rawSlots as Record<string, unknown>)) {
        if (k && typeof v === 'number' && Number.isFinite(v)) slots[k] = Math.floor(v)
      }
    }
    const out: ParseFailCounts = {}
    for (const [svcId, reasons] of Object.entries(parsed as Record<string, unknown>)) {
      if (!svcId || !reasons || typeof reasons !== 'object' || Array.isArray(reasons)) continue
      const inner: Record<string, number> = {}
      for (const [reason, n] of Object.entries(reasons as Record<string, unknown>)) {
        if (reason && typeof n === 'number' && Number.isFinite(n) && n > 0) inner[reason] = Math.floor(n)
      }
      if (Object.keys(inner).length > 0) out[svcId] = inner
    }
    return { counts: out, slots }
  } catch {
    return empty
  }
}

/**
 * Fold one failure into the day, at most once per service per cron slot. Pure.
 *
 * Returns the day UNCHANGED for a repeat within the same slot — that is what keeps the write bounded
 * and the count meaningful. The caller skips the KV write when nothing changed.
 */
export function applyParseFailure(day: ParseFailDay, svcId: string, reason: string, slot: number): ParseFailDay {
  // An empty id would book a `""` bucket that answers nothing — skip it, exactly as #1080's
  // `applyAttempt` does. `svcId`/`slot` are required (not optional) so the type checker holds callers.
  if (!svcId || !reason) return day
  if (day.slots[svcId] === slot) return day
  const prev = day.counts[svcId] ?? {}
  return {
    counts: { ...day.counts, [svcId]: { ...prev, [reason]: (prev[reason] ?? 0) + 1 } },
    slots: { ...day.slots, [svcId]: slot },
  }
}

/** Total failures for a service across a day's counts, all reasons. Pure — for readers. */
export function totalFor(day: ParseFailDay, svcId: string): number {
  return Object.values(day.counts[svcId] ?? {}).reduce((a, b) => a + b, 0)
}

/**
 * Book one failure. Best-effort and never throws — bookkeeping must not be able to fail a status
 * fetch. Near-exact, not exact, and the error runs BOTH ways.
 *
 * UNDER-counts: the read-modify-write can lose a bump, and `fetchAllServices` runs services in
 * concurrent batches, so two writers that land in the same batch race on this one key. As of #1123
 * they DO: with `BATCH_SIZE = 10`, perplexity (index 11) and openrouter (index 15) both sit in batch
 * 1 — mistral is in batch 0 and fal in batch 2. This was the "incidental, not guaranteed" case the
 * earlier version of this note warned about, and adding a second source made it real. It costs a lost
 * bump on a counter that is explicitly an order of magnitude, so it is accepted, not fixed.
 *
 * OVER-counts: the slot dedup depends on READING the write made seconds earlier in the same slot, and
 * KV is eventually consistent with a ~60s per-colo read cache (`KVLike.get` exposes no `cacheTtl`).
 * Since the whole premise is that this path also runs on `/api/status` requests — i.e. from many
 * colos — early in a slot several colos can each book once. So the per-slot bound is per colo.
 *
 * Concretely: ~288/day/service PER COLO while a source stays broken (288 five-minute slots in a day),
 * 0 otherwise. Read it as an order of magnitude ("never / weekly / daily"), never as an exact tally.
 */
export async function recordParseFailure(
  kv: KVLike | undefined,
  now: number,
  svcId: string,
  reason: SourceParseFailure,
): Promise<void> {
  if (!kv) return
  try {
    const key = parseFailKey(new Date(now).toISOString().split('T')[0])
    const day = parseParseFailDay(await kv.get(key).catch(() => null))
    const next = applyParseFailure(day, svcId, reason, slotOf(now))
    // Already booked this slot → no write. This is the bound: writes track cron cycles, not requests.
    if (next === day) return
    await kvPut(kv, key, JSON.stringify(next), { expirationTtl: PARSE_FAIL_TTL_S })
  } catch (err) {
    console.warn('[parse-fail] counter bump failed:', err instanceof Error ? err.message : err)
  }
}
