import { test, expect } from './fixtures.js'

// Same service, two distinct incidents — exercises the per-svcId merge path in AnalysisModal.
// Regression guard for #315 (duplicate service name + duplicate fallback list).

const INC_NETWORK = {
  id: 'tog-inc-network',
  title: 'Network Maintenance',
  status: 'investigating',
  impact: 'major',
  startedAt: new Date(Date.now() - 7200_000).toISOString(),
  resolvedAt: null,
  duration: null,
  timeline: [],
}

const INC_MODEL = {
  id: 'tog-inc-model',
  title: 'OpenAI GPT OSS 120B — down',
  status: 'investigating',
  impact: 'minor',
  startedAt: new Date(Date.now() - 3600_000).toISOString(),
  resolvedAt: null,
  duration: null,
  timeline: [],
}

const ANALYSIS_NETWORK = {
  incidentId: 'tog-inc-network',
  summary: 'Scheduled network maintenance affecting Together AI connectivity.',
  estimatedRecovery: 'Exceeded typical pattern',
  affectedScope: ['Network Connectivity', 'API Availability'],
  needsFallback: true,
  analyzedAt: new Date().toISOString(),
}

const ANALYSIS_MODEL = {
  incidentId: 'tog-inc-model',
  summary: 'OpenAI GPT OSS 120B model outage — recurring failure pattern.',
  estimatedRecovery: '30m–1h',
  affectedScope: ['OpenAI GPT OSS 120B model'],
  needsFallback: true,
  analyzedAt: new Date().toISOString(),
}

// Degraded variant — the modal's fallback gate is status-based (#454), so the
// Alternatives block only renders when the service is down/degraded. The #315
// dedup guard ("exactly once per card") needs a card that actually shows it.
const MOCK = {
  services: [
    { id: 'together', category: 'api', name: 'Together AI', provider: 'Together', status: 'degraded', latency: 150, incidents: [INC_NETWORK, INC_MODEL] },
    { id: 'groq', category: 'api', name: 'Groq Cloud', provider: 'Groq', status: 'operational', latency: 100, incidents: [], aiwatchScore: 92 },
    { id: 'fireworks', category: 'api', name: 'Fireworks AI', provider: 'Fireworks', status: 'operational', latency: 110, incidents: [], aiwatchScore: 87 },
  ],
  aiAnalysis: {
    together: [ANALYSIS_NETWORK, ANALYSIS_MODEL],
  },
  lastUpdated: new Date().toISOString(),
}

test.describe('AnalysisModal grouping — same service multi-incident', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/status', async (route) => {
      await route.fulfill({ json: MOCK })
    })
    await page.route('**/api/status/cached', async (route) => {
      await route.fulfill({ json: MOCK })
    })
  })

  test('renders a single card with two incident sections (no duplicate service name)', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByText('Together AI').first()).toBeVisible({ timeout: 20000 })

    const analyzeBtn = page.locator('button').filter({ hasText: /Analyze|분석/ })
    await analyzeBtn.click()

    const modal = page.locator('.fixed.inset-0').last()
    await expect(modal).toBeVisible()

    // Service header should render exactly once
    await expect(modal.getByText('Together AI', { exact: true })).toHaveCount(1)

    // Both incident summaries appear
    await expect(modal.getByText(/Scheduled network maintenance/)).toBeVisible()
    await expect(modal.getByText(/GPT OSS 120B model outage/)).toBeVisible()

    // Multi-incident badge reflects the count
    await expect(modal.getByText(/\(2 (incidents|건)\)/)).toBeVisible()
  })

  test('renders the fallback Alternatives block exactly once per card', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByText('Together AI').first()).toBeVisible({ timeout: 20000 })

    await page.locator('button').filter({ hasText: /Analyze|분석/ }).click()
    const modal = page.locator('.fixed.inset-0').last()
    await expect(modal).toBeVisible()

    const alternatives = modal.getByText(/🔄 (Alternatives|대안 서비스)/)
    await expect(alternatives).toHaveCount(1)
  })
})

// Operational service with active (unresolved) analyses — the "isolated model
// issue" case. The status-based gate (#454) hides Alternatives here, matching
// the Overview ActionBanner which excludes operational services from its
// affected set, while the isolated-issue badge still surfaces the gap.
const ISOLATED_MOCK = {
  services: [
    { id: 'together', category: 'api', name: 'Together AI', provider: 'Together', status: 'operational', latency: 150, incidents: [INC_NETWORK, INC_MODEL] },
    { id: 'groq', category: 'api', name: 'Groq Cloud', provider: 'Groq', status: 'operational', latency: 100, incidents: [], aiwatchScore: 92 },
    { id: 'fireworks', category: 'api', name: 'Fireworks AI', provider: 'Fireworks', status: 'operational', latency: 110, incidents: [], aiwatchScore: 87 },
  ],
  aiAnalysis: {
    together: [ANALYSIS_NETWORK, ANALYSIS_MODEL],
  },
  lastUpdated: new Date().toISOString(),
}

