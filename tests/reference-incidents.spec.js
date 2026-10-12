import { test, expect } from './fixtures.js'

// #1669 — a Console-only incident (worker `referenceIncidents`) is listed in the cross-service logs,
// labelled "Provider · Component", and never on the Claude API service screen.

const CONSOLE = 'Claude Console (platform.claude.com)'
const LABEL = `Anthropic · ${CONSOLE}`
const TITLE = 'Elevated errors on platform.claude.com'

const MOCK = {
  services: [
    {
      id: 'claude', category: 'api', name: 'Claude API', provider: 'Anthropic', status: 'operational', latency: 120,
      incidents: [],
      referenceIncidents: [{
        id: '978mjkgw6mh7', title: TITLE, status: 'investigating', impact: 'major',
        startedAt: new Date(Date.now() - 3600_000).toISOString(), resolvedAt: null, duration: null, timeline: [],
        componentNames: [CONSOLE],
      }],
      referenceComponents: [{ id: '0qbwn08sd68x', name: CONSOLE, status: 'degraded' }],
    },
    { id: 'openai', category: 'api', name: 'OpenAI API', provider: 'OpenAI', status: 'operational', latency: 110, incidents: [] },
  ],
  lastUpdated: new Date().toISOString(),
}

test.describe('Reference incidents (#1669)', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/status', (route) => route.fulfill({ json: MOCK }))
    await page.route('**/api/status/cached', (route) => route.fulfill({ json: MOCK }))
  })

  test('Overview Recent Incidents lists the Console incident under the component label', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByText(`${LABEL} — ${TITLE}`)).toBeVisible({ timeout: 20000 })
  })

  test('Incidents page lists it as ongoing in the all-services view, and under no service filter', async ({ page }) => {
    await page.goto('/#incidents')
    const row = page.getByRole('row').filter({ hasText: TITLE })
    await expect(row).toContainText(LABEL, { timeout: 20000 })

    await page.locator('select[aria-label="Status"]').selectOption('ongoing')
    await expect(row).toBeVisible()

    await page.locator('select[aria-label="Status"]').selectOption('all')
    await page.locator('select[aria-label="Service"]').selectOption('claude')
    await expect(page.getByRole('row').filter({ hasText: TITLE })).toHaveCount(0)
  })

  test('the Claude API detail page does not show it', async ({ page }) => {
    await page.goto('/#claude')
    await expect(page.getByText(/Incident History|인시던트 히스토리/i)).toBeVisible({ timeout: 20000 })
    await expect(page.getByText(TITLE)).toHaveCount(0)
  })
})
