import { test, expect } from '@playwright/test'
import { waitForDataLoad } from './helpers.js'

// Navigation tests only on desktop (sidebar visible)
test.use({ viewport: { width: 1280, height: 720 } })

test.describe('Sidebar navigation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await waitForDataLoad(page)
  })

  test('4 menu items navigate to correct pages', async ({ page }) => {
    const sidebar = page.locator('aside').first()

    // Latency page (evaluate to bypass ticker bar overlay)
    await sidebar.getByRole('button', { name: 'Latency' }).evaluate((el) => el.click())
    await expect(page.locator('main').getByText('Current Rankings')).toBeVisible()

    // Incidents page
    await sidebar.getByRole('button', { name: 'Incidents' }).evaluate((el) => el.click())
    await expect(page.locator('main select').first()).toBeVisible()

    // Uptime Report page
    await sidebar.getByRole('button', { name: 'Uptime Report' }).evaluate((el) => el.click())
    await expect(page.locator('main').getByText('Most Stable')).toBeVisible()

    // Back to Overview
    await sidebar.getByRole('button', { name: 'Overview' }).evaluate((el) => el.click())
    await expect(page.locator('main button').filter({ hasText: 'Claude API' })).toBeVisible()
  })
})
