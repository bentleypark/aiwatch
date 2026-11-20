// #2026 — CSP violation reports, kept where the daily summary can read them. The browser posts each
// report to the Vercel sink (api/csp-report.ts), whose `forwardCspReports` posts to
// POST /api/csp-violation; each accepted post writes one Analytics Engine point here.
//   index1 = 'csp-violation'
//   blob1  = directive (e.g. 'connect-src')
//   blob2  = blocked host, or the CSP keyword the browser reports ('inline', 'eval', 'data', …)
//   blob3  = page path the violation happened on
//   blob4  = the report's source-file, reduced like blob2 (#2052): host, or the bare scheme ('chrome-extension')

import { V1_DATASET } from './api-traffic'

export const CSP_VIOLATION_INDEX = 'csp-violation'

export interface CspViolation { directive: string; blocked: string; page: string; source: string }

const DIRECTIVE_RE = /^[a-z-]{3,40}$/
const KEYWORD_RE = /^[a-z-]{2,20}$/
const MAX_PAGE = 120

/** The host of a blocked URL, or the bare keyword the browser sends in its place. '' = unusable. */
export function blockedTarget(raw: unknown): string {
  if (typeof raw !== 'string' || !raw) return ''
  try {
    const u = new URL(raw)
    if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'wss:' || u.protocol === 'ws:') return u.host.toLowerCase()
    return u.protocol.replace(/:$/, '')
  } catch {
    const k = raw.toLowerCase()
    return KEYWORD_RE.test(k) ? k : ''
  }
}

/** The path of the document the violation happened on, without query or fragment. */
export function pagePath(raw: unknown): string {
  if (typeof raw !== 'string' || !raw) return ''
  try {
    return new URL(raw).pathname.slice(0, MAX_PAGE)
  } catch {
    return ''
  }
}

export function parseCspViolationBody(body: unknown): CspViolation | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const directive = typeof b.directive === 'string' ? b.directive.toLowerCase() : ''
  if (!DIRECTIVE_RE.test(directive)) return null
  const blocked = blockedTarget(b.blocked)
  if (!blocked) return null
  return { directive, blocked, page: pagePath(b.page), source: blockedTarget(b.source) }
}

export function recordCspViolation(analytics: AnalyticsEngineDataset | undefined, v: CspViolation): void {
  if (!analytics) return
  try {
    analytics.writeDataPoint({ blobs: [v.directive, v.blocked, v.page, v.source], doubles: [1], indexes: [CSP_VIOLATION_INDEX] })
  } catch (err) {
    console.warn('[wae] csp-violation writeDataPoint failed:', err instanceof Error ? err.message : err)
  }
}

export function buildCspViolationSql(dataset = V1_DATASET): string {
  return (
    `SELECT blob1 AS directive, blob2 AS blocked, blob4 AS source, SUM(_sample_interval) AS n ` +
    `FROM ${dataset} ` +
    `WHERE timestamp > NOW() - INTERVAL '1' DAY AND index1 = '${CSP_VIOLATION_INDEX}' ` +
    `GROUP BY blob1, blob2, blob4 ` +
    `FORMAT JSON`
  )
}

export interface CspViolationCounts { total: number; rows: Array<{ directive: string; blocked: string; source: string; n: number }> }

export function parseCspViolationResponse(json: unknown): CspViolationCounts | null {
  const data = (json as { data?: unknown })?.data
  if (!Array.isArray(data)) return null
  const rows = data
    .map((row) => {
      const r = row as { directive?: unknown; blocked?: unknown; source?: unknown; n?: unknown }
      const n = Number(r.n)
      return { directive: String(r.directive ?? '?'), blocked: String(r.blocked ?? '?'), source: String(r.source ?? ''), n: Number.isFinite(n) ? n : 0 }
    })
    .filter((r) => r.n > 0)
    .sort((a, b) => b.n - a.n)
  return { total: rows.reduce((s, r) => s + r.n, 0), rows }
}

export async function queryCspViolations(
  accountId: string | undefined,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<CspViolationCounts | null> {
  if (!accountId || !token) return null
  try {
    const res = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: buildCspViolationSql() },
    )
    if (!res.ok) {
      console.warn(`[wae] csp-violation SQL query failed: HTTP ${res.status}`)
      return null
    }
    return parseCspViolationResponse(await res.json())
  } catch (err) {
    console.warn('[wae] csp-violation SQL query error:', err instanceof Error ? err.message : err)
    return null
  }
}

export const CSP_VIOLATION_TOP_N = 3

/** '' when the read failed; a line (0 included) when it succeeded. */
export function formatCspViolationLine(counts: CspViolationCounts | null | undefined): string {
  if (!counts) return ''
  if (counts.total === 0) return '🛡️ **CSP Violations** (24h): 0'
  const top = counts.rows.slice(0, CSP_VIOLATION_TOP_N).map((r) => `${r.directive} ${r.blocked}${r.source ? ` (from ${r.source})` : ''} ×${r.n}`).join(' · ')
  const more = counts.rows.length > CSP_VIOLATION_TOP_N ? ` · +${counts.rows.length - CSP_VIOLATION_TOP_N} more` : ''
  return `🛡️ **CSP Violations** (24h): ${counts.total} — ${top}${more}`
}
