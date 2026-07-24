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

// ── Badge request traffic (#1157) ──────────────────────────────────────────
// /badge/:serviceId (SVG status badges embedded in READMEs / status pages) has the same
// instrumentation gap #518 closed for /api/v1 and #548 closed for /feed — embeds are a
// retention/distribution signal AIWatch otherwise can't see. Mirrors the feed-poll pattern on the
// SAME dataset, but blob1 carries the requested serviceId (rather than a binary all/service split)
// so per-service embed counts are directly queryable via GROUP BY blob1.
//   index1  = 'badge-request'                                  → total badge traffic, one index filter
//   blob1   = serviceId, or BADGE_UNKNOWN_SERVICE on a miss     → per-service breakdown
//   double1 = 1                                                 → request counter (SUM in AE SQL)
// blob1 is NOT restricted to known service ids by the handler's `^[a-z0-9_-]+$` validation — that
// regex only constrains the character set, and the badge handler deliberately still records a
// not-found id (a stale/retired-service embed is itself a signal worth surfacing). Recording the
// RAW miss string would make blob1 cardinality caller-controlled (unbounded, and inflatable by
// anyone hitting /badge/<random> in a loop — the exact shape #518/#548 avoided by collapsing blob1
// to a fixed enum). Collapsing every miss into the BADGE_UNKNOWN_SERVICE sentinel instead keeps
// blob1 bounded by (known services + 1) regardless of what the caller sends. Unlike v1Variant/
// feedVariant (which classify from the raw pathname), the caller here already knows which case it's
// in (it just did the service lookup), so recordBadgeTraffic takes a discriminated `BadgeRequestOutcome`
// rather than a bare string — the sentinel substitution happens INSIDE this function, so a future call
// site can't pass an arbitrary raw string through to blob1 (the exact failure mode this section exists
// to prevent, and the one the pre-fix code originally shipped).
const BADGE_INDEX = 'badge-request'

/** Sentinel blob1 value recorded for a serviceId with no match — see the cardinality note above.
 *  Never a real service id (services are validated slugs; this literal can't collide, though nothing
 *  currently enforces that against future SERVICES entries). */
export const BADGE_UNKNOWN_SERVICE = '__unknown__'

/** What a `/badge/:serviceId` request resolved to — the input `recordBadgeTraffic` classifies from.
 *  The `known: false` variant carries no serviceId field at all, so there's nothing left to
 *  accidentally thread through to blob1 on a miss. */
export type BadgeRequestOutcome =
  | { known: true; serviceId: string }
  | { known: false }

/** Record one badge-request data point. Best-effort (guarded binding + try/catch), like recordV1Traffic/recordFeedTraffic. */
export function recordBadgeTraffic(
  analytics: AnalyticsEngineDataset | undefined,
  outcome: BadgeRequestOutcome,
): void {
  if (!analytics) return
  const blob = outcome.known ? outcome.serviceId : BADGE_UNKNOWN_SERVICE
  try {
    analytics.writeDataPoint({
      blobs: [blob],
      doubles: [1],
      indexes: [BADGE_INDEX],
    })
  } catch (err) {
    console.warn('[wae] badge writeDataPoint failed:', err instanceof Error ? err.message : err)
  }
}

export interface BadgeTrafficCounts {
  // last-24h badge requests per blob1 value: a real serviceId, OR the BADGE_UNKNOWN_SERVICE sentinel
  // (aggregating every not-found/retired/typo'd id into one bucket — see the cardinality note above).
  byService: Record<string, number>
  total: number  // sum across all buckets, known services + unknown
}

/** AE SQL summing the last-24h badge request count per blob1 bucket (a service id or the
 *  BADGE_UNKNOWN_SERVICE sentinel), sampling-corrected. */
export function buildBadgeTrafficSql(dataset = V1_DATASET): string {
  return (
    `SELECT blob1 AS service, SUM(_sample_interval) AS requests ` +
    `FROM ${dataset} ` +
    `WHERE index1 = '${BADGE_INDEX}' AND timestamp > NOW() - INTERVAL '1' DAY ` +
    `GROUP BY blob1 ` +
    `FORMAT JSON`
  )
}

/** Parse the AE SQL badge-traffic JSON into per-service counts. Tolerant of string/number requests
 *  and a missing/invalid service label. */
export function parseBadgeTrafficResponse(json: unknown): BadgeTrafficCounts | null {
  const data = (json as { data?: unknown })?.data
  if (!Array.isArray(data)) return null
  const byService: Record<string, number> = {}
  let total = 0
  for (const row of data) {
    const r = row as { service?: unknown; requests?: unknown }
    if (typeof r.service !== 'string' || !r.service) continue
    const parsed = Number(r.requests)
    const n = Number.isFinite(parsed) ? parsed : 0
    byService[r.service] = (byService[r.service] ?? 0) + n
    total += n
  }
  return { byService, total }
}

/** Query the last-24h badge request count via the AE SQL API. Best-effort: null on missing creds /
 *  HTTP failure / unparseable response. Never throws. Mirrors queryFeedTraffic. */
