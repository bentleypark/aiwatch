import { test, expect } from './fixtures.js'
import { waitForDataLoad } from './helpers.js'

const at = new Date(Date.now() - 30 * 60_000).toISOString()
const m365 = (id) => ({
  id, title: 'Elevated errors affecting the Microsoft 365 connector', status: 'identified', impact: 'minor',
  startedAt: at, duration: null, timeline: [{ stage: 'identified', text: 'We are investigating.', at }],
})
const svc = (id, name, provider) => ({
  id, category: 'app', name, provider, status: 'degraded', latency: null, uptime30d: 99.5, incidents: [m365(`${id}-1`)],
})
const fulfil = (services) => async (route) => route.fulfill({ json: { services, lastUpdated: new Date().toISOString() } })

test.describe('#1991 — Affected now flags a third party named by two providers', () => {
  test('two providers naming Microsoft 365 → one line naming both, linking its status page', async ({ page }) => {
    await page.route('**/api/status**', fulfil([svc('claudeai', 'claude.ai', 'Anthropic'), svc('chatgpt', 'ChatGPT', 'OpenAI')]))
    await page.goto('/')
    await waitForDataLoad(page)
    const line = page.getByTestId('shared-upstream')
    await expect(line).toHaveCount(1)
    await expect(line).toContainText('Microsoft 365')
    await expect(line).toContainText('claude.ai')
    await expect(line).toContainText('ChatGPT')
    await expect(line.getByRole('link')).toHaveAttribute('href', 'https://status.cloud.microsoft/')
  })

  test('one provider naming it → no line', async ({ page }) => {
    await page.route('**/api/status**', fulfil([svc('claudeai', 'claude.ai', 'Anthropic'), { ...svc('chatgpt', 'ChatGPT', 'OpenAI'), incidents: [] }]))
    await page.goto('/')
    await waitForDataLoad(page)
    await expect(page.getByTestId('affected-now')).toBeVisible()
    await expect(page.getByTestId('shared-upstream')).toHaveCount(0)
  })
})