test.describe('AnalysisModal grouping — operational service with active analyses', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/status', (route) => route.fulfill({ json: ISOLATED_MOCK }))
    await page.route('**/api/status/cached', (route) => route.fulfill({ json: ISOLATED_MOCK }))
  })

  test('shows isolated-issue badge when service is operational with active analyses', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByText('Together AI').first()).toBeVisible({ timeout: 20000 })

    await page.locator('button').filter({ hasText: /Analyze|분석/ }).click()
    const modal = page.locator('.fixed.inset-0').last()
    await expect(modal).toBeVisible()

    await expect(modal.getByText(/Isolated issue|부분 이슈/)).toBeVisible()
  })

  test('hides Alternatives for an operational isolated-issue service (#454 status gate)', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByText('Together AI').first()).toBeVisible({ timeout: 20000 })

    await page.locator('button').filter({ hasText: /Analyze|분석/ }).click()
    const modal = page.locator('.fixed.inset-0').last()
    await expect(modal).toBeVisible()

    await expect(modal.getByText(/🔄 (Alternatives|대안 서비스)/)).toHaveCount(0)
  })
})

// All analyses resolved → card opacity drops, Resolved pill shows, Alternatives + isolated
// badge both suppressed. Guards against regression where these surfaces bleed into a
// fully-resolved group.
const RESOLVED_MOCK = {
  services: [
    { id: 'together', category: 'api', name: 'Together AI', provider: 'Together', status: 'operational', latency: 150, incidents: [] },
    { id: 'groq', category: 'api', name: 'Groq Cloud', provider: 'Groq', status: 'operational', latency: 100, incidents: [], aiwatchScore: 92 },
  ],
  aiAnalysis: {
    together: [{
      ...ANALYSIS_MODEL,
      resolvedAt: new Date().toISOString(),
    }],
  },
  lastUpdated: new Date().toISOString(),
}

test.describe('AnalysisModal — fully resolved group', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/status', (route) => route.fulfill({ json: RESOLVED_MOCK }))
    await page.route('**/api/status/cached', (route) => route.fulfill({ json: RESOLVED_MOCK }))
  })

  test('hides Alternatives and Isolated issue, shows Resolved pill', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByText('Together AI').first()).toBeVisible({ timeout: 20000 })

    await page.locator('button').filter({ hasText: /Analyze|분석/ }).click()
    const modal = page.locator('.fixed.inset-0').last()
    await expect(modal).toBeVisible()

    await expect(modal.getByText(/🔄 (Alternatives|대안 서비스)/)).toHaveCount(0)
    await expect(modal.getByText(/Isolated issue|부분 이슈/)).toHaveCount(0)
    await expect(modal.getByText('Resolved')).toBeVisible()
  })
})

// EXCLUDE_FALLBACK services (replicate/huggingface/pinecone/modal/etc.) must not render
// the Alternatives block even when needsFallback=true — keeps suggestion list in sync with
// constants.js.
// huggingface is degraded here so the #454 status gate passes — this pins that
// the EXCLUDE_FALLBACK membership (not the status gate) is what suppresses the
// Alternatives block.
const EXCLUDED_SVC_MOCK = {
  services: [
    { id: 'huggingface', category: 'api', name: 'Hugging Face', provider: 'Hugging Face', status: 'degraded', latency: 180, incidents: [INC_MODEL] },
    { id: 'groq', category: 'api', name: 'Groq Cloud', provider: 'Groq', status: 'operational', latency: 100, incidents: [], aiwatchScore: 92 },
  ],
  aiAnalysis: {
    huggingface: [{ ...ANALYSIS_MODEL, needsFallback: true }],
  },
  lastUpdated: new Date().toISOString(),
}

test.describe('AnalysisModal — EXCLUDE_FALLBACK service', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/status', (route) => route.fulfill({ json: EXCLUDED_SVC_MOCK }))
    await page.route('**/api/status/cached', (route) => route.fulfill({ json: EXCLUDED_SVC_MOCK }))
  })

  test('does not render Alternatives for EXCLUDE_FALLBACK services', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByText('Hugging Face').first()).toBeVisible({ timeout: 20000 })

    await page.locator('button').filter({ hasText: /Analyze|분석/ }).click()
    const modal = page.locator('.fixed.inset-0').last()
    await expect(modal).toBeVisible()

    await expect(modal.getByText(/🔄 (Alternatives|대안 서비스)/)).toHaveCount(0)
  })
})

