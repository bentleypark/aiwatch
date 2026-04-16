import { test, expect } from '@playwright/test'

const RECENT_ALERT = {
  title: 'xAI API key leaked on GitHub',
  url: 'https://news.ycombinator.com/item?id=12345',
  source: 'hackernews',
  severity: 'critical',
  detectedAt: new Date().toISOString(),
}

const OLD_ALERT = {
  title: 'Old vulnerability from last week',
  url: 'https://osv.dev/vulnerability/OLD-001',
  source: 'osv',
  severity: 'medium',
  detectedAt: new Date(Date.now() - 48 * 3600_000).toISOString(), // 48h ago
}

const MOCK = {
  services: [
    { id: 'claude', category: 'api', name: 'Claude API', provider: 'Anthropic', status: 'operational', latency: 120, incidents: [] },
    { id: 'openai', category: 'api', name: 'OpenAI API', provider: 'OpenAI', status: 'operational', latency: 200, incidents: [] },
  ],
  lastUpdated: new Date().toISOString(),
}

test.describe('Security Alerts Banner', () => {
  test('shows banner for recent security alerts (< 24h)', async ({ page }) => {
    await page.route('**/api/status', async (route) => {
      await route.fulfill({ json: { ...MOCK, securityAlerts: [RECENT_ALERT] } })
    })
    await page.route('**/api/status/cached', async (route) => {
      await route.fulfill({ json: { ...MOCK, securityAlerts: [RECENT_ALERT] } })
    })

    await page.goto('/')
    await expect(page.getByText('Claude API').first()).toBeVisible({ timeout: 20000 })

    // Security banner should be visible
    await expect(page.getByText(/security finding/i).or(page.getByText(/보안 알림/)).first()).toBeVisible()
    await expect(page.getByText('xAI API key leaked').first()).toBeVisible()
  })

  test('hides banner for old alerts (> 24h)', async ({ page }) => {
    await page.route('**/api/status', async (route) => {
      await route.fulfill({ json: { ...MOCK, securityAlerts: [OLD_ALERT] } })
    })
    await page.route('**/api/status/cached', async (route) => {
      await route.fulfill({ json: { ...MOCK, securityAlerts: [OLD_ALERT] } })
    })

    await page.goto('/')
    await expect(page.getByText('Claude API').first()).toBeVisible({ timeout: 20000 })

    // Security banner should NOT be visible (alert is 48h old)
    await expect(page.getByText(/security finding/i)).not.toBeVisible()
    await expect(page.getByText(/보안 알림/)).not.toBeVisible()
  })

  test('hides banner when no security alerts', async ({ page }) => {
    await page.route('**/api/status', async (route) => {
      await route.fulfill({ json: MOCK })
    })
    await page.route('**/api/status/cached', async (route) => {
      await route.fulfill({ json: MOCK })
    })

    await page.goto('/')
    await expect(page.getByText('Claude API').first()).toBeVisible({ timeout: 20000 })

    await expect(page.getByText(/security finding/i)).not.toBeVisible()
    await expect(page.getByText(/보안 알림/)).not.toBeVisible()
  })
})
