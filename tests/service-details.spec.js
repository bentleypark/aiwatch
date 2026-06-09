import { test, expect } from '@playwright/test'
import { waitForDataLoad } from './helpers.js'

test.describe('ServiceDetails page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await waitForDataLoad(page)
    // Navigate to Claude API details via service card click
    const card = page.locator('main button').filter({ hasText: 'Claude API' }).first()
    await card.evaluate((el) => el.click())
    await expect(page.locator('main').getByText('Status Calendar')).toBeVisible({ timeout: 5000 })
  })

  test('renders service header with name and provider', async ({ page }) => {
    const main = page.locator('main')
    await expect(main.getByRole('heading', { name: 'Claude API', exact: true })).toBeVisible()
    // .first() — 'Anthropic' (the provider) appears in several places on the
    // detail page (header + sibling/fallback service rows); we only assert the
    // provider is shown.
    await expect(main.getByText('Anthropic').first()).toBeVisible()
  })

  test('renders metric cards with uptime', async ({ page }) => {
    const main = page.locator('main')
    // Uptime card should show percentage
    await expect(main.getByText(/%/).first()).toBeVisible()
    // Latency card should exist (probe: "API Response Time", non-probe: "Status Page Latency")
    await expect(main.getByText(/API Response Time|Status Page Latency|API 응답 시간|상태 페이지 레이턴시/).first()).toBeVisible()
  })

  test('renders status calendar with legend', async ({ page }) => {
    const main = page.locator('main')
    // Calendar legend should show status labels
    await expect(main.getByText(/Operational|정상/).first()).toBeVisible()
    await expect(main.getByText(/Partial Outage|부분 장애/).first()).toBeVisible()
    await expect(main.getByText(/Major Outage|주요 장애/).first()).toBeVisible()
    // Calendar should have 30 cells
    const calendarCells = main.locator('[aria-label*=":"]')
    await expect(calendarCells.first()).toBeVisible()
  })

  test('Detection Lead badge not shown for Claude (no detectedAt)', async ({ page }) => {
    // Claude has no detectedAt in mock — no lead badge
    await expect(page.locator('main').getByText(/lead/)).not.toBeVisible()
  })

  test('back button returns to overview', async ({ page }) => {
    const backBtn = page.locator('main').getByRole('button', { name: /Overview|← / })
    await backBtn.click()
    // Should return to overview with service grid
    await expect(page.locator('main button').filter({ hasText: 'Claude API' }).first()).toBeVisible()
  })
})

test.describe('#581 Recovery card — ongoing (unresolved) incident', () => {
  const baseSvc = (incidents) => ({
    id: 'claude', category: 'api', name: 'Claude API', provider: 'Anthropic',
    status: incidents.some(i => i.status !== 'resolved') ? 'degraded' : 'operational',
    latency: 120, uptime30d: 99.5, uptimeSource: 'official', calendarDays: 30, incidents,
    aiwatchScore: 80, scoreGrade: 'good', scoreConfidence: 'high',
    scoreBreakdown: { uptime: 39, incidents: 22, recovery: 15, responsiveness: 12, responsivenessStatus: 'available' },
    scoreMetrics: { uptimePct: 99.5, incidents30d: incidents.length, affectedDays30d: 1, mttrHours: null, probe: { p50: 178, p95: 311, cvCombined: 0.5, validDays: 7 } },
  })
  const mount = async (page, incidents) => {
    const mock = { json: { services: [baseSvc(incidents)], lastUpdated: new Date().toISOString() } }
    await page.route('**/api/status**', (route) => route.fulfill(mock))
    await page.route('**/api/status/cached', (route) => route.fulfill(mock))
    await page.goto('/#claude')
    await expect(page.locator('main').getByText(/Status Calendar|상태 캘린더/)).toBeVisible({ timeout: 20000 })
  }

  test('shows "Incident ongoing" (not "No incidents in 7 days") when an incident is unresolved', async ({ page }) => {
    // An unresolved (monitoring) incident has no recovery time yet → computeRecoveryStats returns
    // null → the Recovery card value is "—". Pre-#581 the sub falsely read "No incidents in 7 days",
    // contradicting the Incident History showing the active incident.
    await mount(page, [
      { id: 'on1', status: 'monitoring', title: 'Auth & licensing service issues',
        startedAt: new Date(Date.now() - 3 * 3600_000).toISOString(), impact: 'minor', duration: null },
    ])
    const main = page.locator('main')
    await expect(main.getByText(/Incident ongoing|인시던트 진행 중/)).toBeVisible()
    await expect(main.getByText(/No incidents in 7 days|최근 7일 인시던트 없음/)).toHaveCount(0)
  })

  test('still shows "No incidents in 7 days" when there is genuinely no incident', async ({ page }) => {
    await mount(page, [])
    const main = page.locator('main')
    await expect(main.getByText(/No incidents in 7 days|최근 7일 인시던트 없음/)).toBeVisible()
    await expect(main.getByText(/Incident ongoing|인시던트 진행 중/)).toHaveCount(0)
  })
})

