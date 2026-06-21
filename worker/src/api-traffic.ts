// Public API traffic instrumentation (#518)
//
// /api/v1/status is otherwise unmeasurable: the in-memory rate limiter isn't a persisted
// counter, Workers analytics don't break down by URL path, and the worker runs on a
// workers.dev subdomain (no zone-level HTTP analytics). This records one Analytics Engine
// data point per served (non-429) v1 request, mirroring the #494 statusline pattern, so the
// call volume becomes queryable via the Cloudflare GraphQL Analytics API.
//
// Schema (dataset: aiwatch_statusline, binding env.ANALYTICS):
//   index1  = constant 'v1-status'           → total v1 traffic via one index filter (≤32 bytes)
//   blob1   = 'v1-status-all'|'v1-status-service' → optional all-vs-per-service split
//   double1 = 1                              → request counter (SUM in GraphQL queries)

// AnalyticsEngineDataset is a global ambient type from @cloudflare/workers-types.

export type V1Variant = 'v1-status-all' | 'v1-status-service'

// Shared index dimension. WAE index entries are capped at 32 bytes; 'v1-status' is well under.
const V1_INDEX = 'v1-status'

/**
 * Classify a /api/v1/status request path: bare endpoint = all-services, else per-service.
 * Note: recordV1Traffic runs before the handler's path validation, so blob1='v1-status-service'
 * also includes malformed/404 per-service paths (e.g. /api/v1/status/Bad$ID). The clean,
 * noise-free signal is the index1='v1-status' total; treat the per-service blob split as approximate.
 */
export function v1Variant(pathname: string): V1Variant {
  return pathname === '/api/v1/status' || pathname === '/api/v1/status/'
    ? 'v1-status-all'
    : 'v1-status-service'
}

/**
 * Record one v1-traffic data point. Best-effort: guarded on the optional binding (absent in
 * local dev / tests) and wrapped in try/catch so a WAE failure never aborts the API response.
 */
export function recordV1Traffic(
  analytics: AnalyticsEngineDataset | undefined,
  pathname: string,
): void {
  if (!analytics) return
  try {
    analytics.writeDataPoint({
      blobs: [v1Variant(pathname)],
      doubles: [1],
      indexes: [V1_INDEX],
    })
  } catch (err) {
    console.warn('[wae] v1 writeDataPoint failed:', err instanceof Error ? err.message : err)
  }
}

export interface V1TrafficCounts {
  all: number      // /api/v1/status (all-services) requests
  service: number  // /api/v1/status/:id requests (incl. malformed/404 per-service paths)
  total: number    // all + service
}

// ── Feed-poll traffic (#548) ──────────────────────────────────────────────
// The RSS feeds (/feed.xml + /feed/:slug) are the consent-free retention proxy GA4 can't give:
// a step-up in poll volume after an outage = retained RSS/Slack subscribers. Mirrors the v1
// pattern above on the SAME dataset, distinguished by a separate index ('feed-poll').
//   index1  = 'feed-poll'                     → total feed traffic via one index filter
//   blob1   = 'feed-all' | 'feed-service'     → /feed.xml vs /feed/:slug split
//   double1 = 1                               → request counter (SUM in AE SQL)
export type FeedVariant = 'feed-all' | 'feed-service'

const FEED_INDEX = 'feed-poll'

/** Classify a feed request path: /feed.xml = all-services, /feed/:slug = per-service. */
export function feedVariant(pathname: string): FeedVariant {
  return pathname === '/feed.xml' ? 'feed-all' : 'feed-service'
}

/** Record one feed-poll data point. Best-effort (guarded binding + try/catch), like recordV1Traffic. */
export function recordFeedTraffic(
  analytics: AnalyticsEngineDataset | undefined,
  pathname: string,
): void {
  if (!analytics) return
  try {
    analytics.writeDataPoint({
      blobs: [feedVariant(pathname)],
      doubles: [1],
      indexes: [FEED_INDEX],
    })
  } catch (err) {
    console.warn('[wae] feed writeDataPoint failed:', err instanceof Error ? err.message : err)
  }
}

export interface FeedTrafficCounts {
  all: number      // /feed.xml polls
  service: number  // /feed/:slug polls
  total: number    // all + service
}

