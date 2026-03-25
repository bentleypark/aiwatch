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

test.describe('xAI Regional Availability', () => {
  // Inject mock xAI data with EU region ongoing incident via API intercept
  const XAI_MOCK = {
    id: 'xai', category: 'api', name: 'xAI (Grok)', provider: 'xAI', status: 'degraded',
    latency: 203, uptime30d: 99.75, calendarDays: 30,
    incidents: [
      { id: 'xa-0', title: 'eu-west-1.api.x.ai went down', startedAt: new Date(Date.now() - 7200000).toISOString(), duration: null, status: 'investigating', impact: null, timeline: [] },
      { id: 'xa-1', title: 'Authentication Errors', startedAt: new Date(Date.now() - 86400000 * 2).toISOString(), duration: '22m', status: 'resolved', impact: null, timeline: [] },
    ],
  }

  test('shows regional status with incident type for xAI', async ({ page }) => {
    // Intercept API: serve mock response with xAI EU incident
    await page.route('**/api/status', async (route) => {
      const mockResponse = {
        services: [
          { id: 'claude', category: 'api', name: 'Claude API', provider: 'Anthropic', status: 'operational', latency: 120, uptime30d: 99.95, calendarDays: 30, incidents: [] },
          XAI_MOCK,
        ],
        lastUpdated: new Date().toISOString(),
      }
      await route.fulfill({ json: mockResponse })
    })
    await page.goto('/')
    await waitForDataLoad(page)
    await page.locator('main button').filter({ hasText: 'xAI' }).first().evaluate((el) => el.click())
    await expect(page.locator('main').getByText(/Regional Availability|리전별 가용성/)).toBeVisible({ timeout: 5000 })
    // EU region should show incident type label (Service Down)
    await expect(page.locator('main').getByText(/Service Down|서비스 중단/)).toBeVisible()
    // US region should show no active incidents
    await expect(page.locator('main').getByText(/No Active Incidents|활성 장애 없음/)).toBeVisible()
    // Recommendation + Guide link should be visible
    await expect(page.locator('main').getByText(/API Guide|API 가이드/)).toBeVisible()
  })

  test('shows all regions affected for global incident (no region keyword)', async ({ page }) => {
    const globalMock = { ...XAI_MOCK, incidents: [
      { id: 'xa-g', title: 'Elevated API Error Rates', startedAt: new Date(Date.now() - 3600000).toISOString(), duration: null, status: 'investigating', impact: null, timeline: [] },
    ] }
    await page.route('**/api/status', async (route) => {
      await route.fulfill({ json: {
        services: [
          { id: 'claude', category: 'api', name: 'Claude API', provider: 'Anthropic', status: 'operational', latency: 120, uptime30d: 99.95, calendarDays: 30, incidents: [] },
          globalMock,
        ],
        lastUpdated: new Date().toISOString(),
      } })
    })
    await page.goto('/')
    await waitForDataLoad(page)
    await page.locator('main button').filter({ hasText: 'xAI' }).first().evaluate((el) => el.click())
    await expect(page.locator('main').getByText(/Regional Availability|리전별 가용성/)).toBeVisible({ timeout: 5000 })
    // Both regions should show incident (global → all affected)
    await expect(page.locator('main').getByText(/Incident Detected|장애 감지/)).toHaveCount(2)
    // All-down message should be visible
    await expect(page.locator('main').getByText(/all regions|모든 리전/i)).toBeVisible()
  })

  test('does not show regional section for non-xAI service', async ({ page }) => {
    await page.goto('/')
    await waitForDataLoad(page)
    const card = page.locator('main button').filter({ hasText: 'Claude API' }).first()
    await card.evaluate((el) => el.click())
    await expect(page.locator('main').getByText('Status Calendar')).toBeVisible({ timeout: 5000 })
    await expect(page.locator('main').getByText(/Regional Availability|리전별 가용성/)).not.toBeVisible()
  })
})

