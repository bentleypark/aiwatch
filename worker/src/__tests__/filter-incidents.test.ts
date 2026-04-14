import { describe, it, expect } from 'vitest'
import { filterIncidents, includeUntaggedIncidents, filterByComponentStatus } from '../services'
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
