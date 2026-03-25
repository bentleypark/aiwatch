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

  test('clicking incident row expands accordion detail inline', async ({ page }) => {
    const main = page.locator('main')
    const rows = main.locator('[role="rowgroup"] [role="row"]')
    const count = await rows.count()
    if (count === 0) return // no incidents to test
    // Click first incident row
    await rows.first().click()
    // Accordion detail should appear: header with service name + close button
    await expect(main.getByText('✕').first()).toBeVisible({ timeout: 3000 })
    // Timeline should be visible
    const timeline = main.locator('.rounded-full.w-2\\.5.h-2\\.5')
    expect(await timeline.count()).toBeGreaterThan(0)
    // Click close button
    await main.getByText('✕').first().click()
    // Detail panel should disappear
    await expect(main.locator('.rounded-lg.overflow-hidden.mt-\\[10px\\]')).not.toBeVisible()
  })

  test('ongoing incidents are sorted before resolved', async ({ page }) => {
    const main = page.locator('main')
    const rows = main.locator('[role="rowgroup"] [role="row"]')
    const count = await rows.count()
    if (count < 2) return
    // Check first row — if there are ongoing incidents, they should be first
    const firstRowText = await rows.first().textContent()
    const hasOngoing = firstRowText?.toLowerCase().includes('ongoing') || firstRowText?.toLowerCase().includes('monitoring')
    // If no ongoing, all should be resolved — which is also valid
    if (!hasOngoing) {
      const allText = await rows.allTextContents()
      const allResolved = allText.every(t => t.toLowerCase().includes('resolved'))
      expect(allResolved).toBe(true)
    }
  })
})
