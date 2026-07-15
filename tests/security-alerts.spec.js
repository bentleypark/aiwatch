import { test, expect } from './fixtures.js'

const RECENT_ALERT = {
  title: 'xAI API key leaked on GitHub',
  url: 'https://news.ycombinator.com/item?id=12345',
  source: 'hackernews',
  severity: 'critical',
  detectedAt: new Date().toISOString(),
}

const OSV_ALERT = {
  title: 'Command injection in anthropic SDK',
  url: 'https://osv.dev/vulnerability/GHSA-test',
  source: 'osv',
  severity: 'high',
  service: 'Anthropic (Claude)',
  detectedAt: new Date().toISOString(),
}

const MOCK = {
  services: [
    { id: 'claude', category: 'api', name: 'Claude API', provider: 'Anthropic', status: 'operational', latency: 120, incidents: [] },
    { id: 'claudeai', category: 'app', name: 'claude.ai', provider: 'Anthropic', status: 'operational', latency: 0, incidents: [] },
    { id: 'openai', category: 'api', name: 'OpenAI API', provider: 'OpenAI', status: 'operational', latency: 200, incidents: [] },
    { id: 'xai', category: 'api', name: 'xAI (Grok)', provider: 'xAI', status: 'operational', latency: 150, incidents: [] },
  ],
  lastUpdated: new Date().toISOString(),
}

// #950 — the Overview security banner was removed. The ServiceDetails per-service
// security card remains the surface for security findings, tested below.
test.describe('Security Alerts in ServiceDetails', () => {
  const ALERTS = [OSV_ALERT, RECENT_ALERT]

  test.beforeEach(async ({ page }) => {
    await page.route('**/api/status**', async (route) => {
      await route.fulfill({ json: { ...MOCK, securityAlerts: ALERTS } })
    })
    await page.route('**/api/status/cached', async (route) => {
      await route.fulfill({ json: { ...MOCK, securityAlerts: ALERTS } })
    })
  })

  test('Claude API detail shows its own alert but not an unrelated xAI alert', async ({ page }) => {
    await page.goto('/#claude')
    await expect(page.getByText('Claude API').first()).toBeVisible({ timeout: 20000 })
    await expect(page.getByText('Command injection in anthropic SDK').first()).toBeVisible()
    // The xAI HN alert in the same feed must not leak onto the Claude card (service-specific).
    await expect(page.getByText('xAI API key leaked on GitHub')).not.toBeVisible()
  })

  test('claude.ai detail does NOT show Anthropic SDK alert (API-specific)', async ({ page }) => {
    await page.goto('/#claudeai')
    await expect(page.getByText('claude.ai').first()).toBeVisible({ timeout: 20000 })
    await expect(page.getByText('Command injection in anthropic SDK')).not.toBeVisible()
  })
})