test.describe('AIWatch Score Breakdown denominators (#132)', () => {
  // Regression guards for the weight redistribution: 40/25/15 + 20 (Responsiveness).
  // Routes are set up before navigation — no beforeEach interference.

  test('probed service with available probe data shows /40, /25, /15, /20', async ({ page }) => {
    const probedMock = { json: {
      services: [
        {
          id: 'claude', category: 'api', name: 'Claude API', provider: 'Anthropic',
          status: 'operational', latency: 120, uptime30d: 99.95, uptimeSource: 'official',
          calendarDays: 30, incidents: [],
          aiwatchScore: 92, scoreGrade: 'excellent', scoreConfidence: 'high',
          scoreBreakdown: { uptime: 39.6, incidents: 25, recovery: 15, responsiveness: 12.4, responsivenessStatus: 'available' },
          scoreMetrics: { uptimePct: 99.95, incidents30d: 0, affectedDays30d: 0, mttrHours: null, probe: { p50: 178, p95: 311, cvCombined: 0.5, validDays: 7 } },
        },
      ],
      lastUpdated: new Date().toISOString(),
    } }
    await page.route('**/api/status**', async (route) => { await route.fulfill(probedMock) })
    await page.route('**/api/status/cached', async (route) => { await route.fulfill(probedMock) })
    await page.goto('/#claude')
    await expect(page.locator('main').getByText(/Status Calendar|상태 캘린더/)).toBeVisible({ timeout: 20000 })
    // Use regex anchored on the new max values — locks the denominators against revert
    const main = page.locator('main')
    await expect(main.getByText(/39\.6\s*\/\s*40/)).toBeVisible()
    await expect(main.getByText(/\b25\s*\/\s*25\b/)).toBeVisible()
    await expect(main.getByText(/\b15\s*\/\s*15\b/)).toBeVisible()
    await expect(main.getByText(/12\.4\s*\/\s*20/)).toBeVisible()
    // Old denominators must not appear
    await expect(main.getByText(/\/\s*50\b/)).not.toBeVisible()
    await expect(main.getByText(/\/\s*30\b/)).not.toBeVisible()
  })

  test('unsupported service hides Responsiveness row entirely', async ({ page }) => {
    const unsupportedMock = { json: {
      services: [
        {
          id: 'chatgpt', category: 'app', name: 'ChatGPT', provider: 'OpenAI',
          status: 'operational', latency: null, uptime30d: 99.99, uptimeSource: 'official',
          calendarDays: 30, incidents: [],
          aiwatchScore: 100, scoreGrade: 'excellent', scoreConfidence: 'high',
          scoreBreakdown: { uptime: 40, incidents: 25, recovery: 15, responsiveness: null, responsivenessStatus: 'unsupported' },
          scoreMetrics: { uptimePct: 99.99, incidents30d: 0, affectedDays30d: 0, mttrHours: null, probe: null },
        },
      ],
      lastUpdated: new Date().toISOString(),
    } }
    await page.route('**/api/status**', async (route) => { await route.fulfill(unsupportedMock) })
    await page.route('**/api/status/cached', async (route) => { await route.fulfill(unsupportedMock) })
    await page.goto('/#chatgpt')
    await expect(page.locator('main').getByText(/Status Calendar|상태 캘린더/)).toBeVisible({ timeout: 20000 })
    // No /20 denominator should render
    await expect(page.locator('main').getByText('/20')).not.toBeVisible()
  })

  test('unavailable status (transient KV race) hides row — locks deliberate-collapse contract', async ({ page }) => {
    // Intentional UI behavior: 'unavailable' is a seconds-long KV race. Surfacing alarmist text would
    // be useless to users with no recourse. This test fails if a future contributor renders text for it.
    const unavailableMock = { json: {
      services: [
        {
          id: 'claude', category: 'api', name: 'Claude API', provider: 'Anthropic',
          status: 'operational', latency: 120, uptime30d: 99.95, uptimeSource: 'official',
          calendarDays: 30, incidents: [],
          aiwatchScore: 92, scoreGrade: 'excellent', scoreConfidence: 'high',
          scoreBreakdown: { uptime: 39.6, incidents: 25, recovery: 15, responsiveness: null, responsivenessStatus: 'unavailable' },
          scoreMetrics: { uptimePct: 99.95, incidents30d: 0, affectedDays30d: 0, mttrHours: null, probe: null },
        },
      ],
      lastUpdated: new Date().toISOString(),
    } }
    await page.route('**/api/status**', async (route) => { await route.fulfill(unavailableMock) })
    await page.route('**/api/status/cached', async (route) => { await route.fulfill(unavailableMock) })
    await page.goto('/#claude')
    await expect(page.locator('main').getByText(/Status Calendar|상태 캘린더/)).toBeVisible({ timeout: 20000 })
    // Responsiveness row hidden — same treatment as 'unsupported'
    await expect(page.locator('main').getByText('/20')).not.toBeVisible()
    await expect(page.locator('main').getByText(/unavailable|일시적 불가/i)).not.toBeVisible()
  })

  test('insufficient status renders text fallback (locks i18n key)', async ({ page }) => {
    const insufficientMock = { json: {
      services: [
        {
          id: 'claude', category: 'api', name: 'Claude API', provider: 'Anthropic',
          status: 'operational', latency: 120, uptime30d: 99.95, uptimeSource: 'official',
          calendarDays: 30, incidents: [],
          aiwatchScore: 95, scoreGrade: 'excellent', scoreConfidence: 'high',
          scoreBreakdown: { uptime: 39.6, incidents: 25, recovery: 15, responsiveness: null, responsivenessStatus: 'insufficient' },
          scoreMetrics: { uptimePct: 99.95, incidents30d: 0, affectedDays30d: 0, mttrHours: null, probe: null },
        },
      ],
      lastUpdated: new Date().toISOString(),
    } }
    await page.route('**/api/status**', async (route) => { await route.fulfill(insufficientMock) })
    await page.route('**/api/status/cached', async (route) => { await route.fulfill(insufficientMock) })
    await page.goto('/#claude')
    await expect(page.locator('main').getByText(/Status Calendar|상태 캘린더/)).toBeVisible({ timeout: 20000 })
    // i18n key score.responsiveness.insufficient — KO/EN
    await expect(page.locator('main').getByText(/Building data|데이터 누적 중/)).toBeVisible()
  })
})

