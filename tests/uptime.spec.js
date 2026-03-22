import { test, expect } from '@playwright/test'
import { waitForDataLoad, navigateVia } from './helpers.js'

test.describe('Uptime page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await waitForDataLoad(page)
    await navigateVia(page, 'Uptime Status')
  })

  test('renders summary cards with uptime percentages', async ({ page }) => {
    const main = page.locator('main')
    // At least one uptime percentage should be visible
    await expect(main.getByText(/%/).first()).toBeVisible()
  })

  test('renders uptime rankings with service names', async ({ page }) => {
    const main = page.locator('main')
    // Rankings section should show services with uptime bars
    await expect(main.getByText('Claude API').first()).toBeVisible()
  })

  test('renders uptime matrix', async ({ page }) => {
    const main = page.locator('main')
    // Matrix section should show service names in a grid
    const serviceCount = await main.getByText(/API|Cloud|AI|Copilot|Cursor|Windsurf/).count()
    expect(serviceCount).toBeGreaterThan(0)
  })
})
