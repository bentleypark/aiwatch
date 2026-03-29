import { test, expect } from '@playwright/test'
import { waitForDataLoad, navigateToSettings } from './helpers.js'

test.describe('Settings', () => {
  test.beforeEach(async ({ page }) => {
    // Clear localStorage to avoid state pollution between tests
    await page.goto('/')
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await waitForDataLoad(page)
    await navigateToSettings(page)
    // Wait for Settings page content
    await expect(page.locator('main').getByText('General')).toBeVisible()
  })

  test('theme toggle persists to localStorage', async ({ page }) => {
    const html = page.locator('html')

    // Click Light theme button via evaluate to bypass pointer interception
    const lightBtn = page.locator('main button').filter({ hasText: 'Light' })
    await lightBtn.evaluate((el) => el.click())
    await expect(html).toHaveAttribute('data-theme', 'light')

    // Verify localStorage
    const stored = await page.evaluate(() => localStorage.getItem('aiwatch-theme'))
    expect(stored).toBe('light')

    // Reload and verify persistence (theme applies before API data loads)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(html).toHaveAttribute('data-theme', 'light')

    // Restore dark theme
    await navigateToSettings(page)
    const darkBtn = page.locator('main button').filter({ hasText: 'Dark' })
    await darkBtn.evaluate((el) => el.click())
    await expect(html).not.toHaveAttribute('data-theme', 'light')
  })

  test('language toggle switches UI text', async ({ page }) => {
    await expect(page.locator('main').getByText('General')).toBeVisible()

    // Switch to Korean
    const koBtn = page.locator('main button').filter({ hasText: '한국어' })
    await koBtn.evaluate((el) => el.click())

    // Verify Korean text appears
    await expect(page.locator('main').getByText('일반')).toBeVisible()
    await expect(page.locator('main').getByText('테마')).toBeVisible()

    // Verify localStorage
    const stored = await page.evaluate(() => localStorage.getItem('aiwatch-lang'))
    expect(stored).toBe('ko')

    // Switch back to English
    const enBtn = page.locator('main button').filter({ hasText: 'English' })
    await enBtn.evaluate((el) => el.click())
    await expect(page.locator('main').getByText('General')).toBeVisible()
  })

  test('save button shows feedback', async ({ page }) => {
    // Change a setting so save button becomes active
    const periodBtn = page.locator('main button').filter({ hasText: '30' }).first()
    await periodBtn.evaluate((el) => el.click())
    await page.waitForTimeout(200)
    const saveBtn = page.locator('main button').filter({ hasText: /저장|Save/ })
    await saveBtn.evaluate((el) => el.click())
    await expect(page.locator('main').getByText(/저장됨|Saved/)).toBeVisible()
    await expect(page.locator('main').getByText(/저장됨|Saved/)).toBeHidden({ timeout: 3000 })
  })
})