test.describe('xAI Regional Availability', () => {
  // Inject mock xAI data with EU region ongoing incident via API intercept
  const XAI_MOCK = {
    id: 'xai', category: 'api', name: 'xAI (Grok)', provider: 'xAI', status: 'degraded',
    latency: 203, uptime30d: 99.75, calendarDays: 30,
    incidents: [
      { id: 'xa-0', title: 'eu-west-1.api.x.ai went down', startedAt: new Date(Date.now() - 7200000).toISOString(), duration: null, status: 'investigating', impact: null, timeline: [] },
      { id: 'xa-1', title: 'Authentication Errors', startedAt: new Date(Date.now() - 86400000 * 2).toISOString(), duration: '22m', status: 'resolved', impact: null, timeline: [] },
    ],
  }

  test('shows regional status with incident type for xAI', async ({ page }) => {
    // Intercept API: serve mock response with xAI EU incident
    await page.route('**/api/status**', async (route) => {
      const mockResponse = {
        services: [
          { id: 'claude', category: 'api', name: 'Claude API', provider: 'Anthropic', status: 'operational', latency: 120, uptime30d: 99.95, calendarDays: 30, incidents: [] },
          XAI_MOCK,
        ],
        lastUpdated: new Date().toISOString(),
      }
      await route.fulfill({ json: mockResponse })
    })
    await page.goto('/')
    await waitForDataLoad(page)
    await page.locator('main button').filter({ hasText: 'xAI' }).first().evaluate((el) => el.click())
    await expect(page.locator('main').getByText(/Regional Availability|리전별 가용성/)).toBeVisible({ timeout: 5000 })
    // EU region should show incident type label (Service Down)
    await expect(page.locator('main').getByText(/Service Down|서비스 중단/)).toBeVisible()
    // US region should show no active incidents
    await expect(page.locator('main').getByText(/No Active Incidents|활성 장애 없음/)).toBeVisible()
    // Recommendation line still renders (recommends the healthy region)...
    await expect(page.locator('main').getByText(/to avoid service interruption|서비스 중단을 피하려면/)).toBeVisible()
    // ...but the "Check API Guide" link is GONE: xAI removed its regions doc page (#560), so
    // REGION_DOCS_URL has no xai entry and the card omits the (previously 404ing) link.
    await expect(page.locator('main').getByText(/API Guide|API 가이드/)).toHaveCount(0)
  })

  test('shows all regions affected for global incident (no region keyword)', async ({ page }) => {
    const globalMock = { ...XAI_MOCK, incidents: [
      { id: 'xa-g', title: 'Elevated API Error Rates', startedAt: new Date(Date.now() - 3600000).toISOString(), duration: null, status: 'investigating', impact: null, timeline: [] },
    ] }
    await page.route('**/api/status**', async (route) => {
      await route.fulfill({ json: {
        services: [
          { id: 'claude', category: 'api', name: 'Claude API', provider: 'Anthropic', status: 'operational', latency: 120, uptime30d: 99.95, calendarDays: 30, incidents: [] },
          globalMock,
        ],
        lastUpdated: new Date().toISOString(),
      } })
    })
    await page.goto('/')
    await waitForDataLoad(page)
    await page.locator('main button').filter({ hasText: 'xAI' }).first().evaluate((el) => el.click())
    await expect(page.locator('main').getByText(/Regional Availability|리전별 가용성/)).toBeVisible({ timeout: 5000 })
    // Both regions should show incident (global → all affected)
    await expect(page.locator('main').getByText(/Incident Detected|장애 감지/)).toHaveCount(2)
    // All-down message should be visible
    await expect(page.locator('main').getByText(/all regions|모든 리전/i)).toBeVisible()
  })

  test('does not show regional section for non-xAI service', async ({ page }) => {
    await page.goto('/')
    await waitForDataLoad(page)
    const card = page.locator('main button').filter({ hasText: 'Claude API' }).first()
    await card.evaluate((el) => el.click())
    await expect(page.locator('main').getByText('Status Calendar')).toBeVisible({ timeout: 5000 })
    await expect(page.locator('main').getByText(/Regional Availability|리전별 가용성/)).not.toBeVisible()
  })
})

