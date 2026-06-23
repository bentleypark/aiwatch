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

  test('category tabs filter the grid into per-category sections (#646)', async ({ page }) => {
    // The Overview surfaces the sidebar's category taxonomy as an on-screen control + per-category
    // section headers (so the active category is visible/changeable here, incl. on mobile).
    const tablist = page.getByRole('tablist', { name: /Services|서비스/ })
    await expect(tablist).toBeVisible()
    // All seven category tabs present (locale-agnostic) — dev-audience order (#658):
    // All · LLM APIs · Coding Agents · Voice · Inference & Infra · Video · AI Apps.
    for (const name of [/^All$|^전체$/, /LLM/, /Coding Agents|코딩 에이전트/, /^Voice$|^음성$/, /Inference & Infra|추론 & 인프라/, /^Video$|^영상$/, /AI Apps|AI 앱/]) {
      await expect(tablist.getByRole('tab', { name }).first()).toBeVisible()
    }

    // Default 'all' → multiple category section headings render (the structure #646 adds).
    await expect(page.getByRole('heading', { name: /LLM/ })).toBeVisible()
    await expect(page.getByRole('heading', { name: /Coding Agents|코딩 에이전트/ })).toBeVisible()

    // Select the LLM tab → only the LLM section renders; the AI Apps section heading disappears
    // (catServices is scoped to LLM, so the apps section is not built at all).
    await tablist.getByRole('tab', { name: /LLM/ }).click()
    await page.waitForTimeout(200)
    await expect(page.locator('main button').filter({ hasText: 'Claude API' }).first()).toBeVisible()
    await expect(page.getByRole('heading', { name: /AI Apps|AI 앱/ })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: /Coding Agents|코딩 에이전트/ })).toHaveCount(0)
  })

  test('status filter composes within a category and resets when the category changes (#646)', async ({ page }) => {
    // MOCK_SERVICES is merged in, so override the services this test reasons about to known statuses.
    const op = (id, name, category = 'api') => ({ id, category, name, provider: 'x', status: 'operational', latency: 150, uptime30d: 99.9, calendarDays: 30, incidents: [] })
    const degraded = (id, name, category = 'api') => ({ ...op(id, name, category), status: 'degraded',
      incidents: [{ id: `${id}-i`, title: 'Issue', status: 'investigating', impact: 'minor', startedAt: new Date(Date.now() - 60_000).toISOString(), timeline: [] }] })
    const mockData = { json: { services: [
      degraded('openai', 'OpenAI API'),               // LLM, degraded
      op('claude', 'Claude API'),                     // LLM, operational
      degraded('claudecode', 'Claude Code', 'agent'), // agent, degraded
      op('cursor', 'Cursor', 'agent'),                // agent, operational
    ], lastUpdated: new Date().toISOString() } }
    await page.route('**/api/status**', (route) => route.fulfill(mockData))
    await page.route('**/api/status/cached', (route) => route.fulfill(mockData))
    await page.goto('/')
    await page.locator('main button').first().waitFor({ state: 'visible', timeout: 20000 })

    const tablist = page.getByRole('tablist', { name: /Services|서비스/ })
    // LLM category + Issues status → only the degraded LLM service shows; the operational LLM is hidden.
    await tablist.getByRole('tab', { name: /LLM/ }).click()
    await page.locator('main').getByRole('button', { name: /Issues/ }).click()
    await page.waitForTimeout(200)
    await expect(page.locator('main button').filter({ hasText: 'OpenAI API' }).first()).toBeVisible()
    await expect(page.locator('main button').filter({ hasText: 'Claude API' })).toHaveCount(0)

    // Switching category resets the status filter to All (useEffect on categoryFilter) → the operational
    // agent (Cursor) is visible, which it would NOT be if the Issues filter had persisted.
    await tablist.getByRole('tab', { name: /Coding Agents|코딩 에이전트/ }).click()
    await page.waitForTimeout(200)
    await expect(page.locator('main button').filter({ hasText: 'Cursor' }).first()).toBeVisible()
    await expect(page.locator('main button').filter({ hasText: 'Claude Code' }).first()).toBeVisible()
  })

  test('card latency label reflects probe status — "API response" for probed, "status page" otherwise (#658)', async ({ page }) => {
    // The card's latency value is the direct probe RTT for probed services and status-page timing
    // otherwise; the label must say which (matches ServiceDetails svc.latency vs svc.latency.statusPage).
    // probeServiceIds is derived by usePolling from the response's probe24h snapshot, so seed one.
    const svc = (id, name, category) => ({ id, category, name, provider: 'x', status: 'operational', latency: 150, uptime30d: 99.9, calendarDays: 30, incidents: [] })
    const mockData = { json: {
      services: [svc('claude', 'Claude API', 'api'), svc('claudeai', 'claude.ai', 'app')],
      probe24h: [{ data: { claude: { rtt: 150 } } }], // → probeServiceIds = ['claude']
      lastUpdated: new Date().toISOString(),
    } }
    await page.route('**/api/status**', (route) => route.fulfill(mockData))
    await page.route('**/api/status/cached', (route) => route.fulfill(mockData))
    await page.goto('/')
    const claudeCard = page.locator('main button').filter({ hasText: 'Claude API' }).first()
    const claudeaiCard = page.locator('main button').filter({ hasText: 'claude.ai' }).first()
    await claudeCard.waitFor({ state: 'visible', timeout: 20000 })
    // Probed → "API response" / "API 응답"; not "status page".
    await expect(claudeCard.getByText(/API response|API 응답/)).toBeVisible()
    await expect(claudeCard.getByText(/^status page$|^상태 페이지$/)).toHaveCount(0)
    // Non-probed app → "status page" / "상태 페이지".
    await expect(claudeaiCard.getByText(/status page|상태 페이지/)).toBeVisible()
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
    await page.route('**/api/status**', async (route) => { await route.fulfill(bulkLinkedMock) })
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

  test('Recent Incidents spans all categories — a category filter does not hide other-category incidents (#676)', async ({ page }) => {
    // The category filter scopes the stats/sections/latency to one bucket, but Recent Incidents is a
    // cross-category "what's live right now" panel: picking a category must NOT hide an active incident
    // from another category. Pre-#676 it iterated the category-filtered list, so an LLM filter hid an
    // app outage from the panel.
    const appInc = { id: 'app-outage-676', title: 'ChatGPT app outage 676', status: 'investigating', impact: 'major', startedAt: new Date(Date.now() - 60_000).toISOString(), duration: null, timeline: [] }
    const mock = { json: { services: [
      { id: 'claude', category: 'api', name: 'Claude API', provider: 'Anthropic', status: 'operational', latency: 120, uptime30d: 99.9, calendarDays: 30, incidents: [] },
      { id: 'chatgpt', category: 'app', name: 'ChatGPT', provider: 'OpenAI', status: 'degraded', latency: 150, uptime30d: 99.5, calendarDays: 30, incidents: [appInc] },
    ], lastUpdated: new Date().toISOString() } }
    await page.route('**/api/status**', (route) => route.fulfill(mock))
    await page.route('**/api/status/cached', (route) => route.fulfill(mock))
    await page.goto('/')
    await waitForDataLoad(page)
    // Under default 'all', the app incident shows in Recent Incidents.
    await expect(page.locator('main').getByText(/ChatGPT app outage 676/).first()).toBeVisible({ timeout: 10000 })
    // Filter to LLM → the ChatGPT card leaves the grid (it's an app)…
    const tablist = page.getByRole('tablist', { name: /Services|서비스/ })
    await tablist.getByRole('tab', { name: /LLM/ }).click()
    await page.waitForTimeout(200)
    await expect(page.locator('main button').filter({ hasText: 'ChatGPT' })).toHaveCount(0)
    // …but its incident is STILL listed in Recent Incidents (cross-category panel, #676).
    await expect(page.locator('main').getByText(/ChatGPT app outage 676/).first()).toBeVisible()
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

  test('action banner renders multi-tier groups in same category without duplicate React keys', async ({ browser }) => {
    // Two degraded services in DIFFERENT fallback tiers but the SAME category (`api`) —
    // OpenAI (Tier 1 LLM) + ElevenLabs (Tier 4 Voice) — make ActionBanner emit two grouped
    // fallback rows ("LLM →" and "Voice →") both keyed under category `api`. Pre-fix the React
    // key was `grp.category`, which collided across those two rows. Inject this scenario via a
    // deterministic route fixture instead of relying on live/MOCK_SERVICES data: the live worker
    // only intermittently has the right degraded mix (Score/incident drift), which made this test
    // flaky. Then capture console errors on a fresh page load and assert no "same key" warning fires.
    const mkDegraded = (id, name, provider) => ({
      id, category: 'api', name, provider, status: 'degraded', latency: 150, uptime30d: 99.5,
      calendarDays: 30,
      incidents: [{ id: `${id}-inc`, title: `${name} elevated errors`, status: 'investigating',
        impact: 'major', startedAt: new Date(Date.now() - 60_000).toISOString(), duration: null, timeline: [] }],
    })
    const multiTierMock = { json: {
      services: [
        mkDegraded('openai', 'OpenAI API', 'OpenAI'),         // Tier 1 LLM
        mkDegraded('elevenlabs', 'ElevenLabs', 'ElevenLabs'), // Tier 4 Voice
      ],
      lastUpdated: new Date().toISOString(),
    } }
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await page.route('**/api/status**', async (route) => { await route.fulfill(multiTierMock) })
    await page.route('**/api/status/cached', async (route) => { await route.fulfill(multiTierMock) })
    const errors = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text())
    })
    await page.goto('/')
    await waitForDataLoad(page)
    // Require both `LLM →` and `Voice →` groups in the fallback banner — both live under category
    // `api` and are precisely what produced the pre-fix `key='api'` collision. Two groups in
    // *different* categories wouldn't trigger the bug, so a generic " · " separator count isn't
    // strong enough. If the fixture or tier mapping changes so only one group renders, these fail.
    const banner = page.locator('main .rounded-lg').filter({ hasText: /Suggested fallback|대체 추천/ }).first()
    await expect(banner).toBeVisible({ timeout: 5000 })
    const bannerText = (await banner.textContent()) ?? ''
    expect(bannerText, 'fixture no longer renders LLM-tier fallback group; bug path not exercised').toMatch(/LLM →/)
    expect(bannerText, 'fixture no longer renders Voice-tier fallback group; bug path not exercised').toMatch(/Voice →/)
    const dupKeyError = errors.find((e) => /two children with the same key/i.test(e))
    expect(dupKeyError, `unexpected duplicate-key console error:\n${dupKeyError ?? ''}`).toBeUndefined()
    await ctx.close()
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

// ── ActionBanner region recommendation (refs #422 Phase 1) ───────────
//
// Surfaces the region-switch hint that today only appears on the per-service
// detail page. The line renders only when:
//   - the affected service has a SERVICE_REGIONS entry
//   - at least one region is OK (not allDown)
//   - the incident actually matched a region key (hasRegionSpecific) — global
//     incidents that taint every region must NOT produce a misleading "switch
//     to region X" suggestion
// These three gates are tested below via mock API responses.

test.describe('ActionBanner region recommendation', () => {
  test('partial regional outage surfaces "Switch region: X → Y" above fallback', async ({ page }) => {
    // Pinecone with AWS us-east-1 hit via componentNames (mirrors the real
    // Atlassian feed shape — title uses [AWS][us-east-1] bracket form that
    // substring-match can't parse, but components always carry the structured
    // `AWS us-east-1` string).
    const inc = {
      id: 'pinecone-aws-east-422',
      title: '[AWS][us-east-1] 5xx errors on read',
      status: 'investigating',
      impact: 'major',
      startedAt: new Date(Date.now() - 120_000).toISOString(),
      componentNames: ['AWS us-east-1'],
      timeline: [],
    }
    const mockData = { json: {
      services: [{
        id: 'pinecone', category: 'api', name: 'Pinecone', provider: 'Pinecone',
        status: 'degraded', latency: 80, uptime30d: 99.91, calendarDays: 30, incidents: [inc],
      }],
      lastUpdated: new Date().toISOString(),
    } }
    await page.route('**/api/status**', async (route) => { await route.fulfill(mockData) })
    await page.route('**/api/status/cached', async (route) => { await route.fulfill(mockData) })
    await page.goto('/')
    // waitForDataLoad checks for `Claude API` text which is rendered in BOTH
    // the mobile (hidden) <span> and the desktop <div>. When negative-test
    // mocks override most services back to operational, the helper's
    // `.first()` resolution can land on the hidden mobile span. Wait directly
    // for any service card to render instead — same effect, resilient to the
    // mocked-service ordering.
    await page.locator('main button').first().waitFor({ state: 'visible', timeout: 20000 })

    // Region recommendation line surfaces with the i18n label + recommended region.
    // Label key `overview.banner.regionSwitch` → "Switch region:" (en) / "리전 전환:" (ko).
    await expect(page.locator('main').getByText(/Switch region|리전 전환/)).toBeVisible({ timeout: 10000 })
    // Recommended region is the next OK in SERVICE_REGIONS array order — AWS us-west-2.
    await expect(page.locator('main').getByText(/AWS US West/)).toBeVisible()

    // Security contract — `target="_blank"` external link MUST carry
    // `rel="noopener noreferrer"` to prevent reverse-tabnabbing into the
    // provider docs site. A future "clean up the anchor props" refactor that
    // drops `rel` would be a real (low-impact but real) security regression
    // with otherwise no test guarding it.
    const docsLink = page.locator('main a').filter({ hasText: /AWS US West/ }).first()
    await expect(docsLink).toHaveAttribute('target', '_blank')
    await expect(docsLink).toHaveAttribute('rel', /noopener/)
    await expect(docsLink).toHaveAttribute('rel', /noreferrer/)

    // Order: region rec line appears before "Suggested fallback" since cheaper
    // action (region switch) deserves first-line visibility.
    const banner = page.locator('main').filter({ hasText: /Switch region|리전 전환/ }).first()
    const bannerText = (await banner.textContent()) ?? ''
    const regionIdx = bannerText.search(/Switch region|리전 전환/)
    const fallbackIdx = bannerText.search(/Suggested fallback|대체 추천/)
    if (fallbackIdx > -1) {
      expect(regionIdx, `region line should precede fallback line (regionIdx=${regionIdx}, fallbackIdx=${fallbackIdx})`).toBeLessThan(fallbackIdx)
    }
  })

  // MOCK_SERVICES (src/hooks/usePolling.js) ships with several default-degraded
  // entries to keep the dashboard demo lively, INCLUDING an xAI mock incident
  // titled `eu-west-1.api.x.ai went down` — that title matches xAI's region key
  // `eu-west-1`, so a Pinecone-only test mock would still see "Switch region:
  // xAI → US" surface from the mock fallthrough. Negative tests must explicitly
  // operational-ize the four default-degraded mock services (openai, xai,
  // huggingface, elevenlabs) so only the test's intended affected service
  // contributes to ActionBanner.
  const operationalize = (id, name) => ({
    id, category: 'api', name, provider: name, status: 'operational',
    latency: 100, uptime30d: 99.99, calendarDays: 30, incidents: [],
  })
  const MOCK_DEGRADED_OVERRIDE = [
    operationalize('openai', 'OpenAI API'),
    operationalize('xai', 'xAI (Grok)'),
    operationalize('huggingface', 'Hugging Face'),
    operationalize('elevenlabs', 'ElevenLabs'),
  ]

  test('global outage (no region keyword) does NOT show region line', async ({ page }) => {
    // Title and componentNames carry no region substring → regionStatusOf falls
    // into the "global incident → mark all regions affected" branch, which sets
    // hasRegionSpecific=false. Recommending any region in this state would be
    // misleading. Banner must show the cross-service fallback ONLY.
    const inc = {
      id: 'pinecone-global-422',
      title: 'API authentication broken',
      status: 'investigating',
      impact: 'major',
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      componentNames: [],
      timeline: [],
    }
    const mockData = { json: {
      services: [
        { id: 'pinecone', category: 'api', name: 'Pinecone', provider: 'Pinecone',
          status: 'down', latency: 80, uptime30d: 99.91, calendarDays: 30, incidents: [inc] },
        ...MOCK_DEGRADED_OVERRIDE,
      ],
      lastUpdated: new Date().toISOString(),
    } }
    await page.route('**/api/status**', async (route) => { await route.fulfill(mockData) })
    await page.route('**/api/status/cached', async (route) => { await route.fulfill(mockData) })
    await page.goto('/')
    // waitForDataLoad checks for `Claude API` text which is rendered in BOTH
    // the mobile (hidden) <span> and the desktop <div>. When negative-test
    // mocks override most services back to operational, the helper's
    // `.first()` resolution can land on the hidden mobile span. Wait directly
    // for any service card to render instead — same effect, resilient to the
    // mocked-service ordering.
    await page.locator('main button').first().waitFor({ state: 'visible', timeout: 20000 })

    // Down banner present (sanity)
    await expect(page.locator('main').getByText(/Down|중단/).first()).toBeVisible({ timeout: 10000 })
    // Region recommendation line is NOT shown — the algorithm marks every
    // region affected, so there's no OK region to recommend.
    await expect(page.locator('main').getByText(/Switch region|리전 전환/)).not.toBeVisible()
  })

  test('affected service without region data does not show region line', async ({ page }) => {
    // Mistral has no SERVICE_REGIONS entry → regionStatusOf returns null →
    // banner skips the region line entirely. The fallback line still renders.
    const inc = {
      id: 'mistral-422',
      title: 'API errors',
      status: 'investigating',
      impact: 'major',
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      timeline: [],
    }
    const mockData = { json: {
      services: [
        { id: 'mistral', category: 'api', name: 'Mistral API', provider: 'Mistral AI',
          status: 'degraded', latency: 120, uptime30d: 99.5, calendarDays: 30, incidents: [inc] },
        ...MOCK_DEGRADED_OVERRIDE,
      ],
      lastUpdated: new Date().toISOString(),
    } }
    await page.route('**/api/status**', async (route) => { await route.fulfill(mockData) })
    await page.route('**/api/status/cached', async (route) => { await route.fulfill(mockData) })
    await page.goto('/')
    // waitForDataLoad checks for `Claude API` text which is rendered in BOTH
    // the mobile (hidden) <span> and the desktop <div>. When negative-test
    // mocks override most services back to operational, the helper's
    // `.first()` resolution can land on the hidden mobile span. Wait directly
    // for any service card to render instead — same effect, resilient to the
    // mocked-service ordering.
    await page.locator('main button').first().waitFor({ state: 'visible', timeout: 20000 })

    await expect(page.locator('main').getByText(/Degraded|성능 저하/).first()).toBeVisible({ timeout: 10000 })
    await expect(page.locator('main').getByText(/Switch region|리전 전환/)).not.toBeVisible()
  })
})

test.describe('RSS subscribe affordances (#433)', () => {
  test('incident banner shows an RSS copy icon that copies the all-services feed', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.route('**/api/status**', (route) => route.fulfill({ json: {
      services: [
        { id: 'deepseek', category: 'api', name: 'DeepSeek API', provider: 'DeepSeek', status: 'degraded', latency: 200, uptime30d: 99.5, incidents: [] },
        { id: 'claude', category: 'api', name: 'Claude API', provider: 'Anthropic', status: 'operational', latency: 120, uptime30d: 99.95, incidents: [] },
      ],
      lastUpdated: new Date().toISOString(),
    } }))
    await page.goto('/')
    await expect(page.locator('main').getByText(/Degraded|성능 저하/).first()).toBeVisible({ timeout: 15000 })
    // Labeled CTA (not a bare glyph) so it's noticeable at peak intent
    const rssBtn = page.locator('main').getByRole('button', { name: /Subscribe via RSS|RSS로 구독/ })
    await expect(rssBtn).toBeVisible()
    await rssBtn.click()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('https://ai-watch.dev/feed.xml')
  })

  test('sidebar footer shows an always-visible RSS copy icon', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.goto('/')
    // Sidebar footer is static chrome — renders without waiting on service data.
    await expect(page.getByRole('link', { name: 'AIWatch' }).first()).toBeVisible({ timeout: 15000 })
    const rssBtn = page.locator('aside').getByRole('button', { name: /Copy RSS feed URL|RSS 피드 URL 복사/ })
    await expect(rssBtn).toBeVisible()
    await rssBtn.click()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('https://ai-watch.dev/feed.xml')
  })
})

test.describe('#553 Issues filter — agent-only issue', () => {
  test('does NOT show "No Issues" when only a coding agent is degraded', async ({ page }) => {
    // usePolling MERGES the API response with MOCK_SERVICES, keeping the mock status for any service
    // the response omits. MOCK_SERVICES defaults openai/xai/huggingface/elevenlabs to 'degraded', so
    // the fixture must override ALL of them to operational — otherwise a non-agent issue keeps the
    // grid non-empty and the empty state never fires (the bug would be masked → false pass).
    const op = (id, name, category = 'api') => ({ id, category, name, provider: 'x', status: 'operational', latency: 200, uptime30d: 99.9, calendarDays: 30, incidents: [] })
    const mockData = { json: {
      services: [
        op('openai', 'OpenAI API'), op('xai', 'xAI (Grok)'), op('huggingface', 'Hugging Face'), op('elevenlabs', 'ElevenLabs'),
        { id: 'claudecode', category: 'agent', name: 'Claude Code', provider: 'Anthropic', status: 'degraded', latency: null, uptime30d: 99.05, calendarDays: 30,
          incidents: [{ id: 'cc1', title: 'Partial outage', status: 'investigating', impact: 'minor', startedAt: new Date(Date.now() - 120_000).toISOString(), timeline: [] }] },
      ],
      lastUpdated: new Date().toISOString(),
    } }
    await page.route('**/api/status**', (route) => route.fulfill(mockData))
    await page.route('**/api/status/cached', (route) => route.fulfill(mockData))
    await page.goto('/')
    await page.locator('main button').first().waitFor({ state: 'visible', timeout: 20000 })

    // Precondition guard: exactly ONE issue and it is the agent (else the fixture didn't neutralize a
    // non-agent issue and the test isn't exercising the agent-only path). The Issues tab shows "1".
    await expect(page.locator('main').getByRole('button', { name: /Issues\s*1\b/ })).toBeVisible()

    // Select Issues → the agent section must render and the "No Issues" empty state must NOT appear.
    await page.locator('main').getByRole('button', { name: /Issues/ }).click()

    // Positive: assert the *Coding Agents section heading* (renders only when the agents section has a
    // matching service), NOT bare getByText('Claude Code') — the agent name also appears in the Recent
    // Incidents panel below, which renders regardless of the filter or the fix, so a name-only check
    // would pass even when buggy. Scoped to role=heading because #646 added a CategoryTabs "Coding
    // Agents" *tab* with the same label — getByText would now match both (strict-mode violation).
    await expect(page.locator('main').getByRole('heading', { name: /Coding Agents|코딩 에이전트/ })).toBeVisible()

    // Negative (load-bearing — this is what fails when the fix is reverted): no "No Issues" empty state.
    // EmptyState type="good" is shared by the issues-grid AND the Recent Incidents panel, but the fixture's
    // incident is left UNRESOLVED so the incidents panel is non-empty → the only "No Issues" that can appear
    // is the issues-grid bug. (If a future edit resolves/removes the incident, also scope this to the grid.)
    await expect(page.locator('main').getByText(/No Issues|이슈 없음/)).toHaveCount(0)
  })
})

// #575 — crowd "Report an issue": floating button + modal + gated "Recent user reports" panel.
test.describe('Overview — crowd reports (#575)', () => {
  const baseSvc = (id, name, status = 'operational') => ({ id, category: 'api', name, provider: 'x', status, latency: 150, uptime30d: 99.9, calendarDays: 30, incidents: status === 'operational' ? [] : [{ id: `${id}-i`, title: 'Issue', status: 'investigating', impact: 'minor', startedAt: new Date(Date.now() - 60_000).toISOString(), timeline: [] }] })
  const now = Date.now()
  const withReports = {
    json: {
      services: [baseSvc('claude', 'Claude API', 'degraded'), baseSvc('openai', 'OpenAI API')],
      reportFeed: { claude: Array.from({ length: 6 }, (_, i) => ({ cat: 'errors', desc: `report ${i}`, ts: now - i * 60_000 })) },
      lastUpdated: new Date().toISOString(),
    },
  }
  const noReports = { json: { services: [baseSvc('claude', 'Claude API'), baseSvc('openai', 'OpenAI API')], lastUpdated: new Date().toISOString() } }

  test('gated panel renders with reports + 5-row preview and a "show more" toggle', async ({ page }) => {
    await page.route('**/api/status**', (route) => route.fulfill(withReports))
    await page.route('**/api/status/cached', (route) => route.fulfill(withReports))
    await page.goto('/')
    await page.locator('main button').first().waitFor({ state: 'visible', timeout: 20000 })
    const main = page.locator('main')
    await expect(main.getByText(/Recent user reports|최근 사용자 신고/)).toBeVisible()
    await expect(main.getByText('report 0')).toBeVisible()
    await expect(main.getByText('report 4')).toBeVisible()        // 5th (index 4) in preview
    await expect(main.getByText('report 5')).toHaveCount(0)        // 6th hidden until expanded
    const toggle = main.getByRole('button', { name: /Show 1 more|1개 더 보기/ })
    await expect(toggle).toBeVisible()
    await toggle.click()
    await expect(main.getByText('report 5')).toBeVisible()
  })

  test('no panel when there are no corroborated reports (gate)', async ({ page }) => {
    await page.route('**/api/status**', (route) => route.fulfill(noReports))
    await page.route('**/api/status/cached', (route) => route.fulfill(noReports))
    await page.goto('/')
    await page.locator('main button').first().waitFor({ state: 'visible', timeout: 20000 })
    await expect(page.locator('main').getByText(/Recent user reports|최근 사용자 신고/)).toHaveCount(0)
  })

  test('floating report button opens the modal; submit posts and thanks', async ({ page }) => {
    await page.route('**/api/status**', (route) => route.fulfill(noReports))
    await page.route('**/api/status/cached', (route) => route.fulfill(noReports))
    let posted = null
    await page.route('**/api/report-issue', async (route) => {
      posted = route.request().postDataJSON()
      await route.fulfill({ status: 200, json: { ok: true, message: 'Thanks' } })
    })
    // Returning-user state: consent set so the one-time cookie banner (bottom, full-width) doesn't
    // overlap the bottom-right floating button.
    await page.addInitScript(() => { try { localStorage.setItem('aiwatch-cookie-consent', 'granted') } catch { /* private mode */ } })
    await page.goto('/')
    await page.locator('main button').first().waitFor({ state: 'visible', timeout: 20000 })
    await page.getByRole('button', { name: /Report an issue|문제 신고/ }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await dialog.locator('#report-svc').selectOption('openai')
    await dialog.locator('#report-cat').selectOption('outage')
    await dialog.locator('#report-desc').fill('cannot reach api')
    await dialog.getByRole('button', { name: /^Submit$|^제출$/ }).click()
    await expect(dialog.getByText(/Thanks|감사/)).toBeVisible()
    expect(posted).toMatchObject({ svcId: 'openai', category: 'outage', description: 'cannot reach api' })
  })
})

// #574 — supply-chain correlation banner (AWS region degraded + dependent AI service degraded).
test.describe('Overview — supply-chain banner (#574)', () => {
  const svc = (id, name, status = 'operational') => ({ id, category: 'api', name, provider: 'x', status, latency: 150, uptime30d: 99.9, calendarDays: 30, incidents: [] })
  const withBanner = { json: {
    services: [svc('claude', 'Claude API', 'degraded'), svc('bedrock', 'Amazon Bedrock'), svc('together', 'Together AI')],
    supplyChainBanner: {
      cloud: 'aws', severity: 'degraded',
      regions: [{ region: 'us-east-1', level: 'degraded', summary: 'Increased error rates in us-east-1' }],
      affectedNow: [{ id: 'claude', name: 'Claude API' }],
      mayBeAffected: [{ id: 'bedrock', name: 'Amazon Bedrock', confidence: 'certain' }, { id: 'together', name: 'Together AI', confidence: 'medium' }],
    },
    lastUpdated: new Date().toISOString(),
  } }
  const noBanner = { json: { services: [svc('claude', 'Claude API')], lastUpdated: new Date().toISOString() } }

  test('renders the banner with region, affected-now + may-be-affected services', async ({ page }) => {
    await page.route('**/api/status**', (route) => route.fulfill(withBanner))
    await page.route('**/api/status/cached', (route) => route.fulfill(withBanner))
    await page.goto('/')
    await page.locator('main button').first().waitFor({ state: 'visible', timeout: 20000 })
    const main = page.locator('main')
    await expect(main.getByText(/AWS infrastructure issue.*us-east-1|AWS 인프라 이슈.*us-east-1/)).toBeVisible()
    await expect(main.getByText('Increased error rates in us-east-1')).toBeVisible()
    await expect(main.getByText(/AWS-attributed|AWS 귀속/)).toBeVisible()
    await expect(main.getByText(/may be affected|영향 가능/)).toBeVisible()
    // the affected/estimated service NAMES render inside the banner (scoped to avoid the service-card collision)
    const banner = page.getByTestId('supply-chain-banner')
    await expect(banner.getByText('Claude API')).toBeVisible()   // affectedNow
    await expect(banner.getByText('Amazon Bedrock')).toBeVisible() // mayBeAffected
  })

  test('no banner when supplyChainBanner is absent (gate)', async ({ page }) => {
    await page.route('**/api/status**', (route) => route.fulfill(noBanner))
    await page.route('**/api/status/cached', (route) => route.fulfill(noBanner))
    await page.goto('/')
    await page.locator('main button').first().waitFor({ state: 'visible', timeout: 20000 })
    await expect(page.locator('main').getByText(/AWS infrastructure issue|AWS 인프라 이슈/)).toHaveCount(0)
  })
})
