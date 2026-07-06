// Consent-free outage-moment audience snapshot — #842-B Deliverable B (근거 ①).
//
// The "outage-spike audience by source" a sponsor asks for (#637/#803) is unmeasurable today: GA4 is
// consent-gated (systematic undercount) AND the is-down page's inbound traffic collapses to (direct)
// when it arrives via the X app — which strips the HTTP referrer (≈91% of the #547 outage analysis).
// This records ONE Analytics Engine data point per is-down page view (fired by a consent-free
// page-load beacon → POST /api/pageview), classified by inbound source and tagged with whether the
// service was in an active outage at view time → a per-outage "N views, by source" the report surfaces.
//
// Storage = Analytics Engine, NOT KV: a viral outage spikes page views, and a per-view KV
// read-modify-write would burn the write budget + race. WAE is built for high-cardinality event
// counts and is read back once/day via AE SQL for the operator report. Mirrors the #518/#548
// api-traffic.ts pattern on the SAME dataset, distinguished by a separate index ('isdown-view').
//   index1  = 'isdown-view'                         → total is-down views via one index filter
//   blob1   = source bucket ('x'|'search'|'feed'|'direct')
//   blob2   = 'active' | 'clear'                    → viewed during an outage window vs not
//   blob3   = service id                            → stored for a future per-service split; NOT
//                                                     queried yet (buildOutageAudienceSql groups on
//                                                     blob1+blob2 only)
//   double1 = 1                                     → view counter (SUM in AE SQL)

import { V1_DATASET } from './api-traffic'

// AnalyticsEngineDataset is a global ambient type from @cloudflare/workers-types.

export type AudienceSource = 'x' | 'search' | 'feed' | 'direct' | 'plugin'
export const AUDIENCE_SOURCES: AudienceSource[] = ['x', 'search', 'feed', 'direct', 'plugin']

const ISDOWN_INDEX = 'isdown-view'

// Host patterns for referrer-based classification (utm is the primary signal; host is the fallback
// for organic arrivals that DON'T strip the referrer — mainly search).
const X_HOSTS = /(^|\.)(x\.com|twitter\.com|t\.co)$/
const SEARCH_HOSTS = /(^|\.)(google|bing|duckduckgo|yahoo|ecosia|brave|baidu|naver|yandex|qwant|startpage)\./

/**
 * Classify an is-down visit's inbound source from the (already-tagged) utm_source and the referrer
 * hostname. Pure. The X app strips the referrer, so utm_source — added to our outage shares by
 * #842-B slice 1 + the operator X_UTM (alerts.ts) — is the primary X signal; our RSS feed links
 * carry utm_source=rss → 'feed'; the Claude Code plugin's is-down links carry utm_source=claude-code
 * (#920) → 'plugin'; organic search is caught by host. Everything else → 'direct' (unattributed):
 * no referrer, unknown, or a share channel we don't bucket separately — including threads/copy-link
 * AND Reddit (utm_source=reddit, deliberately not folded into 'feed').
 */
export function classifyReferrer(utmSource: string | undefined, refHost: string | undefined): AudienceSource {
  const utm = (utmSource || '').toLowerCase()
  const host = (refHost || '').toLowerCase()
  if (utm === 'x' || utm === 'twitter' || X_HOSTS.test(host)) return 'x'
  if (utm === 'rss' || utm === 'feed') return 'feed'
  if (utm === 'claude-code') return 'plugin'  // #920 Claude Code plugin is-down links
  if (SEARCH_HOSTS.test(host)) return 'search'
  return 'direct'
}

/**
 * Validate a beacon body → `{ svc, source, active }` or null. `svc` MUST be a known service id (the
 * abuse guard: the endpoint is public, so an arbitrary body can't inflate an unknown bucket). `ref`
 * (referrer hostname) + `utm` (utm_source) are length-capped free-text — never stored raw, only fed
 * to the pure `classifyReferrer` → a fixed bucket. `active` (in an outage window) comes from the
 * rendered page status. Pure. Cheap id-safe validation; no free-form strings reach WAE.
 */
