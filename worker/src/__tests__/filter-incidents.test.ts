import { describe, it, expect } from 'vitest'
import { filterIncidents, includeUntaggedIncidents, filterByComponentStatus } from '../services'
import { normalizeStatus } from '../parsers/statuspage'
import type { Incident, ServiceConfig } from '../types'

function mockIncident(overrides: Partial<Incident> = {}): Incident {
  return {
    id: 'inc-1',
    title: 'Test incident',
    status: 'investigating',
    impact: 'major',
    startedAt: '2026-04-06T10:00:00Z',
    resolvedAt: null,
    duration: null,
    timeline: [],
    ...overrides,
  }
}

function mockConfig(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    id: 'test',
    name: 'Test',
    provider: 'Test',
    category: 'api',
    statusUrl: 'https://example.com',
    apiUrl: null,
    ...overrides,
  }
}

describe('filterIncidents', () => {
  it('returns all incidents when no keywords or excludes', () => {
    const incidents = [mockIncident({ title: 'API Error' })]
    expect(filterIncidents(incidents, mockConfig())).toHaveLength(1)
  })

  it('excludes by incidentExclude keywords', () => {
    const incidents = [mockIncident({ title: 'ChatGPT login issues' })]
    const config = mockConfig({ incidentExclude: ['chatgpt'] })
    expect(filterIncidents(incidents, config)).toHaveLength(0)
  })

  it('includes only matching incidentKeywords', () => {
    const incidents = [
      mockIncident({ id: '1', title: 'API latency spike' }),
      mockIncident({ id: '2', title: 'Dashboard outage' }),
    ]
    const config = mockConfig({ incidentKeywords: ['api'] })
    const result = filterIncidents(incidents, config)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('1')
  })

  it('matches keywords against componentNames', () => {
    const incidents = [mockIncident({ title: 'Service issue', componentNames: ['API Gateway'] })]
    const config = mockConfig({ incidentKeywords: ['api'] })
    expect(filterIncidents(incidents, config)).toHaveLength(1)
  })

  it('exclude takes precedence over keywords', () => {
    const incidents = [mockIncident({ title: 'ChatGPT API error' })]
    const config = mockConfig({ incidentKeywords: ['api'], incidentExclude: ['chatgpt'] })
    expect(filterIncidents(incidents, config)).toHaveLength(0)
  })

  it('bypasses keyword filter for aistudio-prefixed incidents (#310)', () => {
    const incidents = [
      mockIncident({ id: 'aistudio:batch-api-outage', title: 'Batch API outage' }),
      mockIncident({ id: 'aistudio:file-api', title: 'File API document processing outage' }),
      mockIncident({ id: 'vertex:non-gemini', title: 'Speech-to-Text throttling' }),
    ]
    const config = mockConfig({
      id: 'gemini',
      incidentKeywords: ['vertex', 'gemini', 'us-central1'],
      aistudioStatus: true,
    })
    const result = filterIncidents(incidents, config)
    // aistudio: incidents pass the gate even without 'gemini' in title;
    // vertex: incident without a keyword match is still dropped.
    expect(result.map((i) => i.id)).toEqual([
      'aistudio:batch-api-outage',
      'aistudio:file-api',
    ])
  })

  it('still drops aistudio incidents that match incidentExclude', () => {
    const incidents = [
      mockIncident({ id: 'aistudio:drive-link', title: 'AI Studio Drive link issue' }),
    ]
    const config = mockConfig({
      id: 'gemini',
      incidentExclude: ['drive link'],
      aistudioStatus: true,
    })
    // exclude runs before the aistudio bypass
    expect(filterIncidents(incidents, config)).toHaveLength(0)
  })

  it('bypasses incidentExclude when incident explicitly lists this service component (#357)', () => {
    // "claude.ai and API unavailable" should NOT be excluded from the Claude API service
    // even though the title contains "claude.ai" (which is in incidentExclude).
    const incident = mockIncident({
      id: '2gf1jpyty350',
      title: 'claude.ai and API unavailable',
      componentNames: ['claude.ai', 'Claude Console', 'Claude API (api.anthropic.com)', 'Claude Code', 'Claude Cowork'],
    })
    const claudeApiConfig = mockConfig({
      id: 'claude',
      statusComponent: 'Claude API',
      statusComponentId: 'k8w3r06qmzrp',
      incidentExclude: ['claude.ai', 'claude code', 'claude desktop', 'cowork'],
    })
    expect(filterIncidents([incident], claudeApiConfig)).toHaveLength(1)
  })

  it('still excludes when title matches exclude and component does NOT list this service', () => {
    // A claude.ai-only incident should still be excluded from the Claude API service.
    const incident = mockIncident({
      id: 'abc123',
      title: 'claude.ai loading issues',
      componentNames: ['claude.ai'],
    })
    const claudeApiConfig = mockConfig({
      id: 'claude',
      statusComponent: 'Claude API',
      statusComponentId: 'k8w3r06qmzrp',
      incidentExclude: ['claude.ai', 'claude code', 'claude desktop', 'cowork'],
    })
    expect(filterIncidents([incident], claudeApiConfig)).toHaveLength(0)
  })

  it('OpenAI API excludes login incidents', () => {
    const incidents = [mockIncident({ title: 'Elevated Errors with Login' })]
    const config = mockConfig({
      incidentKeywords: ['api', 'us-east-1', 'us-west-2', 'eu-central-1'],
      incidentExclude: ['chatgpt', 'sign-in', 'login'],
    })
    expect(filterIncidents(incidents, config)).toHaveLength(0)
  })

  it('ChatGPT includes login incidents via keyword', () => {
    const incidents = [mockIncident({ title: 'Elevated Errors with Login' })]
    const config = mockConfig({
      incidentKeywords: ['chatgpt', 'conversation', 'login'],
    })
    expect(filterIncidents(incidents, config)).toHaveLength(1)
  })
})