test.describe('Gemini Regional Availability', () => {
  test('shows regional status for Gemini with region-specific incident', async ({ page }) => {
    await page.route('**/api/status**', async (route) => {
      await route.fulfill({ json: {
        services: [
          { id: 'claude', category: 'api', name: 'Claude API', provider: 'Anthropic', status: 'operational', latency: 120, uptime30d: 99.95, calendarDays: 30, incidents: [] },
          {
            id: 'gemini', category: 'api', name: 'Gemini API', provider: 'Google', status: 'degraded',
            latency: 180, uptime30d: 99.80, calendarDays: 30,
            incidents: [
              { id: 'gm-1', title: 'Vertex AI europe-west1 elevated error rates', startedAt: new Date(Date.now() - 3600000).toISOString(), duration: null, status: 'investigating', impact: null, timeline: [] },
            ],
          },
        ],
        lastUpdated: new Date().toISOString(),
      } })
    })
    await page.goto('/')
    await waitForDataLoad(page)
    await page.locator('main button').filter({ hasText: 'Gemini' }).first().evaluate((el) => el.click())
    await expect(page.locator('main').getByText(/Regional Availability|리전별 가용성/)).toBeVisible({ timeout: 5000 })
    // Europe West should show incident, other regions should be ok
    await expect(page.locator('main').getByText(/No Active Incidents|활성 장애 없음/).first()).toBeVisible()
    await expect(page.locator('main').getByText(/Inference Issue|추론 장애/)).toBeVisible()
  })
})

