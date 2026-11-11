// #1959 — the "Affected now" block on the Overview.
//
// Other mock services may also be affected (MOCK_SERVICES is merged into the response).
// The assertions compare only the services overridden here.
import { test, expect } from './fixtures.js'
import { waitForDataLoad } from './helpers.js'
import { ALL_SERVICE_IDS } from '../src/utils/constants.js'

const H = 3_600_000
const inc = (id, title, msAgo) => ({
  id, title, status: 'investigating', impact: 'major',
  startedAt: new Date(Date.now() - msAgo).toISOString(), resolvedAt: null, duration: null, timeline: [],
})
const svc = (id, name, category, provider, incidents) => ({
  id, category, name, provider, status: 'degraded', latency: 120, uptime30d: 99.5, calendarDays: 30, incidents,
})

const ANTHROPIC = inc('anthropic-shared-1959', 'Anthropic shared errors 1959', 3 * H)
const OPENAI = inc('openai-1959', 'OpenAI latency 1959', 5 * H)
const CHATGPT = inc('chatgpt-1959', 'ChatGPT image errors 1959', 1 * H)
const FAL = { ...inc('fal-1959', 'fal fix rolling out 1959', 2 * H), status: 'monitoring' }

const MOCK = {
  services: [
    svc('claude', 'Claude API', 'api', 'Anthropic', [ANTHROPIC]),
    svc('claudeai', 'claude.ai', 'app', 'Anthropic', [ANTHROPIC]),
    svc('claudecode', 'Claude Code', 'agent', 'Anthropic', [ANTHROPIC]),
    svc('openai', 'OpenAI API', 'api', 'OpenAI', [OPENAI]),
    svc('chatgpt', 'ChatGPT', 'app', 'OpenAI', [CHATGPT]),
    svc('groq', 'GroqCloud', 'api', 'Groq', []),
    svc('fal', 'fal.ai', 'api', 'fal', [FAL]),
  ],
  lastUpdated: new Date().toISOString(),
}

test.describe('Affected now block (#1959)', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/status**', (route) => route.fulfill({ json: MOCK }))
    await page.route('**/api/status/cached', (route) => route.fulfill({ json: MOCK }))
    await page.goto('/')
    await waitForDataLoad(page)
    await expect(page.getByTestId('affected-now')).toBeVisible({ timeout: 20000 })
  })

  test('services sharing one incident id are one entry, across three categories', async ({ page }) => {
    const entry = page.getByTestId('affected-entry').filter({ hasText: 'Anthropic shared errors 1959' })
    await expect(entry).toHaveCount(1)
    const members = entry.getByTestId('affected-member')
    await expect(members).toHaveCount(3)
    for (const name of ['Claude API', 'claude.ai', 'Claude Code']) {
      await expect(members.filter({ hasText: name })).toHaveCount(1)
    }
  })

  test('the entry names its group size and state, and the heading states the scope', async ({ page }) => {
    const entry = page.getByTestId('affected-entry').filter({ hasText: 'Anthropic shared errors 1959' })
    await expect(entry).toContainText(/3 services|3개 서비스/)
    await expect(entry).toContainText(/In Progress|진행 중/)
    const heading = page.getByTestId('affected-now').getByRole('heading', { level: 2 })
    await expect(heading).toContainText(/Affected now|지금 영향 중/)
    await expect(heading).toContainText(/all categories|전체 카테고리/)
    await expect(page.getByTestId('affected-entry').filter({ hasText: 'OpenAI latency 1959' })).not.toContainText(/1 services|1개 서비스/)
  })

  test('the block sits above the category sections', async ({ page }) => {
    const above = await page.evaluate(() => {
      const section = document.querySelector('[data-testid="affected-now"]')
      const firstCard = document.querySelector('[data-testid="service-card"]')
      return !!(section.compareDocumentPosition(firstCard) & Node.DOCUMENT_POSITION_FOLLOWING)
    })
    expect(above).toBe(true)
  })

  test('a monitoring incident is labelled Monitoring, a live one In Progress', async ({ page }) => {
    const entry = page.getByTestId('affected-entry').filter({ hasText: 'fal fix rolling out 1959' })
    await expect(entry).toContainText(/Monitoring|모니터링 중/)
    await expect(entry).not.toContainText(/In Progress|진행 중/)
  })

  test('an affected service with no incident is listed without an incident header', async ({ page }) => {
    const entry = page.getByTestId('affected-entry').filter({ has: page.getByTestId('affected-member').filter({ hasText: 'GroqCloud' }) })
    await expect(entry).toHaveCount(1)
    await expect(entry.getByTestId('affected-member')).toHaveCount(1)
    await expect(entry).not.toContainText(/Started|발생/)
  })

  test('entries run newest incident first, not in category order', async ({ page }) => {
    const texts = await page.getByTestId('affected-entry').allTextContents()
    const at = (title) => texts.findIndex((t) => t.includes(title))
    expect(at('ChatGPT image errors 1959')).toBeGreaterThanOrEqual(0)
    expect(at('ChatGPT image errors 1959')).toBeLessThan(at('Anthropic shared errors 1959'))
    expect(at('Anthropic shared errors 1959')).toBeLessThan(at('OpenAI latency 1959'))
  })

  test('the block is not scoped to the selected category, the grid still is', async ({ page }) => {
    await page.getByRole('tablist', { name: /Services|서비스/ }).getByRole('tab', { name: /LLM/ }).click()
    await page.waitForTimeout(200)
    const entry = page.getByTestId('affected-entry').filter({ hasText: 'ChatGPT image errors 1959' })
    await expect(entry).toHaveCount(1)
    await expect(page.getByTestId('service-card').filter({ hasText: 'ChatGPT' })).toHaveCount(0)
  })

  for (const [name, id] of [['claude.ai', 'claudeai'], ['Claude Code', 'claudecode']]) {
    test(`the ${name} member opens its own service page`, async ({ page }) => {
      await page.getByTestId('affected-entry').filter({ hasText: 'Anthropic shared errors 1959' })
        .getByTestId('affected-member').filter({ hasText: name }).click()
      await expect(page).toHaveURL(new RegExp(`#${id}$`))
      await expect(page.locator('main').getByText('Status Calendar')).toBeVisible({ timeout: 5000 })
    })
  }
})

test.describe('Affected now block, nothing affected (#1959)', () => {
  test('the block is absent when every service is operational', async ({ page }) => {
    const calm = { services: ALL_SERVICE_IDS.map((id) => ({ id, category: 'api', name: id, provider: 'x', status: 'operational', latency: 100, uptime30d: 99.9, calendarDays: 30, incidents: [] })), lastUpdated: new Date().toISOString() }
    await page.route('**/api/status**', (route) => route.fulfill({ json: calm }))
    await page.route('**/api/status/cached', (route) => route.fulfill({ json: calm }))
    await page.goto('/')
    await page.getByTestId('service-card').first().waitFor({ state: 'visible', timeout: 20000 })
    await expect(page.locator('main').getByRole('button', { name: /Issues\s*0\b/ })).toBeVisible()
    await expect(page.getByTestId('affected-now')).toHaveCount(0)
  })
})
