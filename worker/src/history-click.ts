// #1612 — consent-free count of clicks on the is-down "30-day history" links, the demand signal for a
// 30-day incident view. One Analytics Engine point per click (POST /api/history-click), on the SAME
// dataset as the is-down page views (outage-audience.ts, index `isdown-view`), so the daily read takes
// clicks and the views they divide by in one query.
//   index1 = 'isdown-history-click'
//   blob1  = service id (an unrecognised id → AUDIENCE_UNKNOWN_SCREEN, as parsePageviewBody does)
//   blob2  = 'active' | 'clear' — the page's SSR-time outage status (same position as `isdown-view`)
//   blob3  = agent ('bot' | 'unflagged')
//   blob4  = surface ('service' | 'group' | 'unknown')

import { V1_DATASET } from './api-traffic'
import {
  AUDIENCE_SURFACES, AUDIENCE_SURFACE_UNKNOWN, AUDIENCE_UNKNOWN_SCREEN, ISDOWN_INDEX,
  type AudienceAgent, type AudienceSurface, type AudienceSurfaceKey,
} from './outage-audience'

const HISTORY_CLICK_INDEX = 'isdown-history-click'

export function parseHistoryClickBody(
  body: unknown,
  validIds: Set<string>,
): { svc: string; active: boolean; surface: AudienceSurfaceKey } | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const rawSvc = typeof b.svc === 'string' ? b.svc : ''
  if (!rawSvc) return null
  const surface: AudienceSurfaceKey = AUDIENCE_SURFACES.includes(b.surface as AudienceSurface)
    ? (b.surface as AudienceSurface)
    : AUDIENCE_SURFACE_UNKNOWN
  return { svc: validIds.has(rawSvc) ? rawSvc : AUDIENCE_UNKNOWN_SCREEN, active: b.active === true, surface }
}

export function recordHistoryClick(
  analytics: AnalyticsEngineDataset | undefined,
  svcId: string,
  active: boolean,
  surface: AudienceSurfaceKey,
  agent: AudienceAgent,
): void {
  if (!analytics) return
  try {
    analytics.writeDataPoint({
      blobs: [svcId, active ? 'active' : 'clear', agent, surface],
      doubles: [1],
      indexes: [HISTORY_CLICK_INDEX],
    })
  } catch (err) {
    console.warn('[wae] history-click writeDataPoint failed:', err instanceof Error ? err.message : err)
  }
}

/** Flagged bots excluded on both sides. Views are those the caller's query selects. */
export interface ClickRateCounts {
  active: { clicks: number; views: number }
  clear: { clicks: number; views: number }
}
export type HistoryClickCounts = ClickRateCounts

/** A click index read against the is-down views — for any click point written as
 *  `[svc, phase, agent, surface, …]` under its own `index1`. `viewsWhere` narrows the views to the
 *  pages that carry the clicked element. */
export function buildClickRateSql(clickIndex: string, dataset = V1_DATASET, viewsWhere = ''): string {
  return (
    `SELECT index1 AS kind, blob2 AS phase, SUM(_sample_interval) AS n ` +
    `FROM ${dataset} ` +
    `WHERE timestamp > NOW() - INTERVAL '1' DAY AND (` +
    `(index1 = '${clickIndex}' AND blob3 != 'bot') OR ` +
    `(index1 = '${ISDOWN_INDEX}' AND blob4 IN ('service', 'group') AND blob5 != 'bot'${viewsWhere})` +
    `) ` +
    `GROUP BY index1, blob2 ` +
    `FORMAT JSON`
  )
}

export function parseClickRateResponse(json: unknown, clickIndex: string): ClickRateCounts | null {
  const data = (json as { data?: unknown })?.data
  if (!Array.isArray(data)) return null
  const counts: ClickRateCounts = { active: { clicks: 0, views: 0 }, clear: { clicks: 0, views: 0 } }
  for (const row of data) {
    const r = row as { kind?: unknown; phase?: unknown; n?: unknown }
    const parsed = Number(r.n)
    const n = Number.isFinite(parsed) ? parsed : 0
    const phase = r.phase === 'active' ? counts.active : counts.clear
    if (r.kind === clickIndex) phase.clicks += n
    else if (r.kind === ISDOWN_INDEX) phase.views += n
  }
  return counts
}

export async function queryClickRate(
  clickIndex: string,
  accountId: string | undefined,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
  viewsWhere = '',
): Promise<ClickRateCounts | null> {
  if (!accountId || !token) return null
  try {
    const res = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: buildClickRateSql(clickIndex, V1_DATASET, viewsWhere) },
    )
    if (!res.ok) {
      console.warn(`[wae] ${clickIndex} SQL query failed: HTTP ${res.status}`)
      return null
    }
    return parseClickRateResponse(await res.json(), clickIndex)
  } catch (err) {
    console.warn(`[wae] ${clickIndex} SQL query error:`, err instanceof Error ? err.message : err)
    return null
  }
}

export const buildHistoryClickSql = (dataset = V1_DATASET): string => buildClickRateSql(HISTORY_CLICK_INDEX, dataset)
export const parseHistoryClickResponse = (json: unknown): HistoryClickCounts | null => parseClickRateResponse(json, HISTORY_CLICK_INDEX)
export const queryHistoryClicks = (accountId: string | undefined, token: string | undefined, fetchImpl: typeof fetch = fetch): Promise<HistoryClickCounts | null> =>
  queryClickRate(HISTORY_CLICK_INDEX, accountId, token, fetchImpl)