test.describe('OpenAI Regional Availability', () => {
  test('shows regional status for OpenAI with global incident', async ({ page }) => {
    await page.route('**/api/status**', async (route) => {
      await route.fulfill({ json: {
        services: [
          { id: 'claude', category: 'api', name: 'Claude API', provider: 'Anthropic', status: 'operational', latency: 120, uptime30d: 99.95, calendarDays: 30, incidents: [] },
          {
            id: 'openai', category: 'api', name: 'OpenAI API', provider: 'OpenAI', status: 'degraded',
            latency: 250, uptime30d: 99.70, calendarDays: 30,
            incidents: [
              { id: 'oa-1', title: 'Elevated API Error Rates', startedAt: new Date(Date.now() - 1800000).toISOString(), duration: null, status: 'investigating', impact: null, timeline: [] },
            ],
          },
        ],
        lastUpdated: new Date().toISOString(),
      } })
    })
    await page.goto('/')
    await waitForDataLoad(page)
    await page.locator('main button').filter({ hasText: 'OpenAI API' }).first().click()
    await expect(page.locator('main').getByText(/Regional Availability|리전별 가용성/)).toBeVisible({ timeout: 5000 })
    // Global incident → all 3 regions should show incident
    await expect(page.locator('main').getByText(/Incident Detected|장애 감지/)).toHaveCount(3)
    await expect(page.locator('main').getByText(/all regions|모든 리전/i)).toBeVisible()
  })
})

test.describe('Bedrock Regional Availability (always visible)', () => {
  test('shows all regions operational when no incidents', async ({ page }) => {
    await page.route('**/api/status**', async (route) => {
      await route.fulfill({ json: {
        services: [
          { id: 'claude', category: 'api', name: 'Claude API', provider: 'Anthropic', status: 'operational', latency: 120, uptime30d: 99.95, calendarDays: 30, incidents: [] },
          { id: 'bedrock', category: 'api', name: 'Amazon Bedrock', provider: 'AWS', status: 'operational', latency: 175, uptime30d: 100, calendarDays: 14, incidents: [] },
        ],
        lastUpdated: new Date().toISOString(),
      } })
    })
    await page.goto('/')
    await waitForDataLoad(page)
    await page.locator('main button').filter({ hasText: 'Amazon Bedrock' }).first().evaluate((el) => el.click())
    await expect(page.locator('main').getByText(/Regional Availability|리전별 가용성/)).toBeVisible({ timeout: 5000 })
    // All 4 regions should show "No Active Incidents"
    await expect(page.locator('main').getByText(/No Active Incidents|활성 장애 없음/)).toHaveCount(4)
  })

  test('shows region-specific incident via componentNames', async ({ page }) => {
    await page.route('**/api/status**', async (route) => {
      await route.fulfill({ json: {
        services: [
          { id: 'claude', category: 'api', name: 'Claude API', provider: 'Anthropic', status: 'operational', latency: 120, uptime30d: 99.95, calendarDays: 30, incidents: [] },
          {
            id: 'bedrock', category: 'api', name: 'Amazon Bedrock', provider: 'AWS', status: 'degraded',
            latency: 200, uptime30d: 99.9, calendarDays: 14,
            incidents: [
              { id: 'br-1', title: 'Increased API Error Rates', startedAt: new Date(Date.now() - 3600000).toISOString(), duration: null, status: 'investigating', impact: null, timeline: [], componentNames: ['us-east-1'] },
            ],
          },
        ],
        lastUpdated: new Date().toISOString(),
      } })
    })
    await page.goto('/')
    await waitForDataLoad(page)
    await page.locator('main button').filter({ hasText: 'Amazon Bedrock' }).first().evaluate((el) => el.click())
    await expect(page.locator('main').getByText(/Regional Availability|리전별 가용성/)).toBeVisible({ timeout: 5000 })
    // us-east-1 should show incident, other 3 should be ok
    await expect(page.locator('main').getByText(/No Active Incidents|활성 장애 없음/)).toHaveCount(3)
    await expect(page.locator('main').getByText(/Incident Detected|장애 감지/)).toHaveCount(1)
  })
})