export async function queryBadgeTraffic(
  accountId: string | undefined,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<BadgeTrafficCounts | null> {
  if (!accountId || !token) return null
  try {
    const res = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: buildBadgeTrafficSql() },
    )
    if (!res.ok) {
      console.warn(`[wae] badge SQL query failed: HTTP ${res.status}`)
      return null
    }
    return parseBadgeTrafficResponse(await res.json())
  } catch (err) {
    console.warn('[wae] badge SQL query error:', err instanceof Error ? err.message : err)
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

// ── Statusline poll volume (#918, feeds #400 Phase 1 measurement) ─────────
// The Claude Code statusline snippets (#400) poll /api/status/cached?src=statusline-<preset>,
// each tagged with its FULL preset slug in the SAME aiwatch_statusline dataset (index.ts writes
// index1 = the `statusline-*` src, #494). Counting them is the consent-free adoption proxy that
// #400 Phase 1's distribution/measurement gate needs — collected since #494 but never read back
// (unlike ext-claude / feed). Unlike ext-claude's single 'ext-claude' index, statusline's index1
// is MULTI-VALUED (one per preset: statusline-branded / -clickable / -degraded_only / -compact_badge
// / -full_list / -scoped), so filter with LIKE + GROUP BY index1 (feed's per-variant shape).
// NOTE: poll volume ≈ active-usage proxy, NOT user count — Claude Code re-renders the statusline
// per prompt, so a single active user generates many polls; the day-over-day step-up is the signal.
const STATUSLINE_INDEX_PREFIX = 'statusline-'
// The legacy Vercel-rewrite catch-all tag (#452/#453): every hit on ai-watch.dev/api/status/cached
// is rewritten to the worker with ?src=statusline-proxy. NOT a display preset — it's the pre-#918
// jq-snippet cohort (preset-unknown) plus any other apex-cached traffic. Tracked SEPARATELY from the
// path-tagged server-render presets (#918) because the two cohorts move in opposite target
// directions: legacy should SHRINK as users re-copy, server-render should GROW. Blending them into
// one total cancels the adoption signal (#944).
const STATUSLINE_PROXY_KEY = 'proxy'

export interface StatuslineTrafficCounts {
  byPreset: Record<string, number>  // path-tagged server-render presets ONLY (proxy excluded) → last-24h polls
  serverRenderTotal: number         // sum across path-tagged presets — the #918 adoption signal (want ↑)
  legacyProxy: number               // the legacy jq-snippet cohort (statusline-proxy tag; want ↓)
  total: number                     // serverRenderTotal + legacyProxy (grand total across all statusline-* polls)
}

/** Per-cohort day-over-day delta (today − yesterday); null per cohort when no usable baseline. */
export interface StatuslineTrafficDelta {
  serverRender: number | null
  legacyProxy: number | null
}

/** AE SQL summing the last-24h statusline poll count per preset (sampling-corrected via SUM(_sample_interval)). */
export function buildStatuslineTrafficSql(dataset = V1_DATASET): string {
  return (
    `SELECT index1 AS preset, SUM(_sample_interval) AS requests ` +
    `FROM ${dataset} ` +
    `WHERE index1 LIKE '${STATUSLINE_INDEX_PREFIX}%' AND timestamp > NOW() - INTERVAL '1' DAY ` +
    `GROUP BY index1 ` +
    `FORMAT JSON`
  )
}

/** Parse the AE SQL statusline JSON into per-cohort counts. Strips the 'statusline-' prefix from the
 *  key for readability, and routes the legacy `proxy` catch-all (#452/#453) into its OWN `legacyProxy`
 *  field so it's never blended into the server-render preset adoption signal (#944). Tolerant of
 *  string/number requests + a missing/invalid preset. */
export function parseStatuslineTrafficResponse(json: unknown): StatuslineTrafficCounts | null {
  const data = (json as { data?: unknown })?.data
  if (!Array.isArray(data)) return null
  const byPreset: Record<string, number> = {}
  let serverRenderTotal = 0
  let legacyProxy = 0
  for (const row of data) {
    const r = row as { preset?: unknown; requests?: unknown }
    if (typeof r.preset !== 'string' || !r.preset.startsWith(STATUSLINE_INDEX_PREFIX)) continue
    const parsed = Number(r.requests)
    const n = Number.isFinite(parsed) ? parsed : 0
    const key = r.preset.slice(STATUSLINE_INDEX_PREFIX.length) || r.preset
    if (key === STATUSLINE_PROXY_KEY) {
      legacyProxy += n
    } else {
      byPreset[key] = (byPreset[key] ?? 0) + n
      serverRenderTotal += n
    }
  }
  return { byPreset, serverRenderTotal, legacyProxy, total: serverRenderTotal + legacyProxy }
}

/** Serialize today's cohort totals for the day-over-day snapshot KV (read tomorrow by
 *  computeStatuslineDelta). Compact JSON `{sr,lp}` — mirrors the #548 subscriber-count snapshot. */
export function serializeStatuslineSnapshot(counts: StatuslineTrafficCounts): string {
  return JSON.stringify({ sr: counts.serverRenderTotal, lp: counts.legacyProxy })
}

/** Diff today's cohort totals against yesterday's persisted snapshot. Returns null PER COHORT when
 *  there's no usable baseline (absent / empty / non-JSON / non-numeric field) — same empty-string
 *  footgun guard as computeSubscriberDelta (#548), so a corrupt snapshot reads as "no delta" rather
 *  than a bogus full-count jump. Pure. */
export function computeStatuslineDelta(
  counts: StatuslineTrafficCounts,
  prevSnapshotRaw: string | null,
): StatuslineTrafficDelta {
  const none: StatuslineTrafficDelta = { serverRender: null, legacyProxy: null }
  if (prevSnapshotRaw == null || prevSnapshotRaw.trim() === '') return none
  let prev: unknown
  try {
    prev = JSON.parse(prevSnapshotRaw)
  } catch {
    return none
  }
  const p = prev as { sr?: unknown; lp?: unknown }
  const prevSr = Number(p?.sr)
  const prevLp = Number(p?.lp)
  return {
    serverRender: Number.isFinite(prevSr) ? counts.serverRenderTotal - prevSr : null,
    legacyProxy: Number.isFinite(prevLp) ? counts.legacyProxy - prevLp : null,
  }
}

/** Query the last-24h statusline poll count via the AE SQL API. Best-effort: null on missing creds /
 *  HTTP failure / unparseable response. Never throws. Mirrors queryFeedTraffic / queryExtTraffic. */
export async function queryStatuslineTraffic(
  accountId: string | undefined,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<StatuslineTrafficCounts | null> {
  if (!accountId || !token) return null
  try {
    const res = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: buildStatuslineTrafficSql() },
    )
    if (!res.ok) {
      console.warn(`[wae] statusline SQL query failed: HTTP ${res.status}`)
      return null
    }
    return parseStatuslineTrafficResponse(await res.json())
  } catch (err) {
    console.warn('[wae] statusline SQL query error:', err instanceof Error ? err.message : err)
    return null
  }
}

