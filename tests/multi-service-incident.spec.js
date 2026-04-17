import { test, expect } from '@playwright/test'

const SHARED_INCIDENT = {
  id: 'shared-inc-123',
  title: 'Opus 4.6 elevated rate of errors',
  status: 'investigating',
  impact: 'major',
  startedAt: new Date(Date.now() - 3600_000).toISOString(),
  resolvedAt: null,
  duration: null,
  timeline: [],
}

const SHARED_ANALYSIS = {
  incidentId: 'shared-inc-123',
  summary: 'Recurring Opus 4.6 model error pattern identified with fix being implemented.',
  estimatedRecovery: '30m–2h',
  affectedScope: ['Claude Opus 4.6 API', 'Model inference requests'],
  needsFallback: true,
  analyzedAt: new Date().toISOString(),
}

const MOCK = {
  services: [
    { id: 'claude', category: 'api', name: 'Claude API', provider: 'Anthropic', status: 'degraded', latency: 120, incidents: [SHARED_INCIDENT] },
    { id: 'claudeai', category: 'app', name: 'claude.ai', provider: 'Anthropic', status: 'degraded', latency: 0, incidents: [SHARED_INCIDENT] },
    { id: 'claudecode', category: 'agent', name: 'Claude Code', provider: 'Anthropic', status: 'degraded', latency: 0, incidents: [SHARED_INCIDENT] },
    { id: 'openai', category: 'api', name: 'OpenAI API', provider: 'OpenAI', status: 'operational', latency: 200, incidents: [] },
  ],
  aiAnalysis: {
    claude: [SHARED_ANALYSIS],
    claudeai: [SHARED_ANALYSIS],
    claudecode: [SHARED_ANALYSIS],
  },
  lastUpdated: new Date().toISOString(),
}

test.describe('Multi-service incident display', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/status', async (route) => {
      await route.fulfill({ json: MOCK })
    })
    await page.route('**/api/status/cached', async (route) => {
      await route.fulfill({ json: MOCK })
    })
  })

  test('AI Analysis modal groups shared incidentId and shows all service names', async ({ page }) => {
    await page.goto('/')
    // Wait for data to load
    await expect(page.getByText('Claude API').first()).toBeVisible({ timeout: 20000 })

    // Click Analyze button
    const analyzeBtn = page.locator('button').filter({ hasText: /Analyze|분석/ })
    await analyzeBtn.click()

    // Modal should show all 3 service names in one card
    const modal = page.locator('.fixed.inset-0')
    await expect(modal).toBeVisible()
    await expect(modal.getByText('Claude API')).toBeVisible()
    await expect(modal.getByText('claude.ai')).toBeVisible()
    await expect(modal.getByText('Claude Code')).toBeVisible()

    // Should only have 1 analysis group (not 3 separate ones)
    // The summary text should appear exactly once
    const summaries = modal.getByText('Recurring Opus 4.6 model error pattern')
    await expect(summaries).toHaveCount(1)
  })

  test('Incidents page shows all affected service names for shared incident', async ({ page }) => {
    await page.goto('/#incidents')
    await expect(page.getByText('Opus 4.6 elevated rate of errors').first()).toBeVisible({ timeout: 20000 })

    const main = page.locator('main')
    // All 3 affected service names should appear together (order depends on mock services array)
    await expect(main.getByText(/claude\.ai, Claude API, Claude Code/).first()).toBeVisible()
  })
})
