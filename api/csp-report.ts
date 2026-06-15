// Vercel Edge Function — CSP violation report sink (#482 Phase 1).
//
// Receives Content-Security-Policy-Report-Only violation reports (wired via the policy's
// `report-uri` + `report-to` in vercel.json) and logs one compact structured line per
// violation so the operator can review what an ENFORCING policy would block — before Phase 2
// (refactor the ~30 inline `onclick`/`onerror` handlers → addEventListener + nonce/hash the
// static inline <script> blocks) and Phase 3 (flip to enforcing). Report-Only breaks nothing;
// this only collects. Always 204s so the browser's reporting pipeline stays quiet.

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
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = r[k]
      if (v !== undefined && v !== null && v !== '') return String(v)
    }
    return '?'
  }
  const directive = pick('violated-directive', 'effectiveDirective', 'violatedDirective', 'effective-directive')
  const blocked = pick('blocked-uri', 'blockedURL', 'blockedUri')
  const doc = pick('document-uri', 'documentURL', 'documentUri')
  const file = pick('source-file', 'sourceFile')
  const line = pick('line-number', 'lineNumber')
  const where = file !== '?' ? ` src=${file}:${line}` : ''
  return `directive=${directive} blocked=${blocked} doc=${doc}${where}`
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
    }
  } catch (err) {
    console.error('[csp-report] handler error:', err instanceof Error ? err.message : err)
  }
  return new Response(null, { status: 204 })
}
