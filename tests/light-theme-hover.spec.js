import { test, expect } from './fixtures.js'

// #1893 — a row inside an expanded group sits on the group's inset (bg0 or bg2), so its hover must
// use a fill the inset does not already have, in both themes.

const now = Date.now()
const flap = (n) => ({
  id: `flap-${n}`, title: 'Elevated error rates', status: 'investigating', impact: null,
  startedAt: new Date(now - (n + 1) * 30_000).toISOString(), resolvedAt: null, duration: null,
  timeline: [{ stage: 'investigating', text: 'Investigating', at: new Date(now - n * 10_000).toISOString() }],
})

const MOCK = {
  services: [
    { id: 'openai', category: 'api', name: 'OpenAI API', provider: 'OpenAI', status: 'operational', latency: 200, uptime30d: 99.9, incidents: [flap(0), flap(1), flap(2)] },
  ],
  lastUpdated: new Date().toISOString(),
}

const SURFACES = [
  { name: 'Overview', path: '/', group: '[role="button"][aria-expanded]', inset: 'xpath=following-sibling::div[1]', row: '.cursor-pointer' },
  { name: 'ServiceDetails', path: '/#openai', group: 'button[aria-expanded]', inset: 'xpath=following-sibling::div[1]', row: '.cursor-pointer' },
  { name: 'Incidents', path: '/#incidents', group: '[role="row"][aria-expanded]', inset: 'xpath=following-sibling::div[@role="rowgroup"][1]', row: '[role="row"]' },
]

for (const theme of ['light', 'dark']) {
  for (const s of SURFACES) {
    test(`${theme} ${s.name}: a row inside an expanded flap group shows its hover`, async ({ page }) => {
      await page.addInitScript((th) => localStorage.setItem('aiwatch-theme', th), theme)
      await page.route('**/api/status', (route) => route.fulfill({ json: MOCK }))
      await page.route('**/api/status/cached', (route) => route.fulfill({ json: MOCK }))
      await page.goto(s.path)
      await page.addStyleTag({ content: '* { transition: none !important }' })

      const group = page.locator(s.group).filter({ hasText: 'Elevated error rates' }).first()
      await expect(group).toBeVisible({ timeout: 20000 })
      await group.click()
      await expect(group).toHaveAttribute('aria-expanded', 'true')

      const inset = group.locator(s.inset)
      const row = inset.locator(s.row).first()
      const bg = (loc) => loc.evaluate((el) => getComputedStyle(el).backgroundColor)
      await expect(row).toBeVisible()
      expect(await bg(row)).toBe('rgba(0, 0, 0, 0)')
      await row.hover()
      const hovered = await bg(row)
      expect(hovered).not.toBe('rgba(0, 0, 0, 0)')
      expect(hovered).not.toBe(await bg(inset))
    })
  }
}