test.describe('Azure OpenAI Regional Availability (always visible)', () => {
  test('shows all 7 regions operational when no incidents', async ({ page }) => {
    await page.route('**/api/status**', async (route) => {
      await route.fulfill({ json: {
        services: [
          { id: 'claude', category: 'api', name: 'Claude API', provider: 'Anthropic', status: 'operational', latency: 120, uptime30d: 99.95, calendarDays: 30, incidents: [] },
          { id: 'azureopenai', category: 'api', name: 'Azure OpenAI', provider: 'Microsoft', status: 'operational', latency: 150, uptime30d: 100, calendarDays: 14, incidents: [] },
        ],
        lastUpdated: new Date().toISOString(),
      } })
    })
    await page.goto('/')
    await waitForDataLoad(page)
    await page.locator('main button').filter({ hasText: 'Azure OpenAI' }).first().evaluate((el) => el.click())
    await expect(page.locator('main').getByText(/Regional Availability|리전별 가용성/)).toBeVisible({ timeout: 5000 })
    // All 7 regions should show "No Active Incidents"
    await expect(page.locator('main').getByText(/No Active Incidents|활성 장애 없음/)).toHaveCount(7)
  })

  test('shows region-specific incident for Azure OpenAI', async ({ page }) => {
    await page.route('**/api/status**', async (route) => {
      await route.fulfill({ json: {
        services: [
          { id: 'claude', category: 'api', name: 'Claude API', provider: 'Anthropic', status: 'operational', latency: 120, uptime30d: 99.95, calendarDays: 30, incidents: [] },
          {
            id: 'azureopenai', category: 'api', name: 'Azure OpenAI', provider: 'Microsoft', status: 'degraded',
            latency: 200, uptime30d: 99.9, calendarDays: 14,
            incidents: [
              { id: 'az-1', title: 'Azure OpenAI - East US 2 elevated error rates', startedAt: new Date(Date.now() - 3600000).toISOString(), duration: null, status: 'investigating', impact: null, timeline: [], componentNames: [] },
            ],
          },
        ],
        lastUpdated: new Date().toISOString(),
      } })
    })
    await page.goto('/')
    await waitForDataLoad(page)
    await page.locator('main button').filter({ hasText: 'Azure OpenAI' }).first().evaluate((el) => el.click())
    await expect(page.locator('main').getByText(/Regional Availability|리전별 가용성/)).toBeVisible({ timeout: 5000 })
    // East US 2 should show incident (matched from title), other 6 should be ok
    await expect(page.locator('main').getByText(/No Active Incidents|활성 장애 없음/)).toHaveCount(6)
  })
})

test.describe('Detection Lead badge removed (#464)', () => {
  test('does NOT render a per-incident lead/early badge even with detectedAt before startedAt', async ({ page }) => {
    // #464: the per-incident "Xm lead/early" badge was removed. It only ever rendered for the
    // in_window case (probe detected before the official publish), which production data showed
    // is ~0 — status-page polling is structurally later than the official publish. Even with a
    // detectedAt 7min before startedAt (the old trigger), no lead/early badge must appear now.
    const startedAt = new Date(Date.now() - 2 * 3600_000).toISOString()
    const detectedAt = new Date(Date.now() - 2 * 3600_000 - 7 * 60_000).toISOString()
    await page.route('**/api/status**', (route) => route.fulfill({ json: {
      services: [
        { id: 'openai', category: 'api', name: 'OpenAI API', provider: 'OpenAI', status: 'degraded', latency: 200, uptime30d: 99.21, detectedAt, incidents: [
          { id: 'oi-ongoing', title: 'Elevated error rates', status: 'investigating', impact: 'major', startedAt, duration: null, timeline: [] },
        ] },
      ],
      lastUpdated: new Date().toISOString(),
    } }))
    await page.goto('/')
    await expect(page.locator('main button').filter({ hasText: 'OpenAI API' }).first()).toBeVisible({ timeout: 20000 })
    await page.locator('main button').filter({ hasText: 'OpenAI API' }).first().click()
    await expect(page.locator('main').getByText('Incident History')).toBeVisible({ timeout: 5000 })
    // The incident renders, but no lead/early badge alongside its title.
    await expect(page.locator('main').getByText('Elevated error rates')).toBeVisible()
    await expect(page.locator('main').getByText(/\d+m (lead|early|먼저)/)).toHaveCount(0)
  })
})

