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
