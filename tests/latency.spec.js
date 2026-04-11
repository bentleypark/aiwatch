import { test, expect } from '@playwright/test'
import { waitForDataLoad, navigateVia } from './helpers.js'

test.describe('Latency page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await waitForDataLoad(page)
    await navigateVia(page, 'Latency')
  })

  test('renders summary cards with latency values', async ({ page }) => {
    // Three summary cards: fastest, average, slowest
    const main = page.locator('main')
    await expect(main.getByText(/ms/).first()).toBeVisible()
    // At least one card should show a service name as sub-text
    await expect(main.getByText(/API|Cloud|AI/).first()).toBeVisible()
  })

  test('renders latency rankings with service names', async ({ page }) => {
    // Rankings section should show numbered services with latency bars
    const main = page.locator('main')
    await expect(main.getByText('Claude API').first()).toBeVisible()
    await expect(main.getByText('OpenAI API').first()).toBeVisible()
  })

  test('renders 24h trend section', async ({ page }) => {
    const main = page.locator('main')
    // Trend section header should be visible (canvas or "Collecting data" depending on data availability)
    await expect(main.getByText(/trend/i).first()).toBeVisible({ timeout: 10000 })
  })
})