describe('includeUntaggedIncidents', () => {
  const apiIncident = mockIncident({
    id: 'api-inc',
    title: 'GET /v1/responses endpoint is down',
    componentNames: [],
  })
  const chatgptIncident = mockIncident({
    id: 'chat-inc',
    title: 'ChatGPT conversation errors',
    componentNames: ['Conversations'],
  })

  const components = [
    { id: 'comp-api', name: 'API', status: 'major_outage' },
    { id: 'comp-conv', name: 'Conversations', status: 'operational' },
  ]

  it('skips untagged fallback when component is operational (ChatGPT case)', () => {
    // ChatGPT has keyword filter, no matching active incidents, but component is operational
    const config = mockConfig({
      id: 'chatgpt',
      incidentKeywords: ['chatgpt', 'conversation'],
      statusComponentId: 'comp-conv', // Conversations → operational
    })
    const filtered: Incident[] = [] // keyword filter excluded the API incident
    const result = includeUntaggedIncidents(filtered, [apiIncident], config, components, 'major')
    expect(result).toHaveLength(0) // should NOT include untagged API incident
  })

  it('includes untagged incidents when no component configured and page is degraded', () => {
    // Service without statusComponentId — uses overall page status
    const config = mockConfig({
      id: 'generic',
      incidentKeywords: ['something'],
    })
    const filtered: Incident[] = []
    const result = includeUntaggedIncidents(filtered, [apiIncident], config, components, 'major')
    expect(result).toHaveLength(1) // should include untagged since overall is major
    expect(result[0].id).toBe('api-inc')
  })

  it('skips when filtered already has active incidents', () => {
    const config = mockConfig({ incidentKeywords: ['chatgpt'] })
    const active = [mockIncident({ id: 'active', status: 'investigating' })]
    const result = includeUntaggedIncidents(active, [apiIncident], config, components, 'major')
    expect(result).toEqual(active) // no change — already has active incidents
  })

  it('skips when no keyword filters configured', () => {
    const config = mockConfig({}) // no incidentKeywords
    const result = includeUntaggedIncidents([], [apiIncident], config, components, 'major')
    expect(result).toHaveLength(0)
  })

  it('skips when overall status is operational', () => {
    const config = mockConfig({ incidentKeywords: ['something'] })
    const result = includeUntaggedIncidents([], [apiIncident], config, [], 'none')
    expect(result).toHaveLength(0)
  })

  it('excludes untagged incidents matching incidentExclude', () => {
    const config = mockConfig({
      incidentKeywords: ['something'],
      incidentExclude: ['responses'],
    })
    const result = includeUntaggedIncidents([], [apiIncident], config, [], 'major')
    expect(result).toHaveLength(0) // excluded by title match
  })

  it('skips incidents that have componentNames (not untagged)', () => {
    const config = mockConfig({ incidentKeywords: ['something'] })
    const tagged = mockIncident({ id: 'tagged', componentNames: ['API Gateway'] })
    const result = includeUntaggedIncidents([], [tagged], config, [], 'major')
    expect(result).toHaveLength(0) // has componentNames → not untagged
  })

  it('uses statusComponent name match when available', () => {
    const config = mockConfig({
      incidentKeywords: ['something'],
      statusComponent: 'Conversations',
    })
    // Conversations component is operational → skip
    const result = includeUntaggedIncidents([], [apiIncident], config, components, 'major')
    expect(result).toHaveLength(0)
  })

  it('includes untagged when component is degraded', () => {
    const config = mockConfig({
      incidentKeywords: ['something'],
      statusComponentId: 'comp-api', // API → major_outage
    })
    const result = includeUntaggedIncidents([], [apiIncident], config, components, 'major')
    expect(result).toHaveLength(1) // component is down, include untagged
  })

  it('only includes unresolved untagged incidents', () => {
    const config = mockConfig({ incidentKeywords: ['something'] })
    const resolved = mockIncident({ id: 'old', status: 'resolved', componentNames: [] })
    const active = mockIncident({ id: 'new', status: 'investigating', componentNames: [] })
    const result = includeUntaggedIncidents([], [resolved, active], config, [], 'major')
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('new')
  })
})

