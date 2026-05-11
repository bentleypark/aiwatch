// #375 — pin the network contract for the 90d archive merge.
// The unit suite covers merge/dedup logic; this E2E verifies the live wiring:
// the Incidents page actually issues the /api/report fetch when 90d is selected,
// and does NOT issue it for 7d/30d (those windows are already covered by live data).

import { test, expect } from '@playwright/test'
import { waitForDataLoad, navigateVia } from './helpers.js'

const REPORT_PATH_RE = /\/api\/report\?month=\d{4}-\d{2}/

test.describe('Incidents — 90d archive merge (#375)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await waitForDataLoad(page)
    await navigateVia(page, 'Incidents')
    await page.locator('main select').first().waitFor({ state: 'visible', timeout: 5000 })
  })

  test('selecting 90d period triggers /api/report fetch for archive months', async ({ page }) => {
    // Track ALL /api/report URLs the page hits during the test. We capture both 'request'
    // (asserts the fetch fires) and don't care about the response body — the unit suite
    // already covers merge logic. Network-contract pin only.
    const reportUrls = []
    page.on('request', (req) => {
      const url = req.url()
      if (REPORT_PATH_RE.test(url)) reportUrls.push(url)
    })

    const periodSelect = page.locator('main select').nth(2)
    await periodSelect.selectOption('90')

    // useMonthlyArchives fires the fetch via useEffect — give it a beat to settle.
    // 1500ms is conservative: archives are cached process-wide, but cold start needs
    // Promise.all over 3 fetches. CI on slower runners has been the timing concern.
    await page.waitForTimeout(1500)

    expect(reportUrls.length).toBeGreaterThan(0)
    // Each URL should specify a YYYY-MM that's NOT the current month (live covers it)
    const currentMonth = new Date().toISOString().slice(0, 7)
    for (const url of reportUrls) {
      const match = url.match(/month=(\d{4}-\d{2})/)
      expect(match).not.toBeNull()
      expect(match[1]).not.toBe(currentMonth)
    }
  })

  test('7d period does NOT trigger /api/report fetch', async ({ page }) => {
    const reportUrls = []
    page.on('request', (req) => {
      if (REPORT_PATH_RE.test(req.url())) reportUrls.push(req.url())
    })

    const periodSelect = page.locator('main select').nth(2)
    // 7d is already the default per Incidents.jsx initial state, but selecting explicitly
    // exercises the filter-change path the way a user would.
    await periodSelect.selectOption('7')
    await page.waitForTimeout(800)

    expect(reportUrls).toHaveLength(0)
  })

  test('30d period does NOT trigger /api/report fetch (live data covers 30d)', async ({ page }) => {
    const reportUrls = []
    page.on('request', (req) => {
      if (REPORT_PATH_RE.test(req.url())) reportUrls.push(req.url())
    })

    const periodSelect = page.locator('main select').nth(2)
    await periodSelect.selectOption('30')
    await page.waitForTimeout(800)

    expect(reportUrls).toHaveLength(0)
  })
})
