import { describe, it, expect } from 'vitest'
import { atlassianRosterAuditServices, uptimeScopeOf, SERVICES } from '../services'
import { rosterAgedInFindings } from '../roster-audit'
import { atlassianRosterEntries } from '../parsers/statuspage'
import type { ServiceConfig } from '../types'

describe('atlassianRosterAuditServices (#1518 — the Atlassian-branch equivalent of rosterAuditPages)', () => {
  it('matches exactly the real multi-id Atlassian services, none of the incident.io ones', () => {
    const ids = atlassianRosterAuditServices().map((s) => s.id).sort()
    expect(ids).toEqual(['bfl', 'claudeai', 'copilot', 'cursor', 'runway', 'windsurf'])
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

  it('bfl is the only one configured rosterAuditFixedScope; the others are not', () => {
    const services = atlassianRosterAuditServices()
    const fixed = services.filter((s) => s.rosterAuditFixedScope).map((s) => s.id)
    expect(fixed).toEqual(['bfl'])
  })

  it('no two of them share a statusUrl — the cron keys its seen-set on statusUrl alone', () => {
    const urls = atlassianRosterAuditServices().map((s) => s.statusUrl)
    expect(new Set(urls).size).toBe(urls.length)
  })

  it('claudeai: every component on status.claude.com (live 2026-10-05) is in scope or excluded — no aged-in finding', () => {
    const claudeai = SERVICES.find((s) => s.id === 'claudeai')!
    const page = [
      { id: 'rwppv331jlwc', created_at: '2023-07-11T00:00:00Z' }, // claude.ai
      { id: '0qbwn08sd68x', created_at: '2023-07-11T00:00:00Z' }, // Claude Console
      { id: 'k8w3r06qmzrp', created_at: '2023-07-11T00:00:00Z' }, // Claude API
      { id: 'yyzkbfz2thpt', created_at: '2025-05-22T00:00:00Z' }, // Claude Code
      { id: 'bpp5gb3hpjcl', created_at: '2026-04-01T00:00:00Z' }, // Claude Cowork
      { id: '0scnb50nvy53', created_at: '2026-02-17T00:00:00Z' }, // Claude for Government
    ]
    const findings = rosterAgedInFindings(atlassianRosterEntries(page), uptimeScopeOf(claudeai), claudeai.rosterAuditExclude ?? [], false, Date.parse('2026-10-05T00:00:00Z'))
    expect(findings).toEqual([])
  })
})