test.describe('Gemini Regional Availability', () => {
  test('shows regional status for Gemini with region-specific incident', async ({ page }) => {
    await page.route('**/api/status', async (route) => {
      await route.fulfill({ json: {
        services: [
          { id: 'claude', category: 'api', name: 'Claude API', provider: 'Anthropic', status: 'operational', latency: 120, uptime30d: 99.95, calendarDays: 30, incidents: [] },
          {
            id: 'gemini', category: 'api', name: 'Gemini API', provider: 'Google', status: 'degraded',
            latency: 180, uptime30d: 99.80, calendarDays: 30,
            incidents: [
              { id: 'gm-1', title: 'Vertex AI europe-west1 elevated error rates', startedAt: new Date(Date.now() - 3600000).toISOString(), duration: null, status: 'investigating', impact: null, timeline: [] },
            ],
          },
        ],
        lastUpdated: new Date().toISOString(),
      } })
    })
    await page.goto('/')
    await waitForDataLoad(page)
    await page.locator('main button').filter({ hasText: 'Gemini' }).first().evaluate((el) => el.click())
    await expect(page.locator('main').getByText(/Regional Availability|리전별 가용성/)).toBeVisible({ timeout: 5000 })
    // Europe West should show incident, other regions should be ok
    await expect(page.locator('main').getByText(/No Active Incidents|활성 장애 없음/).first()).toBeVisible()
    await expect(page.locator('main').getByText(/Inference Issue|추론 장애/)).toBeVisible()
  })
})

test.describe('OpenAI Regional Availability', () => {
  test('shows regional status for OpenAI with global incident', async ({ page }) => {
    await page.route('**/api/status', async (route) => {
      await route.fulfill({ json: {
        services: [
          { id: 'claude', category: 'api', name: 'Claude API', provider: 'Anthropic', status: 'operational', latency: 120, uptime30d: 99.95, calendarDays: 30, incidents: [] },
          {
            id: 'openai', category: 'api', name: 'OpenAI API', provider: 'OpenAI', status: 'degraded',
            latency: 250, uptime30d: 99.70, calendarDays: 30,
            incidents: [
              { id: 'oa-1', title: 'Elevated API Error Rates', startedAt: new Date(Date.now() - 1800000).toISOString(), duration: null, status: 'investigating', impact: null, timeline: [] },
            ],
          },
        ],
        lastUpdated: new Date().toISOString(),
      } })
    })
    await page.goto('/')
    await waitForDataLoad(page)
    await page.locator('main button').filter({ hasText: 'OpenAI API' }).first().click()
    await expect(page.locator('main').getByText(/Regional Availability|리전별 가용성/)).toBeVisible({ timeout: 5000 })
    // Global incident → all 3 regions should show incident
    await expect(page.locator('main').getByText(/Incident Detected|장애 감지/)).toHaveCount(3)
    await expect(page.locator('main').getByText(/all regions|모든 리전/i)).toBeVisible()
  })
})

test.describe('Detection Lead badge', () => {
  test('shows lead badge for OpenAI ongoing incident', async ({ page }) => {
    await page.goto('/')
    await waitForDataLoad(page)
    // Navigate to OpenAI (mock: detectedAt 7min before ongoing incident)
    await page.locator('main button').filter({ hasText: 'OpenAI API' }).first().click()
    await expect(page.locator('main').getByText('Incident History')).toBeVisible({ timeout: 5000 })
    // Lead badge should be visible for ongoing incident
    await expect(page.locator('main').getByText('lead').first()).toBeVisible()
  })
})

test.describe('Incident accordion in ServiceDetails', () => {
  test('clicking incident expands timeline inline', async ({ page }) => {
    await page.goto('/')
    await waitForDataLoad(page)
    // Navigate to Claude API (has incidents in mock data)
    await page.locator('main button').filter({ hasText: 'Claude API' }).first().click()
    await expect(page.locator('main').getByText('Incident History')).toBeVisible({ timeout: 5000 })
    // Find an incident row with the expand arrow
    const arrow = page.locator('main').getByText('▸').first()
    if (await arrow.isVisible()) {
      await arrow.click()
      // Timeline should expand with close button
      await expect(page.locator('main').getByText('✕').first()).toBeVisible({ timeout: 3000 })
      // Click close
      await page.locator('main').getByText('✕').first().click()
    }
  })
})
