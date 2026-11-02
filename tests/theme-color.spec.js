import { test, expect } from './fixtures.js'

// The browser / installed-PWA status bar reads <meta name="theme-color">; it must follow the
// app's theme (including a theme chosen in Settings), matching the top bar's surface.

const MOCK = {
  services: [{ id: 'openai', category: 'api', name: 'OpenAI API', provider: 'OpenAI', status: 'operational', latency: 200, uptime30d: 99.9, incidents: [] }],
  lastUpdated: new Date().toISOString(),
}

const themeColor = (page) => page.locator('meta[name="theme-color"]').getAttribute('content')
const topbarBg = (page) => page.locator('header').first().evaluate((el) => {
  const [r, g, b] = getComputedStyle(el).backgroundColor.match(/\d+/g).map(Number)
  return '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')
})

test.beforeEach(async ({ page }) => {
  await page.route('**/api/status', (route) => route.fulfill({ json: MOCK }))
  await page.route('**/api/status/cached', (route) => route.fulfill({ json: MOCK }))
})

for (const theme of ['dark', 'light']) {
  test(`${theme}: theme-color matches the top bar on load`, async ({ page }) => {
    await page.addInitScript((th) => localStorage.setItem('aiwatch-theme', th), theme)
    await page.goto('/')
    await expect(page.getByText('OpenAI API').first()).toBeVisible({ timeout: 20000 })
    await expect.poll(() => themeColor(page)).toBe(await topbarBg(page))
  })
}

test('switching the theme in Settings updates theme-color', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('aiwatch-theme', 'dark'))
  await page.goto('/#settings')
  const dark = await themeColor(page)
  await page.getByRole('button', { name: /^(라이트|Light)$/ }).click()
  await expect.poll(() => themeColor(page)).not.toBe(dark)
  expect(await themeColor(page)).toBe(await topbarBg(page))
})
