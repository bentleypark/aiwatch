import { describe, it, expect } from 'vitest'
import { atlassianRosterAuditServices } from '../services'
import type { ServiceConfig } from '../types'

describe('atlassianRosterAuditServices (#1518 — the Atlassian-branch equivalent of rosterAuditPages)', () => {
  it('matches exactly the real multi-id Atlassian services, none of the incident.io ones', () => {
    const ids = atlassianRosterAuditServices().map((s) => s.id).sort()
    expect(ids).toEqual(['bfl', 'copilot', 'cursor', 'runway', 'windsurf'])
  })

  it('excludes a service with a single-id statusComponentIds list', () => {
    const configs: ServiceConfig[] = [
      { id: 'single', name: 'S', provider: 'X', category: 'api', statusUrl: 'https://x.example', apiUrl: null, statusComponentIds: ['a'] },
    ]
    expect(atlassianRosterAuditServices(configs)).toEqual([])
  })

  it('excludes a multi-id service that ALSO sets incidentIoComponentId — that one goes through the incident.io branch instead', () => {
    const configs: ServiceConfig[] = [
      { id: 'both', name: 'B', provider: 'X', category: 'api', statusUrl: 'https://x.example', apiUrl: null, statusComponentIds: ['a', 'b'], incidentIoComponentId: 'c' },
    ]
    expect(atlassianRosterAuditServices(configs)).toEqual([])
  })

  it('includes a multi-id service with no incidentIoComponentId', () => {
    const configs: ServiceConfig[] = [
      { id: 'multi', name: 'M', provider: 'X', category: 'api', statusUrl: 'https://x.example', apiUrl: null, statusComponentIds: ['a', 'b'] },
    ]
    expect(atlassianRosterAuditServices(configs).map((s) => s.id)).toEqual(['multi'])
  })

  it('bfl is the only one configured rosterAuditFixedScope; the other 4 are not', () => {
    const services = atlassianRosterAuditServices()
    const fixed = services.filter((s) => s.rosterAuditFixedScope).map((s) => s.id)
    expect(fixed).toEqual(['bfl'])
  })
})
