import { expect } from './fixtures.js'
// Shared test helpers — usePolling has an 800ms simulated loading delay.

export async function waitForDataLoad(page) {
  // Wait for the skeleton to clear — a service card name is a reliable signal.
  // Filter to the visible match: under some live-data layouts (e.g. when an
  // ActionBanner renders above the grid because a service is down/degraded) the
  // first 'Claude API' node in <main> is a 0×0 element, so a bare `.first()`
  // resolves to a never-visible node and times out (#455).
  await page.locator('main').getByText('Claude API').filter({ visible: true }).first().waitFor({ state: 'visible', timeout: 20000 })
}

// Navigate to a page via sidebar click (desktop only)
export async function navigateVia(page, label) {
  const sidebar = page.locator('aside').first()
  await sidebar.getByRole('button', { name: label }).click()
}

// Navigate to Settings via Topbar gear button (Settings is not in sidebar)
export async function navigateToSettings(page) {
  await page.locator('header button[aria-label]').last().click()
}

// #1405 — two cards with the same one-line name, only the first carrying an upcoming maintenance window.
export async function serveMaintenanceCard(page) {
  const card = { category: 'api', name: 'Cerebras Inference', provider: 'Cerebras', status: 'operational', latency: 300, uptime30d: 100, incidents: [] }
  const mock = { json: { services: [
    { ...card, id: 'cerebras', scheduledMaintenances: [{ id: 'eu', title: 'EU cluster storage maintenance',
      scheduledFor: '2099-11-04T04:00:00.000Z', scheduledUntil: '2099-11-04T10:00:00.000Z', componentNames: [] }] },
    { ...card, id: 'groq' },
  ], lastUpdated: new Date().toISOString() } }
  await page.route('**/api/status**', (route) => route.fulfill(mock))
  await page.route('**/api/status/cached', (route) => route.fulfill(mock))
}

// #1405 — where the visible maintenance chip renders relative to its card's status pill.
export async function maintenanceChipBoxes(page) {
  const chip = page.locator('[data-testid="maintenance-chip"]:visible')
  await expect(chip).toHaveCount(1)
  const card = page.locator('[data-testid="service-card"]', { has: chip })
  const pill = card.locator('span:visible', { hasText: /^Operational$/i })
  return { chip: await chip.boundingBox(), pill: await pill.boundingBox() }
}

// #1405 — the visible name heights of the two same-named cards `serveMaintenanceCard` serves.
export async function twinNameHeights(page) {
  const names = page.locator('[data-testid="service-card"] :visible', { hasText: /^Cerebras Inference$/ })
  await expect(names).toHaveCount(2)
  return [(await names.nth(0).boundingBox()).height, (await names.nth(1).boundingBox()).height]
}
