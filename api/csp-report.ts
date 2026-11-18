// Vercel Edge Function — CSP violation report sink (#482 Phase 1).
//
// Receives Content-Security-Policy-Report-Only violation reports (wired via the policy's
// `report-uri` + `report-to` in vercel.json) and logs one compact structured line per
// violation so the operator can review what an ENFORCING policy would block — before Phase 2
// (refactor the ~30 inline `onclick`/`onerror` handlers → addEventListener + nonce/hash the
// static inline <script> blocks) and Phase 3 (flip to enforcing). Report-Only breaks nothing;
// this only collects. Always 204s so the browser's reporting pipeline stays quiet.

import { workerApiFor } from './_shared/worker-api'

export const config = { runtime: 'edge' }

// Normalize the two violation-report wire formats into a flat list of records:
//  • report-uri  → `application/csp-report`     : { "csp-report": { "violated-directive", "blocked-uri", … } }
//  • report-to   → `application/reports+json`    : [ { type:"csp-violation", body:{ effectiveDirective, blockedURL, … } }, … ]
// Pure + exported so it's unit-tested without an Edge runtime. Returns [] on non-JSON/garbage.
export function parseCspReports(body: string): Array<Record<string, unknown>> {
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return []
  }
  if (json && typeof json === 'object' && 'csp-report' in json) {
    const r = (json as Record<string, unknown>)['csp-report']
    return r && typeof r === 'object' ? [r as Record<string, unknown>] : []
  }
  if (Array.isArray(json)) {
    return json
      .filter((r) => r && typeof r === 'object' && ((r as Record<string, unknown>).type === 'csp-violation' || 'body' in (r as object)))
      .map((r) => {
        const rec = r as Record<string, unknown>
        return (rec.body && typeof rec.body === 'object' ? rec.body : rec) as Record<string, unknown>
      })
  }
  return []
}

// One-line summary of a report, tolerant of both the kebab-case (report-uri) and camelCase
// (report-to) field names. Exported for the test.
export function summarizeCspReport(r: Record<string, unknown>): string {
  const pick = (keys: readonly string[]) => reportField(r, keys) || '?'
  const directive = pick(DIRECTIVE_KEYS)
  const blocked = pick(BLOCKED_KEYS)
  const doc = pick(DOCUMENT_KEYS)
  const file = pick(['source-file', 'sourceFile'])
  const line = pick(['line-number', 'lineNumber'])
  const where = file !== '?' ? ` src=${file}:${line}` : ''
  return `directive=${directive} blocked=${blocked} doc=${doc}${where}`
}

const DIRECTIVE_KEYS = ['violated-directive', 'effectiveDirective', 'violatedDirective', 'effective-directive'] as const
const BLOCKED_KEYS = ['blocked-uri', 'blockedURL', 'blockedUri'] as const
const DOCUMENT_KEYS = ['document-uri', 'documentURL', 'documentUri'] as const

function reportField(r: Record<string, unknown>, keys: readonly string[]): string {
  for (const k of keys) {
    const v = r[k]
    if (v !== undefined && v !== null && v !== '') return String(v)
  }
  return ''
}

/** #2026 — the fields the worker keeps (api/csp-report.ts logs vanish within the log window). */
export function toViolationRecord(r: Record<string, unknown>): { directive: string; blocked: string; page: string } {
  return {
    directive: reportField(r, DIRECTIVE_KEYS).split(' ')[0],
    blocked: reportField(r, BLOCKED_KEYS),
    page: reportField(r, DOCUMENT_KEYS),
  }
}

export const MAX_FORWARDED = 5

/** One record per distinct directive + blocked URL, at most MAX_FORWARDED per POST. */
export function forwardableRecords(reports: Array<Record<string, unknown>>): Array<{ directive: string; blocked: string; page: string }> {
  const seen = new Set<string>()
  const out: Array<{ directive: string; blocked: string; page: string }> = []
  for (const r of reports) {
    const rec = toViolationRecord(r)
    const key = `${rec.directive} ${rec.blocked}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(rec)
    if (out.length === MAX_FORWARDED) break
  }
  return out
}

/** Production and `vercel dev` only: a Preview's reports would land in the production count. */
export function forwardsFrom(reqUrl: string): boolean {
  const { hostname } = new URL(reqUrl)
  return hostname === 'ai-watch.dev' || hostname === 'localhost' || hostname === '127.0.0.1'
}

/** Returns how many forwards the worker did not accept, and logs that count. */
export async function forwardCspReports(reports: Array<Record<string, unknown>>, req: Request, fetchImpl: typeof fetch = fetch): Promise<number> {
  if (!forwardsFrom(req.url)) return 0
  const target = `${workerApiFor(req.url)}/api/csp-violation`
  const headerOrigin = req.headers.get('Origin')
  const origin = headerOrigin && headerOrigin !== 'null' ? headerOrigin : new URL(req.url).origin
  const results = await Promise.allSettled(
    forwardableRecords(reports).map((rec) =>
      fetchImpl(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify(rec),
        signal: AbortSignal.timeout(3000),
      }),
    ),
  )
  const failed = results.filter((r) => r.status === 'rejected' || !r.value.ok)
  if (failed.length > 0) {
    const first = failed[0]
    const why = first.status === 'rejected' ? String(first.reason) : `HTTP ${first.value.status}`
    console.warn(`[csp-report] ${failed.length}/${results.length} forwards to the worker failed (${why})`)
  }
  return failed.length
}

export default async function handler(req: Request) {
  if (req.method !== 'POST') return new Response(null, { status: 405 })
  try {
    const body = await req.text()
    const reports = parseCspReports(body)
    if (reports.length === 0) {
      // Keep a short trace of unparseable payloads (truncated) — helps if a browser sends a
      // shape we don't handle yet, without flooding logs.
      console.log(`[csp-report] unparsed (${body.slice(0, 200)})`)
    } else {
      for (const r of reports) console.log(`[csp-report] ${summarizeCspReport(r)}`)
      await forwardCspReports(reports, req)
    }
  } catch (err) {
    console.error('[csp-report] handler error:', err instanceof Error ? err.message : err)
  }
  return new Response(null, { status: 204 })
}
