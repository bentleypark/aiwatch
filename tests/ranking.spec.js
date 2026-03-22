import { test, expect } from '@playwright/test'
import { waitForDataLoad } from './helpers.js'

test.describe('Ranking page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await waitForDataLoad(page)
  })

  test('navigates to ranking page via sidebar', async ({ page }) => {
    const rankingButton = page.locator('button').filter({ hasText: /랭킹|Ranking/i }).first()
    await rankingButton.click()
    await expect(page.locator('h2').filter({ hasText: /랭킹|Ranking/i })).toBeVisible()
  })

  test('ranking page accessible via hash', async ({ page }) => {
    await page.goto('/#ranking')
    await waitForDataLoad(page)
    await expect(page.locator('h2').filter({ hasText: /랭킹|Ranking/i })).toBeVisible()
  })
})
