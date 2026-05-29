// #488 — refresh the status cache on a status-change edge.
//
// Every OG/SEO surface reads CACHE_KEY (via /api/status/cached). That key is otherwise written only
// by the /api/status fetch handler's cacheWrite, throttled to once per 10 min and dependent on
// incidental live traffic. So an incident the cron just detected (and alerted on) stays invisible to
// SEO/OG for up to ~10 min — a shared "Is X Down?" card previews the pre-incident state.
//
// The cron already holds the fresh `services` it alerted on, so when a status-change alert fired
// (sentCount > 0) we write that snapshot straight to CACHE_KEY, bypassing the throttle (this is an
// event-driven write, not traffic-driven; status edges are rare → a handful of writes/day, negligible
// against the monthly KV budget). Extracted here as a thin, KV-only function so the decision is unit-
// testable without invoking the whole cron (cronAlertCheck is not exported).
//
// Contract parity with cacheWrite: stores RAW ServiceStatus[] under { services, cachedAt }.
// /api/status/cached recomputes scores on read, so the OG card gets both the correct status and the
// incident-adjusted Score. Does NOT touch the daily uptime counters — those stay with the throttled
// cacheWrite so incident edges don't bias the sampling.

import { kvPut } from './utils'
import type { ServiceStatus } from './services'

/** Write the live `services` snapshot to `cacheKey` iff a status-change alert fired this cron.
 *  Returns true when a write was issued and succeeded (caller aligns its throttle clock), false when
 *  skipped (no change) or the KV write failed. Never throws — kvPut already swallows + logs. */
export async function refreshStatusCacheOnChange(
  kv: KVNamespace,
  services: ServiceStatus[],
  sentCount: number,
  cacheKey: string,
  ttlSeconds: number,
  now: number = Date.now(),
): Promise<boolean> {
  if (sentCount <= 0 || services.length === 0) return false
  return kvPut(kv, cacheKey, JSON.stringify({
    services,
    cachedAt: new Date(now).toISOString(),
  }), { expirationTtl: ttlSeconds })
}
