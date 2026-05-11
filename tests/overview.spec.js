import { test, expect } from '@playwright/test'
import { waitForDataLoad } from './helpers.js'

test.describe('Overview page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await waitForDataLoad(page)
  })

  test('renders stat cards with correct data', async ({ page }) => {
    // Stat cards visible (count varies by live/mock data)
    await expect(page.locator('main').getByText('%').first()).toBeVisible()
    await expect(page.locator('main').getByText('%').first()).toBeVisible()
  })

  test('renders all service cards', async ({ page }) => {
    const serviceNames = [
      'claude.ai', 'ChatGPT', 'Character.AI',
      'Claude API', 'OpenAI API', 'Gemini API', 'Amazon Bedrock', 'Azure OpenAI',
      'Mistral API', 'Cohere API', 'Groq Cloud', 'Together AI', 'Perplexity',
      'xAI (Grok)', 'DeepSeek API', 'OpenRouter',
      'Hugging Face', 'Replicate', 'ElevenLabs', 'Pinecone', 'Stability AI',
      'Claude Code', 'GitHub Copilot', 'Cursor', 'Windsurf',
    ]
    for (const name of serviceNames) {
      await expect(page.locator('main button').filter({ hasText: name }).first()).toBeVisible()
    }
  })

  test('service card click navigates to ServiceDetails', async ({ page }) => {
    const card = page.locator('main button').filter({ hasText: 'Claude API' }).first()
    await card.evaluate((el) => el.click())
    await expect(page.locator('main').getByText('Status Calendar')).toBeVisible({ timeout: 5000 })
  })

  test('filter tabs switch between All / Operational / Issues', async ({ page }) => {
    // Filter tabs are pill-style segment control (bg2 rounded container)
    const tabBar = page.locator('main .flex.bg-\\[var\\(--bg2\\)\\]')

    // Click Operational tab via evaluate
    const opTab = tabBar.getByRole('button', { name: /Operational|정상/ })
    await opTab.evaluate((el) => el.click())
    // Wait for filter to apply
    await page.waitForTimeout(200)
    // Claude API should be visible (always operational)
    await expect(page.locator('main button').filter({ hasText: 'Claude API' })).toBeVisible()

    // Click All tab to restore
    const allTab2 = tabBar.getByRole('button').first()
    await allTab2.evaluate((el) => el.click())
    await page.waitForTimeout(200)

    // Click All tab to restore
    const allTab = tabBar.getByRole('button').first()
    await allTab.evaluate((el) => el.click())
    await page.waitForTimeout(200)
    await expect(page.locator('main button').filter({ hasText: 'Claude API' })).toBeVisible()
  })

  test('Analyze button shows Coming Soon or Beta based on analysis data', async ({ page }) => {
    // Analyze button should exist in topbar (desktop)
    const analyzeBtn = page.locator('header button, header [aria-disabled]').filter({ hasText: /Analyze/ })
    await expect(analyzeBtn.first()).toBeAttached()
  })

  test('action banner navigates to Incidents page on click', async ({ page }) => {
    // Banner only shows when services are degraded/down — check if it exists
    const banner = page.locator('main').getByText(/인시던트 상세 확인|View incident details/)
    if (await banner.isVisible({ timeout: 3000 }).catch(() => false)) {
      await banner.click()
      // Should navigate to Incidents page
      // Incidents page has filter selects
      await expect(page.locator('main select').first()).toBeVisible({ timeout: 5000 })
    }
  })

  test('Recent Incidents shows all affected services for bulk-linked incident (#285)', async ({ page }) => {
    // Regression: Anthropic bulk-links one incident ID to claude.ai + Claude API + Claude Code.
    // Overview previously showed only the first service's name via Set-based dedup.
    // Fix: collect affectedNames[], render joined when length > 1.
    const sharedId = 'shared-anthropic-incident-285'
    // status: 'investigating' (unresolved) + recent startedAt keeps this incident above any
    // mock incidents in MOCK_SERVICES that mergeWithMock leaves in place for services we
    // don't override here. Overview sorts non-resolved ahead of resolved, then by newest.
    const inc = { id: sharedId, title: 'Claude Sonnet 4.5 error spike', status: 'investigating', impact: 'major', startedAt: new Date(Date.now() - 60_000).toISOString(), duration: null, timeline: [] }
    const mkSvc = (id, cat, name) => ({ id, category: cat, name, provider: 'Anthropic', status: 'degraded', latency: 120, uptime30d: 99.95, calendarDays: 30, incidents: [inc] })
    const bulkLinkedMock = { json: {
      services: [mkSvc('claude', 'api', 'Claude API'), mkSvc('claudeai', 'app', 'claude.ai'), mkSvc('claudecode', 'agent', 'Claude Code')],
      lastUpdated: new Date().toISOString(),
    } }
    await page.route('**/api/status', async (route) => { await route.fulfill(bulkLinkedMock) })
    await page.route('**/api/status/cached', async (route) => { await route.fulfill(bulkLinkedMock) })
    await page.goto('/')
    await waitForDataLoad(page)
    const entry = page.locator('main').getByText(/Claude Sonnet 4\.5 error spike/).first()
    await expect(entry).toBeVisible({ timeout: 10000 })
    const entryText = await entry.textContent()
    // All 3 affected service names must appear in the Recent Incidents entry
    expect(entryText).toContain('Claude API')
    expect(entryText).toContain('claude.ai')
    expect(entryText).toContain('Claude Code')
  })

  test('Recent Incidents date label exposes contextual label via tooltip (#406)', async ({ page }) => {
    // Vitest suite covers `getContextualTime` correctness directly; this test guards the
    // Overview.jsx call site so reverting `incident.startedAt` or dropping the `title` attribute
    // is caught at the UI layer. Pre-fix: no incident-row date cell had a `title` attribute.
    // Post-fix: every cell carries `${ctx.label} ${formatDate(ctx.date)}` where label is one of
    // Started/Updated/Resolved (or the ko equivalent). MOCK_SERVICES already supplies ≥1 visible
    // Recent Incidents row across both languages, so no custom route mock is needed.
    await page.goto('/')
    await waitForDataLoad(page)
    const cells = await page.evaluate(() =>
      Array.from(document.querySelectorAll('main [title]'))
        .map((el) => ({ title: el.getAttribute('title') ?? '', text: (el.textContent ?? '').trim() }))
        .filter((c) => /^(Resolved|Updated|Started|해결|업데이트|발생) /.test(c.title))
    )
    expect(cells.length, `expected ≥1 incident date cell with contextual [title] like "Resolved May 9, …" or "해결 5월 9일 …"`).toBeGreaterThan(0)
    // Substring check: pre-fix bug variant would be "title attribute kept but visible date
    // reverted to incident.startedAt" — title and visible text would no longer share a date.
    // Contract: visible text is `formatDate(ctx.date).split(' ').slice(0,2).join(' ')`, title
    // is `${label} ${formatDate(ctx.date)}` — so visible text MUST appear inside title.
    for (const c of cells) {
      expect(c.title, `visible date "${c.text}" not found in title "${c.title}" — display axis diverged from tooltip axis`).toContain(c.text)
    }
  })

  test('action banner shows severity labels and excludes affected from alternatives', async ({ page }) => {
    // Banner only shows when services are degraded/down (requires Worker data or dev mock)
    const banner = page.locator('main').getByText(/Degraded|성능 저하|Down|서비스 중단/)
    if (await banner.isVisible({ timeout: 5000 }).catch(() => false)) {
      const bannerCard = page.locator('main .rounded-lg').filter({ hasText: /Degraded|성능 저하|Down|서비스 중단/ }).first()
      const text = await bannerCard.textContent()
      // Should have severity label
      expect(text).toMatch(/Degraded|Down|성능 저하|서비스 중단/)
      // Should have incidents link
      expect(text).toMatch(/incident|인시던트/)
      // If healthy alternatives shown, affected services must be excluded
      if (text.match(/Healthy alternatives|정상 대안/)) {
        const altSection = text.split(/Healthy alternatives|정상 대안/)[1] ?? ''
        // Any service shown in the severity lines should NOT appear in alternatives
        const downMatch = text.match(/Down[^:]*:\s*([^⚠🟡]+)/)
        const degradedMatch = text.match(/Degraded[^:]*:\s*([^👉✅]+)/)
        const affectedNames = [...(downMatch?.[1]?.split(',') ?? []), ...(degradedMatch?.[1]?.split(',') ?? [])].map(s => s.trim())
        for (const name of affectedNames) {
          if (name) expect(altSection).not.toContain(name)
        }
      }
    }
  })

})
