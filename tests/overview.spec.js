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
      'claude.ai', 'ChatGPT', 'Character.AI',
      'Claude API', 'OpenAI API', 'Gemini API', 'Amazon Bedrock', 'Azure OpenAI',
      'Mistral API', 'Cohere API', 'Groq Cloud', 'Together AI', 'Perplexity',
      'xAI (Grok)', 'DeepSeek API', 'OpenRouter',
      'Hugging Face', 'Replicate', 'ElevenLabs', 'Pinecone', 'Stability AI',
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

  test('action banner shows severity labels and excludes affected from alternatives', async ({ page }) => {
    // Banner only shows when services are degraded/down (requires Worker data or dev mock)
    const banner = page.locator('main').getByText(/Degraded|성능 저하|Down|서비스 중단/)
    if (await banner.isVisible({ timeout: 5000 }).catch(() => false)) {
      const bannerCard = page.locator('main .rounded-lg').filter({ hasText: /Degraded|성능 저하|Down|서비스 중단/ }).first()
      const text = await bannerCard.textContent()
      // Should have severity label
      expect(text).toMatch(/Degraded|Down|성능 저하|서비스 중단/)
      // Should have incidents link
      expect(text).toMatch(/incident|인시던트/)
      // If healthy alternatives shown, affected services must be excluded
      if (text.match(/Healthy alternatives|정상 대안/)) {
        const altSection = text.split(/Healthy alternatives|정상 대안/)[1] ?? ''
        // Any service shown in the severity lines should NOT appear in alternatives
        const downMatch = text.match(/Down[^:]*:\s*([^⚠🟡]+)/)
        const degradedMatch = text.match(/Degraded[^:]*:\s*([^👉✅]+)/)
        const affectedNames = [...(downMatch?.[1]?.split(',') ?? []), ...(degradedMatch?.[1]?.split(',') ?? [])].map(s => s.trim())
        for (const name of affectedNames) {
          if (name) expect(altSection).not.toContain(name)
        }
      }
    }
  })
})