describe('filterByComponentStatus (#228)', () => {
  it('removes active incidents when component is operational', () => {
    const incidents = [
      mockIncident({ id: 'active-1', status: 'investigating' }),
      mockIncident({ id: 'resolved-1', status: 'resolved', resolvedAt: '2026-04-14T00:00:00Z' }),
      mockIncident({ id: 'monitoring-1', status: 'monitoring' }),
    ]
    const config = mockConfig({ statusComponentId: 'k8w3r06qmzrp' })
    const result = filterByComponentStatus(incidents, 'operational', config)
    expect(result).toHaveLength(2)
    expect(result.map(i => i.id)).toEqual(['resolved-1', 'monitoring-1'])
  })

  it('keeps all incidents when component is degraded', () => {
    const incidents = [
      mockIncident({ id: 'active-1', status: 'investigating' }),
      mockIncident({ id: 'resolved-1', status: 'resolved' }),
    ]
    const config = mockConfig({ statusComponentId: 'k8w3r06qmzrp' })
    const result = filterByComponentStatus(incidents, 'degraded', config)
    expect(result).toHaveLength(2)
  })

  it('keeps all incidents when component is down', () => {
    const incidents = [
      mockIncident({ id: 'active-1', status: 'investigating' }),
    ]
    const config = mockConfig({ statusComponentId: 'abc123' })
    const result = filterByComponentStatus(incidents, 'down', config)
    expect(result).toHaveLength(1)
  })

  it('skips filtering when no statusComponentId or statusComponent', () => {
    const incidents = [
      mockIncident({ id: 'active-1', status: 'investigating' }),
    ]
    const config = mockConfig({}) // no component config
    const result = filterByComponentStatus(incidents, 'operational', config)
    expect(result).toHaveLength(1)
  })

  it('works with statusComponent (name-based) config', () => {
    const incidents = [
      mockIncident({ id: 'active-1', status: 'investigating' }),
      mockIncident({ id: 'resolved-1', status: 'resolved' }),
    ]
    const config = mockConfig({ statusComponent: 'claude.ai' })
    const result = filterByComponentStatus(incidents, 'operational', config)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('resolved-1')
  })

  it('real-world: Anthropic bulk-links incident to all components', () => {
    // Simulates the actual scenario: admin API incident linked to claude.ai, Claude Code, etc.
    const adminApiIncident = mockIncident({
      id: 'w3389p5qg7kp',
      title: 'Degraded service on usage and analytics admin API endpoints',
      status: 'investigating',
      componentNames: ['claude.ai', 'Claude API', 'Claude Code', 'Claude Cowork'],
    })
    const oldResolved = mockIncident({ id: 'old-1', status: 'resolved', resolvedAt: '2026-04-10T00:00:00Z' })

    // claude.ai component is operational — should filter out active incident
    const claudeAiConfig = mockConfig({ id: 'claudeai', statusComponentId: 'rwppv331jlwc', incidentKeywords: ['claude.ai'] })
    const claudeAiResult = filterByComponentStatus([adminApiIncident, oldResolved], 'operational', claudeAiConfig)
    expect(claudeAiResult).toHaveLength(1)
    expect(claudeAiResult[0].id).toBe('old-1')

    // Claude API component is degraded — should keep all incidents
    const claudeApiConfig = mockConfig({ id: 'claude', statusComponentId: 'k8w3r06qmzrp' })
    const claudeApiResult = filterByComponentStatus([adminApiIncident, oldResolved], 'degraded', claudeApiConfig)
    expect(claudeApiResult).toHaveLength(2)
  })
})