/** AE SQL summing the last-24h feed poll count per variant (sampling-corrected via SUM(_sample_interval)). */
export function buildFeedTrafficSql(dataset = V1_DATASET): string {
  return (
    `SELECT blob1 AS variant, SUM(_sample_interval) AS requests ` +
    `FROM ${dataset} ` +
    `WHERE index1 = '${FEED_INDEX}' AND timestamp > NOW() - INTERVAL '1' DAY ` +
    `GROUP BY blob1 ` +
    `FORMAT JSON`
  )
}

/** Parse the AE SQL feed-traffic JSON into per-variant counts. Tolerant of string/number requests. */
export function parseFeedTrafficResponse(json: unknown): FeedTrafficCounts | null {
  const data = (json as { data?: unknown })?.data
  if (!Array.isArray(data)) return null
  let all = 0
  let service = 0
  for (const row of data) {
    const r = row as { variant?: unknown; requests?: unknown }
    const parsed = Number(r.requests)
    const n = Number.isFinite(parsed) ? parsed : 0
    if (r.variant === 'feed-all') all += n
    else if (r.variant === 'feed-service') service += n
  }
  return { all, service, total: all + service }
}

/** Query the last-24h feed poll count via the AE SQL API. Best-effort: null on missing creds /
 *  HTTP failure / unparseable response. Never throws. */
export async function queryFeedTraffic(
  accountId: string | undefined,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<FeedTrafficCounts | null> {
  if (!accountId || !token) return null
  try {
    const res = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: buildFeedTrafficSql() },
    )
    if (!res.ok) {
      console.warn(`[wae] feed SQL query failed: HTTP ${res.status}`)
      return null
    }
    return parseFeedTrafficResponse(await res.json())
  } catch (err) {
    console.warn('[wae] feed SQL query error:', err instanceof Error ? err.message : err)
    return null
  }
}

/** The WAE dataset name (matches wrangler.toml [[analytics_engine_datasets]].dataset). */
export const V1_DATASET = 'aiwatch_statusline'

/** Build the AE SQL that sums the last-24h v1 request count per variant.
 *  WAE samples at high volume, so SUM(_sample_interval) is the unbiased event-count estimate
 *  (exact when _sample_interval=1 at low volume) — NOT COUNT(*), which would undercount. */
export function buildV1TrafficSql(dataset = V1_DATASET): string {
  return (
    `SELECT blob1 AS variant, SUM(_sample_interval) AS requests ` +
    `FROM ${dataset} ` +
    `WHERE index1 = '${V1_INDEX}' AND timestamp > NOW() - INTERVAL '1' DAY ` +
    `GROUP BY blob1 ` +
    `FORMAT JSON`
  )
}

/** Parse the AE SQL API JSON response into per-variant counts. Tolerant of string/number
 *  `requests` and unknown variants. Returns null when the payload has no usable data array. */
export function parseV1TrafficResponse(json: unknown): V1TrafficCounts | null {
  const data = (json as { data?: unknown })?.data
  if (!Array.isArray(data)) return null
  let all = 0
  let service = 0
  for (const row of data) {
    const r = row as { variant?: unknown; requests?: unknown }
    // Number() (not parseInt) so sampling-corrected SUM(_sample_interval) fractional totals on the
    // string-typed path aren't floored; NaN → 0.
    const parsed = Number(r.requests)
    const n = Number.isFinite(parsed) ? parsed : 0
    if (r.variant === 'v1-status-all') all += n
    else if (r.variant === 'v1-status-service') service += n
  }
  return { all, service, total: all + service }
}

/**
 * Query the last-24h /api/v1 request count via the Analytics Engine SQL API.
 * Best-effort: returns null (caller skips the daily section) when the account id / token is
 * absent, the HTTP call fails, or the response can't be parsed. Never throws.
 */
export async function queryV1Traffic(
  accountId: string | undefined,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<V1TrafficCounts | null> {
  if (!accountId || !token) return null
  try {
    const res = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: buildV1TrafficSql() },
    )
    if (!res.ok) {
      console.warn(`[wae] v1 SQL query failed: HTTP ${res.status}`)
      return null
    }
    return parseV1TrafficResponse(await res.json())
  } catch (err) {
    console.warn('[wae] v1 SQL query error:', err instanceof Error ? err.message : err)
    return null
  }
}
