// #1371 — the status snapshot's TTL, and the two intervals it must outlive.
//
// It owns the TTL for `CACHE_KEY` and the timing model it is derived from: the key must not lapse
// before the cron next LOOKS at it. `msUntilCronLooksAgain` makes that interval computable, and
// `cache-ttl.test.ts` pins the inequality. Why the old literal was wrong, and what actually caused the
// production 503s, is in `docs/reference/product-constraints.md` — once, not restated here.
//
// Extracted into its own module rather than exported from `index.ts`: `wrangler dev`'s local runtime
// rejects non-handler value exports from the entry module — the same constraint that produced
// `edge-fallback-alert-keys.ts`, whose comment asks that new shared constants be placed like this.

// How often the scheduled handler runs, mirroring the `crons` entry in `worker/wrangler.toml` (the
// wall-clock 5-minute grid). The schedule is not TypeScript, so nothing about this file can make the
// two impossible to desynchronise — `cache-ttl.test.ts` READS the TOML and fails if they disagree,
// because the whole derived TTL hangs off this number. `alerts.ts` imports it from here rather than
// declaring its own; `parse-failure-log.ts` still hardcodes the same cadence for its dedup slot, which
// this file does not attempt to speak for.
// (Line comments, not a JSDoc block: the cron expression contains `*` followed by `/`, which closes a
// block comment early — it broke the build once here already.)
export const CRON_CADENCE_MS = 5 * 60 * 1000

/** How old the cached snapshot must be before the cron treats it as stale and live-fetches. */
export const CACHE_STALE_THRESHOLD_MS = 10 * 60 * 1000

/**
 * How long after a write the cron will next LOOK at the snapshot — the interval the TTL must outlive.
 *
 * `offsetInTickMs` is where the write landed relative to the cron's tick grid, which is the variable
 * the old TTL ignored: a write landing exactly on a tick boundary waits the longest, and that worst
 * case is what the 900s TTL matched exactly instead of exceeding.
 *
 * Pure, and deliberately not folded into the constant below — a test that recomputed the same formula
 * would assert nothing. This walks the timeline instead, so the assertion is about the behaviour.
 */
export function msUntilCronLooksAgain(offsetInTickMs: number): number {
  const writeAt = offsetInTickMs
  const staleAt = writeAt + CACHE_STALE_THRESHOLD_MS
  // The first tick STRICTLY after the snapshot goes stale. A tick landing exactly at `staleAt` sees an
  // age equal to the threshold, not greater, so it does not live-fetch.
  const nextTick = (Math.floor(staleAt / CRON_CADENCE_MS) + 1) * CRON_CADENCE_MS
  return nextTick - writeAt
}

/** Headroom on top of the worst case. TWO ticks, not one: a skipped tick has to be survivable *and*
 *  the recovering tick still has to finish its live fetch before the key lapses — it evaluates
 *  staleness at the instant it runs, but writes only after `fetchAllServices` returns. One tick made
 *  `TTL === worst + one skip` exactly, i.e. the same zero-margin condition this file names as the
 *  original defect, one tick further out. Counted in ticks rather than minutes so it survives a
 *  schedule change. */
const CACHE_TTL_MARGIN_MS = 2 * CRON_CADENCE_MS

/**
 * TTL for `CACHE_KEY`, derived from the interval that actually binds it rather than hardcoded.
 *
 * The worst case of `msUntilCronLooksAgain` is `CACHE_STALE_THRESHOLD_MS + CRON_CADENCE_MS`; the
 * margin puts the TTL two ticks beyond it. `cache-ttl.test.ts` walks the offsets and asserts STRICT
 * inequality — an equality would be the zero-margin bug again — so changing any input without carrying
 * the TTL along fails the build.
 */
export const CACHE_TTL_SECONDS =
  (CACHE_STALE_THRESHOLD_MS + CRON_CADENCE_MS + CACHE_TTL_MARGIN_MS) / 1000
