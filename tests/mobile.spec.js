import { test, expect } from '@playwright/test'

test.describe('Mobile viewport', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.locator('main').getByText('Claude API').first().waitFor({ state: 'visible', timeout: 20000 })
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
    // Wait for analyze button (🤖) — mock data includes aiAnalysis for openai
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
})