// ── Claude Code plugin usage (#920) ───────────────────────────────────────
// The plugin (#920) tags two DISTINCT indexes in the same dataset — deliberately NOT
// `statusline-*`, so continuous monitor polling doesn't pollute the #918 preset metric:
//   'aiwatch-monitor' — every 60s background-monitor poll of /api/statusline/down
//   'aiwatch-brief'   — every on-demand /aiwatch briefing (/api/statusline/brief)
// Collected since #920 but, like the pre-#918 statusline tags, needs a read-back to be
// usable. This is the consent-free plugin-adoption proxy (monitor volume ≈ installs × up-time;
// brief volume ≈ active engagement). Same NOT-a-user-count caveat as statusline.
const PLUGIN_MONITOR_INDEX = 'aiwatch-monitor'
const PLUGIN_BRIEF_INDEX = 'aiwatch-brief'

export interface PluginTrafficCounts {
  monitor: number  // last-24h background-monitor polls
  brief: number    // last-24h /aiwatch briefings
}

/** AE SQL summing the last-24h plugin poll counts per index (sampling-corrected). */
export function buildPluginTrafficSql(dataset = V1_DATASET): string {
  return (
    `SELECT index1 AS tag, SUM(_sample_interval) AS requests ` +
    `FROM ${dataset} ` +
    `WHERE index1 IN ('${PLUGIN_MONITOR_INDEX}', '${PLUGIN_BRIEF_INDEX}') AND timestamp > NOW() - INTERVAL '1' DAY ` +
    `GROUP BY index1 ` +
    `FORMAT JSON`
  )
}

/** Parse the AE SQL plugin JSON into monitor/brief counts. Tolerant of string/number + missing rows. */
export function parsePluginTrafficResponse(json: unknown): PluginTrafficCounts | null {
  const data = (json as { data?: unknown })?.data
  if (!Array.isArray(data)) return null
  let monitor = 0
  let brief = 0
  for (const row of data) {
    const r = row as { tag?: unknown; requests?: unknown }
    const parsed = Number(r.requests)
    const n = Number.isFinite(parsed) ? parsed : 0
    if (r.tag === PLUGIN_MONITOR_INDEX) monitor += n
    else if (r.tag === PLUGIN_BRIEF_INDEX) brief += n
  }
  return { monitor, brief }
}

/** Query the last-24h Claude Code plugin usage via the AE SQL API. Best-effort: null on missing
 *  creds / HTTP failure / unparseable response. Never throws. Mirrors queryStatuslineTraffic. */
export async function queryPluginTraffic(
  accountId: string | undefined,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<PluginTrafficCounts | null> {
  if (!accountId || !token) return null
  try {
    const res = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: buildPluginTrafficSql() },
    )
    if (!res.ok) {
      console.warn(`[wae] plugin SQL query failed: HTTP ${res.status}`)
      return null
    }
    return parsePluginTrafficResponse(await res.json())
  } catch (err) {
    console.warn('[wae] plugin SQL query error:', err instanceof Error ? err.message : err)
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
