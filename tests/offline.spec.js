import { test, expect } from '@playwright/test'
import { waitForDataLoad } from './helpers.js'

test.describe('Offline / API failure (dev mode)', () => {
  test('falls back to mock data when API is unreachable', async ({ page }) => {
    // Block all API requests to simulate Worker not running
    await page.route('**/api/status*', (route) => route.abort('connectionrefused'))
    await page.goto('/')

    // In dev mode, mock data should load as fallback (network error → MOCK_SERVICES)
    await expect(page.locator('main').getByText('Claude API').first()).toBeVisible({ timeout: 15000 })
    await expect(page.locator('main').getByText('OpenAI API').first()).toBeVisible()

    // Offline EmptyState should NOT appear in dev mode with network error
    await expect(page.getByText(/Unable to connect|연결할 수 없습니다/)).not.toBeVisible()
  })

  test('shows error state when API returns malformed response', async ({ page }) => {
    // Return invalid JSON to simulate a non-network error
    await page.route('**/api/status*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: 'not json' })
    )
    await page.goto('/')

    // Non-network errors should show error UI even in dev mode
    await expect(page.getByText(/Unable to connect|연결할 수 없습니다|Failed to load|불러올 수 없습니다/).first()).toBeVisible({ timeout: 15000 })
  })

  test('mock data includes expected service count', async ({ page }) => {
    await page.route('**/api/status*', (route) => route.abort('connectionrefused'))
    await page.goto('/')

    // Wait for mock data to load
    await expect(page.locator('main').getByText('Claude API').first()).toBeVisible({ timeout: 15000 })

    // Verify key services from mock data are present
    const services = ['Claude API', 'ChatGPT', 'Gemini API', 'Groq Cloud', 'Cursor']
    for (const name of services) {
      await expect(page.locator('main button').filter({ hasText: name }).first()).toBeVisible()
    }
  })
})
