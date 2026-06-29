import { describe, it, expect } from 'vitest'
import { extractInlineScripts, sha256Base64, buildCspWithHashes, cspForHtml } from '../csp-hash'

describe('extractInlineScripts (#482)', () => {
  it('returns executable inline script bodies, skipping src loaders + JSON-LD', () => {
    const html = `
      <script async src="https://www.googletagmanager.com/gtag/js?id=X"></script>
      <script>console.log('a')</script>
      <script type="application/ld+json">{"@type":"WebPage"}</script>
      <script nonce="n">console.log('b')</script>`
    expect(extractInlineScripts(html)).toEqual(["console.log('a')", "console.log('b')"])
  })
})

describe('sha256Base64 (#482)', () => {
  it('matches the known SHA-256 (base64) of "abc" — the form CSP sha256- expects', async () => {
    // echo -n abc | openssl dgst -sha256 -binary | base64
    expect(await sha256Base64('abc')).toBe('ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=')
  })

  it('is deterministic (a content hash, not a random nonce) — cache-safe', async () => {
    expect(await sha256Base64('x')).toBe(await sha256Base64('x'))
  })
})

describe('buildCspWithHashes (#482)', () => {
  it('puts every hash in script-src as a sha256- source, no unsafe-inline', () => {
    const { value } = buildCspWithHashes(['AAA', 'BBB'])
    const scriptSrc = value.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src'))!
    expect(scriptSrc).toContain("'sha256-AAA'")
    expect(scriptSrc).toContain("'sha256-BBB'")
    expect(scriptSrc).not.toContain("'unsafe-inline'")
    expect(scriptSrc).toContain('https://www.googletagmanager.com')
  })

  it('defaults to Report-Only; enforce:true switches the header name', () => {
    expect(buildCspWithHashes([]).key).toBe('Content-Security-Policy-Report-Only')
    expect(buildCspWithHashes([], { enforce: true }).key).toBe('Content-Security-Policy')
  })
})

describe('cspForHtml (#482)', () => {
  it('hashes the page inline scripts so the policy is derived from the served content', async () => {
    const html = `<script>console.log('a')</script><script type="application/ld+json">{}</script>`
    const { value } = await cspForHtml(html)
    expect(value).toContain(`'sha256-${await sha256Base64("console.log('a')")}'`)
    // JSON-LD is NOT hashed
    expect(value).not.toContain(`'sha256-${await sha256Base64('{}')}'`)
  })

  it('de-dupes identical scripts so the header stays compact', async () => {
    const dup = '<script>x()</script>'
    const { value } = await cspForHtml(dup + dup)
    const hash = await sha256Base64('x()')
    expect(value.split(`'sha256-${hash}'`).length - 1).toBe(1) // appears exactly once
  })
})
