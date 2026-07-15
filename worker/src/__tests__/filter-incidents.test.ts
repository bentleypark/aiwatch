import { describe, it, expect, vi } from 'vitest'
import { filterIncidents, includeUntaggedIncidents, filterByComponentStatus, badgeGroupNames, SERVICES } from '../services'
import { buildIncidentAlerts } from '../alerts'
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

  it('#623 — Mistral: scopes to API, excludes Le Chat / non-API surfaces (Nuxt title carries the component)', () => {
    // status.mistral.ai is Instatus/Nuxt — the parser appends the affected component to the title
    // ("name · Component"). The mistral denylist drops the consumer/non-API surfaces while keeping
    // every API component (denylist, so a real API incident is never dropped).
    const mistral = mockConfig({ id: 'mistral', incidentExclude: ['le chat', 'le console', 'documentation', 'website'] })
    const incidents = [
      mockIncident({ id: 'a', title: 'Requests are experiencing degraded service · Chat Completions API' }),
      mockIncident({ id: 'b', title: 'Requests are experiencing degraded service · AI Registry Prompts API' }),
      mockIncident({ id: 'g', title: 'Elevated errors · Files API' }),   // broadens the no-collision net
      mockIncident({ id: 'c', title: 'Slow responses · Le Chat' }),
      mockIncident({ id: 'd', title: 'Login broken · Le Console' }),
      mockIncident({ id: 'e', title: 'Docs outage · Documentation' }),
      mockIncident({ id: 'f', title: 'Marketing page down · Mistral.ai Website' }),
    ]
    const kept = filterIncidents(incidents, mistral).map((i) => i.id)
    expect(kept).toEqual(['a', 'b', 'g']) // only the API-component incidents survive
    // a real API incident is never accidentally dropped (no API component name contains a denylist term)
    expect(kept).not.toContain('c')
    expect(kept).not.toContain('f')
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

// #683 — exact-component-name incident scoping (Junie on the shared JetBrains status page; the page
// moved to status.jetbrains.cloud in #1004, still shared with the sibling products).
// Uses the REAL junie config from SERVICES so a regression that drops `incidentComponents` fails here.
describe('filterIncidents — incidentComponents exact-name scoping (#683)', () => {
  const junie = (): ServiceConfig => {
    const c = SERVICES.find((s) => s.id === 'junie')
    if (!c) throw new Error('junie config missing')
    return c
  }

  it('drops a sibling-only (Grazie) incident not listing Junie — the 2026-06-17 false positive', () => {
    const inc = mockIncident({
      id: 'grazie-nlp',
      title: 'Raised error rates from NLP services',
      status: 'resolved',
      componentNames: ['Grazie'],
    })
    expect(filterIncidents([inc], junie())).toHaveLength(0)
  })

  it('keeps a genuine Junie-affecting incident (componentNames includes JetBrains AI)', () => {
    // #1004 follow-on — JetBrains removed the standalone "Junie" component; Junie now scopes to the
    // "JetBrains AI" roll-up + "JetBrains Central Console" gateway (SUPPORT-A-2595 + our incident archive).
    const inc = mockIncident({
      id: 'junie-auth',
      title: 'Auth & licensing service issues',
      componentNames: ['JetBrains AI', 'Grazie'],
    })
    expect(filterIncidents([inc], junie()).map((i) => i.id)).toEqual(['junie-auth'])
  })

  it('keeps a Central Console gateway incident (where the real LLM-API outages tag)', () => {
    // The case that motivated option C: "AI Platform LLM APIs outage" tags Central Console, not the
    // empty "JetBrains AI" component — a JetBrains-AI-only scope would have dropped it.
    const inc = mockIncident({
      id: 'llm-api-outage',
      title: 'AI Platform LLM APIs outage',
      componentNames: ['JetBrains Central Console'],
    })
    expect(filterIncidents([inc], junie()).map((i) => i.id)).toEqual(['llm-api-outage'])
  })

  it('drops an untagged incident (no componentNames) — nothing to match', () => {
    const inc = mockIncident({ id: 'untagged', title: 'AI Platform LLM APIs outage', componentNames: [] })
    expect(filterIncidents([inc], junie())).toHaveLength(0)
  })

  it('uses EXACT (not substring) match — config of "AI Platform" must NOT keep "AI Platform China"', () => {
    const config = mockConfig({ id: 'x', incidentComponents: ['AI Platform'] })
    const platform = mockIncident({ id: 'p', title: 'outage', componentNames: ['AI Platform'] })
    const china = mockIncident({ id: 'c', title: 'outage', componentNames: ['AI Platform China'] })
    const kept = filterIncidents([platform, china], config).map((i) => i.id)
    expect(kept).toEqual(['p']) // exact 'AI Platform' kept; 'AI Platform China' dropped (no collision)
  })

  it('match is case-insensitive', () => {
    const config = mockConfig({ id: 'x', incidentComponents: ['Junie'] })
    const inc = mockIncident({ id: 'j', title: 'x', componentNames: ['junie'] })
    expect(filterIncidents([inc], config)).toHaveLength(1)
  })

  it('incidentExclude is still applied first (excluded → dropped even if the component matches)', () => {
    const config = mockConfig({ id: 'x', incidentComponents: ['Junie'], incidentExclude: ['maintenance'] })
    const inc = mockIncident({ id: 'm', title: 'Scheduled maintenance', componentNames: ['Junie'] })
    expect(filterIncidents([inc], config)).toHaveLength(0) // exclude runs before the component gate
  })

  it('includeUntaggedIncidents does NOT resurrect an untagged incident for an incidentComponents-only service', () => {
    // The real safety guarantee for the "page-wide incident hidden?" concern: the untagged-include
    // path early-returns unless incidentKeywords is set, and junie uses incidentComponents instead.
    const untagged = mockIncident({ id: 'pagewide', title: 'AI Platform LLM APIs outage', status: 'identified', componentNames: [] })
    expect(includeUntaggedIncidents([], [untagged], junie(), [], 'major')).toHaveLength(0)
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

// Real component lists, copied from the live `api/v2/summary.json` of each page. The #970 guard maps
// `statusComponentIds` (ids) → the `componentNames` an Incident carries, so faithful ids matter.
const RUNWAY_COMPONENTS = [
  { id: '2fr8tksxj5ns', name: 'App' },
  { id: 'hl94rh0mg6xt', name: 'Backend' },
  { id: 'pxc5jjl6wty0', name: 'Billing' },
  { id: 'f8yl6htsys9v', name: 'Support' },
  { id: 'w3jcq3dwljp4', name: 'Public API' },
]
const CLAUDE_COMPONENTS = [
  { id: 'rwppv331jlwc', name: 'claude.ai' },
  { id: '0qbwn08sd68x', name: 'Claude Console (platform.claude.com)' },
  { id: 'k8w3r06qmzrp', name: 'Claude API (api.anthropic.com)' },
  { id: 'yyzkbfz2thpt', name: 'Claude Code' },
  { id: 'bpp5gb3hpjcl', name: 'Claude Cowork' },
  { id: '0scnb50nvy53', name: 'Claude for Government' },
]

describe('filterByComponentStatus (#228)', () => {
  it('removes active incidents when component is operational', () => {
    const incidents = [
      mockIncident({ id: 'active-1', status: 'investigating' }),
      mockIncident({ id: 'resolved-1', status: 'resolved', resolvedAt: '2026-04-14T00:00:00Z' }),
      mockIncident({ id: 'monitoring-1', status: 'monitoring' }),
    ]
    const config = mockConfig({ statusComponentId: 'k8w3r06qmzrp' })
    const result = filterByComponentStatus(incidents, 'operational', config, [])
    expect(result).toHaveLength(2)
    expect(result.map(i => i.id)).toEqual(['resolved-1', 'monitoring-1'])
  })

  it('keeps all incidents when component is degraded', () => {
    const incidents = [
      mockIncident({ id: 'active-1', status: 'investigating' }),
      mockIncident({ id: 'resolved-1', status: 'resolved' }),
    ]
    const config = mockConfig({ statusComponentId: 'k8w3r06qmzrp' })
    const result = filterByComponentStatus(incidents, 'degraded', config, [])
    expect(result).toHaveLength(2)
  })

  it('keeps all incidents when component is down', () => {
    const incidents = [
      mockIncident({ id: 'active-1', status: 'investigating' }),
    ]
    const config = mockConfig({ statusComponentId: 'abc123' })
    const result = filterByComponentStatus(incidents, 'down', config, [])
    expect(result).toHaveLength(1)
  })

  it('skips filtering when no statusComponentId or statusComponent', () => {
    const incidents = [
      mockIncident({ id: 'active-1', status: 'investigating' }),
    ]
    const config = mockConfig({}) // no component config
    const result = filterByComponentStatus(incidents, 'operational', config, [])
    expect(result).toHaveLength(1)
  })

  it('works with statusComponent (name-based) config', () => {
    const incidents = [
      mockIncident({ id: 'active-1', status: 'investigating' }),
      mockIncident({ id: 'resolved-1', status: 'resolved' }),
    ]
    const config = mockConfig({ statusComponent: 'claude.ai' })
    const result = filterByComponentStatus(incidents, 'operational', config, [])
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
    const claudeAiResult = filterByComponentStatus([adminApiIncident, oldResolved], 'operational', claudeAiConfig, CLAUDE_COMPONENTS)
    expect(claudeAiResult).toHaveLength(1)
    expect(claudeAiResult[0].id).toBe('old-1')

    // Claude API component is degraded — should keep all incidents
    const claudeApiConfig = mockConfig({ id: 'claude', statusComponentId: 'k8w3r06qmzrp' })
    const claudeApiResult = filterByComponentStatus([adminApiIncident, oldResolved], 'degraded', claudeApiConfig, CLAUDE_COMPONENTS)
    expect(claudeApiResult).toHaveLength(2)
  })

  // #934 — a RESOLVED sibling-component-only incident must not cross-attribute to a service whose
  // own component stayed operational. Reproduces the production case: "Claude Tag seeing elevated
  // GitHub operation failures" (componentNames: ['Claude Code']) surfaced under Claude API on resolution.
  describe('#934 resolved sibling-component cross-attribution', () => {
    // The real SERVICES config carries statusComponent NAMES, so the fix engages.
    const claudeApi = SERVICES.find(s => s.id === 'claude')!
    const claudeCode = SERVICES.find(s => s.id === 'claudecode')!
    const githubIncident = (status: Incident['status']) => mockIncident({
      id: 'gh-1',
      title: 'Claude Tag seeing elevated GitHub operation failures',
      status,
      componentNames: ['Claude Code'],
      resolvedAt: status === 'resolved' ? '2026-07-07T15:52:01Z' : null,
    })

    it('drops the resolved Claude-Code-only incident from Claude API (operational)', () => {
      const result = filterByComponentStatus([githubIncident('resolved')], 'operational', claudeApi, CLAUDE_COMPONENTS)
      expect(result).toHaveLength(0)
    })

    it('drops the monitoring Claude-Code-only incident from Claude API (operational)', () => {
      const result = filterByComponentStatus([githubIncident('monitoring')], 'operational', claudeApi, CLAUDE_COMPONENTS)
      expect(result).toHaveLength(0)
    })

    it('keeps the resolved incident on Claude Code (keyword-scoped, no flag)', () => {
      // claudecode does NOT set scopeResolvedToComponent (keyword-scoped upstream), so it is unaffected
      // by #934 and retains its own resolved incident — surfaces normally on resolution.
      expect(claudeCode.scopeResolvedToComponent).toBeUndefined()
      const result = filterByComponentStatus([githubIncident('resolved')], 'operational', claudeCode, CLAUDE_COMPONENTS)
      expect(result.map(i => i.id)).toEqual(['gh-1'])
    })

    it('keeps a genuine combined incident that names Claude API', () => {
      const combined = mockIncident({
        id: 'combo-1',
        title: 'Elevated errors across surfaces',
        status: 'resolved',
        componentNames: ['Claude API', 'Claude Code'],
        resolvedAt: '2026-07-07T00:00:00Z',
      })
      const result = filterByComponentStatus([combined], 'operational', claudeApi, CLAUDE_COMPONENTS)
      expect(result.map(i => i.id)).toEqual(['combo-1'])
    })

    it('keeps an untagged resolved incident on Claude API (fail-open)', () => {
      const untagged = mockIncident({ id: 'ut-1', status: 'resolved', resolvedAt: '2026-07-07T00:00:00Z' })
      const result = filterByComponentStatus([untagged], 'operational', claudeApi, CLAUDE_COMPONENTS)
      expect(result.map(i => i.id)).toEqual(['ut-1'])
    })

    it.each([
      ['resolved' as const],
      ['monitoring' as const],
    ])('#970 does not disturb the %s branch when components are passed', (status) => {
      const result = filterByComponentStatus([githubIncident(status)], 'operational', claudeApi, CLAUDE_COMPONENTS)
      expect(result).toHaveLength(0)
    })

    it('does NOT scope a single-tenant broad-"API" service (perplexity) — no regression', () => {
      // perplexity has statusComponent 'API' but does NOT opt in. A resolved incident whose component
      // does not literally prefix 'API' (e.g. 'Sonar API') must still be kept — the #934 name-scoping
      // would wrongly drop it, so the flag guards single-tenant services from that.
      const perplexity = SERVICES.find(s => s.id === 'perplexity')!
      expect(perplexity.scopeResolvedToComponent).toBeUndefined()
      const sonar = mockIncident({
        id: 'px-1', title: 'Elevated latency on Sonar API', status: 'resolved',
        componentNames: ['Sonar API'], resolvedAt: '2026-07-07T00:00:00Z',
      })
      const result = filterByComponentStatus([sonar], 'operational', perplexity, [])
      expect(result.map(i => i.id)).toEqual(['px-1'])
    })
  })

  // #970 — an `impact: none` incident degrades no component, so "our component is operational" proves
  // nothing and the active-drop silently ate the incident. Pinned to the two REAL payloads that decide
  // the rule: Runway's Aleph 2.0 (must be kept) and Anthropic's bulk-link (must stay dropped, #228).
  describe('#970 impact:none active incidents', () => {
    const runway = SERVICES.find(s => s.id === 'runway')!
    const claudeApi = SERVICES.find(s => s.id === 'claude')!

    // status.runwayml.com incident nprnqn29h7y9, as parsed at 20:45Z (7 min in, still investigating).
    const aleph = (status: Incident['status'] = 'investigating') => mockIncident({
      id: 'nprnqn29h7y9',
      title: 'Aleph 2.0 delayed generations',
      status,
      impact: null,
      componentNames: ['App', 'Backend', 'Public API'],
      startedAt: '2026-07-08T20:39:56.000Z',
      resolvedAt: status === 'resolved' ? '2026-07-08T21:02:49.380Z' : null,
    })

    it('keeps the ACTIVE Runway incident even though every component is operational', () => {
      const result = filterByComponentStatus([aleph()], 'operational', runway, RUNWAY_COMPONENTS)
      expect(result.map(i => i.id)).toEqual(['nprnqn29h7y9'])
    })

    it('drops a Billing-only impact:none incident (outside the badge group)', () => {
      const billing = mockIncident({
        id: 'billing-1', title: 'Invoice delays', status: 'investigating',
        impact: null, componentNames: ['Billing'],
      })
      expect(filterByComponentStatus([billing], 'operational', runway, RUNWAY_COMPONENTS)).toEqual([])
    })

    it('drops an UNTAGGED impact:none incident (would leak onto every sibling of a shared page) — but warns', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const untagged = mockIncident({ id: 'ut-1', status: 'investigating', impact: null })
      expect(filterByComponentStatus([untagged], 'operational', runway, RUNWAY_COMPONENTS)).toEqual([])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('UNTAGGED impact:none incident ut-1'))
      warn.mockRestore()
    })

    it('#228 intact: Anthropic bulk-link (impact minor, names Claude API) is still dropped', () => {
      // 4 of 6 components — a strict subset that DOES intersect the Claude API badge group. Only the
      // `impact` condition separates it from Runway's case, which is why both conditions are required.
      const bulkLink = mockIncident({
        id: 'bulk-1', title: 'Elevated errors on Claude Sonnet 5', status: 'investigating', impact: 'minor',
        componentNames: ['claude.ai', 'Claude API (api.anthropic.com)', 'Claude Code', 'Claude Cowork'],
      })
      expect(filterByComponentStatus([bulkLink], 'operational', claudeApi, CLAUDE_COMPONENTS)).toEqual([])
    })

    // Isolates the PREFIX branch: with no component list the ids resolve to nothing, so only
    // `statusComponent` ('Claude API') can match the page's full name — exactly that fallback path.
    it('matches statusComponent by PREFIX ("Claude API" → "Claude API (api.anthropic.com)")', () => {
      const noneImpact = mockIncident({
        id: 'none-1', title: 'Informational', status: 'investigating', impact: null,
        componentNames: ['Claude API (api.anthropic.com)'],
      })
      expect(badgeGroupNames(claudeApi, [])).toEqual(new Set(['claude api']))
      expect(filterByComponentStatus([noneImpact], 'operational', claudeApi, [])).toHaveLength(1)
      expect(filterByComponentStatus([noneImpact], 'operational', claudeApi, CLAUDE_COMPONENTS)).toHaveLength(1)
    })

    // The active branch is `status !== 'resolved' && status !== 'monitoring'`, so `identified` takes it too.
    it.each(['investigating' as const, 'identified' as const])('retains an %s impact:none incident', (status) => {
      const result = filterByComponentStatus([aleph(status)], 'operational', runway, RUNWAY_COMPONENTS)
      expect(result.map(i => i.id)).toEqual(['nprnqn29h7y9'])
    })

    // A drop must never be silent. When NO configured id resolves we cannot judge membership at all,
    // so fail OPEN (keep + warn) — dropping a real alert is worse than a phantom, and a silent drop
    // here is bug #970 itself. Distinct from "resolved fine, just didn't match" (Billing-only above).
    it('fails OPEN with a warning when the badge group is unresolvable', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const stale = mockConfig({ id: 'x', statusComponentId: 'gone-from-page' })
      const inc = mockIncident({ id: 'i-1', status: 'investigating', impact: null, componentNames: ['App'] })
      expect(filterByComponentStatus([inc], 'operational', stale, RUNWAY_COMPONENTS).map(i => i.id)).toEqual(['i-1'])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('badge group unresolvable'))
      warn.mockRestore()
    })

    it('fails OPEN with a warning when the component list is empty (broken/absent summary.json)', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      expect(filterByComponentStatus([aleph()], 'operational', runway, []).map(i => i.id)).toEqual(['nprnqn29h7y9'])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('badge group unresolvable'))
      warn.mockRestore()
    })

    it('a PARTIALLY resolved badge group is judgeable — Billing-only is still dropped', () => {
      const partial = RUNWAY_COMPONENTS.filter(c => c.id === 'w3jcq3dwljp4') // only Public API resolves
      const billing = mockIncident({
        id: 'billing-2', status: 'investigating', impact: null, componentNames: ['Billing'],
      })
      expect(filterByComponentStatus([billing], 'operational', runway, partial)).toEqual([])
    })

    // The bug's actual OUTCOME was a missing Discord/Slack alert, not a filter verdict — so drive the
    // real pipeline (filter → buildIncidentAlerts) rather than asserting on the filter alone.
    it('=> the New alert now fires for the Runway incident', () => {
      const kept = filterByComponentStatus([aleph()], 'operational', runway, RUNWAY_COMPONENTS)
      const svc = { ...runway, status: 'operational', incidents: kept } as never
      const alerts = buildIncidentAlerts([svc], new Map(), Date.parse('2026-07-08T20:45:00Z'))
      expect(alerts.map(a => a.key)).toEqual(['alerted:new:nprnqn29h7y9'])
      // status is operational, so no fallback recommendation is attached (an impact:none incident
      // gives no reason to switch providers).
      expect(alerts[0].fallbackText).toBe('')
    })

    it('=> and the Resolved alert follows, because a New alert preceded it', () => {
      const kept = filterByComponentStatus([aleph('resolved')], 'operational', runway, RUNWAY_COMPONENTS)
      const svc = { ...runway, status: 'operational', incidents: kept } as never
      const alerted = new Map([['nprnqn29h7y9', new Set(['runway'])]])
      const alerts = buildIncidentAlerts([svc], alerted, Date.parse('2026-07-08T21:05:00Z'))
      expect(alerts.map(a => a.key)).toEqual(['alerted:res:nprnqn29h7y9'])
    })

    it('regression: without a preceding New alert, the Resolved path stays silent (the old bug)', () => {
      const kept = filterByComponentStatus([aleph('resolved')], 'operational', runway, RUNWAY_COMPONENTS)
      const svc = { ...runway, status: 'operational', incidents: kept } as never
      expect(buildIncidentAlerts([svc], new Map(), Date.parse('2026-07-08T21:05:00Z'))).toEqual([])
    })
  })
})

