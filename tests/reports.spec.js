import { test, expect } from './fixtures.js'

// Edge Function /api/reports proxies ai-watch.dev/reports/* to the aiwatch-reports
// Jekyll origin (#264). A regression here — falling through to the SPA — is exactly
// what happened with the previous external-URL rewrite approach, so these tests
// fetch the proxy and verify the response body is Jekyll content, not the SPA.

test.describe('Reports proxy (/reports/*)', () => {
  test('home route returns Jekyll content', async ({ request }) => {
    const res = await request.get('/reports/')
    expect(res.status()).toBe(200)
    const html = await res.text()
    // Jekyll SEO tag marker — present on every Jekyll-rendered page
    expect(html).toContain('Begin Jekyll SEO tag')
    // SPA sanity check: must not be the dashboard
    expect(html).not.toContain('id="root"')
  })

  test('home route without trailing slash also proxies', async ({ request }) => {
    const res = await request.get('/reports')
    expect(res.status()).toBe(200)
    const html = await res.text()
    expect(html).toContain('Begin Jekyll SEO tag')
  })

  test('monthly report with trailing slash proxies', async ({ request }) => {
    // Trailing-slash variants are the path-to-regexp edge case that breaks
    // with a naive `:rest*` rewrite — this asserts the 4-route workaround in
    // vercel.json is wired correctly.
    const res = await request.get('/reports/2026-03/')
    expect(res.status()).toBe(200)
    const html = await res.text()
    expect(html).toContain('Begin Jekyll SEO tag')
    expect(html).toMatch(/<title>[^<]*2026[^<]*<\/title>/)
  })

  test('static asset is proxied', async ({ request }) => {
    const res = await request.get('/reports/assets/main.css')
    expect(res.status()).toBe(200)
    expect(res.headers()['content-type']).toMatch(/css/)
  })

  test('method not allowed for POST', async ({ request }) => {
    const res = await request.post('/reports/')
    expect(res.status()).toBe(405)
    expect(res.headers()['allow']).toBe('GET, HEAD')
  })

  test('HTML paths rewritten so assets resolve under /reports/', async ({ request }) => {
    // Jekyll emits root-relative paths (/assets/main.css). If they reach the
    // browser as-is, the request hits ai-watch.dev/assets/... and falls through
    // to the SPA — the exact failure mode the proxy must prevent.
    const res = await request.get('/reports/')
    const html = await res.text()
    expect(html).toContain('href="/reports/assets/main.css"')
    expect(html).not.toMatch(/href="\/assets\/main\.css"/)
    // Home-link ("/") in nav also rewritten
    expect(html).toContain('href="/reports/"')
  })
})
