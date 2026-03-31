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

  test('action banner hides incident link when degraded service has no incidents', async ({ page }) => {
    // Intercept API and return a single degraded service with NO incidents
    await page.route('**/api/status*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          services: [
            { id: 'azureopenai', category: 'api', name: 'Azure OpenAI', provider: 'Microsoft', status: 'degraded', latency: 350, uptime30d: null, incidents: [] },
            { id: 'claude', category: 'api', name: 'Claude API', provider: 'Anthropic', status: 'operational', latency: 145, uptime30d: 99.97, incidents: [] },
            { id: 'openai', category: 'api', name: 'OpenAI API', provider: 'OpenAI', status: 'operational', latency: 200, uptime30d: 99.99, incidents: [] },
          ],
          lastUpdated: new Date().toISOString(),
        }),
      })
    )
    await page.goto('/')
    await expect(page.locator('main').getByText('Azure OpenAI').first()).toBeVisible({ timeout: 15000 })

    // Banner should show degraded label
    await expect(page.locator('main').getByText(/Degraded|성능 저하/).first()).toBeVisible()

    // "View incident details" link should NOT appear (no incidents)
    await expect(page.locator('main').getByText(/View incident details|인시던트 상세 확인/)).not.toBeVisible()
  })

  test('action banner shows incident link when investigating service has active incidents', async ({ page }) => {
    // Intercept API and return an operational service with an unresolved incident
    await page.route('**/api/status*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          services: [
            { id: 'copilot', category: 'agent', name: 'GitHub Copilot', provider: 'Microsoft', status: 'operational', latency: null, uptime30d: 99.4, incidents: [
              { id: 'cp-test', title: 'Billing issues', status: 'investigating', impact: 'minor', startedAt: new Date().toISOString(), duration: null },
            ] },
            { id: 'claude', category: 'api', name: 'Claude API', provider: 'Anthropic', status: 'operational', latency: 145, uptime30d: 99.97, incidents: [] },
          ],
          lastUpdated: new Date().toISOString(),
        }),
      })
    )
    await page.goto('/')
    await expect(page.locator('main').getByText('GitHub Copilot').first()).toBeVisible({ timeout: 15000 })

    // Banner should show investigating label
    await expect(page.locator('main').getByText(/Investigating|조사 중/).first()).toBeVisible()

    // "View incident details" link SHOULD appear (has active incident)
    await expect(page.locator('main').getByText(/View incident details|인시던트 상세 확인/).first()).toBeVisible()
  })
})