export function parsePageviewBody(
  body: unknown,
  validIds: Set<string>,
): { svc: string; source: AudienceSource; active: boolean } | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const svc = typeof b.svc === 'string' ? b.svc : ''
  if (!validIds.has(svc)) return null
  const utm = typeof b.utm === 'string' ? b.utm.slice(0, 64) : ''
  const ref = typeof b.ref === 'string' ? b.ref.slice(0, 128) : ''
  return { svc, source: classifyReferrer(utm, ref), active: b.active === true }
}

/**
 * Record one is-down-view data point. Best-effort: guarded on the optional binding (absent in local
 * dev / tests) and wrapped in try/catch so a WAE failure never aborts the beacon response. Sync
 * (writeDataPoint is fire-and-forget) — no waitUntil needed.
 */
export function recordOutageView(
  analytics: AnalyticsEngineDataset | undefined,
  source: AudienceSource,
  active: boolean,
  svcId: string,
): void {
  if (!analytics) return
  try {
    analytics.writeDataPoint({
      blobs: [source, active ? 'active' : 'clear', svcId],
      doubles: [1],
      indexes: [ISDOWN_INDEX],
    })
  } catch (err) {
    console.warn('[wae] isdown-view writeDataPoint failed:', err instanceof Error ? err.message : err)
  }
}

export interface AudienceCounts {
  total: number // all is-down views in the window
  activeTotal: number // subset viewed while the service was in an active outage (the sponsor evidence)
  bySource: Record<AudienceSource, number> // all views by source
  activeBySource: Record<AudienceSource, number> // active-outage views by source
}

const zeroBySource = (): Record<AudienceSource, number> => ({ x: 0, search: 0, feed: 0, direct: 0, plugin: 0 })

/** AE SQL summing the last-24h is-down view count per (source, active/clear) — sampling-corrected
 *  via SUM(_sample_interval), NOT COUNT(*) which undercounts at high volume (WAE samples). */
export function buildOutageAudienceSql(dataset = V1_DATASET): string {
  // `phase` (NOT `window`, a SQL reserved keyword the AE parser may reject → 400 → the section
  // silently omits forever); mirrors api-traffic.ts aliasing to non-reserved tokens.
  return (
    `SELECT blob1 AS source, blob2 AS phase, SUM(_sample_interval) AS views ` +
    `FROM ${dataset} ` +
    `WHERE index1 = '${ISDOWN_INDEX}' AND timestamp > NOW() - INTERVAL '1' DAY ` +
    `GROUP BY blob1, blob2 ` +
    `FORMAT JSON`
  )
}

/** Parse the AE SQL JSON into per-source + active/clear counts. Tolerant of string/number `views`
 *  and unknown source buckets (skipped). Returns null when the payload has no usable data array. */
export function parseOutageAudienceResponse(json: unknown): AudienceCounts | null {
  const data = (json as { data?: unknown })?.data
  if (!Array.isArray(data)) return null
  const bySource = zeroBySource()
  const activeBySource = zeroBySource()
  let total = 0
  let activeTotal = 0
  for (const row of data) {
    const r = row as { source?: unknown; phase?: unknown; views?: unknown }
    const source = r.source as AudienceSource
    if (!AUDIENCE_SOURCES.includes(source)) continue
    const parsed = Number(r.views)
    const n = Number.isFinite(parsed) ? parsed : 0
    bySource[source] += n
    total += n
    if (r.phase === 'active') {
      activeBySource[source] += n
      activeTotal += n
    }
  }
  return { total, activeTotal, bySource, activeBySource }
}

/** Query the last-24h is-down audience via the AE SQL API. Best-effort: null on missing creds /
 *  HTTP failure / unparseable response. Never throws. Mirrors queryFeedTraffic (api-traffic.ts). */
export async function queryOutageAudience(
  accountId: string | undefined,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<AudienceCounts | null> {
  if (!accountId || !token) return null
  try {
    const res = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: buildOutageAudienceSql() },
    )
    if (!res.ok) {
      console.warn(`[wae] isdown-view SQL query failed: HTTP ${res.status}`)
      return null
    }
    return parseOutageAudienceResponse(await res.json())
  } catch (err) {
    console.warn('[wae] isdown-view SQL query error:', err instanceof Error ? err.message : err)
    return null
  }
}