test.describe('Incident accordion in ServiceDetails', () => {
  test('clicking incident expands timeline inline', async ({ page }) => {
    await page.goto('/')
    await waitForDataLoad(page)
    // Navigate to Claude API (has incidents in mock data)
    await page.locator('main button').filter({ hasText: 'Claude API' }).first().click()
    await expect(page.locator('main').getByText('Incident History')).toBeVisible({ timeout: 5000 })
    // Find an incident row with the expand arrow
    const arrow = page.locator('main').getByText('▸').first()
    if (await arrow.isVisible()) {
      await arrow.click()
      // Timeline should expand with close button
      await expect(page.locator('main').getByText('✕').first()).toBeVisible({ timeout: 3000 })
      // Click close
      await page.locator('main').getByText('✕').first().click()
    }
  })
})

test.describe('Non-probe service latency card', () => {
  test('shows "Not provided" latency for non-probe API service', async ({ page }) => {
    await page.route('**/api/status**', async (route) => {
      await route.fulfill({ json: {
        services: [
          { id: 'claude', category: 'api', name: 'Claude API', provider: 'Anthropic', status: 'operational', latency: 120, uptime30d: 99.95, uptimeSource: 'official', calendarDays: 30, incidents: [], aiwatchScore: 92 },
          { id: 'modal', category: 'api', name: 'Modal', provider: 'Modal', status: 'operational', latency: null, uptime30d: 99.99, uptimeSource: 'platform_avg', calendarDays: 30, incidents: [{ id: 'm1', title: 'Test', startedAt: new Date().toISOString(), duration: '10m', status: 'resolved', impact: 'minor', timeline: [] }] },
        ],
        lastUpdated: new Date().toISOString(),
      } })
    })
    // Modal: non-probe → latency card shows "—" + "Not provided"
    await page.goto('/#modal')
    await expect(page.locator('main').getByText(/Status Calendar|상태 캘린더/)).toBeVisible({ timeout: 20000 })
    const main = page.locator('main')
    await expect(main.getByText(/Status Page Latency|상태 페이지 레이턴시/)).toBeVisible()
    // Should show "Not provided" under latency (not a ms value)
    await expect(main.getByText(/Not provided|공식 데이터 미제공/).first()).toBeVisible()
    // Should NOT show 24h Trend chart
    await expect(main.getByText(/24h Trend|24시간 추이/)).not.toBeVisible()
  })

  test('shows RTT latency for probe API service', async ({ page }) => {
    await page.route('**/api/status**', async (route) => {
      await route.fulfill({ json: {
        services: [
          { id: 'claude', category: 'api', name: 'Claude API', provider: 'Anthropic', status: 'operational', latency: 142, uptime30d: 99.95, uptimeSource: 'official', calendarDays: 30, incidents: [] },
        ],
        lastUpdated: new Date().toISOString(),
        probe24h: [{ t: new Date().toISOString(), data: { claude: { rtt: 142, status: 200 } } }],
      } })
    })
    await page.goto('/#claude')
    await expect(page.locator('main').getByText(/Status Calendar|상태 캘린더/)).toBeVisible({ timeout: 20000 })
    const main = page.locator('main')
    // Should show "API Response Time" label (not "Status Page Latency")
    await expect(main.getByText(/API Response Time|API 응답 시간/).first()).toBeVisible()
    // Should show ms value
    await expect(main.getByText(/142 ms/)).toBeVisible()
  })
})

