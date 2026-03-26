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

      test(`has AIWatch Data summary`, async ({ page: p }) => {
        await p.goto(`/is-${page.slug}-down`, { waitUntil: 'domcontentloaded' })
        // Data summary should contain "Based on AIWatch data" or not exist (when service data unavailable)
        const body = await p.locator('body').textContent()
        if (body?.includes('AIWatch Data:')) {
          expect(body).toMatch(/Based on AIWatch data from the last 30 days/)
          // Should contain either incident count or "zero incidents"
          expect(body).toMatch(/experienced \d+ incident|zero incidents/)
        }
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
    await expect(page.locator('a[href="/is-chatgpt-down"]').first()).toBeAttached()
    await expect(page.locator('a[href="/is-gemini-down"]').first()).toBeAttached()
    await expect(page.locator('a[href="/is-cursor-down"]').first()).toBeAttached()
  })

  test('OG meta tags point to dynamic OG image', async ({ page }) => {
    await page.goto('/is-claude-down', { waitUntil: 'domcontentloaded' })
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', /Is Claude Down/)
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute('content', 'https://ai-watch.dev/is-claude-down')
    // Dynamic OG image URL should contain /api/og with service param
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', /\/api\/og\?service=Claude/)
    await expect(page.locator('meta[name="twitter:image"]')).toHaveAttribute('content', /\/api\/og\?service=Claude/)
  })

  test('share buttons are present', async ({ page }) => {
    await page.goto('/is-claude-down', { waitUntil: 'domcontentloaded' })
    // X (Twitter) share link
    await expect(page.locator('a.share-x')).toHaveAttribute('href', /x\.com\/intent\/tweet/)
    // Threads share link
    await expect(page.locator('a.share-threads')).toHaveAttribute('href', /threads\.net\/intent\/post/)
    // Copy Link button
    await expect(page.locator('button.share-copy')).toBeVisible()
    // KakaoTalk button exists (hidden until SDK loads)
    await expect(page.locator('#kakao-share')).toHaveCount(1)
  })

  test('share text includes AIWatch branding', async ({ page }) => {
    await page.goto('/is-claude-down', { waitUntil: 'domcontentloaded' })
    // Copy button data-text should mention AIWatch
    const copyText = await page.locator('button.share-copy').getAttribute('data-text')
    expect(copyText).toContain('AIWatch')
    // X share href should contain encoded text with AIWatch
    const xHref = await page.locator('a.share-x').getAttribute('href')
    expect(xHref).toContain('AIWatch')
  })

  test('related cross-links are present in footer', async ({ page }) => {
    await page.goto('/is-claude-down', { waitUntil: 'domcontentloaded' })
    // Claude page should cross-link to Claude Code and OpenAI
    await expect(page.locator('a[href="/is-claude-code-down"]').first()).toBeAttached()
    await expect(page.locator('a[href="/is-openai-down"]').first()).toBeAttached()
  })

  test('AI Insight card shows when analysis available', async ({ page }) => {
    await page.goto('/is-claude-down', { waitUntil: 'domcontentloaded' })
    // AI Insight card is conditional — only shows when Worker has analysis data
    const aiCard = page.locator('text=AI Analysis').or(page.locator('text=Post-Incident Analysis'))
    if (await aiCard.isVisible({ timeout: 3000 }).catch(() => false)) {
      // Beta badge present
      await expect(page.locator('text=Beta').first()).toBeVisible()
      // Disclaimer present
      await expect(page.locator('text=AI-generated estimation').first()).toBeAttached()
    }
  })
})