// Reproduces the call-site decision flow inside fetchService for shared
// status-page services (#361). Mirrors the new ordering: filterIncidents →
// computeSvcStatus → conditional includeUntaggedIncidents → filterByComponentStatus.
// The bug was that includeUntaggedIncidents ran unconditionally, leaking
// untagged sibling incidents (e.g., ChatGPT-only) into other services on
// the same status page (e.g., Codex) whose keyword filter correctly dropped them.
function applyFetchServiceFlow(
  incidents: Incident[],
  config: ServiceConfig,
  summaryComponents: Array<{ id: string; name: string; status: string }>,
  overallIndicator: string,
): { filtered: Incident[]; svcStatus: string } {
  let filtered = filterIncidents(incidents, config)

  const svcStatus = (() => {
    const overall = normalizeStatus(overallIndicator)
    if (!config.statusComponent && !config.statusComponentId) {
      if (overall !== 'operational' && filtered.filter((i) => i.status !== 'resolved').length === 0) {
        return 'operational'
      }
      return overall
    }
    const comp = config.statusComponent
      ? summaryComponents.find((c) => c.name.startsWith(config.statusComponent!))
      : summaryComponents.find((c) => c.id === config.statusComponentId)
    return comp ? normalizeStatus(comp.status) : overall
  })()

  if (svcStatus !== 'operational') {
    filtered = includeUntaggedIncidents(filtered, incidents, config, summaryComponents, overallIndicator)
  }
  filtered = filterByComponentStatus(filtered, svcStatus, config)
  return { filtered, svcStatus }
}