test.describe('Estimate-only services (Bedrock, Azure OpenAI)', () => {
  const ESTIMATE_MOCK = {
    services: [
      { id: 'claude', category: 'api', name: 'Claude API', provider: 'Anthropic', status: 'operational', latency: 120, uptime30d: 99.95, uptimeSource: 'official', calendarDays: 30, incidents: [], aiwatchScore: 92, scoreGrade: 'excellent', scoreConfidence: 'high' },
      { id: 'bedrock', category: 'api', name: 'Amazon Bedrock', provider: 'AWS', status: 'operational', latency: 280, uptime30d: 100, uptimeSource: 'estimate', calendarDays: 14, incidents: [], aiwatchScore: 85, scoreGrade: 'good', scoreConfidence: 'medium' },
      { id: 'azureopenai', category: 'api', name: 'Azure OpenAI', provider: 'Microsoft', status: 'operational', latency: 350, uptime30d: 100, uptimeSource: 'estimate', calendarDays: 14, incidents: [], aiwatchScore: 85, scoreGrade: 'good', scoreConfidence: 'medium' },
      { id: 'openai', category: 'api', name: 'OpenAI API', provider: 'OpenAI', status: 'operational', latency: 200, uptime30d: 99.99, uptimeSource: 'official', calendarDays: 30, incidents: [], aiwatchScore: 90, scoreGrade: 'excellent', scoreConfidence: 'high' },
    ],
    lastUpdated: new Date().toISOString(),
  }

  test('shows "Not provided" for estimate service with no incidents', async ({ page }) => {
    await page.route('**/api/status**', async (route) => {
      await route.fulfill({ json: ESTIMATE_MOCK })
    })
    await page.goto('/#bedrock')
    await expect(page.locator('main').getByText(/Status Calendar|상태 캘린더/)).toBeVisible({ timeout: 20000 })
    // Should NOT show 100.00% uptime
    await expect(page.locator('main').getByText('100.00%')).not.toBeVisible()
    // "Not provided" should appear in multiple metric cards (uptime, incidents, MTTR) + incident history
    const notProvided = page.locator('main').getByText(/Not provided|제공되지 않음/)
    await expect(notProvided.first()).toBeVisible()
    expect(await notProvided.count()).toBeGreaterThanOrEqual(3)
    // AIWatch Score section should be hidden
    await expect(page.locator('main').getByText(/AIWatch Score/)).not.toBeVisible()
  })

  test('hides 24h Trend chart for non-probe services', async ({ page }) => {
    await page.route('**/api/status**', async (route) => {
      await route.fulfill({ json: ESTIMATE_MOCK })
    })
    await page.goto('/#bedrock')
    await expect(page.locator('main').getByText(/Status Calendar|상태 캘린더/)).toBeVisible({ timeout: 20000 })
    // 24h Trend section should not exist for non-probe services
    await expect(page.locator('main').getByText(/24h Trend|24시간 추이/)).not.toBeVisible()
  })

  test('excludes estimate services from Ranking scored list', async ({ page }) => {
    await page.route('**/api/status**', async (route) => {
      await route.fulfill({ json: ESTIMATE_MOCK })
    })
    await page.goto('/#ranking')
    await expect(page.locator('h2').filter({ hasText: /랭킹|Ranking/i })).toBeVisible({ timeout: 20000 })
    // Claude and OpenAI should be ranked in the table
    const rankingTable = page.locator('table').first()
    await expect(rankingTable).toBeVisible({ timeout: 10000 })
    await expect(rankingTable.getByText('Claude API')).toBeVisible()
    await expect(rankingTable.getByText('OpenAI API')).toBeVisible()
    // Bedrock and Azure OpenAI should NOT be in the scored ranking table
    await expect(rankingTable.getByText('Amazon Bedrock')).not.toBeVisible()
    await expect(rankingTable.getByText('Azure OpenAI')).not.toBeVisible()
  })
})

test.describe('ServiceDetails RSS feed link (#432)', () => {
  test('Claude shows an RSS link that copies the per-service feed URL', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.goto('/#claude')
    await expect(page.locator('main').getByText(/Status Calendar|상태 캘린더/)).toBeVisible({ timeout: 20000 })

    const rssBtn = page.locator('main').getByRole('button', { name: /RSS/ })
    await expect(rssBtn).toBeVisible()
    await rssBtn.click()
    // Success-path feedback proves writeText resolved
    await expect(page.locator('main').getByText(/Copied ✓|복사됨 ✓/)).toBeVisible()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('https://ai-watch.dev/feed/claude')
  })

  test('Claude Code feed URL uses the is-down slug, not the service ID', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.goto('/#claudecode')
    await expect(page.locator('main').getByText(/Status Calendar|상태 캘린더/)).toBeVisible({ timeout: 20000 })
    await page.locator('main').getByRole('button', { name: /RSS/ }).click()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('https://ai-watch.dev/feed/claude-code')
  })

  test('estimate-only Bedrock has no RSS link', async ({ page }) => {
    await page.goto('/#bedrock')
    await expect(page.locator('main').getByText(/Status Calendar|상태 캘린더/)).toBeVisible({ timeout: 20000 })
    await expect(page.locator('main').getByRole('button', { name: /RSS/ })).not.toBeVisible()
  })
})
