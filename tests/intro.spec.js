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

  test('PH banner visible with ?ref=producthunt', async ({ page }) => {
    await page.goto('/intro?ref=producthunt', { waitUntil: 'domcontentloaded' })
    const banner = page.locator('#ph-banner')
    await expect(banner).not.toHaveCSS('display', 'none')
    await expect(banner).toContainText('Product Hunters')
  })

  test('PH banner visible with Referer header', async ({ request }) => {
    const res = await request.get('/intro', {
      headers: { 'Referer': 'https://www.producthunt.com/posts/aiwatch' },
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
})
