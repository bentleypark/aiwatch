import { test, expect } from '@playwright/test'
import { waitForDataLoad } from './helpers.js'

test.describe('Overview page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await waitForDataLoad(page)
  })

  test('renders stat cards with correct data', async ({ page }) => {
    await expect(page.locator('main').getByText('11').first()).toBeVisible()
    await expect(page.locator('main').getByText('%').first()).toBeVisible()
  })

  test('renders 13 service cards', async ({ page }) => {
    const serviceNames = [
      'Claude API', 'OpenAI API', 'Gemini API', 'Mistral API',
      'Cohere API', 'Groq Cloud', 'Together AI', 'Perplexity',
      'Hugging Face', 'Replicate', 'ElevenLabs', 'xAI (Grok)', 'DeepSeek API',
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
    // Filter tabs are the border-b-2 buttons inside the tab bar
    const tabBar = page.locator('main .flex.gap-1.border-b')

    // Click Operational tab via evaluate
    const opTab = tabBar.getByRole('button', { name: /Operational|정상/ })
    await opTab.evaluate((el) => el.click())
    // Wait for filter to apply
    await page.waitForTimeout(200)
    await expect(page.locator('main button').filter({ hasText: 'OpenAI API' })).toBeHidden()
    await expect(page.locator('main button').filter({ hasText: 'Claude API' })).toBeVisible()

    // Click Issues tab
    const issTab = tabBar.getByRole('button', { name: /Issues|이슈/ })
    await issTab.evaluate((el) => el.click())
    await page.waitForTimeout(200)
    await expect(page.locator('main button').filter({ hasText: 'OpenAI API' })).toBeVisible()
    await expect(page.locator('main button').filter({ hasText: 'Claude API' })).toBeHidden()

    // Click All tab to restore
    const allTab = tabBar.getByRole('button').first()
    await allTab.evaluate((el) => el.click())
    await page.waitForTimeout(200)
    await expect(page.locator('main button').filter({ hasText: 'Claude API' })).toBeVisible()
  })
})
