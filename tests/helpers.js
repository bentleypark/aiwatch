// Shared test helpers — usePolling has an 800ms simulated loading delay.

export async function waitForDataLoad(page) {
  // Wait for the skeleton to clear — stat card "11" (operational count) is a reliable signal
  await page.locator('main').getByText('11').first().waitFor({ state: 'visible', timeout: 5000 })
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
