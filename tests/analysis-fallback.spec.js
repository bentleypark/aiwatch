import { test, expect } from '@playwright/test'
import { waitForDataLoad } from './helpers.js'

test.describe('AnalysisModal fallback section', () => {
  const mockServices = [
    {
      id: 'openai', category: 'api', name: 'OpenAI API', provider: 'OpenAI',
      status: 'degraded', latency: 200, uptime30d: 99.99,
      incidents: [
        { id: 'oi-test', title: 'Elevated Latency', status: 'investigating', impact: 'major', startedAt: new Date().toISOString(), duration: null, timeline: [] },
      ],
    },
    { id: 'claude', category: 'api', name: 'Claude API', provider: 'Anthropic', status: 'operational', latency: 145, uptime30d: 99.97, incidents: [] },
    { id: 'gemini', category: 'api', name: 'Gemini API', provider: 'Google', status: 'operational', latency: 180, uptime30d: 99.95, incidents: [] },
    { id: 'mistral', category: 'api', name: 'Mistral API', provider: 'Mistral AI', status: 'operational', latency: 90, uptime30d: 99.90, incidents: [] },
  ]

  test('renders fallback alternatives when needsFallback is true', async ({ page }) => {
    await page.route('**/api/status*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          services: mockServices,
          lastUpdated: new Date().toISOString(),
          aiAnalysis: {
            openai: [{
              summary: 'Chat endpoint latency elevated due to increased traffic.',
              estimatedRecovery: '~1h',
              affectedScope: ['Chat API'],
              needsFallback: true,
              analyzedAt: new Date().toISOString(),
              incidentId: 'oi-test',
            }],
          },
        }),
      })
    )
    await page.goto('/')
    await waitForDataLoad(page)

    // Desktop: click the "Analyze" button (hidden md:block container)
    const analyzeBtn = page.locator('header .hidden.md\\:block button.btn-topbar').first()
    await expect(analyzeBtn).toBeVisible({ timeout: 10000 })
    await analyzeBtn.click()

    // Verify modal is open with analysis content
    await expect(page.getByText('Elevated Latency').first()).toBeVisible({ timeout: 5000 })

    // Verify fallback section renders with "Alternatives" heading
    await expect(page.getByText(/Alternatives|대안 서비스/).first()).toBeVisible()

    // Verify at least one fallback service name appears
    await expect(page.getByText(/Claude API|Gemini API|Mistral API/).first()).toBeVisible()
  })

  test('does not render fallback section when needsFallback is false', async ({ page }) => {
    await page.route('**/api/status*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          services: mockServices,
          lastUpdated: new Date().toISOString(),
          aiAnalysis: {
            openai: [{
              summary: 'Minor dashboard rendering issue.',
              estimatedRecovery: '~30m',
              affectedScope: ['Dashboard'],
              needsFallback: false,
              analyzedAt: new Date().toISOString(),
              incidentId: 'oi-test',
            }],
          },
        }),
      })
    )
    await page.goto('/')
    await waitForDataLoad(page)

    const analyzeBtn = page.locator('header .hidden.md\\:block button.btn-topbar').first()
    await expect(analyzeBtn).toBeVisible({ timeout: 10000 })
    await analyzeBtn.click()

    // Modal should show analysis but NOT fallback section
    await expect(page.getByText('Minor dashboard rendering issue').first()).toBeVisible({ timeout: 5000 })
    await expect(page.getByText(/Alternatives|대안 서비스/).first()).not.toBeVisible()
  })
})
