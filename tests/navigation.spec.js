import { test, expect } from './fixtures.js'
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

  // #978 made the MOBILE drawer scroll as a whole. With room to spare the desktop sidebar keeps the
  // opposite contract (#601) — footer pinned, service list scrolling within itself — so guard that
  // the `md:`-gating of `h-full` / `flex-1` didn't leak across the 768px breakpoint.
  test('#978 — roomy desktop sidebar keeps its pinned footer and inner-scrolling list', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1000 })
    await page.goto('/')
    await waitForDataLoad(page)

    const sidebar = page.locator('aside').first()
    const serviceNav = sidebar.getByRole('navigation', { name: /Services|서비스/ })
    await expect(serviceNav).toBeVisible()

    // The list — not the sidebar — is the scroll container. Were the mobile whole-drawer scroll to
    // leak past `md:`, the sidebar would overflow and the list would stop scrolling internally.
    expect(await sidebar.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(false)
    expect(await serviceNav.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)

    // Footer stays pinned and visible without scrolling anything.
    await expect(sidebar.getByText(/aiwatch\.dev · v/)).toBeInViewport()
  })

  // #978 — the desktop half of the same collapse. Once the nav grew (#673/#805/#920), nav + filter
  // + footer left the flex-1 list with a few pixels at best — zero in the locales with the tallest
  // nav — so a short desktop window showed no usable service list. The 160px floor keeps the list
  // present and pushes the overflow out to the sidebar's own scroll container.
  //
  // Sets its own viewport rather than leaning on this file's 1280x720 default: the collapse depends
  // on the nav's rendered height, so a test that must overflow should say so at the test site.
  test('#978 — short desktop window: the service list never collapses and the footer stays reachable', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 640 })
    await page.goto('/')
    await waitForDataLoad(page)

    const sidebar = page.locator('aside').first()
    const serviceNav = sidebar.getByRole('navigation', { name: /Services|서비스/ })

    // Used to be 0 here. The floor is 160px; assert against it rather than a bare `> 0` so a
    // future regression that leaves a sliver of a row still fails.
    expect((await serviceNav.boundingBox()).height).toBeGreaterThanOrEqual(160)

    // The sidebar itself now scrolls, so everything below the tall nav is reachable. At this height
    // the list starts below the fold, so "reachable" — not "already on screen" — is the contract.
    expect(await sidebar.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)

    const firstService = serviceNav.locator('button').first()
    await firstService.scrollIntoViewIfNeeded()
    await expect(firstService).toBeInViewport()

    const footer = sidebar.getByText(/aiwatch\.dev · v/)
    await footer.scrollIntoViewIfNeeded()
    await expect(footer).toBeInViewport()
  })
})
