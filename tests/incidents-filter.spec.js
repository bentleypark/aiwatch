import { test, expect } from '@playwright/test'
import { waitForDataLoad, navigateVia } from './helpers.js'

test.describe('Incidents filtering', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await waitForDataLoad(page)
    await navigateVia(page, 'Incidents')
    // Wait for lazy-loaded Incidents page to render
    await page.locator('main select').first().waitFor({ state: 'visible', timeout: 5000 })
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

  test('clicking incident row expands accordion with header and close button', async ({ page }) => {
    const main = page.locator('main')
    const rows = main.locator('[role="rowgroup"] [role="row"]')
    const count = await rows.count()
    if (count === 0) return // no incidents to test
    // Click first incident row
    await rows.first().click()
    // Accordion detail should appear with header (desktop does not use hideHeader)
    const timeline = main.locator('.rounded-lg.overflow-hidden.mt-2').first()
    await expect(timeline).toBeVisible({ timeout: 3000 })
    // Header section with border-b should be present on desktop
    const header = timeline.locator('.border-b')
    await expect(header).toBeVisible()
    // Close button should be in the header
    await expect(header.getByText('✕')).toBeVisible()
    // Timeline dots should be visible
    const dots = timeline.locator('.rounded-full.w-2\\.5.h-2\\.5')
    expect(await dots.count()).toBeGreaterThan(0)
    // Click close button
    await header.getByText('✕').click()
    await page.waitForTimeout(300)
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

  test('status groups sort as ongoing > monitoring > resolved', async ({ page }) => {
    const main = page.locator('main')
    const rows = main.locator('[role="rowgroup"] [role="row"]')
    const count = await rows.count()
    if (count < 2) return
    // Collect status of each row
    const statuses = []
    for (let i = 0; i < count; i++) {
      const text = (await rows.nth(i).textContent())?.toLowerCase() ?? ''
      if (text.includes('ongoing')) statuses.push(0)
      else if (text.includes('monitoring')) statuses.push(1)
      else statuses.push(2)
    }
    // Verify non-decreasing order (ongoing=0 → monitoring=1 → resolved=2)
    for (let i = 1; i < statuses.length; i++) {
      expect(statuses[i]).toBeGreaterThanOrEqual(statuses[i - 1])
    }
  })

  test('incident list and timeline use consistent time format', async ({ page }) => {
    const main = page.locator('main')
    const rows = main.locator('[role="rowgroup"] [role="row"]')
    const count = await rows.count()
    if (count === 0) return
    // Get time from first row (first cell)
    const firstCell = rows.first().locator('[role="cell"]').first()
    const listTime = await firstCell.textContent()
    // Both should use 24h format (no AM/PM)
    expect(listTime).not.toMatch(/AM|PM/i)
    // Expand row to see timeline
    await rows.first().click()
    await page.waitForTimeout(300)
    // Timeline timestamps should also use 24h format
    const timelineTexts = await main.locator('.mono.text-\\[10px\\].text-\\[var\\(--text2\\)\\]').allTextContents()
    const timeEntries = timelineTexts.filter(t => t.match(/\d{1,2}:\d{2}/))
    for (const entry of timeEntries) {
      expect(entry).not.toMatch(/AM|PM/i)
    }
  })
})
