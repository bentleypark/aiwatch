// #375 — pin the network contract for the 90d archive merge.
// The unit suite covers merge/dedup logic; this E2E verifies the live wiring:
// the Incidents page actually issues the /api/report fetch when 90d/30d is selected
// (incl. the current month, #587), and only the current month for 7d.
//
// #650 — made deterministic + production-independent:
//   1. `/api/report` is MOCKED (was hitting the real worker via VITE_API_URL||prod, so the result
//      depended on whatever the live current-month archive returned — 404 vs partial:true).
//   2. The `request` listener is attached BEFORE `goto('/')` so the current-month fetch fired by the
//      initial period=7 mount is captured too. Previously the listener attached after the mount, and
//      the current-month promise (partial → evicted only AFTER it resolves) was still pending in the
//      client cache when the test changed period, so `fetchArchive(currentMonth)` reused the pending
//      promise and issued no new request — a race the slow CI runner lost every time (deterministic
//      CI failure, deterministic local pass).
//   3. Bounded `expect.poll` on the captured requests instead of fixed `waitForTimeout` sleeps.

import { test, expect } from './fixtures.js'
import { waitForDataLoad, navigateVia } from './helpers.js'

const REPORT_PATH_RE = /\/api\/report\?month=\d{4}-\d{2}/
const currentMonth = () => new Date().toISOString().slice(0, 7)
const monthsOf = (urls) => new Set(urls.map((u) => u.match(/month=(\d{4}-\d{2})/)?.[1]).filter(Boolean))

// Deterministic /api/report: the current month is served as a `partial:true` archive (#587) — so
// useMonthlyArchives evicts + re-fetches it on each period change; finished months are plain 200 and
// stay cached. Body is minimal (no services) — this test pins the *network contract*, not merge logic.
async function mockReport(page) {
  await page.route(REPORT_PATH_RE, (route) => {
    const month = new URL(route.request().url()).searchParams.get('month')
    route.fulfill({ json: { period: month, partial: month === currentMonth(), services: {} } })
  })
}

// Attach the report-request capture BEFORE navigating so the initial period=7 mount's current-month
// fetch is recorded, then load the Incidents page. Returns the live-collected reportUrls array.
// NOTE: only `/api/report` is mocked — `/api/status` is left live (same dependency every other
// non-status-mocked spec carries) because this test asserts only the `/api/report` network contract.
async function openIncidents(page) {
  const reportUrls = []
  page.on('request', (req) => { if (REPORT_PATH_RE.test(req.url())) reportUrls.push(req.url()) })
  await mockReport(page)
  await page.goto('/')
  await waitForDataLoad(page)
  await navigateVia(page, 'Incidents')
  await page.locator('main select').first().waitFor({ state: 'visible', timeout: 5000 })
  return reportUrls
}

test.describe('Incidents — 90d archive merge (#375)', () => {
  test('selecting 90d fetches the window archive months incl. the current month', async ({ page }) => {
    const reportUrls = await openIncidents(page)

    const periodSelect = page.locator('main select').nth(2)
    await periodSelect.selectOption('90')

    // 90d spans the current month + ≥1 prior month → wait until >1 distinct month is requested
    // (deterministic signal, replaces a fixed sleep).
    await expect.poll(() => monthsOf(reportUrls).size, { timeout: 5000 }).toBeGreaterThan(1)

    // Every report URL carries a valid YYYY-MM, and the CURRENT month is among them (#587 — the
    // partial archive backfills current-month incidents that rolled out of the live feed).
    for (const url of reportUrls) expect(url).toMatch(/month=\d{4}-\d{2}/)
    expect(monthsOf(reportUrls).has(currentMonth())).toBe(true)
  })

  test('7d period fetches the current-month archive (#587 — short-window services need backfill)', async ({ page }) => {
    // The default period is 7, so the initial mount already fetched the current month — captured
    // because the listener is attached before goto.
    const reportUrls = await openIncidents(page)

    await expect.poll(() => reportUrls.length, { timeout: 5000 }).toBeGreaterThan(0)
    // Assert the CURRENT month is fetched (the #587 backfill), not that it's the ONLY month: near the
    // start of a month the 7d window (now−7d … now) spans the PRIOR month too, so the prior-month
    // archive is legitimately fetched as well. The old `.every(current)` false-failed on the 1st–6th
    // (e.g. Jul 1 → window includes late June). Matches the 90d/30d tests' `.has(currentMonth())`.
    for (const url of reportUrls) expect(url).toMatch(/month=\d{4}-\d{2}/)
    expect(monthsOf(reportUrls).has(currentMonth())).toBe(true)
  })

  test('30d period fetches archive months incl. the current month (#587 — a rolled-out incident within 30d must show)', async ({ page }) => {
    const reportUrls = await openIncidents(page)

    const periodSelect = page.locator('main select').nth(2)
    await periodSelect.selectOption('30')

    // 30d fetches the months its window spans (current + usually the prior month). We assert only the
    // current month here: whether the prior month is included is calendar-edge-dependent (on, e.g., a
    // 31st, `now-30d` lands in the same month → current only), so asserting a 2-month span would
    // reintroduce a date-dependent flake — exactly what #650 removed. The robust multi-month-fetch
    // contract is pinned by the 90d test above.
    await expect.poll(() => reportUrls.length, { timeout: 5000 }).toBeGreaterThan(0)
    expect(monthsOf(reportUrls).has(currentMonth())).toBe(true)
  })
})
