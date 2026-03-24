import { test, expect } from '@playwright/test'
import { waitForDataLoad, navigateVia } from './helpers.js'

test.describe('Modal / Detail Panel', () => {
  test('Incidents detail panel opens and closes', async ({ page }) => {
    await page.goto('/')
    await waitForDataLoad(page)
    await navigateVia(page, 'Incidents')

    // Find incident rows in rowgroup (skip header row)
    const incidentRows = page.locator('main [role="rowgroup"] [role="row"]')
    const count = await incidentRows.count()
    if (count === 0) {
      // No incidents available (live data may have none) — skip gracefully
      return
    }
    await incidentRows.first().click({ force: true })
    // Detail panel shows close button with "닫기" / "Close" text
    const closeBtn = page.locator('main').getByRole('button', { name: /닫기|Close/i })
    await expect(closeBtn).toBeVisible()

    await closeBtn.click({ force: true })
    await expect(closeBtn).toBeHidden({ timeout: 5000 })
  })

  test('Privacy modal opens from footer and closes on ESC', async ({ page }) => {
    await page.goto('/')
    await waitForDataLoad(page)

    // Scroll to footer and click privacy link
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    const privacyBtn = page.getByRole('button', { name: /개인정보|Privacy/i })
    await privacyBtn.waitFor({ state: 'visible' })
    await privacyBtn.evaluate((el) => el.click())

    // Modal should be visible
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.getByText(/수집하는 정보|Information We Collect/)).toBeVisible()

    // Close with ESC
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toBeHidden()
  })

  test('Terms modal opens and closes on backdrop click', async ({ page }) => {
    await page.goto('/')
    await waitForDataLoad(page)

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    const termsBtn = page.getByRole('button', { name: /이용약관|Terms/i })
    await termsBtn.waitFor({ state: 'visible' })
    await termsBtn.evaluate((el) => el.click())

    // Modal should be visible
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.getByText(/서비스 개요|Service Overview/)).toBeVisible()

    // Close by clicking backdrop (the fixed overlay outside the modal panel)
    await page.locator('[role="dialog"]').click({ position: { x: 10, y: 10 } })
    await expect(page.getByRole('dialog')).toBeHidden()
  })
})
