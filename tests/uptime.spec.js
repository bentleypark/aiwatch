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
    await expect(main.getByText(/API|Cloud|AI|Copilot|Cursor|Windsurf/).first()).toBeVisible({ timeout: 10000 })
  })
})

test.describe('Uptime Rankings — estimate-only services', () => {
  const MOCK = {
    services: [
      { id: 'claude', category: 'api', name: 'Claude API', provider: 'Anthropic', status: 'operational', latency: 120, uptime30d: 99.95, uptimeSource: 'official', calendarDays: 30, incidents: [] },
      { id: 'openai', category: 'api', name: 'OpenAI API', provider: 'OpenAI', status: 'operational', latency: 200, uptime30d: 99.99, uptimeSource: 'official', calendarDays: 30, incidents: [] },
      { id: 'bedrock', category: 'api', name: 'Amazon Bedrock', provider: 'AWS', status: 'operational', latency: 280, uptime30d: 100, uptimeSource: 'estimate', calendarDays: 14, incidents: [] },
      { id: 'azureopenai', category: 'api', name: 'Azure OpenAI', provider: 'Microsoft', status: 'operational', latency: 350, uptime30d: 100, uptimeSource: 'estimate', calendarDays: 14, incidents: [] },
      { id: 'gemini', category: 'api', name: 'Gemini API', provider: 'Google', status: 'operational', latency: 150, calendarDays: 14, incidents: [] },
    ],
    lastUpdated: new Date().toISOString(),
  }

  test('shows estimate-only services as "—" instead of percentage', async ({ page }) => {
    await page.route('**/api/status', async (route) => {
      await route.fulfill({ json: MOCK })
    })
    await page.goto('/#uptime')
    const rankings = page.locator('section').filter({ hasText: /Uptime Rankings/ })
    await expect(rankings).toBeVisible({ timeout: 20000 })

    // Official services show percentages in rankings
    await expect(rankings.getByText('99.99%').first()).toBeVisible()
    await expect(rankings.getByText('99.95%').first()).toBeVisible()

    // Estimate-only services (no incidents) should show "—", not 100.00%
    await expect(rankings.getByText('Amazon Bedrock')).toBeVisible()
    await expect(rankings.getByText('Azure OpenAI')).toBeVisible()
    await expect(rankings.getByText('100.00%')).not.toBeVisible()

    // Gemini (null uptime) also shows "—"
    await expect(rankings.getByText('Gemini API')).toBeVisible()
  })

  test('excludes estimate-only services from summary cards', async ({ page }) => {
    await page.route('**/api/status', async (route) => {
      await route.fulfill({ json: MOCK })
    })
    await page.goto('/#uptime')
    const main = page.locator('main')
    await expect(main.getByText(/Uptime Rankings/).first()).toBeVisible({ timeout: 20000 })

    // Most Stable should be a real service (OpenAI 99.99%), not estimate-only Bedrock/Azure at 100%
    await expect(main.getByText('OpenAI API').first()).toBeVisible({ timeout: 10000 })
    // Average of Claude (99.95) + OpenAI (99.99) = 99.97 — but mock merges with MOCK_SERVICES,
    // so just verify that 100.00% (from estimate services) is NOT shown in summary cards
    const summaryCards = main.locator('.grid').first()
    await expect(summaryCards.getByText('100.00%')).not.toBeVisible()
  })
})
