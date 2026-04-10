import { describe, it, expect } from 'vitest'
import { filterIncidents, includeUntaggedIncidents } from '../services'
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
