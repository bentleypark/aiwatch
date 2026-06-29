import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { generateNonce, buildCsp, nonceAttr } from '../csp-nonce'

describe('generateNonce (#482)', () => {
  it('returns a non-empty base64 string', () => {
    const n = generateNonce()
    expect(n).toMatch(/^[A-Za-z0-9+/]+=*$/)
    expect(n.length).toBeGreaterThan(0)
  })

  it('is unique per call (per-response nonce)', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 100; i++) seen.add(generateNonce())
    expect(seen.size).toBe(100)
  })
})

describe('buildCsp (#482)', () => {
  it('puts the nonce in script-src and keeps unsafe-inline OUT of script-src', () => {
    const { value } = buildCsp('ABC123')
    const scriptSrc = value.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src'))!
    expect(scriptSrc).toContain("'nonce-ABC123'")
    expect(scriptSrc).not.toContain("'unsafe-inline'")
    // GA + Kakao origins still allowlisted
    expect(scriptSrc).toContain('https://www.googletagmanager.com')
    expect(scriptSrc).toContain('https://t1.kakaocdn.net')
  })

  it('keeps unsafe-inline ON style-src (inline style="" attrs are not the #482 target)', () => {
    const { value } = buildCsp('n')
    const styleSrc = value.split(';').map((d) => d.trim()).find((d) => d.startsWith('style-src'))!
    expect(styleSrc).toContain("'unsafe-inline'")
  })

  it('reports to the csp sink and mirrors the core vercel.json directives', () => {
    const { value } = buildCsp('n')
    expect(value).toContain('report-uri /api/csp-report')
    expect(value).toContain('report-to csp')
    expect(value).toContain("default-src 'self'")
    expect(value).toContain("object-src 'none'")
    expect(value).toContain("frame-ancestors 'none'")
  })

  it('defaults to Report-Only; enforce:true switches the header name', () => {
    expect(buildCsp('n').key).toBe('Content-Security-Policy-Report-Only')
    expect(buildCsp('n', { enforce: true }).key).toBe('Content-Security-Policy')
    // same policy value regardless of mode
    expect(buildCsp('n').value).toBe(buildCsp('n', { enforce: true }).value)
  })
})

// Drift pin (review #482 PR1): buildCsp MUST stay byte-identical to the SPA's vercel.json policy,
// modulo the added `'nonce-…'`. Otherwise a new origin added to vercel.json (e.g. a connect-src)
// silently gives the migrated Edge pages a stale, more-restrictive policy. Mirrors the repo's
// other sync-pin tests (api-tier-sync, feed-slug-sync).
describe('buildCsp ↔ vercel.json drift pin (#482)', () => {
  it('matches the vercel.json CSP directive-for-directive (modulo the nonce vs SPA hashes)', () => {
    // vitest runs from the repo root (cwd), where vercel.json lives.
    const vercel = JSON.parse(readFileSync(resolve(process.cwd(), 'vercel.json'), 'utf8'))
    const headerEntry = vercel.headers
      .flatMap((h: { headers: { key: string; value: string }[] }) => h.headers)
      .find((h: { key: string }) => /content-security-policy/i.test(h.key))
    expect(headerEntry, 'vercel.json must carry a CSP header').toBeTruthy()

    const nonce = 'TESTNONCE'
    // Both policies share every directive + origin; they differ ONLY in script-src's per-page tokens —
    // buildCsp (Edge nonce pages) carries `'nonce-…'`, vercel.json (the SPA) carries the index.html
    // inline-script `'sha256-…'` hashes. Strip both token kinds, then the rest must be identical (so a
    // new origin added to vercel.json can't silently desync the Edge nonce policy).
    const built = buildCsp(nonce).value.replace(`'nonce-${nonce}' `, '')
    const vercelStripped = headerEntry.value.replace(/'sha256-[^']+' /g, '')
    expect(built).toBe(vercelStripped)
  })
})

describe('nonceAttr (#482)', () => {
  it('emits a nonce attribute when given a nonce, nothing when empty', () => {
    expect(nonceAttr('abc')).toBe(' nonce="abc"')
    expect(nonceAttr('')).toBe('')
    expect(nonceAttr(undefined)).toBe('')
  })
})
