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
    await expect(page.locator('main select').first()).toBeVisible()

    // Uptime Status page
    await sidebar.getByRole('button', { name: 'Uptime Status' }).click()
    await expect(page.locator('main').getByText('Most Stable')).toBeVisible()

    // Back to Overview
    await sidebar.getByRole('button', { name: 'Overview' }).click()
    await expect(page.locator('main button').filter({ hasText: 'Claude API' })).toBeVisible()
  })

  test('Monthly Reports link opens external page in new tab', async ({ page }) => {
    const sidebar = page.locator('aside').first()
    const reportsLink = sidebar.getByRole('link', { name: 'Reports' })

    await expect(reportsLink).toBeVisible()
    await expect(reportsLink).toHaveAttribute('href', 'https://reports.ai-watch.dev/')
    await expect(reportsLink).toHaveAttribute('target', '_blank')
  })
})
