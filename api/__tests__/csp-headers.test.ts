import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'

// #482 (complete) — vercel.json ships the SPA's ENFORCING Content-Security-Policy. The EDGE SSR pages
// enforce via their OWN per-response headers (see the Edge handlers); this header is SPA-only (its
// `source` is a boundary-anchored negative lookahead excluding the Edge surfaces + proxy routes), and
// `script-src` is hash-locked to index.html's two inline scripts (font-swap + FOUC theme). Guards:
// (a) it's enforcing (not Report-Only), (b) script-src carries both index.html hashes (drift pin) and
// NO 'unsafe-inline', (c) the source admits SPA paths + excludes Edge/proxy routes,
// (c) the origins the SPA + Edge SSR actually use are allowlisted, (d) the report sink is wired.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')
const vercelConfig = JSON.parse(readFileSync(join(repoRoot, 'vercel.json'), 'utf8')) as {
  headers?: Array<{ source: string; headers: Array<{ key: string; value: string }> }>
}

// #482 — the SPA header source is now a negative-lookahead that excludes the Edge SSR surfaces (own
// enforcing headers) + the proxy routes (reports/confirm/feed/api). Locate the block by its CSP key.
function spaCspBlock() {
  const block = vercelConfig.headers?.find((h) => h.headers.some((x) => x.key === 'Content-Security-Policy'))
  expect(block, 'the SPA enforcing-CSP headers block must exist').toBeDefined()
  return block!
}

function cspHeaderValue(): string {
  const csp = spaCspBlock().headers.find((h) => h.key === 'Content-Security-Policy')
  return csp!.value
}

// SHA-256 (base64) of each EXECUTABLE inline <script> in index.html (skip src loaders + JSON-LD) —
// the served dist/index.html is byte-identical (Vite preserves these inline scripts).
function indexHtmlScriptHashes(): string[] {
  const html = readFileSync(join(repoRoot, 'index.html'), 'utf8')
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/g
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    if (/\bsrc=/.test(m[1]) || /application\/ld\+json/.test(m[1])) continue
    out.push(createHash('sha256').update(m[2], 'utf8').digest('base64'))
  }
  return out
}

describe('vercel.json CSP — SPA ENFORCING (#482 complete; Edge SSR enforces via its own headers)', () => {
  it('ships an ENFORCING Content-Security-Policy (not Report-Only) for the SPA', () => {
    const block = spaCspBlock()
    expect(block.headers.some((h) => h.key === 'Content-Security-Policy')).toBe(true)
    // the Report-Only header is retired now the SPA is hash-locked
    expect(block.headers.some((h) => h.key === 'Content-Security-Policy-Report-Only')).toBe(false)
  })

  it('script-src is hash-locked to the two index.html inline scripts (drift pin)', () => {
    const scriptSrc = cspHeaderValue().split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src '))!
    const hashes = indexHtmlScriptHashes()
    expect(hashes.length, 'index.html should have 2 executable inline scripts (font-swap + theme)').toBe(2)
    for (const h of hashes) {
      expect(scriptSrc, `script-src must carry the index.html inline-script hash 'sha256-${h}'`).toContain(`'sha256-${h}'`)
    }
  })

  it('the SPA header source EXCLUDES the Edge SSR + proxy routes (so their own/external policies are not double-gated)', () => {
    const src = spaCspBlock().source
    expect(src).toContain('?!') // negative lookahead, not the bare /(.*)
    for (const r of ['is-', 'intro', 'badges', 'methodology', 'reports', 'confirm', 'feed', 'api']) {
      expect(src, `source lookahead must exclude ${r}`).toContain(r)
    }
    // The lookahead must admit SPA routes (incl. fallback paths that merely START with an excluded
    // token) and reject every real Edge/proxy route. Boundary-anchored so /introspect ≠ /intro etc.
    const re = new RegExp('^' + src + '$')
    for (const p of ['/', '/dashboard', '/introspect', '/feedback', '/feeds', '/reports-archive', '/api-docs']) {
      expect(re.test(p), `SPA path ${p} must KEEP the CSP header`).toBe(true)
    }
    for (const p of ['/is-claude-down', '/intro', '/badges', '/methodology', '/reports', '/reports/', '/reports/2026-03', '/confirm', '/feed.xml', '/feed.xsl', '/feed/claude', '/api/csp-report']) {
      expect(re.test(p), `Edge/proxy route ${p} must be excluded from the SPA header`).toBe(false)
    }
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
    const re = spaCspBlock().headers.find((h) => h.key === 'Reporting-Endpoints')
    expect(re?.value).toContain('csp=')
    expect(re?.value).toContain('/api/csp-report')
  })
})
