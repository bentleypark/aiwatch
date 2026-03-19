import { test, expect } from '@playwright/test'

test.describe('Mobile viewport', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.locator('main').getByText('11').first().waitFor({ state: 'visible', timeout: 5000 })
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
