import { test, expect } from './fixtures.js'

// #1879 — the AI Analysis modal is a native <dialog> opened with showModal(), wired like Modal.jsx.

const INC = {
  id: 'oi-dialog', title: 'Elevated Latency', status: 'investigating', impact: 'major',
  startedAt: new Date(Date.now() - 1800_000).toISOString(), resolvedAt: null, duration: null, timeline: [],
}

const MOCK = {
  services: [
    { id: 'openai', category: 'api', name: 'OpenAI API', provider: 'OpenAI', status: 'degraded', latency: 200, uptime30d: 99.99, incidents: [INC] },
    { id: 'claude', category: 'api', name: 'Claude API', provider: 'Anthropic', status: 'operational', latency: 145, uptime30d: 99.97, incidents: [] },
  ],
  aiAnalysis: {
    openai: [{
      incidentId: 'oi-dialog',
      summary: 'Chat endpoint latency elevated due to increased traffic.',
      estimatedRecovery: '~1h',
      affectedScope: ['Chat API'],
      needsFallback: true,
      analyzedAt: new Date().toISOString(),
    }],
  },
  lastUpdated: new Date().toISOString(),
}

test.describe('AnalysisModal — native dialog (#1879)', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/status', (route) => route.fulfill({ json: MOCK }))
    await page.route('**/api/status/cached', (route) => route.fulfill({ json: MOCK }))
    await page.goto('/')
    await expect(page.getByText('OpenAI API').first()).toBeVisible({ timeout: 20000 })
  })

  async function open(page) {
    const trigger = page.locator('button').filter({ hasText: /Analyze|분석/ })
    await trigger.evaluate((el) => { el.focus(); el.click() })
    const dialog = page.getByRole('dialog', { name: 'AI Analysis' })
    await expect(dialog).toBeVisible()
    return { trigger, dialog }
  }

  test('opens as the only dialog, modal, and labelled by its heading', async ({ page }) => {
    const { dialog } = await open(page)
    await expect(page.locator('dialog')).toHaveCount(1)
    expect(await dialog.evaluate((el) => el.matches(':modal'))).toBe(true)
  })

  test('locks body scroll while open and releases it on close', async ({ page }) => {
    const bodyOverflow = () => page.evaluate(() => document.body.style.overflow)
    expect(await bodyOverflow()).toBe('')
    await open(page)
    expect(await bodyOverflow()).toBe('hidden')
    await page.keyboard.press('Escape')
    await expect(page.locator('dialog')).toHaveCount(0)
    expect(await bodyOverflow()).toBe('')
  })

  test('Escape closes it and returns focus to the trigger', async ({ page }) => {
    const { trigger, dialog } = await open(page)
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(page.locator('dialog')).toHaveCount(0)
    await expect(trigger).toBeFocused()
  })

  test('the close button closes it', async ({ page }) => {
    const { trigger, dialog } = await open(page)
    await dialog.getByRole('button', { name: /닫기|Close/i }).click()
    await expect(page.locator('dialog')).toHaveCount(0)
    await expect(trigger).toBeFocused()
  })

  test('a backdrop click closes it; a click inside the panel does not', async ({ page }) => {
    const { dialog } = await open(page)
    // Without closedby the click handler is the only close path, as in engines that lack the attribute.
    await dialog.evaluate((el) => el.removeAttribute('closedby'))
    await dialog.getByText('Chat endpoint latency elevated').first().click()
    await expect(dialog).toBeVisible()
    // A click whose target is the dialog itself but inside its box (its own scrollbar) must not close it.
    await dialog.evaluate((el) => {
      const r = el.getBoundingClientRect()
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.right - 3, clientY: r.top + r.height / 2 }))
    })
    await expect(dialog).toBeVisible()
    const box = await dialog.boundingBox()
    await page.mouse.click(box.x + box.width / 2, Math.max(2, box.y - 20))
    await expect(page.locator('dialog')).toHaveCount(0)
  })
})

test.describe('Ticker pause control (#1879)', () => {
  test('the button pauses and resumes the ticker animation', async ({ page }) => {
    await page.route('**/api/status', (route) => route.fulfill({ json: MOCK }))
    await page.route('**/api/status/cached', (route) => route.fulfill({ json: MOCK }))
    await page.goto('/')
    const track = page.locator('.ticker-track')
    await expect(track).toBeVisible({ timeout: 20000 })
    const playState = () => track.evaluate((el) => getComputedStyle(el).animationPlayState)
    expect(await track.evaluate((el) => getComputedStyle(el).animationName)).toBe('ticker-scroll')
    expect(await playState()).toBe('running')

    const button = page.getByRole('button', { name: /Pause status ticker|상태 티커 일시정지/ })
    await expect(button).toHaveAttribute('aria-pressed', 'false')
    await button.click()
    await expect(button).toHaveAttribute('aria-pressed', 'true')
    expect(await playState()).toBe('paused')

    await button.click()
    await expect(button).toHaveAttribute('aria-pressed', 'false')
    expect(await playState()).toBe('running')
  })

  for (const [reducedMotion, expected] of [
    ['no-preference', { shimmer: 'skeleton-shimmer', pulse: 'pulse', ticker: 'ticker-scroll', pauseVisible: true }],
    ['reduce', { shimmer: 'none', pulse: 'none', ticker: 'none', pauseVisible: false }],
  ]) {
    test(`motion with prefers-reduced-motion: ${reducedMotion}`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion })
      let release
      const held = new Promise((r) => { release = r })
      const fulfil = async (route) => { await held; await route.fulfill({ json: MOCK }) }
      await page.route('**/api/status', fulfil)
      await page.route('**/api/status/cached', fulfil)
      await page.goto('/')
      const animationOf = (locator) => locator.first().evaluate((el) => getComputedStyle(el).animationName)

      // While the status request is held, the real skeleton and the LIVE dot are on screen.
      await expect(page.locator('.skeleton-shimmer').first()).toBeVisible({ timeout: 20000 })
      expect(await animationOf(page.locator('.skeleton-shimmer'))).toBe(expected.shimmer)
      expect(await animationOf(page.locator('.live-pulse'))).toBe(expected.pulse)

      release()
      await expect(page.locator('.ticker-track')).toBeVisible({ timeout: 20000 })
      expect(await animationOf(page.locator('.ticker-track'))).toBe(expected.ticker)
      await expect(page.locator('.ticker-pause')).toBeVisible({ visible: expected.pauseVisible })
    })
  }
})
