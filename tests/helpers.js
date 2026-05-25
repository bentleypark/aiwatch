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
