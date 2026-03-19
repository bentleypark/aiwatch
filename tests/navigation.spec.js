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

    // Latency page
    await sidebar.getByRole('button', { name: 'Latency' }).click()
    await expect(page.locator('main').getByText('Current Rankings')).toBeVisible()

    // Incidents page
    await sidebar.getByRole('button', { name: 'Incidents' }).click()
    // Filter bar dropdowns
    await expect(page.locator('main select').first()).toBeVisible()

    // Uptime Report page
    await sidebar.getByRole('button', { name: 'Uptime Report' }).click()
    await expect(page.locator('main').getByText('Most Stable')).toBeVisible()

    // Back to Overview
    await sidebar.getByRole('button', { name: 'Overview' }).click()
    await expect(page.locator('main button').filter({ hasText: 'Claude API' })).toBeVisible()
  })
})
