import { test, expect } from '@playwright/test'

const PAGES = [
  { slug: 'claude', title: 'Is Claude Down?', displayName: 'Claude' },
  { slug: 'chatgpt', title: 'Is ChatGPT Down?', displayName: 'ChatGPT' },
  { slug: 'gemini', title: 'Is Gemini Down?', displayName: 'Gemini' },
  { slug: 'github-copilot', title: 'Is GitHub Copilot Down?', displayName: 'GitHub Copilot' },
  { slug: 'cursor', title: 'Is Cursor Down?', displayName: 'Cursor' },
]

test.describe('Is X Down? SSR pages', () => {
  for (const page of PAGES) {
    test.describe(page.slug, () => {
      test(`renders with correct title`, async ({ page: p }) => {
        await p.goto(`/is-${page.slug}-down`, { waitUntil: 'domcontentloaded' })
        await expect(p).toHaveTitle(new RegExp(page.title))
      })

      test(`shows status indicator`, async ({ page: p }) => {
        await p.goto(`/is-${page.slug}-down`, { waitUntil: 'domcontentloaded' })
        // Status should be one of: Operational, Degraded Performance, Down
        await expect(p.locator('body')).toContainText(/(Operational|Degraded Performance|Down)/)
      })

      test(`has canonical URL`, async ({ page: p }) => {
        await p.goto(`/is-${page.slug}-down`, { waitUntil: 'domcontentloaded' })
        const canonical = p.locator('link[rel="canonical"]')
        await expect(canonical).toHaveAttribute('href', `https://ai-watch.dev/is-${page.slug}-down`)
      })

      test(`has FAQ section with schema.org markup`, async ({ page: p }) => {
        await p.goto(`/is-${page.slug}-down`, { waitUntil: 'domcontentloaded' })
        await expect(p.locator('h2', { hasText: 'Frequently Asked Questions' })).toBeVisible()
        // Verify FAQPage JSON-LD exists
        const jsonLd = await p.locator('script[type="application/ld+json"]').allTextContents()
        const hasFaqSchema = jsonLd.some(t => t.includes('FAQPage'))
        expect(hasFaqSchema).toBe(true)
      })

      test(`has About section with insight`, async ({ page: p }) => {
        await p.goto(`/is-${page.slug}-down`, { waitUntil: 'domcontentloaded' })
        await expect(p.locator('h2', { hasText: `About ${page.displayName}` })).toBeVisible()
        await expect(p.locator('body')).toContainText('AIWatch Insight:')
      })

      test(`has CTA alert banner`, async ({ page: p }) => {
        await p.goto(`/is-${page.slug}-down`, { waitUntil: 'domcontentloaded' })
        await expect(p.locator('.cta')).toBeVisible()
        await expect(p.locator('.cta a.btn-primary')).toHaveAttribute('href', 'https://ai-watch.dev/#settings')
      })

      test(`has GA4 tag`, async ({ page: p }) => {
        await p.goto(`/is-${page.slug}-down`, { waitUntil: 'domcontentloaded' })
        const ga = p.locator('script[src*="googletagmanager.com/gtag/js"]')
        await expect(ga).toHaveAttribute('src', /G-D4ZWVHQ7JK/)
      })
    })
  }

  test('unknown slug does not match edge function', async ({ page }) => {
    // Unknown slugs are not in vercel.json rewrites, so they fall through to SPA
    // In vercel dev, this may cause redirects — we just verify the edge function
    // doesn't serve content for unknown slugs by checking the API directly
    const res = await page.request.get('/api/is-down?slug=nonexistent')
    expect(res.status()).toBe(404)
  })

  test('meta description contains dynamic status', async ({ page }) => {
    await page.goto('/is-claude-down', { waitUntil: 'domcontentloaded' })
    const desc = page.locator('meta[name="description"]')
    await expect(desc).toHaveAttribute('content', /Check if Claude is down right now/)
  })

  test('footer has internal cross-links to other service pages', async ({ page }) => {
    await page.goto('/is-claude-down', { waitUntil: 'domcontentloaded' })
    await expect(page.locator('a[href="/is-chatgpt-down"]')).toBeVisible()
    await expect(page.locator('a[href="/is-gemini-down"]')).toBeVisible()
    await expect(page.locator('a[href="/is-cursor-down"]')).toBeVisible()
  })

  test('OG meta tags are present', async ({ page }) => {
    await page.goto('/is-claude-down', { waitUntil: 'domcontentloaded' })
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', /Is Claude Down/)
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute('content', 'https://ai-watch.dev/is-claude-down')
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', /og-image/)
  })
})
