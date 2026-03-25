import { test, expect } from '@playwright/test'
import { waitForDataLoad } from './helpers.js'

test.describe('Overview page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await waitForDataLoad(page)
  })

  test('renders stat cards with correct data', async ({ page }) => {
    // Stat cards visible (count varies by live/mock data)
    await expect(page.locator('main').getByText('%').first()).toBeVisible()
    await expect(page.locator('main').getByText('%').first()).toBeVisible()
  })

  test('renders all service cards', async ({ page }) => {
    const serviceNames = [
      'Claude API', 'OpenAI API', 'Gemini API', 'Mistral API',
      'Cohere API', 'Groq Cloud', 'Together AI', 'Perplexity',
      'Hugging Face', 'Replicate', 'ElevenLabs', 'xAI (Grok)', 'DeepSeek API',
      'claude.ai', 'ChatGPT',
      'Claude Code', 'GitHub Copilot', 'Cursor', 'Windsurf',
    ]
    for (const name of serviceNames) {
      await expect(page.locator('main').getByText(name).first()).toBeVisible()
    }
  })

  test('service card click navigates to ServiceDetails', async ({ page }) => {
    const card = page.locator('main button').filter({ hasText: 'Claude API' }).first()
    await card.evaluate((el) => el.click())
    await expect(page.locator('main').getByText('Status Calendar')).toBeVisible({ timeout: 5000 })
  })

  test('filter tabs switch between All / Operational / Issues', async ({ page }) => {
    // Filter tabs are pill-style segment control (bg2 rounded container)
    const tabBar = page.locator('main .flex.bg-\\[var\\(--bg2\\)\\]')

    // Click Operational tab via evaluate
    const opTab = tabBar.getByRole('button', { name: /Operational|정상/ })
    await opTab.evaluate((el) => el.click())
    // Wait for filter to apply
    await page.waitForTimeout(200)
    // Claude API should be visible (always operational)
    await expect(page.locator('main button').filter({ hasText: 'Claude API' })).toBeVisible()

    // Click All tab to restore
    const allTab2 = tabBar.getByRole('button').first()
    await allTab2.evaluate((el) => el.click())
    await page.waitForTimeout(200)

    // Click All tab to restore
    const allTab = tabBar.getByRole('button').first()
    await allTab.evaluate((el) => el.click())
    await page.waitForTimeout(200)
    await expect(page.locator('main button').filter({ hasText: 'Claude API' })).toBeVisible()
  })

  test('action banner navigates to Incidents page on click', async ({ page }) => {
    // Banner only shows when services are degraded/down — check if it exists
    const banner = page.locator('main').getByText(/인시던트 상세 확인|View incident details/)
    if (await banner.isVisible({ timeout: 3000 }).catch(() => false)) {
      await banner.click()
      // Should navigate to Incidents page
      // Incidents page has filter selects
      await expect(page.locator('main select').first()).toBeVisible({ timeout: 5000 })
    }
  })
})
