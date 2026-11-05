// #1257 — a countable, reason-labelled record of a value we gave up on, for paths where an empty result
// would otherwise read the same as a healthy one. One Analytics Engine point per drop:
//   index1 = `drop:{site}` (one index per site, so a burst at one site cannot sample another's rows)
//   blob1  = site
//   blob2  = reason
//   blob3  = detail (which source, when the site has several; else empty)
//   double1 = count
// The daily summary reads the last 24h back.

import { V1_DATASET } from './api-traffic'

/** Every site that records drops. The SQL reads exactly these indexes. */
export const DROP_SITES = ['probe-snapshot', 'stale-sources'] as const
export type DropSite = typeof DROP_SITES[number]

/** What the operator does about each reason. A reason cannot be recorded without one. */
export const DROP_ACTIONS = {
  'read-failed': 'those slots were skipped on a KV read error; search Workers Logs for `[probe] KV read failed`',
  'window-unreadable': 'probe:24h is corrupt and every slot skips until it is deleted or its TTL lapses: `npx wrangler kv key delete probe:24h --binding STATUS_CACHE --remote --config worker/wrangler.toml` (7d latency history restarts)',
  'write-rejected': 'search Workers Logs for `[probe] snapshot write rejected` for the error',
  'source-read-failed': 'the changelog source(s) named in parentheses went unchecked for staleness this week; check them by hand',
} as const
export type DropReason = keyof typeof DROP_ACTIONS

const UNREADABLE_ACTION = 'check the `CF_ACCOUNT_ID` / `CF_ANALYTICS_TOKEN` secrets and Workers Logs for `[wae] drop SQL`'

const indexOf = (site: DropSite): string => `drop:${site}`

export function recordDrop(analytics: AnalyticsEngineDataset | undefined, site: DropSite, reason: DropReason, detail?: string): void {
  if (!analytics) return
  try {
    analytics.writeDataPoint({ blobs: detail ? [site, reason, detail] : [site, reason], doubles: [1], indexes: [indexOf(site)] })
  } catch (err) {
    console.warn('[wae] drop writeDataPoint failed:', err instanceof Error ? err.message : err)
  }
}

export interface DropCount { site: string; reason: string; detail?: string; n: number }

export function buildDropSql(dataset = V1_DATASET): string {
  return (
    `SELECT blob1 AS site, blob2 AS reason, blob3 AS detail, SUM(_sample_interval * double1) AS n ` +
    `FROM ${dataset} ` +
    `WHERE timestamp > NOW() - INTERVAL '1' DAY AND index1 IN (${DROP_SITES.map((s) => `'${indexOf(s)}'`).join(', ')}) ` +
    `GROUP BY blob1, blob2, blob3 ` +
    `FORMAT JSON`
  )
}

/** `null` when the response is not a readable result, so "could not read" never renders as "no drops". */
export function parseDropResponse(json: unknown): DropCount[] | null {
  const data = (json as { data?: unknown })?.data
  if (!Array.isArray(data)) return null
  const out: DropCount[] = []
  for (const row of data) {
    const r = row as { site?: unknown; reason?: unknown; detail?: unknown; n?: unknown }
    const n = Number(r.n)
    if (typeof r.site !== 'string' || typeof r.reason !== 'string' || !Number.isFinite(n) || n <= 0) continue
    out.push(typeof r.detail === 'string' && r.detail ? { site: r.site, reason: r.reason, detail: r.detail, n } : { site: r.site, reason: r.reason, n })
  }
  return out.sort((a, b) => b.n - a.n || a.site.localeCompare(b.site) || a.reason.localeCompare(b.reason) || (a.detail ?? '').localeCompare(b.detail ?? ''))
}

export async function queryDrops(
  accountId: string | undefined,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<DropCount[] | null> {
  if (!accountId || !token) return null
  try {
    const res = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: buildDropSql() },
    )
    if (!res.ok) {
      console.warn(`[wae] drop SQL query failed: HTTP ${res.status}`)
      return null
    }
    return parseDropResponse(await res.json())
  } catch (err) {
    console.warn('[wae] drop SQL query error:', err instanceof Error ? err.message : err)
    return null
  }
}

/** Always a line: an unreadable count says so instead of disappearing. */
export function formatDropLine(drops: DropCount[] | null | undefined): string {
  if (drops == null) return `🧮 **Silent drops** (24h): unreadable\n   ↳ ${UNREADABLE_ACTION}`
  if (drops.length === 0) return '🧮 **Silent drops** (24h): none'
  const head = `🧮 **Silent drops** (24h): ${drops.map((d) => `${d.site} · ${d.reason}${d.detail ? ` (${d.detail})` : ''} ×${d.n}`).join(', ')}`
  const reasons = [...new Set(drops.map((d) => d.reason))].filter((r): r is DropReason => Object.hasOwn(DROP_ACTIONS, r))
  return [head, ...reasons.map((r) => `   ↳ ${r}: ${DROP_ACTIONS[r]}`)].join('\n')
}
