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
    // Each URL specifies a valid YYYY-MM, and the CURRENT month is now among them (#587 —
    // the partial archive backfills current-month incidents that rolled out of the live feed).
    const currentMonth = new Date().toISOString().slice(0, 7)
    const fetchedMonths = new Set()
    for (const url of reportUrls) {
      const match = url.match(/month=(\d{4}-\d{2})/)
      expect(match).not.toBeNull()
      fetchedMonths.add(match[1])
    }
    expect(fetchedMonths.has(currentMonth)).toBe(true)
  })

  test('7d period fetches the current-month archive (#587 — short-window services need backfill)', async ({ page }) => {
    const periodSelect = page.locator('main select').nth(2)
    // 7d is the default, so selectOption('7') would be a no-op (no change event) and its initial
    // fetch already fired during page load. Move to 90d first, THEN switch to 7d so the change
    // actually fires — and attach the request listener only for that transition.
    await periodSelect.selectOption('90')
    await page.waitForTimeout(1000)

    const reportUrls = []
    page.on('request', (req) => {
      if (REPORT_PATH_RE.test(req.url())) reportUrls.push(req.url())
    })

    await periodSelect.selectOption('7')
    await page.waitForTimeout(1200)

    // 7d's window doesn't span a prior month, so it fetches ONLY the current month — re-fetched on
    // the switch because the mutable partial archive is evicted from the client cache each cycle (#587).
    expect(reportUrls.length).toBeGreaterThan(0)
    const currentMonth = new Date().toISOString().slice(0, 7)
    expect(reportUrls.every((u) => u.includes(`month=${currentMonth}`))).toBe(true)
  })

  test('30d period fetches archive months (#587 — a rolled-out incident within 30d must show)', async ({ page }) => {
    const reportUrls = []
    page.on('request', (req) => {
      if (REPORT_PATH_RE.test(req.url())) reportUrls.push(req.url())
    })

    const periodSelect = page.locator('main select').nth(2)
    await periodSelect.selectOption('30')
    await page.waitForTimeout(1200)

    // 30d now fetches the months its window spans (current + possibly the prior month).
    expect(reportUrls.length).toBeGreaterThan(0)
    const currentMonth = new Date().toISOString().slice(0, 7)
    const fetched = new Set(reportUrls.map((u) => u.match(/month=(\d{4}-\d{2})/)?.[1]))
    expect(fetched.has(currentMonth)).toBe(true)
  })
})
