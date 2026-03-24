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

  test('Detection Lead badge not shown for Claude (no detectedAt)', async ({ page }) => {
    // Claude has no detectedAt in mock — no lead badge
    await expect(page.locator('main').getByText(/lead/)).not.toBeVisible()
  })

  test('back button returns to overview', async ({ page }) => {
    const backBtn = page.locator('main').getByRole('button', { name: /Overview|← / })
    await backBtn.click()
    // Should return to overview with service grid
    await expect(page.locator('main button').filter({ hasText: 'Claude API' }).first()).toBeVisible()
  })
})

test.describe('Detection Lead badge', () => {
  test('shows lead badge for OpenAI ongoing incident', async ({ page }) => {
    await page.goto('/')
    await waitForDataLoad(page)
    // Navigate to OpenAI (mock: detectedAt 7min before ongoing incident)
    await page.locator('main button').filter({ hasText: 'OpenAI API' }).first().evaluate((el) => el.click())
    await expect(page.locator('main').getByText('Incident History')).toBeVisible({ timeout: 5000 })
    // Lead badge should be visible for ongoing incident
    await expect(page.locator('main').getByText('lead').first()).toBeVisible()
  })
})