describe('fetchService cross-contamination guard (#361)', () => {
  // Real production scenario captured 2026-04-30: status.openai.com hosts
  // ChatGPT, OpenAI API, and Codex. An untagged ChatGPT-only incident is
  // active; the page indicator is non-operational. Codex's keywords
  // (codex/cli/vs code) do not match the title, and Codex has no
  // statusComponent/Id (only incidentIoComponentId). Pre-fix flow leaked
  // the ChatGPT incident into Codex; post-fix must not.
  const chatgptUntagged = mockIncident({
    id: '01KQDM1K1826RP1FFN86ZNA3WG',
    title: 'Partial Disruption of ChatGPT Workspace Connector Write Actions',
    status: 'identified',
    componentNames: null,
  })
  const codexResolved = mockIncident({
    id: 'codex-old-1',
    title: 'Elevated errors in Codex',
    status: 'resolved',
    resolvedAt: '2026-04-25T00:00:00Z',
    componentNames: null,
  })
  const allIncidents = [chatgptUntagged, codexResolved]

  it('codex: untagged ChatGPT incident does NOT leak (cross-contamination guard fires)', () => {
    const codexConfig = mockConfig({
      id: 'codex',
      apiUrl: 'https://status.openai.com/api/v2/summary.json',
      incidentKeywords: ['codex', 'cli', 'vs code'],
      incidentIoComponentId: '01KMP3KP5MGE23B80K1EK4S8PV',
    })
    const { filtered, svcStatus } = applyFetchServiceFlow(allIncidents, codexConfig, [], 'major')
    expect(svcStatus).toBe('operational')
    expect(filtered.find((i) => i.id === '01KQDM1K1826RP1FFN86ZNA3WG')).toBeUndefined()
    expect(filtered.find((i) => i.id === 'codex-old-1')).toBeDefined()
  })

  it('chatgpt: still surfaces the incident via keyword match (no regression)', () => {
    const chatgptConfig = mockConfig({
      id: 'chatgpt',
      apiUrl: 'https://status.openai.com/api/v2/summary.json',
      incidentKeywords: ['chatgpt', 'workspaces', 'conversation', 'login'],
    })
    const { filtered, svcStatus } = applyFetchServiceFlow(allIncidents, chatgptConfig, [], 'major')
    expect(svcStatus).toBe('down')
    expect(filtered.find((i) => i.id === '01KQDM1K1826RP1FFN86ZNA3WG')).toBeDefined()
  })

  it('openai: still excludes via incidentExclude (no regression)', () => {
    const openaiConfig = mockConfig({
      id: 'openai',
      apiUrl: 'https://status.openai.com/api/v2/summary.json',
      incidentExclude: ['chatgpt', 'workspaces', 'codex'],
      incidentKeywords: ['api'],
      incidentIoComponentId: '01JMXBRMFE6N2NNT7DG6XZQ6PW',
    })
    const { filtered, svcStatus } = applyFetchServiceFlow(allIncidents, openaiConfig, [], 'major')
    expect(svcStatus).toBe('operational')
    expect(filtered.find((i) => i.id === '01KQDM1K1826RP1FFN86ZNA3WG')).toBeUndefined()
  })

  it('legitimate untagged-include still works when filterIncidents misses the keyword', () => {
    // A service alone on its status page gets an untagged incident surfaced when
    // the overall indicator is non-operational AND filterIncidents found nothing
    // (cross-contamination guard MUST NOT fire if there's no sibling to contaminate
    // FROM — ie. when the page truly belongs to this service). Title deliberately
    // does NOT substring-match the keywords so the only path to inclusion is via
    // includeUntaggedIncidents; otherwise the test would silently pass via
    // filterIncidents and never exercise the untagged path.
    const untaggedDb = mockIncident({
      id: 'db-1',
      title: 'Database outage',
      status: 'identified',
      componentNames: null,
    })
    const soloConfig = mockConfig({
      id: 'solo',
      apiUrl: 'https://status.solo.example/api/v2/summary.json',
      incidentKeywords: ['api'],
    })
    const { filtered, svcStatus } = applyFetchServiceFlow([untaggedDb], soloConfig, [], 'major')
    // Cross-contamination guard fires (filterIncidents returned 0 unresolved),
    // so untagged-include is skipped and svcStatus stays operational. This is the
    // accepted trade-off (#361): a single-service page with an untagged incident
    // whose title doesn't match keywords becomes a false negative, but production
    // status pages reliably tag their own components when only one service uses
    // the page (e.g. cohere/groq/elevenlabs/replicate/stability).
    expect(svcStatus).toBe('operational')
    expect(filtered.find((i) => i.id === 'db-1')).toBeUndefined()
  })
})
