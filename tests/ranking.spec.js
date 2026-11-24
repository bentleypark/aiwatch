import { test, expect } from './fixtures.js'
import { waitForDataLoad } from './helpers.js'

test.describe('Ranking page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await waitForDataLoad(page)
  })

  test('navigates to ranking page via sidebar', async ({ page }) => {
    const rankingButton = page.locator('button').filter({ hasText: /랭킹|Ranking/i }).first()
    await rankingButton.click()
    await expect(page.locator('h2').filter({ hasText: /랭킹|Ranking/i })).toBeVisible()
  })

  test('ranking page accessible via hash', async ({ page }) => {
    await page.goto('/#ranking')
    await waitForDataLoad(page)
    await expect(page.locator('h2').filter({ hasText: /랭킹|Ranking/i })).toBeVisible()
  })

  test('#802/#2061 — a recently-added (<30d coverage) service, its number withheld, is not ranked and is listed under Recently Added', async ({ page }) => {
    // fal has only 5 days of coverage → the Worker withholds its number, and it must not rank alongside the
    // established Claude until 30 days accrue.
    const mock = { json: { services: [
      { id: 'claude', category: 'api', name: 'Claude API', provider: 'Anthropic', status: 'operational', latency: 120, uptime30d: 99.9, aiwatchScore: 95, scoreGrade: 'excellent', scoreConfidence: 'high', calendarDays: 30, incidents: [] },
      { id: 'fal', category: 'api', name: 'fal.ai', provider: 'fal', status: 'operational', latency: 150, uptime30d: 99.5, aiwatchScore: null, scoreGrade: null, scoreConfidence: 'high', coverageDays: 5, calendarDays: 30, incidents: [] },
    ], lastUpdated: new Date().toISOString() } }
    await page.route('**/api/status**', (route) => route.fulfill(mock))
    await page.route('**/api/status/cached', (route) => route.fulfill(mock))
    // beforeEach already loaded `/` with real data before this route was set; reload so the fetch
    // re-runs against the mock (a hash-only goto would not re-fetch in the SPA).
    await page.goto('/#ranking')
    await page.reload()
    await waitForDataLoad(page)

    // The ranked table contains the established service but NOT the <30d one.
    const table = page.locator('table')
    await expect(table.getByText('Claude API').first()).toBeVisible({ timeout: 10000 })
    await expect(table.getByText('fal.ai')).toHaveCount(0)

    // #802 — the <30d service is shown under the distinct "Recently Added" group (NOT lumped with the
    // "Insufficient Data" / low-confidence bucket), so the two exclusion reasons are clearly separated.
    await expect(page.locator('main').getByText(/Recently Added|최근 추가/).first()).toBeVisible()
    await expect(page.locator('main').getByText('fal.ai').first()).toBeVisible()
  })
})
