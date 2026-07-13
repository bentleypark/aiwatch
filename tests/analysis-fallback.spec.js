import { test, expect } from './fixtures.js'

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

  // Status-based gate (#454): the modal shows alternatives whenever the affected
  // service is down/degraded, matching the Overview ActionBanner — it no longer
  // depends on the AI's needsFallback flag.
  async function loadWithAnalysis(page, aiAnalysis, services = mockServices) {
    const body = { services, lastUpdated: new Date().toISOString(), aiAnalysis }
    await page.route('**/api/status', (route) => route.fulfill({ json: body }))
    await page.route('**/api/status/cached', (route) => route.fulfill({ json: body }))
    await page.goto('/')
    // Wait for the affected service card to render (proven pattern from
    // analysis-modal-grouping.spec.js — avoids the main-scoped helper's
    // hidden-first-match flakiness).
    await expect(page.getByText('OpenAI API').first()).toBeVisible({ timeout: 20000 })
    await page.locator('button').filter({ hasText: /Analyze|분석/ }).click()
    const modal = page.locator('.fixed.inset-0').last()
    await expect(modal).toBeVisible()
    return modal
  }

  // Match the grouping spec's idiom: scope to the modal and the 🔄-prefixed
  // heading so the assertion can't match incidental copy and toHaveCount(0)
  // fails fast on a regression instead of waiting out the visibility timeout.
  const alternativesIn = (modal) => modal.getByText(/🔄 (Alternatives|대안 서비스)/)

  test('renders fallback alternatives for a degraded service (needsFallback true)', async ({ page }) => {
    const modal = await loadWithAnalysis(page, {
      openai: [{
        summary: 'Chat endpoint latency elevated due to increased traffic.',
        estimatedRecovery: '~1h',
        affectedScope: ['Chat API'],
        needsFallback: true,
        analyzedAt: new Date().toISOString(),
        incidentId: 'oi-test',
      }],
    })

    // Single-incident cards render the AI summary, not the incident title (the
    // title only shows for multi-incident cards — AnalysisModal.jsx).
    await expect(modal.getByText('Chat endpoint latency elevated').first()).toBeVisible({ timeout: 5000 })
    await expect(alternativesIn(modal)).toHaveCount(1)
    await expect(modal.getByText(/Claude API|Gemini API|Mistral API/).first()).toBeVisible()
  })

  test('still renders fallback alternatives for a degraded service when needsFallback is false (#454)', async ({ page }) => {
    // Regression guard for the #454 gate unification: the AI classifies partial
    // degradation as needsFallback:false, but a degraded service must still show
    // alternatives so the modal stays consistent with the Overview ActionBanner.
    const modal = await loadWithAnalysis(page, {
      openai: [{
        summary: 'Partial degradation on a subset of chat models.',
        estimatedRecovery: '~30m',
        affectedScope: ['Chat API'],
        needsFallback: false,
        analyzedAt: new Date().toISOString(),
        incidentId: 'oi-test',
      }],
    })

    await expect(modal.getByText('Partial degradation').first()).toBeVisible({ timeout: 5000 })
    await expect(alternativesIn(modal)).toHaveCount(1)
    await expect(modal.getByText(/Claude API|Gemini API|Mistral API/).first()).toBeVisible()
  })

  test('hides fallback section for an operational service with an active analysis (isolated model issue)', async ({ page }) => {
    // When the service dot is operational but a model/component incident is still
    // being analyzed, the status gate hides alternatives — matching Overview,
    // which excludes operational services from its affected set.
    const operationalServices = mockServices.map(s =>
      s.id === 'openai' ? { ...s, status: 'operational' } : s
    )
    const modal = await loadWithAnalysis(page, {
      openai: [{
        summary: 'Isolated model rendering issue under investigation.',
        estimatedRecovery: '~30m',
        affectedScope: ['Single model'],
        needsFallback: true,
        analyzedAt: new Date().toISOString(),
        incidentId: 'oi-test',
      }],
    }, operationalServices)

    await expect(modal.getByText('Isolated model rendering issue').first()).toBeVisible({ timeout: 5000 })
    await expect(alternativesIn(modal)).toHaveCount(0)
  })
})