// Mixed: shared incident across sibling services + a service-private incident on one of them.
// Guard against the cross-service-bleed regression — the private incident must not appear
// under the multi-svc sibling card.
const SHARED_INC = {
  id: 'anthropic-admin-api',
  title: 'Admin API degraded',
  status: 'investigating',
  impact: 'major',
  startedAt: new Date(Date.now() - 7200_000).toISOString(),
  resolvedAt: null,
  duration: null,
  timeline: [],
}
const CLAUDE_PRIVATE_INC = {
  id: 'claude-opus-46',
  title: 'Opus 4.6 elevated errors',
  status: 'investigating',
  impact: 'minor',
  startedAt: new Date(Date.now() - 1800_000).toISOString(),
  resolvedAt: null,
  duration: null,
  timeline: [],
}
const SHARED_ANALYSIS = {
  incidentId: 'anthropic-admin-api',
  summary: 'Admin API endpoints are degraded across Anthropic surfaces.',
  estimatedRecovery: '30m–2h',
  affectedScope: ['Admin API'],
  needsFallback: false,
  analyzedAt: new Date().toISOString(),
}
const CLAUDE_PRIVATE_ANALYSIS = {
  incidentId: 'claude-opus-46',
  summary: 'Opus 4.6 model error rate elevated — API-only surface.',
  estimatedRecovery: '15m–45m',
  affectedScope: ['Opus 4.6'],
  needsFallback: true,
  analyzedAt: new Date().toISOString(),
}
const MIXED_MOCK = {
  services: [
    { id: 'claude', category: 'api', name: 'Claude API', provider: 'Anthropic', status: 'degraded', latency: 120, incidents: [SHARED_INC, CLAUDE_PRIVATE_INC] },
    { id: 'claudeai', category: 'app', name: 'claude.ai', provider: 'Anthropic', status: 'degraded', latency: 0, incidents: [SHARED_INC] },
    { id: 'openai', category: 'api', name: 'OpenAI API', provider: 'OpenAI', status: 'operational', latency: 200, incidents: [], aiwatchScore: 90 },
  ],
  aiAnalysis: {
    claude: [SHARED_ANALYSIS, CLAUDE_PRIVATE_ANALYSIS],
    claudeai: [SHARED_ANALYSIS],
  },
  lastUpdated: new Date().toISOString(),
}

test.describe('AnalysisModal — mixed sibling-shared + service-private', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/status', (route) => route.fulfill({ json: MIXED_MOCK }))
    await page.route('**/api/status/cached', (route) => route.fulfill({ json: MIXED_MOCK }))
  })

  test('renders shared incident in one card and private incident in a separate Claude-only card', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByText('Claude API').first()).toBeVisible({ timeout: 20000 })

    await page.locator('button').filter({ hasText: /Analyze|분석/ }).click()
    const modal = page.locator('.fixed.inset-0').last()
    await expect(modal).toBeVisible()

    // Shared admin-api summary appears once
    await expect(modal.getByText(/Admin API endpoints are degraded/)).toHaveCount(1)
    // Private Opus 4.6 summary appears once — must NOT bleed onto the sibling card
    await expect(modal.getByText(/Opus 4\.6 model error rate elevated/)).toHaveCount(1)

    // Shared card must list claude.ai alongside Claude API (sibling grouping preserved)
    const sharedSection = modal.getByText(/Admin API endpoints are degraded/).locator('xpath=ancestor::div[contains(@class, "rounded-lg")][1]')
    await expect(sharedSection.getByText('claude.ai')).toBeVisible()

    // Multi-service degraded group still surfaces Alternatives under the #454
    // status gate even though SHARED_ANALYSIS is needsFallback:false — pins the
    // `svcs.some(non-operational)` semantics for a mixed sibling group.
    await expect(sharedSection.getByText(/🔄 (Alternatives|대안 서비스)/)).toHaveCount(1)

    // Private card must be Claude-only — claude.ai must not leak into this card
    const privateSection = modal.getByText(/Opus 4\.6 model error rate elevated/).locator('xpath=ancestor::div[contains(@class, "rounded-lg")][1]')
    await expect(privateSection.getByText('claude.ai')).toHaveCount(0)
  })
})
