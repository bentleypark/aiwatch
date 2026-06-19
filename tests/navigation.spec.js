import { test, expect } from '@playwright/test'
import { waitForDataLoad } from './helpers.js'

// Navigation tests only on desktop (sidebar visible)
test.use({ viewport: { width: 1280, height: 720 } })

test.describe('Sidebar navigation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await waitForDataLoad(page)
  })

  test('4 menu items navigate to correct pages', async ({ page }) => {
    const sidebar = page.locator('aside').first()

    // Latency page
    await sidebar.getByRole('button', { name: 'Latency' }).click()
    await expect(page.locator('main').getByText('Current Rankings')).toBeVisible()

    // Incidents page
    await sidebar.getByRole('button', { name: 'Incidents' }).click()
    await expect(page.locator('main select').first()).toBeVisible()

    // Uptime Status page
    await sidebar.getByRole('button', { name: 'Uptime Status' }).click()
    await expect(page.locator('main').getByText('Most Stable')).toBeVisible()

    // Back to Overview
    await sidebar.getByRole('button', { name: 'Overview' }).click()
    await expect(page.locator('main button').filter({ hasText: 'Claude API' })).toBeVisible()
  })

  test('Monthly Reports link points to consolidated /reports/ path', async ({ page }) => {
    const sidebar = page.locator('aside').first()
    const reportsLink = sidebar.getByRole('link', { name: 'Reports' })

    await expect(reportsLink).toBeVisible()
    await expect(reportsLink).toHaveAttribute('href', '/reports/')
  })

  test('service list is ordered by category — Agents before Apps, Apps last (#676)', async ({ page }) => {
    // Pre-#676 the sidebar rendered raw worker order (api → apps → divider → agents), putting Apps
    // before Agents. Now it's a single flat list sorted by SERVICE_CATEGORIES rank (#658): LLM →
    // Agents → Voice → Inference → Video → Apps. Mock a service in an LLM / agent / app bucket and
    // assert the rendered order.
    const svc = (id, name, category) => ({ id, category, name, provider: 'x', status: 'operational', latency: 150, uptime30d: 99.9, calendarDays: 30, incidents: [] })
    const mock = { json: { services: [
      svc('chatgpt', 'ChatGPT', 'app'),          // app — must end up LAST
      svc('claudecode', 'Claude Code', 'agent'), // agent — must precede the app
      svc('claude', 'Claude API', 'api'),        // llm — must come first
    ], lastUpdated: new Date().toISOString() } }
    await page.route('**/api/status**', (route) => route.fulfill(mock))
    await page.route('**/api/status/cached', (route) => route.fulfill(mock))
    await page.goto('/')
    await waitForDataLoad(page)
    const serviceNav = page.locator('aside').first().getByRole('navigation', { name: /Services|서비스/ })
    const names = await serviceNav.locator('button').allTextContents()
    const idx = (n) => names.findIndex((x) => x.includes(n))
    // LLM < Agent < App  (the #676 canonical order; Apps last)
    expect(idx('Claude API'), names.join(' | ')).toBeGreaterThanOrEqual(0)
    expect(idx('Claude API')).toBeLessThan(idx('Claude Code'))
    expect(idx('Claude Code')).toBeLessThan(idx('ChatGPT'))
  })
})
