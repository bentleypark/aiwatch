import { test, expect } from '@playwright/test'

test.describe('Landing page (/intro)', () => {
  test('renders with correct title and meta', async ({ page }) => {
    await page.goto('/intro', { waitUntil: 'domcontentloaded' })
    await expect(page).toHaveTitle(/AIWatch/)
    const desc = page.locator('meta[name="description"]')
    await expect(desc).toHaveAttribute('content', /Claude|OpenAI|Gemini/)
    const ogImage = page.locator('meta[property="og:image"]')
    await expect(ogImage).toHaveAttribute('content', /og-intro\.png/)
  })

  test('hero section is visible with CTA buttons', async ({ page }) => {
    await page.goto('/intro', { waitUntil: 'domcontentloaded' })
    const hero = page.locator('.hero-left')
    await expect(hero.locator('h1')).toBeVisible()
    await expect(hero.locator('a.btn-primary')).toBeVisible()
    await expect(hero.locator('a.btn-secondary')).toBeVisible()
  })

  test('dashboard mock shows service cards', async ({ page }) => {
    await page.goto('/intro', { waitUntil: 'domcontentloaded' })
    await expect(page.locator('.dashboard-mock')).toBeVisible()
    await expect(page.locator('.mock-cards > .mock-card')).toHaveCount(4) // 3 services + 1 "more"
  })

  test('PH banner hidden by default', async ({ page }) => {
    await page.goto('/intro', { waitUntil: 'domcontentloaded' })
    const banner = page.locator('#ph-banner')
    await expect(banner).toHaveCSS('display', 'none')
  })

  test('PH banner visible with ?ref=producthunt and upvote link', async ({ page }) => {
    await page.goto('/intro?ref=producthunt', { waitUntil: 'domcontentloaded' })
    const banner = page.locator('#ph-banner')
    await expect(banner).not.toHaveCSS('display', 'none')
    await expect(banner).toContainText('Product Hunters')
    const link = banner.locator('a')
    await expect(link).toHaveAttribute('href', 'https://www.producthunt.com/products/aiwatch-2')
    await expect(link).toHaveAttribute('target', '_blank')
  })

  test('PH banner visible with Referer header', async ({ request }) => {
    const res = await request.get('/intro', {
      headers: { 'Referer': 'https://www.producthunt.com/products/aiwatch-2' },
    })
    expect(res.status()).toBe(200)
    const html = await res.text()
    expect(html).toContain('id="ph-banner" style="display:block')
  })

  test('PH banner hidden without Referer', async ({ request }) => {
    const res = await request.get('/intro')
    expect(res.status()).toBe(200)
    const html = await res.text()
    expect(html).toContain('id="ph-banner" style="display:none')
  })

  test('i18n toggle switches language', async ({ page }) => {
    await page.goto('/intro', { waitUntil: 'domcontentloaded' })
    const toggle = page.locator('.lang-toggle button')
    // Playwright Chrome defaults to en-US, so page starts in EN
    // Switch to KO
    await toggle.filter({ hasText: 'KO' }).click()
    await expect(page.locator('.hero-left h1')).toContainText('나만 안 되는 건가요')
    // Switch back to EN
    await toggle.filter({ hasText: 'EN' }).click()
    await expect(page.locator('.hero-left h1')).toContainText('is it just you')
  })

  test('flow animation elements exist', async ({ page }) => {
    await page.goto('/intro', { waitUntil: 'domcontentloaded' })
    for (const id of ['fw1', 'fw2', 'fw3', 'fw4']) {
      await expect(page.locator(`#${id}`)).toBeAttached()
    }
  })

  test('page-wrap wrapper has overflow-x:clip (not on html/body)', async ({ page }) => {
    await page.goto('/intro', { waitUntil: 'domcontentloaded' })
    // overflow-x must be on .page-wrap, not html/body (iOS IO compatibility)
    await expect(page.locator('.page-wrap')).toBeAttached()
    const wrapOverflow = await page.locator('.page-wrap').evaluate(el => getComputedStyle(el).overflowX)
    expect(wrapOverflow).toBe('clip')
    const htmlOverflow = await page.locator('html').evaluate(el => getComputedStyle(el).overflowX)
    expect(htmlOverflow).not.toBe('clip')
    expect(htmlOverflow).not.toBe('hidden')
  })

  test('flow steps get .show class via IntersectionObserver', async ({ page }) => {
    await page.goto('/intro', { waitUntil: 'domcontentloaded' })
    // Flow widget is in viewport on desktop — IO triggers .show (auto-retry)
    for (const id of ['fw1', 'fw2', 'fw3', 'fw4']) {
      await expect(page.locator(`#${id}`)).toHaveClass(/show/, { timeout: 5000 })
    }
  })

  test('flow steps have CSS keyframe animation when .show', async ({ page }) => {
    await page.goto('/intro', { waitUntil: 'domcontentloaded' })
    await expect(page.locator('#fw1')).toHaveClass(/show/, { timeout: 5000 })
    const fw1Anim = await page.locator('#fw1').evaluate(el => getComputedStyle(el).animationName)
    expect(fw1Anim).toContain('fc1')
  })

  test('mobile: hero-right has no fadeInUp animation', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto('/intro', { waitUntil: 'domcontentloaded' })
    const heroRight = page.locator('.hero-right')
    await expect(heroRight).toHaveCSS('animation-name', 'none')
    await expect(heroRight).toHaveCSS('opacity', '1')
  })

  test('fade-up sections become visible on scroll', async ({ page }) => {
    await page.goto('/intro', { waitUntil: 'domcontentloaded' })
    await page.locator('.features-section').scrollIntoViewIfNeeded()
    const featureCard = page.locator('.feature-card.fade-up').first()
    await expect(featureCard).toHaveClass(/visible/, { timeout: 5000 })
  })
})
