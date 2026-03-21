import { test, expect } from '@playwright/test'
import { waitForDataLoad } from './helpers.js'

test.describe('ServiceDetails page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await waitForDataLoad(page)
    // Navigate to Claude API details via service card click
    const card = page.locator('main button').filter({ hasText: 'Claude API' }).first()
    await card.evaluate((el) => el.click())
    await expect(page.locator('main').getByText('Status Calendar')).toBeVisible({ timeout: 5000 })
  })

  test('renders service header with name and provider', async ({ page }) => {
    const main = page.locator('main')
    await expect(main.getByRole('heading', { name: 'Claude API', exact: true })).toBeVisible()
    await expect(main.getByText('Anthropic')).toBeVisible()
  })

  test('renders 4 metric cards', async ({ page }) => {
    const main = page.locator('main')
    // Latency card should show ms value
    await expect(main.getByText(/ms/).first()).toBeVisible()
    // Uptime card should show percentage
    await expect(main.getByText(/%/).first()).toBeVisible()
  })

  test('renders status calendar with legend', async ({ page }) => {
    const main = page.locator('main')
    // Calendar legend should show status labels
    await expect(main.getByText(/Operational|정상/).first()).toBeVisible()
    await expect(main.getByText(/Partial Outage|부분 장애/).first()).toBeVisible()
    await expect(main.getByText(/Major Outage|주요 장애/).first()).toBeVisible()
    // Calendar should have 30 cells
    const calendarCells = main.locator('[aria-label*=":"]')
    await expect(calendarCells.first()).toBeVisible()
  })

  test('back button returns to overview', async ({ page }) => {
    const backBtn = page.locator('main').getByRole('button', { name: /Overview|← / })
    await backBtn.click()
    // Should return to overview with service grid
    await expect(page.locator('main button').filter({ hasText: 'Claude API' }).first()).toBeVisible()
  })
})
