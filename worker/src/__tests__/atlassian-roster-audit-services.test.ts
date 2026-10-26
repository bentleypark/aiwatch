import { describe, it, expect } from 'vitest'
import { atlassianRosterAuditServices, uptimeScopeOf, SERVICES } from '../services'
import { rosterAgedInFindings } from '../roster-audit'
import { atlassianRosterEntries } from '../parsers/statuspage'
import type { ServiceConfig } from '../types'

describe('atlassianRosterAuditServices (#1518 — the Atlassian-branch equivalent of rosterAuditPages)', () => {
  it('matches exactly the real multi-id Atlassian services, none of the incident.io ones', () => {
    const ids = atlassianRosterAuditServices().map((s) => s.id).sort()
    expect(ids).toEqual(['bfl', 'claudeai', 'copilot', 'cursor', 'jina', 'kimiapp', 'runway', 'windsurf'])
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

  // #1741 — status.bfl.ml components.json as served 2026-10-25, every component.
  const BFL_PAGE = [
    { id: 'lzj5bpsmhwt6', name: 'FLUX 1.1 [pro]', created_at: '2024-10-07T19:54:52.676Z', group_id: 'm991l9z7y6jj' },
    { id: 'ygnttdvrl2pj', name: 'Flux.3', created_at: '2026-09-28T11:58:06.151Z', group_id: 'x16d9nh49hch' },
    { id: '70p23r3xs7b0', name: 'FLUX.1 [pro]', created_at: '2024-10-07T23:33:59.086Z', group_id: 'm991l9z7y6jj' },
    { id: 'h4v0br1sctqx', name: 'FLUX.1 [dev]', created_at: '2024-10-07T23:34:26.058Z', group_id: 'm991l9z7y6jj' },
    { id: 'm991l9z7y6jj', name: 'Image Generation Services', created_at: '2024-10-07T23:33:19.918Z', group_id: null },
    { id: 'ppxtlh70k466', name: 'FLUX 1.1 [pro] Ultra', created_at: '2025-02-05T22:48:18.818Z', group_id: 'm991l9z7y6jj' },
    { id: '8jg9v8zhstys', name: 'Finetuning', created_at: '2025-01-17T18:24:11.561Z', group_id: null },
    { id: 'thvty5dzd95w', name: 'FLUX.1 Fill [pro]', created_at: '2025-02-05T22:49:40.002Z', group_id: 'm991l9z7y6jj' },
    { id: 'qcvzszkj9m47', name: 'FLUX.1 Canny [pro]', created_at: '2025-02-05T22:50:08.202Z', group_id: 'm991l9z7y6jj' },
    { id: 'ws9rrzk6n2j7', name: 'API (api.bfl.ai)', created_at: '2026-04-22T14:05:41.303Z', group_id: null },
    { id: 'l27p2yhv77bj', name: 'FLUX.1 Depth [pro]', created_at: '2025-02-05T22:50:57.261Z', group_id: 'm991l9z7y6jj' },
    { id: 'x16d9nh49hch', name: 'Video Generation Services', created_at: '2026-09-28T11:58:06.107Z', group_id: null },
    { id: '6yncdw0dwc1s', name: 'FLUX .1 Kontext [pro]', created_at: '2025-05-29T20:18:08.536Z', group_id: 'm991l9z7y6jj' },
    { id: 'cw5sckn8002d', name: 'API EU (api.eu.bfl.ai)', created_at: '2026-09-28T11:58:59.729Z', group_id: null },
    { id: 'bvfp4p0szk5y', name: 'FLUX.1 Kontext [max]', created_at: '2025-06-02T17:36:00.742Z', group_id: 'm991l9z7y6jj' },
    { id: 'wb9xb021290k', name: 'API US (api.us.bfl.ai)', created_at: '2026-09-28T11:59:21.941Z', group_id: null },
    { id: 'k1f1dgrqqc9g', name: 'FLUX.2', created_at: '2026-03-25T13:39:02.312Z', group_id: 'm991l9z7y6jj' },
    { id: '67vphhw599hb', name: 'FLUX.2 [klein]', created_at: '2026-03-25T13:39:30.851Z', group_id: 'm991l9z7y6jj' },
  ]
  // Past 30 days for the 2026-09-28 additions, so they are aged in.
  const BFL_AGED = Date.parse('2026-11-01T00:00:00Z')

  it('#1741 bfl: every badge id is on the live page under the expected name', () => {
    const bfl = SERVICES.find((s) => s.id === 'bfl')!
    const names = new Map(BFL_PAGE.map((c) => [c.id, c.name]))
    expect(bfl.statusComponentIds!.map((id) => names.get(id))).toEqual([
      'API (api.bfl.ai)', 'Image Generation Services', 'Video Generation Services', 'API EU (api.eu.bfl.ai)', 'API US (api.us.bfl.ai)', 'Finetuning',
    ])
  })

  it('#1741 bfl: the live page yields no aged-in finding under the real config', () => {
    const bfl = SERVICES.find((s) => s.id === 'bfl')!
    const findings = rosterAgedInFindings(atlassianRosterEntries(BFL_PAGE), uptimeScopeOf(bfl), bfl.rosterAuditExclude ?? [], bfl.rosterAuditFixedScope ?? false, BFL_AGED)
    expect(findings).toEqual([])
  })

  it('#1741 bfl: the pre-#1741 scope reports every untracked top-level component, never a FLUX model', () => {
    const findings = rosterAgedInFindings(atlassianRosterEntries(BFL_PAGE), ['ws9rrzk6n2j7', 'm991l9z7y6jj'], [], true, BFL_AGED)
    expect(findings.sort()).toEqual(['8jg9v8zhstys', 'cw5sckn8002d', 'wb9xb021290k', 'x16d9nh49hch'])
  })
})
