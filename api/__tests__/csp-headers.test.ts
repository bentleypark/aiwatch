import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// #482 Phase 1 — vercel.json must ship a Content-Security-Policy-REPORT-ONLY header (not enforcing
// yet) covering all routes, with the target strict policy so report-only surfaces exactly the inline
// scripts/handlers to refactor in Phase 2. Guards: (a) it stays Report-Only until the refactor lands,
// (b) script-src does NOT carry 'unsafe-inline' (which would suppress the very reports we want),
// (c) the origins the SPA + Edge SSR actually use are allowlisted, (d) the report sink is wired.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')
const vercelConfig = JSON.parse(readFileSync(join(repoRoot, 'vercel.json'), 'utf8')) as {
  headers?: Array<{ source: string; headers: Array<{ key: string; value: string }> }>
}

function cspHeaderValue(): string {
  const block = vercelConfig.headers?.find((h) => h.source === '/(.*)')
  expect(block, 'a catch-all /(.*) headers block must exist').toBeDefined()
  const csp = block!.headers.find((h) => h.key === 'Content-Security-Policy-Report-Only')
  expect(csp, 'Content-Security-Policy-Report-Only header must be present').toBeDefined()
  return csp!.value
}

describe('vercel.json CSP (#482 Phase 1)', () => {
  it('ships report-only (NOT enforcing) so it cannot break the live site during rollout', () => {
    const block = vercelConfig.headers?.find((h) => h.source === '/(.*)')
    const enforcing = block?.headers.find((h) => h.key === 'Content-Security-Policy')
    expect(enforcing, 'must NOT ship an enforcing Content-Security-Policy yet (Phase 3)').toBeUndefined()
    cspHeaderValue() // report-only present
  })

  it('script-src omits unsafe-inline (else inline violations are never reported)', () => {
    const directives = cspHeaderValue().split(';').map((d) => d.trim())
    const scriptSrc = directives.find((d) => d.startsWith('script-src '))
    expect(scriptSrc).toBeDefined()
    expect(scriptSrc).not.toContain("'unsafe-inline'")
    expect(scriptSrc).toContain("'self'")
  })

  it('allowlists the origins the SPA + Edge SSR actually load', () => {
    const csp = cspHeaderValue()
    // external script (GA4 + Kakao SDK)
    expect(csp).toContain('https://www.googletagmanager.com')
    expect(csp).toContain('https://t1.kakaocdn.net')
    // fetch targets (Worker API + GA4 collection)
    expect(csp).toContain('https://aiwatch-worker.p2c2kbf.workers.dev')
    expect(csp).toContain('https://www.google-analytics.com')
    // the Worker origin is also an img-src: status/uptime BADGES on ServiceDetails load from
    // <worker>/badge/<id> (#482 review) — must be allowlisted or every detail page false-reports.
    const imgSrc = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('img-src '))
    expect(imgSrc).toContain('https://aiwatch-worker.p2c2kbf.workers.dev')
    // fonts (gstatic = files, googleapis = stylesheet)
    expect(csp).toContain('https://fonts.gstatic.com')
    expect(csp).toContain('https://fonts.googleapis.com')
  })

  it('hardens framing/base/object and wires the report sink', () => {
    const csp = cspHeaderValue()
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("base-uri 'self'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain('report-uri /api/csp-report')
    expect(csp).toContain('report-to csp')
  })

  it('declares the Reporting-Endpoints csp group → /api/csp-report', () => {
    const block = vercelConfig.headers?.find((h) => h.source === '/(.*)')
    const re = block?.headers.find((h) => h.key === 'Reporting-Endpoints')
    expect(re?.value).toContain('csp=')
    expect(re?.value).toContain('/api/csp-report')
  })
})
