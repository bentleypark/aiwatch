// #488/#1057 — refresh the status cache on a status-change edge.
//
// Every OG/SEO surface reads CACHE_KEY (via /api/status/cached). That key is otherwise written only
// by the /api/status fetch handler's cacheWrite, throttled to once per 10 min and dependent on
// incidental live traffic. So an incident the cron just detected (and alerted on) stays invisible to
// SEO/OG for up to ~10 min — a shared "Is X Down?" card previews the pre-incident state.
//
// Two event-driven refreshes bypass that throttle, both writing CACHE_KEY only (never the daily uptime
// counters, so incident edges don't bias the sampling):
//   #488 — the CRON, when a status-change alert fired (sentCount > 0). Covers the no-live-traffic case.
//   #1057 — the LIVE /api/status handler, when a poll's fresh snapshot shows a status edge the cached
//           snapshot doesn't yet reflect. This is what decouples the OG card's freshness from the alert
//           timing: while the operator watches the (live) dashboard flip to down, their browser is
//           polling /api/status, so the OG card flips on that poll — AHEAD of the */5 cron/Discord
//           alert, instead of in lockstep with it (the whole-turn root cause of #1057).
// Status edges are rare → a handful of writes/day, negligible against the monthly KV budget.
// Extracted here as thin, KV-only functions so the decisions are unit-testable without invoking the
// whole cron / fetch handler.
//
// Contract parity: stores RAW ServiceStatus[] under { services, cachedAt } (what /api/status/cached +
// cacheWrite assume). /api/status/cached recomputes scores on read, so the OG card gets both the
// correct status and the incident-adjusted Score.

import { kvPut } from './utils'
import type { ServiceStatus } from './services'

/** The shared CACHE_KEY writer (#488 + #1057). Stores RAW ServiceStatus[] under { services, cachedAt }.
 *  A single primitive so the two event-driven refreshes write byte-identical snapshots — a second copy
 *  of this JSON shape would silently drift from /api/status/cached's read contract. Returns kvPut's
 *  success boolean; never throws (kvPut swallows + logs). */
export async function writeStatusCache(
  kv: KVNamespace,
  services: ServiceStatus[],
  cacheKey: string,
  ttlSeconds: number,
  now: number = Date.now(),
): Promise<boolean> {
  return kvPut(kv, cacheKey, JSON.stringify({
    services,
    cachedAt: new Date(now).toISOString(),
  }), { expirationTtl: ttlSeconds })
}

/** #488 — write the live `services` snapshot to `cacheKey` iff a status-change alert fired this cron.
 *  Returns true when a write was issued and succeeded (caller aligns its throttle clock), false when
 *  skipped (no change) or the KV write failed. */
export async function refreshStatusCacheOnChange(
  kv: KVNamespace,
  services: ServiceStatus[],
  sentCount: number,
  cacheKey: string,
  ttlSeconds: number,
  now: number = Date.now(),
): Promise<boolean> {
  if (sentCount <= 0 || services.length === 0) return false
  return writeStatusCache(kv, services, cacheKey, ttlSeconds, now)
}

/** #1057 — does the freshly-fetched `fresh` snapshot carry a service status the `cached` snapshot does
 *  not yet reflect? Pure — the decision the live /api/status handler force-refreshes CACHE_KEY on.
 *
 *  Compared by service id. Deliberate scope:
 *   - A null / empty `cached` returns false: there is nothing to diff against, and bootstrapping an
 *     empty cache is the throttled cacheWrite's job, not this event-driven one (a false here just lets
 *     the normal write happen).
 *   - A service in `fresh` but ABSENT from `cached` is NOT an edge: a roster change is not a status
 *     flip, and treating it as one would force a write on every service rollout. The throttled writer
 *     / cron bootstraps the new id.
 *   - RECOVERY (down→operational) IS an edge, so the is-down/OG card flips back to green promptly, not
 *     just on the down edge. */
export function hasStatusEdge(
  fresh: ReadonlyArray<{ id: string; status: string }>,
  cached: ReadonlyArray<{ id: string; status: string }> | null | undefined,
): boolean {
  if (!cached || cached.length === 0) return false
  const prev = new Map(cached.map((s) => [s.id, s.status]))
  for (const s of fresh) {
    const p = prev.get(s.id)
    if (p !== undefined && p !== s.status) return true
  }
  return false
}

export type LiveEdgeRefresh = 'skipped' | 'refreshed' | 'refresh-failed'

/** #1057 — the live /api/status handler's post-cacheWrite step, extracted so the read→edge→write
 *  SEQUENCE (the actual fix) is unit-testable. The fetch handler is not exported, and a green
 *  hasStatusEdge test alone would ALSO pass against the pre-#1057 handler that never consulted the edge
 *  — so the pure fn is not enough to prove the wiring (the repo rule: 순수fn 초록 ≠ 배선 초록).
 *
 *  When cacheWrite was throttle-skipped (`wrote === false`), CACHE_KEY still holds the previous
 *  snapshot that the is-down/OG surfaces read. If this poll's `fresh` shows a status edge vs it, force
 *  an immediate CACHE_KEY refresh so the social card flips on THIS poll, ahead of the cron/#488 alert.
 *  `readCached` is injected (not a hard import of index.ts's cacheRead) so this stays KV-fake-testable
 *  and reuses the ONE parser of the { services, cachedAt } shape — no second copy to drift. NOTE the
 *  caller must ensure `readCached` reads the SAME key as `cacheKey` (production: both are CACHE_KEY) —
 *  a mismatch would compare the edge against the wrong snapshot. The read runs ONLY on the throttled
 *  path (short-circuits when `wrote`). Returns the outcome so the caller can
 *  log success vs failure at the right severity — a failed forced write silently reintroduces the
 *  staleness bug #1057 fixes, so it must be observable (the #488 sibling escalates the same failure). */
export async function refreshStatusCacheOnLiveEdge(
  kv: KVNamespace,
  wrote: boolean,
  fresh: ServiceStatus[],
  cacheKey: string,
  ttlSeconds: number,
  readCached: (kv: KVNamespace) => Promise<{ services: ServiceStatus[] } | null>,
  now: number = Date.now(),
): Promise<LiveEdgeRefresh> {
  if (wrote) return 'skipped'                                     // cacheWrite already wrote `fresh`
  const cached = await readCached(kv)
  if (!hasStatusEdge(fresh, cached?.services ?? null)) return 'skipped'
  return (await writeStatusCache(kv, fresh, cacheKey, ttlSeconds, now)) ? 'refreshed' : 'refresh-failed'
}
