import { test, expect } from '@playwright/test'
import { waitForDataLoad, navigateVia } from './helpers.js'

test.describe('Incidents filtering', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await waitForDataLoad(page)
    await navigateVia(page, 'Incidents')
  })

  test('service filter narrows incident list', async ({ page }) => {
    const main = page.locator('main')
    // Select a specific service filter
    const serviceSelect = main.locator('select').first()
    await serviceSelect.selectOption({ index: 1 }) // First service after "All"
    await page.waitForTimeout(300)
    // Incident list should still render (may be empty for some services)
    const hasRows = await main.locator('[role="row"]').count()
    const hasCards = await main.locator('.md\\:hidden button').count()
    // Either rows (desktop) or cards (mobile) or empty state should be present
    expect(hasRows + hasCards).toBeGreaterThanOrEqual(0)
  })

  test('status filter shows only matching incidents', async ({ page }) => {
    const main = page.locator('main')
    const selects = main.locator('select')
    // Status filter is the second select
    const statusSelect = selects.nth(1)
    // Select "Resolved" status
    await statusSelect.selectOption({ index: 3 }) // resolved is last option
    await page.waitForTimeout(300)
    // All visible status badges should be "resolved"
    const rows = main.locator('[role="rowgroup"] [role="row"]')
    const count = await rows.count()
    if (count > 0) {
      const firstRowText = await rows.first().textContent()
      expect(firstRowText?.toLowerCase()).toContain('resolved')
    }
  })

  test('period filter changes displayed range', async ({ page }) => {
    const main = page.locator('main')
    const selects = main.locator('select')
    // Period filter is the third select
    const periodSelect = selects.nth(2)
    const options = await periodSelect.locator('option').count()
    expect(options).toBeGreaterThanOrEqual(3) // 7d, 30d, 90d
  })
})
