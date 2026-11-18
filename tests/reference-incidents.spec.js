import { test, expect } from './fixtures.js'
import { waitForDataLoad } from './helpers.js'

// #1669 — a Console-only incident (worker `referenceIncidents`) is listed in the cross-service logs,
// labelled "Provider · Component", and never on the Claude API service screen.

const CONSOLE = 'Claude Console (platform.claude.com)'
const LABEL = `Anthropic · ${CONSOLE}`
const TITLE = 'Elevated errors on platform.claude.com'

const MOCK = {
  services: [
    {
      id: 'claude', category: 'api', name: 'Claude API', provider: 'Anthropic', status: 'operational', latency: 120,
      incidents: [],
      referenceIncidents: [{
        id: '978mjkgw6mh7', title: TITLE, status: 'investigating', impact: 'major',
        startedAt: new Date(Date.now() - 3600_000).toISOString(), resolvedAt: null, duration: null, timeline: [],
        componentNames: [CONSOLE],
      }],
      referenceComponents: [{ id: '0qbwn08sd68x', name: CONSOLE, status: 'degraded' }],
    },
    { id: 'openai', category: 'api', name: 'OpenAI API', provider: 'OpenAI', status: 'operational', latency: 110, incidents: [] },
    {
      id: 'turbopuffer', category: 'api', name: 'turbopuffer', provider: 'turbopuffer', status: 'operational', latency: 90,
      incidents: [],
      referenceIncidents: [{
        id: '01M1SDXV1KRRFS61H6HMXPVA0P', title: 'Dashboard outage', status: 'resolved', impact: 'critical',
        startedAt: new Date(Date.now() - 2 * 3600_000).toISOString(), resolvedAt: new Date(Date.now() - 3600_000).toISOString(),
        duration: '13m', timeline: [], componentNames: ['Dashboard'],
      }],
    },
  ],
  lastUpdated: new Date().toISOString(),
}

test.describe('Reference incidents (#1669)', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/status', (route) => route.fulfill({ json: MOCK }))
    await page.route('**/api/status/cached', (route) => route.fulfill({ json: MOCK }))
  })

  test('Overview Recent Incidents lists the Console incident under the component label', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByText(`${LABEL} — ${TITLE}`)).toBeVisible({ timeout: 20000 })
  })

  test('Incidents page lists it as ongoing in the all-services view, and under no service filter', async ({ page }) => {
    await page.goto('/#incidents')
    const row = page.getByRole('row').filter({ hasText: TITLE })
    await expect(row).toContainText(LABEL, { timeout: 20000 })

    await page.locator('select[aria-label="Status"]').selectOption('ongoing')
    await expect(row).toBeVisible()

    await page.locator('select[aria-label="Status"]').selectOption('all')
    await page.locator('select[aria-label="Service"]').selectOption('claude')
    await expect(page.getByRole('row').filter({ hasText: TITLE })).toHaveCount(0)
  })

  test('#1672 a row whose label names the service shows under that service filter', async ({ page }) => {
    await page.goto('/#incidents')
    await expect(page.getByRole('row').filter({ hasText: 'Dashboard outage' })).toContainText('turbopuffer · Dashboard', { timeout: 20000 })
    await page.locator('select[aria-label="Service"]').selectOption('turbopuffer')
    await expect(page.getByRole('row').filter({ hasText: 'Dashboard outage' })).toBeVisible()
  })

  test('the Claude API detail page does not show it', async ({ page }) => {
    await page.goto('/#claude')
    await expect(page.getByText(/Incident History|인시던트 히스토리/i)).toBeVisible({ timeout: 20000 })
    await expect(page.getByText(TITLE)).toHaveCount(0)
  })
})

// #2027 — a service the response omits falls back to MOCK_SERVICES (`mergeWithMock`), so each test loads
// the same payload with the reference incident open and then resolved, and compares the two.
const mockWith = (refStatus) => ({
  ...MOCK,
  services: MOCK.services.map((s) => {
    if (s.id === 'claude') {
      const resolved = refStatus === 'resolved'
      const timeline = [{ stage: 'investigating', text: 'We are investigating the console errors 2027.', at: new Date(Date.now() - 3600_000).toISOString() }]
      return { ...s, referenceIncidents: [{ ...s.referenceIncidents[0], status: refStatus, timeline, resolvedAt: resolved ? new Date().toISOString() : null }] }
    }
    if (s.id === 'openai') {
      return { ...s, status: 'degraded', incidents: [{ id: 'openai-2027', title: 'OpenAI latency 2027', status: 'investigating', impact: 'major', startedAt: new Date(Date.now() - 3600_000).toISOString(), resolvedAt: null, duration: null, timeline: [] }] }
    }
    return s
  }),
})

async function serve(page, mock) {
  await page.route('**/api/status', (route) => route.fulfill({ json: mock }))
  await page.route('**/api/status/cached', (route) => route.fulfill({ json: mock }))
}

test.describe('Open reference incidents on the Overview (#2027)', () => {
  test('the sidebar Incidents badge counts the open reference incident the page lists', async ({ page }) => {
    const badge = async () => {
      const button = page.locator('aside').first().getByRole('button', { name: /Incidents|인시던트/ })
      await expect(button).toBeVisible({ timeout: 20000 })
      const m = (await button.innerText()).match(/\d+/)
      return m ? Number(m[0]) : 0
    }
    await serve(page, mockWith('resolved'))
    await page.goto('/')
    await waitForDataLoad(page)
    const whenResolved = await badge()

    await serve(page, mockWith('investigating'))
    await page.reload()
    await waitForDataLoad(page)
    expect(await badge()).toBe(whenResolved + 1)
  })

  test('a monitoring reference incident is labelled Monitoring, not In Progress', async ({ page }) => {
    await serve(page, mockWith('monitoring'))
    await page.goto('/')
    const entry = page.getByTestId('affected-reference-entry')
    await expect(entry).toContainText(/Monitoring|모니터링 중/, { timeout: 20000 })
    await expect(entry).not.toContainText(/In Progress|진행 중/)
  })

  test('Affected now lists the open reference incident as an entry with its timeline, without changing its counts', async ({ page }) => {
    await serve(page, mockWith('resolved'))
    await page.goto('/')
    await expect(page.getByTestId('affected-now')).toBeVisible({ timeout: 20000 })
    await expect(page.getByTestId('affected-reference')).toHaveCount(0)
    const summary = await page.getByTestId('affected-summary').innerText()
    const entries = await page.getByTestId('affected-entry').count()

    await serve(page, mockWith('investigating'))
    await page.reload()
    const section = page.getByTestId('affected-reference')
    await expect(section).toBeVisible({ timeout: 20000 })
    await expect(section.getByRole('list', { name: /Reference incidents|참고 인시던트/ })).toBeVisible()
    const entry = section.getByTestId('affected-reference-entry')
    await expect(entry).toHaveCount(1)
    await expect(entry).toContainText(TITLE)
    await expect(entry).toContainText(LABEL)
    await expect(entry).toContainText(/In Progress|진행 중/)
    await expect(page.getByTestId('affected-summary')).toHaveText(summary)
    await expect(page.getByTestId('affected-entry')).toHaveCount(entries)

    await entry.getByTestId('affected-reference-header').click()
    await expect(page.getByTestId('affected-reference-panel')).toContainText('investigating the console errors 2027')
    expect(new URL(page.url()).hash).not.toBe('#incidents')
  })
})
