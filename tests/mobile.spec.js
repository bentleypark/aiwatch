import { test, expect } from '@playwright/test'
import { waitForDataLoad } from './helpers.js'

test.describe('Mobile viewport', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    // Use the shared helper (visible-filtered) instead of an inline copy so the
    // 0×0 'Claude API' fix lives in one place (#455).
    await waitForDataLoad(page)
  })

  test('sidebar hidden by default, hamburger opens overlay', async ({ page }) => {
    // Hamburger button visible in header
    const menuBtn = page.locator('header button').first()
    await expect(menuBtn).toBeVisible()

    // Click hamburger to open sidebar overlay
    await menuBtn.click()

    // Mobile sidebar overlay should appear
    const mobileSidebar = page.locator('aside.md\\:hidden')
    await expect(mobileSidebar).toBeVisible()
    await expect(mobileSidebar.getByText('Overview')).toBeVisible()
    await expect(mobileSidebar.getByText('Claude API')).toBeVisible()
  })

  test('service cards use compact layout on mobile', async ({ page }) => {
    // Mobile compact: single row with name + metrics
    const card = page.locator('main button').filter({ hasText: 'Claude API' }).first()
    await expect(card).toBeVisible()
    // Desktop layout should be hidden at mobile viewport
    const desktopLayout = card.locator('.hidden.md\\:block')
    await expect(desktopLayout).not.toBeVisible()
    // Mobile layout should be visible
    const mobileLayout = card.locator('.md\\:hidden')
    await expect(mobileLayout).toBeVisible()
  })

  test('topbar icons stay within viewport when analyze button is visible', async ({ page }) => {
    // Provide deterministic analysis data so the 🤖 button is present — the DEV
    // mock fallback's analysis only appears when no worker is reachable, so a
    // running local worker would otherwise leave the button disabled (#455).
    await page.route('**/api/status**', (route) => route.fulfill({ json: {
      services: [
        { id: 'openai', category: 'api', name: 'OpenAI API', provider: 'OpenAI', status: 'degraded', latency: 200, uptime30d: 99.9, incidents: [
          { id: 'oi-m', title: 'Elevated errors', status: 'investigating', impact: 'major', startedAt: new Date().toISOString(), duration: null, timeline: [] },
        ] },
      ],
      aiAnalysis: { openai: [{ summary: 'Elevated error rate under investigation.', estimatedRecovery: '~1h', affectedScope: ['API'], needsFallback: true, analyzedAt: new Date().toISOString(), incidentId: 'oi-m' }] },
      lastUpdated: new Date().toISOString(),
    } }))
    await page.reload()

    // Wait for analyze button (🤖) — enabled because the mock has an active analysis
    const analyzeBtn = page.locator('header button[aria-label]').filter({ hasText: '🤖' })
    await expect(analyzeBtn).toBeVisible({ timeout: 10000 })

    // Verify all topbar action icons are within viewport (375px)
    const viewportWidth = 375
    const header = page.locator('header')
    const headerBox = await header.boundingBox()
    expect(headerBox.width).toBeLessThanOrEqual(viewportWidth)

    // Ensure no horizontal overflow — header content should not exceed viewport
    const overflowX = await header.evaluate((el) => el.scrollWidth > el.clientWidth)
    expect(overflowX).toBe(false)

    // Analyze button should be fully visible (right edge within viewport)
    const btnBox = await analyzeBtn.boundingBox()
    expect(btnBox.x + btnBox.width).toBeLessThanOrEqual(viewportWidth)
  })

  test('incident card has adequate horizontal padding on mobile', async ({ page }) => {
    // Navigate to Incidents page via sidebar
    await page.locator('header button').first().click()
    const mobileSidebar = page.locator('aside.md\\:hidden')
    await expect(mobileSidebar).toBeVisible()
    await mobileSidebar.getByRole('button', { name: 'Incidents' }).click()
    await page.waitForTimeout(500)

    // Find mobile incident cards
    const cards = page.locator('.md\\:hidden button').filter({ hasText: /Resolved|Monitoring|In Progress/ })
    const count = await cards.count()
    if (count === 0) return // no incidents

    // Verify card has inline padding applied (paddingLeft >= 10px)
    const paddingLeft = await cards.first().evaluate(el => parseInt(getComputedStyle(el).paddingLeft))
    expect(paddingLeft).toBeGreaterThanOrEqual(10)
  })

  test('mobile incident timeline hides redundant header', async ({ page }) => {
    // Navigate to Incidents page
    await page.goto('/#incidents')
    await page.waitForTimeout(2000)

    // Find mobile incident cards (within the md:hidden container)
    const mobileList = page.locator('.flex.flex-col.gap-2.md\\:hidden')
    const cards = mobileList.locator('button').filter({ hasText: /Resolved|Monitoring|In Progress/ })
    const count = await cards.count()
    if (count === 0) return // no incidents

    // Click first card to expand timeline
    await cards.first().evaluate(el => el.click())
    await page.waitForTimeout(500)

    // Check DOM: timeline panel should exist and have no header border-b div
    const hasHeaderDivider = await page.evaluate(() => {
      const panels = document.querySelectorAll('.rounded-lg.overflow-hidden.mt-2')
      for (const panel of panels) {
        if (panel.offsetParent !== null) { // visible panel
          const borderB = panel.querySelector('[class*="border-b"]')
          return !!borderB
        }
      }
      // Check all panels including those in hidden containers
      for (const panel of panels) {
        const borderB = panel.querySelector('[class*="border-b"]')
        if (borderB) return true
      }
      return false
    })
    expect(hasHeaderDivider).toBe(false)

    // Timeline dots should exist
    const hasDots = await page.evaluate(() => {
      const panels = document.querySelectorAll('.rounded-lg.overflow-hidden.mt-2')
      for (const panel of panels) {
        const dots = panel.querySelectorAll('.rounded-full')
        if (dots.length > 0) return true
      }
      return false
    })
    expect(hasDots).toBe(true)

    // No close button inside the mobile timeline
    const hasCloseBtn = await page.evaluate(() => {
      const mobileContainer = document.querySelector('.flex.flex-col.gap-2[class*="md:hidden"]')
      if (!mobileContainer) return false
      const panels = mobileContainer.querySelectorAll('.rounded-lg.overflow-hidden.mt-2')
      for (const panel of panels) {
        if (panel.querySelector('button')) return true
      }
      return false
    })
    expect(hasCloseBtn).toBe(false)
  })

  test('latency chart shows Top 8 by Score badge on mobile', async ({ page }) => {
    // Navigate to Latency page
    await page.goto('/#latency')
    const main = page.locator('main')
    await expect(main.getByText(/Top 8 by Score|Score 상위 8개/)).toBeVisible({ timeout: 10000 })
  })

  test('backdrop click closes sidebar overlay', async ({ page }) => {
    // Open sidebar
    await page.locator('header button').first().click()
    const mobileSidebar = page.locator('aside.md\\:hidden')
    await expect(mobileSidebar).toBeVisible()

    // Click backdrop — trigger onSidebarClose via evaluate on the backdrop div
    const backdrop = page.locator('div.fixed.inset-0.md\\:hidden')
    await backdrop.evaluate((el) => el.click())
    await page.waitForTimeout(500)

    // Mobile sidebar should be gone (the entire overlay is removed from DOM)
    await expect(mobileSidebar).toHaveCount(0)
  })

  // #817 — the score-card header's coverage notice (a recently-added <30d service shows
  // "Building data (<30 days) — not yet ranked") used to overrun into the large score
  // number on narrow widths because the left label group could not wrap/shrink and the
  // score span was not shrink-protected. Assert the notice never invades the score.
  test('#817 — score coverage notice does not overlap the score number on mobile', async ({ page }) => {
    const mock = { json: { services: [
      { id: 'bfl', category: 'api', name: 'Black Forest Labs (FLUX)', provider: 'Black Forest Labs',
        status: 'operational', latency: 700, uptime30d: 100, aiwatchScore: 95, scoreGrade: 'excellent',
        scoreConfidence: 'high', coverageDays: 4, calendarDays: 30, incidents: [],
        scoreBreakdown: { uptime: 40, incidents: 25, recovery: 15, responsiveness: 15, responsivenessStatus: 'available' } },
    ], lastUpdated: new Date().toISOString() } }
    await page.route('**/api/status**', (route) => route.fulfill(mock))
    await page.route('**/api/status/cached', (route) => route.fulfill(mock))
    await page.goto('/#bfl')
    await page.reload()

    const header = page.locator('section').filter({ hasText: 'AIWatch Score' }).locator('> div').first()
    const notice = header.getByText(/Building data \(<30 days\)|데이터 수집 중 \(30일 미만\)/)
    const score = header.locator(':scope > span') // the score number is the header's only direct span child
    await expect(notice).toBeVisible({ timeout: 10000 })
    // Pin `score` to the one score-number node so the geometry assertion can't silently
    // degrade into measuring the wrong box if a refactor adds another direct-span child.
    await expect(score).toHaveCount(1)
    await expect(score).toHaveText('95')

    const noticeBox = await notice.boundingBox()
    const scoreBox = await score.boundingBox()
    // The notice (in the left label group) must keep a real gap to the LEFT of the score number.
    // In the buggy layout the un-wrappable label group pushed the notice's right edge flush
    // against the score (gap ≈ 0px, the cramped IMG_7655 look); the fix wraps the notice within
    // a min-w-0 column separated from the shrink-protected score by `gap-3` (≥12px). A required
    // ≥8px gap distinguishes the two without being brittle to sub-pixel font rounding.
    const gap = scoreBox.x - (noticeBox.x + noticeBox.width)
    expect(gap).toBeGreaterThanOrEqual(8)
  })
})