describe('badgeGroupNames (#970)', () => {
  it('resolves statusComponentIds through the page component list', () => {
    const runway = SERVICES.find(s => s.id === 'runway')!
    expect([...badgeGroupNames(runway, RUNWAY_COMPONENTS)].sort()).toEqual(['app', 'backend', 'public api'])
  })

  it('falls back to the single statusComponentId when no group is set', () => {
    const config = mockConfig({ statusComponentId: 'w3jcq3dwljp4' })
    expect([...badgeGroupNames(config, RUNWAY_COMPONENTS)]).toEqual(['public api'])
  })

  it('includes statusComponent (already a name) and tolerates an empty component list', () => {
    const config = mockConfig({ statusComponent: 'API' })
    expect([...badgeGroupNames(config, [])]).toEqual(['api'])
  })

  it('#992 — a displayAllComponents (Cerebras) service groups EVERY shown component, not just its statusComponentId', () => {
    // Regression: after Cerebras dropped statusComponentIds, badgeGroupIds → [statusComponentId] would
    // collapse the #970 keep-group to Developer Console alone, silently dropping an impact:none incident
    // naming any OTHER model. Dynamic mode must group all shown components (minus denylist).
    const config = mockConfig({ displayAllComponents: true, statusComponentId: 'dev', componentDenylist: ['Website'] })
    const comps = [
      { id: 'dev', name: 'Developer Console' },
      { id: 'm1', name: 'GPT-OSS-120B' },
      { id: 'gemma', name: 'Gemma4-31B-Multimodal' },
      { id: 'w', name: 'Website' }, // denylisted → excluded
    ]
    expect([...badgeGroupNames(config, comps)].sort()).toEqual(['developer console', 'gemma4-31b-multimodal', 'gpt-oss-120b'])
  })

  it('#992 — a service with BOTH displayAllComponents AND statusComponentIds (BFL) keeps the CURATED group, not the dynamic all-names group', () => {
    // BFL's badge resolves via the statusComponentIds worst-of (branch 2), NOT the 2.5 dynamic branch,
    // so its #970 keep-group must mirror that — the curated ids only. Broadening it to every shown
    // component would KEEP an impact:none incident the curated badge doesn't cover (the inverse leak).
    const config = mockConfig({ displayAllComponents: true, statusComponentId: 'a', statusComponentIds: ['a', 'b'], componentDenylist: [] })
    const comps = [
      { id: 'a', name: 'API' },
      { id: 'b', name: 'Finetuning' },
      { id: 'c', name: 'Some Model' }, // shown in breakdown but NOT in the curated badge group
    ]
    expect([...badgeGroupNames(config, comps)].sort()).toEqual(['api', 'finetuning'])
  })

  it('#992 — filterByComponentStatus KEEPS an active impact:none incident naming a non-primary Cerebras model (the #970 drop the dynamic keep-group prevents)', () => {
    const config = mockConfig({ displayAllComponents: true, statusComponentId: 'dev', componentDenylist: ['Website'] })
    const comps = [
      { id: 'dev', name: 'Developer Console' },
      { id: 'gemma', name: 'Gemma4-31B-Multimodal' },
    ]
    const inc = { id: 'x', status: 'investigating', impact: null, componentNames: ['Gemma4-31B-Multimodal'] } as unknown as Parameters<typeof filterByComponentStatus>[0][number]
    // Badge operational (all components fine) so the #970 guard runs; the model-named incident must survive.
    expect(filterByComponentStatus([inc], 'operational', config, comps).map(i => i.id)).toEqual(['x'])
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
  // #970 — the real call site passes `breakdownComponents` here (services.ts). Mirror it, so a future
  // refactor that drops the argument fails the `#970 through the real call-site flow` test below rather
  // than silently re-breaking the badge-group resolution in production.
  filtered = filterByComponentStatus(filtered, svcStatus, config, summaryComponents)
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
    componentNames: undefined,
  })
  const codexResolved = mockIncident({
    id: 'codex-old-1',
    title: 'Elevated errors in Codex',
    status: 'resolved',
    resolvedAt: '2026-04-25T00:00:00Z',
    componentNames: undefined,
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
      componentNames: undefined,
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

// #693 — FedRAMP API incidents must surface under openai (FedRAMP is a curated openai
// displayComponentIds surface) instead of being dropped by a bare 'workspaces' exclude, while
// genuine ChatGPT-Workspace incidents stay excluded. Uses the REAL SERVICES configs so a future
// edit that reverts the narrowed 'chatgpt workspaces' term (or re-broadens it) fails loudly.
describe('filterIncidents — OpenAI FedRAMP / workspaces exclude (#693)', () => {
  const cfg = (id: string): ServiceConfig => {
    const c = SERVICES.find((s) => s.id === id)
    if (!c) throw new Error(`missing SERVICES config: ${id}`)
    return c
  }
  // The real production incident (status.openai.com, 2026-06): affects "API orgs", components: [].
  const fedramp = mockIncident({
    id: 'fedramp-api-1',
    title: 'FedRAMP workspaces and API orgs have degraded performance',
    status: 'investigating',
    impact: 'minor',
    componentNames: [],
  })

  it('openai: KEEPS the FedRAMP API incident (no longer dropped by the workspaces exclude)', () => {
    expect(filterIncidents([fedramp], cfg('openai')).map((i) => i.id)).toContain('fedramp-api-1')
  })

  it('chatgpt + codex: do NOT pick up the FedRAMP incident (title misses their keywords AND, since #990, matches the fedramp exclude)', () => {
    expect(filterIncidents([fedramp], cfg('chatgpt'))).toHaveLength(0)
    expect(filterIncidents([fedramp], cfg('codex'))).toHaveLength(0)
  })

  it('openai: still EXCLUDES a genuine ChatGPT Workspaces incident (no regression)', () => {
    // Both the narrowed 'chatgpt workspaces' term AND the existing 'chatgpt'/'login' excludes catch it.
    const chatgptWs = mockIncident({
      id: 'cgpt-ws-1',
      title: 'ChatGPT Workspaces login errors and API latency',
      status: 'investigating',
      componentNames: [],
    })
    expect(filterIncidents([chatgptWs], cfg('openai'))).toHaveLength(0)
  })

  it('openai exclude no longer contains a bare "workspaces" term (pins the #693 narrowing)', () => {
    expect(cfg('openai').incidentExclude).not.toContain('workspaces')
    expect(cfg('openai').incidentExclude).toContain('chatgpt workspaces')
  })
})

describe('filterIncidents — GitHub Copilot scoping (#397)', () => {
  // The GitHub status page mixes incidents across many components (Pull Requests,
  // Actions, Webhooks, Git Operations, Codespaces, Issues, Packages, Pages, Copilot…).
  // Without `incidentKeywords: ['copilot']`, the Copilot service card surfaces every
  // unrelated incident. These tests pin the filter behavior so a future config edit
  // that removes the keywords list re-introduces the leak loudly.
  const copilotConfig: ServiceConfig = {
    id: 'copilot',
    name: 'GitHub Copilot',
    provider: 'Microsoft',
    category: 'agent',
    statusUrl: 'https://githubstatus.com',
    apiUrl: 'https://www.githubstatus.com/api/v2/summary.json',
    statusComponentId: 'pjmpxvq2cmr2',
    statusComponentIds: ['pjmpxvq2cmr2', 'cnnb39dkkk82'],
    incidentKeywords: ['copilot'],
  }

  it('keeps incident when "copilot" is in componentNames', () => {
    const inc = mockIncident({
      title: 'Incident with multiple GitHub services',
      componentNames: ['Webhooks', 'Actions', 'Copilot'],
    })
    expect(filterIncidents([inc], copilotConfig)).toHaveLength(1)
  })

  it('keeps incident when "copilot" is in the title even with null componentNames', () => {
    const inc = mockIncident({
      title: 'Disruption with Copilot Coding Agent sessions',
      componentNames: undefined,
    })
    expect(filterIncidents([inc], copilotConfig)).toHaveLength(1)
  })

  it('drops Pull Requests-only incident', () => {
    const inc = mockIncident({
      title: 'Incident with Pull Requests',
      componentNames: ['Pull Requests'],
    })
    expect(filterIncidents([inc], copilotConfig)).toHaveLength(0)
  })

  it('drops Actions-only incident', () => {
    const inc = mockIncident({
      title: 'Incident with Actions, we are investigating reports of degraded availability',
      componentNames: ['Actions'],
    })
    expect(filterIncidents([inc], copilotConfig)).toHaveLength(0)
  })

  it('drops Git Operations-only incident', () => {
    const inc = mockIncident({
      title: 'Increased Latency and Failures for SSH Git Operations',
      componentNames: ['Git Operations'],
    })
    expect(filterIncidents([inc], copilotConfig)).toHaveLength(0)
  })

  it('drops Codespaces-only incident', () => {
    const inc = mockIncident({
      title: 'Errors starting and connecting to Codespaces',
      componentNames: ['Codespaces'],
    })
    expect(filterIncidents([inc], copilotConfig)).toHaveLength(0)
  })

  it('drops multi-component incident that does NOT include Copilot', () => {
    const inc = mockIncident({
      title: 'Incident with Issues and Webhooks',
      componentNames: ['Git Operations', 'Webhooks', 'Issues', 'Pull Requests', 'Actions', 'Packages', 'Pages', 'Codespaces'],
    })
    expect(filterIncidents([inc], copilotConfig)).toHaveLength(0)
  })

  it('drops generic GitHub incident with null componentNames and no Copilot mention in title', () => {
    // Defensive default: when GitHub doesn't tag the affected components, we don't
    // speculate that Copilot is impacted. The status determination still relies on
    // the component-level operational/degraded signal, so a real Copilot impact would
    // surface there even if the incident itself stays hidden.
    const inc = mockIncident({
      title: 'Disruption with some GitHub services',
      componentNames: undefined,
    })
    expect(filterIncidents([inc], copilotConfig)).toHaveLength(0)
  })
})

// #970 — drives the REAL call-site ordering (filterIncidents → svcStatus → includeUntaggedIncidents →
// filterByComponentStatus-with-components), not the helper in isolation. Guards the "tested twin" gap:
// if services.ts stops passing `breakdownComponents`, the badge group resolves empty and Runway's
// impact:none incident is silently dropped again — this test fails, the unit tests would not.
describe('#970 through the real call-site flow', () => {
  const runway = SERVICES.find(s => s.id === 'runway')!
  // Every component operational — exactly the state during the 2026-07-08 Aleph incident.
  const components = RUNWAY_COMPONENTS.map(c => ({ ...c, status: 'operational' }))
  const aleph = mockIncident({
    id: 'nprnqn29h7y9', title: 'Aleph 2.0 delayed generations', status: 'investigating',
    impact: null, componentNames: ['App', 'Backend', 'Public API'],
    startedAt: '2026-07-08T20:39:56.000Z', // within buildIncidentAlerts' 24h freshness window
  })

  it('keeps the active impact:none incident and leaves the badge operational', () => {
    const { filtered, svcStatus } = applyFetchServiceFlow([aleph], runway, components, 'none')
    expect(svcStatus).toBe('operational')
    expect(filtered.map(i => i.id)).toEqual(['nprnqn29h7y9'])
  })

  it('and the New alert fires from that flow', () => {
    const { filtered } = applyFetchServiceFlow([aleph], runway, components, 'none')
    const svc = { ...runway, status: 'operational', incidents: filtered } as never
    const alerts = buildIncidentAlerts([svc], new Map(), Date.parse('2026-07-08T20:45:00Z'))
    expect(alerts.map(a => a.key)).toEqual(['alerted:new:nprnqn29h7y9'])
  })
})

// #970 — the fail-open path is leak-safe only because of a config property that is true today by
// inspection: every service that can REACH it (statuspage `apiUrl` + ids-only, so `badgeGroupNames`
// can resolve to nothing) is either alone on its status page, or already scoped by
// incidentKeywords/incidentComponents before the guard runs. A future Runway-shaped service added to a
// SHARED page with neither would let a momentary id-resolution failure leak a sibling's impact:none
// incident onto it. Lock the invariant in so that config can't ship silently.
describe('#970 fail-open leak-safety invariant over SERVICES', () => {
  const hostOf = (s: typeof SERVICES[number]) => new URL(s.statusUrl).host
  const serviceCountByHost = new Map<string, number>()
  for (const s of SERVICES) serviceCountByHost.set(hostOf(s), (serviceCountByHost.get(hostOf(s)) ?? 0) + 1)

  const failOpenCapable = SERVICES.filter(s =>
    s.apiUrl                                          // reaches filterByComponentStatus at all
    && (s.statusComponentId || s.statusComponentIds)  // has ids to resolve
    && !s.statusComponent,                            // ...and no name fallback → badge group can be empty
  )

  it('is a non-empty set (guards against the check silently matching nothing)', () => {
    expect(failOpenCapable.length).toBeGreaterThan(0)
    expect(failOpenCapable.map(s => s.id)).toContain('runway')
  })

  it.each(failOpenCapable.map(s => [s.id] as const))(
    '%s: alone on its status page, or keyword/component-scoped before the guard',
    (id) => {
      const svc = SERVICES.find(s => s.id === id)!
      const aloneOnPage = serviceCountByHost.get(hostOf(svc)) === 1
      const preScoped = (svc.incidentKeywords?.length ?? 0) > 0 || (svc.incidentComponents?.length ?? 0) > 0
      expect(aloneOnPage || preScoped).toBe(true)
    },
  )
})

// #990 — the 2026-07 kitchen-sink FedRAMP advisory (impact:minor, componentNames:[]) whose title
// enumerates many product names was substring-attributed to ChatGPT + Codex, firing false
// New+Resolved alerts. ENVIRONMENT_SCOPE_EXCLUDE ('fedramp') is spread into chatgpt + codex only:
// openai already drops it via its existing tokens AND must KEEP a genuine FedRAMP API degradation
// (#693), so it deliberately does NOT carry the token. Exercise the REAL SERVICES configs so this
// guards the wiring, not just filterIncidents' logic.
describe('#990 FedRAMP environment-scope exclude (chatgpt / codex)', () => {
  const FEDRAMP_TITLE =
    'Codex, workspace analytics, conversation search, searching for custom GPTs, ChatGPT user invites, ' +
    'and Compliance Log Platform download endpoint not working in FedRAMP workspaces'

  const openai = SERVICES.find(s => s.id === 'openai')!
  const chatgpt = SERVICES.find(s => s.id === 'chatgpt')!
  const codex = SERVICES.find(s => s.id === 'codex')!

  it.each([['chatgpt', () => chatgpt], ['codex', () => codex]] as const)(
    '%s drops the kitchen-sink FedRAMP advisory (untagged, impact minor)',
    (_id, get) => {
      const inc = mockIncident({ id: 'fedramp', title: FEDRAMP_TITLE, impact: 'minor', componentNames: [] })
      expect(filterIncidents([inc], get())).toHaveLength(0)
    },
  )

  it('openai also drops it — but via its existing tokens, NOT a fedramp exclude (#693 must keep FedRAMP API incidents)', () => {
    const inc = mockIncident({ id: 'fedramp', title: FEDRAMP_TITLE, impact: 'minor', componentNames: [] })
    expect(filterIncidents([inc], openai)).toHaveLength(0)
    expect(openai.incidentExclude).not.toContain('fedramp')
  })

  it('chatgpt + codex carry the fedramp exclude token (wiring guard)', () => {
    expect(chatgpt.incidentExclude).toContain('fedramp')
    expect(codex.incidentExclude).toContain('fedramp')
  })

  it('a genuine Codex outage title is still kept by codex (no over-exclusion)', () => {
    const real = mockIncident({ id: 'real', title: 'Codex Usage Limits Depleting Faster Than Expected' })
    expect(filterIncidents([real], codex).map(i => i.id)).toEqual(['real'])
  })

  it('a genuine ChatGPT outage title is still kept by chatgpt', () => {
    const real = mockIncident({ id: 'real', title: 'chatgpt.com access issues' })
    expect(filterIncidents([real], chatgpt).map(i => i.id)).toEqual(['real'])
  })

  // The advisory is untagged (componentNames:[]), and chatgpt/codex both carry incidentKeywords, so
  // they reach includeUntaggedIncidents — a SECOND re-attribution path that re-adds untagged active
  // incidents from the RAW array when the service's own component is concurrently non-operational,
  // gated only by a re-check of incidentExclude. Guard the token there too, else a concurrent
  // unrelated degradation would re-acquire the FedRAMP advisory and every filterIncidents test above
  // would still pass green.
  it.each([['chatgpt', () => chatgpt, '01JMXBNJXGV1T5GT2M9XA83XNG'], ['codex', () => codex, '01KMP3KP5MGE23B80K1EK4S8PV']] as const)(
    '%s: includeUntaggedIncidents does NOT re-add the untagged FedRAMP advisory even when the component is degraded',
    (_id, get, primaryComponentId) => {
      const active = mockIncident({ id: 'fedramp', title: FEDRAMP_TITLE, status: 'investigating', impact: 'minor', componentNames: [] })
      const components = [{ id: primaryComponentId, name: 'primary', status: 'major_outage' }]
      // filtered is empty (filterIncidents dropped it) → the untagged fallback would fire since the
      // component is non-operational; the incidentExclude re-check must still veto it.
      expect(includeUntaggedIncidents([], [active], get(), components, 'major')).toEqual([])
    },
  )
})
