import { test, expect } from '@playwright/test'
import { waitForDataLoad, navigateVia } from './helpers.js'

test.describe('Modal / Detail Panel', () => {
  test('Incidents detail panel opens and closes', async ({ page }) => {
    await page.goto('/')
    await waitForDataLoad(page)
    await navigateVia(page, 'Incidents')

    // Click on an incident row (use first matching table cell or card)
    await page.locator('main').getByText('Elevated API Error Rates').first().click({ force: true })

    // Detail panel should show timeline
    await expect(page.locator('main').getByText('Timeline')).toBeVisible()

    // Close detail panel via × button
    await page.locator('main').getByRole('button', { name: /close|닫기/i }).click({ force: true })

    // Detail panel should be hidden
    await expect(page.locator('main').getByText('Timeline')).toBeHidden()
  })

  // Modal component exists but is not yet used by any page (Issue #19)
  test.skip('Modal closes on ESC key', async () => {})
  test.skip('Modal closes on backdrop click', async () => {})
})
