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

// ── Chrome-extension poll volume (#837) ───────────────────────────────────
// The extension polls /api/status/cached?src=ext-claude, tagged `ext-claude` in the SAME
// aiwatch_statusline dataset (index1). Counting it gives a CONSENT-FREE active-usage proxy
// (no in-extension analytics needed — see the extension's "zero data collection" privacy bar).
// Single total (no blob split): every ext poll is one variant.
const EXT_INDEX = 'ext-claude'

export function buildExtTrafficSql(dataset = V1_DATASET): string {
  return (
    `SELECT SUM(_sample_interval) AS requests ` +
    `FROM ${dataset} ` +
    `WHERE index1 = '${EXT_INDEX}' AND timestamp > NOW() - INTERVAL '1' DAY ` +
    `FORMAT JSON`
  )
}

/** Parse the AE SQL ext-claude JSON into a single last-24h poll total. Tolerant of string/number. */
export function parseExtTrafficResponse(json: unknown): number | null {
  const data = (json as { data?: unknown })?.data
  if (!Array.isArray(data) || data.length === 0) return null
  const parsed = Number((data[0] as { requests?: unknown })?.requests)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Query the last-24h extension poll count via the AE SQL API. Best-effort: null on missing creds /
 *  HTTP failure / unparseable response. Never throws. */
export async function queryExtTraffic(
  accountId: string | undefined,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<number | null> {
  if (!accountId || !token) return null
  try {
    const res = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: buildExtTrafficSql() },
    )
    if (!res.ok) {
      console.warn(`[wae] ext SQL query failed: HTTP ${res.status}`)
      return null
    }
    return parseExtTrafficResponse(await res.json())
  } catch (err) {
    console.warn('[wae] ext SQL query error:', err instanceof Error ? err.message : err)
    return null
  }
}

// ── New-feed-items count (#748) ───────────────────────────────────────────
// The poll volume above is mostly EMPTY no-op fetches (Slack RSS polls ~every 15min regardless of
// content). The figure that actually matters — how many alert-worthy items were published — is the
// count of incidents AIWatch FIRST detected in the window. Reuses the #750 `feed:firstseen:{incId}`
// markers (ISO first-detected time, 7d TTL) — NO new write surface. It's the upper bound on the
// notifications any subscriber could have received (a poll only notifies on a genuinely new item).
const FIRST_SEEN_PREFIX = 'feed:firstseen:'

/** Pure: count first-seen ISO timestamps within the 24h window ending at `now` (invalid/empty skipped). */
export function countFirstSeenWithin24h(values: (string | null | undefined)[], now: Date): number {
  const end = now.getTime()
  const start = end - 24 * 60 * 60 * 1000
  let n = 0
  for (const v of values) {
    if (!v) continue
    const t = new Date(v).getTime()
    if (Number.isFinite(t) && t >= start && t <= end) n++
  }
  return n
}

/** List the `feed:firstseen:` markers and count those first-detected in the last 24h. Best-effort:
 *  null on KV failure (caller omits the "new items" suffix). 7d-TTL markers keep the set tiny
 *  (~one per incident), so a single un-paginated list + per-key get is well within budget. */
export async function countNewFeedItems(kv: KVNamespace, now: Date = new Date()): Promise<number | null> {
  try {
    const list = await kv.list({ prefix: FIRST_SEEN_PREFIX })
    // Single page is safe (7d TTL × ~5/day ≈ tiny); warn if that ever stops holding so a future
    // fan-out in feed sources surfaces instead of silently undercounting past the 1000-key page.
    if (!list.list_complete) console.warn('[wae] countNewFeedItems: feed:firstseen list truncated — undercounting')
    if (list.keys.length === 0) return 0
    const values = await Promise.all(list.keys.map((k) => kv.get(k.name).catch(() => null)))
    return countFirstSeenWithin24h(values, now)
  } catch (err) {
    console.warn('[wae] countNewFeedItems failed:', err instanceof Error ? err.message : err)
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
