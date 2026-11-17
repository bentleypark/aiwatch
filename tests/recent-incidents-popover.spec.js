// #2013 — Recent Incidents rows open their detail as an anchored popover, so the reports panel
// beside them keeps its height; a grouped row's entries open in place inside that popover.
import { test, expect } from './fixtures.js'
import { waitForDataLoad } from './helpers.js'

const H = 3_600_000
const NOW = new Date()
NOW.setHours(12, 0, 0, 0)
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString()
const step = (stage, text, msAgo) => ({ stage, text, at: ago(msAgo) })
const flap = (n) => ({
  id: `fw-flap-2013-${n}`, title: 'Model flap 2013', status: 'resolved', impact: null,
  startedAt: ago((n * 2 + 1) * H), resolvedAt: ago(n * 2 * H), duration: '1h',
  timeline: [step('investigating', `Flap ${n} investigating 2013`, (n * 2 + 1) * H), step('resolved', `Flap ${n} resolved 2013`, n * 2 * H)],
})
const SINGLE = {
  id: 'oa-2013', title: 'Gateway errors 2013', status: 'investigating', impact: 'major',
  startedAt: ago(H), resolvedAt: null, duration: null,
  timeline: [step('investigating', 'Gateway errors update 2013', H)],
}
const svc = (id, name, provider, incidents) => ({ id, category: 'api', name, provider, status: 'operational', latency: 120, uptime30d: 99.9, calendarDays: 30, incidents })
const MOCK = {
  services: [
    svc('openai', 'OpenAI API', 'OpenAI', [SINGLE]),
    svc('fireworks', 'Fireworks AI', 'Fireworks', [{ ...flap(1), status: 'investigating', resolvedAt: null, duration: null }, flap(2), flap(3)]),
  ],
  reportFeed: { openai: [{ cat: 'errors', desc: 'gateway 2013', ts: NOW.getTime() - 10 * 60_000 }] },
  lastUpdated: NOW.toISOString(),
}

test.describe('Recent Incidents details (#2013)', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 1000 })
    await page.route('**/api/status**', (route) => route.fulfill({ json: MOCK }))
    await page.route('**/api/status/cached', (route) => route.fulfill({ json: MOCK }))
    await page.clock.setFixedTime(NOW)
    await page.goto('/')
    await waitForDataLoad(page)
  })

  const panelHeights = (page) => page.getByTestId('incident-row-header').first().evaluate((el) => {
    const grid = el.closest('.grid')
    return [...grid.children].map((c) => Math.round(c.getBoundingClientRect().height))
  })

  test('opening a single row floats its timeline and leaves both panels their height', async ({ page }) => {
    const header = page.getByTestId('incident-row-header').filter({ hasText: 'Gateway errors 2013' })
    const before = await panelHeights(page)
    expect(before).toHaveLength(2)
    await header.click()
    await expect(page.getByTestId('incident-timeline-panel').filter({ hasText: 'Gateway errors update 2013' })).toBeVisible()
    expect(await panelHeights(page)).toEqual(before)
  })

  test('a grouped row floats its entries, and Enter / Space on an entry open and close it in place', async ({ page }) => {
    await page.getByTestId('incident-group-header').filter({ hasText: 'Model flap 2013' }).click()
    const panel = page.getByTestId('incident-group-panel').filter({ hasText: 'Model flap 2013' })
    await expect(panel).toBeVisible()
    const entry = panel.getByTestId('incident-row-header').nth(1)
    await entry.focus()
    const scrollBefore = await page.evaluate(() => window.scrollY)
    await page.keyboard.press('Enter')
    await expect(panel.getByTestId('incident-timeline')).toContainText('Flap 2 investigating 2013')
    await expect(panel).toBeVisible()
    await page.keyboard.press(' ')
    await expect(panel.getByTestId('incident-timeline')).toHaveCount(0)
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore)
    await expect(panel.locator('dialog')).toHaveCount(0)
  })
})
