import { test, expect } from './fixtures.js'

// #1898 — a click inside a modal focuses the <dialog> itself, and a key press then makes it
// :focus-visible. Its ring must be the themed one, not the browser default.

const INC = {
  id: 'oi-ring', title: 'Elevated Latency', status: 'investigating', impact: 'major',
  startedAt: new Date(Date.now() - 1800_000).toISOString(), resolvedAt: null, duration: null, timeline: [],
}
const MOCK = {
  services: [
    { id: 'openai', category: 'api', name: 'OpenAI API', provider: 'OpenAI', status: 'degraded', latency: 200, uptime30d: 99.99, incidents: [INC] },
  ],
  aiAnalysis: {
    openai: [{
      incidentId: 'oi-ring', summary: 'Chat endpoint latency elevated due to increased traffic.',
      estimatedRecovery: '~1h', affectedScope: ['Chat API'], needsFallback: false, analyzedAt: new Date().toISOString(),
    }],
  },
  lastUpdated: new Date().toISOString(),
}

const MODALS = {
  privacy: async (page) => {
    const btn = page.getByRole('button', { name: /개인정보|Privacy/i })
    await btn.evaluate((el) => el.click())
    return page.getByRole('dialog')
  },
  analysis: async (page) => {
    await page.locator('button').filter({ hasText: /Analyze|분석/ }).evaluate((el) => el.click())
    return page.getByRole('dialog', { name: 'AI Analysis' })
  },
}

for (const theme of ['dark', 'light']) {
  for (const [name, open] of Object.entries(MODALS)) {
    test(`${theme} ${name}: a click then a key press shows the themed focus ring on the dialog`, async ({ page }) => {
      await page.addInitScript((th) => localStorage.setItem('aiwatch-theme', th), theme)
      await page.route('**/api/status', (route) => route.fulfill({ json: MOCK }))
      await page.route('**/api/status/cached', (route) => route.fulfill({ json: MOCK }))
      await page.goto('/')
      await expect(page.getByText('OpenAI API').first()).toBeVisible({ timeout: 20000 })

      const dialog = await open(page)
      await expect(dialog).toBeVisible()
      await dialog.locator('p').first().click()
      await page.keyboard.press('ArrowDown')

      const s = await dialog.evaluate((el) => {
        const cs = getComputedStyle(el)
        const probe = document.createElement('span')
        probe.style.color = 'var(--blue)'
        el.appendChild(probe)
        const blue = getComputedStyle(probe).color
        probe.remove()
        return { focused: document.activeElement === el, style: cs.outlineStyle, width: cs.outlineWidth, color: cs.outlineColor, blue }
      })
      expect(s.focused).toBe(true)
      expect(s.style).toBe('solid')
      expect(s.width).toBe('2px')
      expect(s.color).toBe(s.blue)
    })
  }
}
