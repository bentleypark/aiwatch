import { describe, it, expect } from 'vitest'
import { rosterAuditPages, incidentIoUptimeScopeOf } from '../services'
import type { ServiceConfig } from '../types'

describe('incidentIoUptimeScopeOf (#1518)', () => {
  it('prefers statusComponentIds over incidentIoComponentId when both are set', () => {
    expect(incidentIoUptimeScopeOf({ statusComponentIds: ['A', 'B'], incidentIoComponentId: 'C' })).toEqual(['A', 'B'])
  })

  it('falls back to incidentIoComponentId, normalizing a single string to a one-element array', () => {
    expect(incidentIoUptimeScopeOf({ incidentIoComponentId: 'C' })).toEqual(['C'])
  })

  it('passes a list incidentIoComponentId through unchanged', () => {
    expect(incidentIoUptimeScopeOf({ incidentIoComponentId: ['C', 'D'] })).toEqual(['C', 'D'])
  })

  it('empty when neither field is set', () => {
    expect(incidentIoUptimeScopeOf({})).toEqual([])
  })
})

describe('rosterAuditPages (#1518 — grouping by shared status page)', () => {
  it('skips the aged-in check for Fireworks, whose uptime scope is the whole page (#1709)', () => {
    const fireworks = rosterAuditPages().find((page) => page.statusUrl === 'https://status.fireworks.ai')!

    expect(fireworks.fixedScope).toBe(true)
  })

  it('treats any page-wide uptime scope as fixed, without a second flag (#1709)', () => {
    const cfg = { id: 'x', name: 'X', provider: 'X', category: 'api', statusUrl: 'https://status.x.example', apiUrl: 'https://status.x.example/api/v2/summary.json', incidentIoComponentId: 'ANCHOR', uptimeOverPageComponents: true } as ServiceConfig

    expect(rosterAuditPages([cfg])[0].fixedScope).toBe(true)
  })

  it('groups the real openai/chatgpt/codex config onto one page with the union of their scopes', () => {
    const page = rosterAuditPages().find((p) => p.statusUrl === 'https://status.openai.com')
    expect(page).toBeDefined()
    expect(page!.services.map((s) => s.id).sort()).toEqual(['chatgpt', 'codex', 'openai'])
    // Each service's own scope survives the union (spot-check one id per service).
    expect(page!.scopeIds).toContain('01JMXBRMFE6N2NNT7DG6XZQ6PW') // openai primary
    expect(page!.scopeIds).toContain('01JMXBNJXGV1T5GT2M9XA83XNG') // chatgpt primary
    expect(page!.scopeIds).toContain('01KMP3KP5MGE23B80K1EK4S8PV') // codex primary
    // The exclusion configured on 'openai' applies to the whole page, not just that one service.
    expect(page!.excludeIds).toEqual(expect.arrayContaining(['01KKAD7C71MCCH3FTREMJH4AAS']))
  })

  it('junie is alone on its page, with its own scope and exclude list', () => {
    const page = rosterAuditPages().find((p) => p.statusUrl === 'https://status.jetbrains.cloud')
    expect(page).toBeDefined()
    expect(page!.services).toEqual([{ id: 'junie', name: 'Junie' }])
    expect(page!.scopeIds).toEqual(['01KX3EN535A0SKSZK3S84949V1'])
    expect(page!.excludeIds.length).toBe(9)
  })

  it('turbopuffer excludes its own Dashboard component — the config comment above it names the same id', () => {
    const page = rosterAuditPages().find((p) => p.statusUrl === 'https://status.turbopuffer.com')
    expect(page).toBeDefined()
    expect(page!.excludeIds).toEqual(['01K0Q5QSJV9KAZMEMMQ0NCHD9E'])
  })

  it('a service with no incidentIoComponentId contributes no page at all', () => {
    const configs: ServiceConfig[] = [
      { id: 'no-io', name: 'No IO', provider: 'X', category: 'api', statusUrl: 'https://x.example', apiUrl: null },
    ]
    expect(rosterAuditPages(configs)).toEqual([])
  })

  it('two synthetic services sharing one statusUrl union their scope AND exclude ids', () => {
    const configs: ServiceConfig[] = [
      { id: 'svc-a', name: 'A', provider: 'X', category: 'api', statusUrl: 'https://shared.example', apiUrl: null, incidentIoComponentId: ['id-1'], rosterAuditExclude: ['id-x'] },
      { id: 'svc-b', name: 'B', provider: 'X', category: 'api', statusUrl: 'https://shared.example', apiUrl: null, incidentIoComponentId: ['id-2'] },
    ]
    const [page] = rosterAuditPages(configs)
    expect(page.services.map((s) => s.id).sort()).toEqual(['svc-a', 'svc-b'])
    expect(page.scopeIds.sort()).toEqual(['id-1', 'id-2'])
    expect(page.excludeIds).toEqual(['id-x'])
  })

  it('fixedScope defaults to false when no co-located service sets rosterAuditFixedScope', () => {
    const [page] = rosterAuditPages([
      { id: 'svc-a', name: 'A', provider: 'X', category: 'api', statusUrl: 'https://x.example', apiUrl: null, incidentIoComponentId: ['id-1'] },
    ])
    expect(page.fixedScope).toBe(false)
  })

  it('fixedScope is true when set on the service (a structurally unbounded per-model catalog)', () => {
    const [page] = rosterAuditPages([
      { id: 'svc-a', name: 'A', provider: 'X', category: 'api', statusUrl: 'https://x.example', apiUrl: null, incidentIoComponentId: 'id-1', rosterAuditFixedScope: true },
    ])
    expect(page.fixedScope).toBe(true)
  })

  it('fixedScope is true for the page if ANY co-located service sets it, even if another does not', () => {
    const [page] = rosterAuditPages([
      { id: 'svc-a', name: 'A', provider: 'X', category: 'api', statusUrl: 'https://shared.example', apiUrl: null, incidentIoComponentId: 'id-1', rosterAuditFixedScope: true },
      { id: 'svc-b', name: 'B', provider: 'X', category: 'api', statusUrl: 'https://shared.example', apiUrl: null, incidentIoComponentId: 'id-2' },
    ])
    expect(page.fixedScope).toBe(true)
  })

  it('cohere and groq are configured fixedScope, each alone on its own page', () => {
    for (const [statusUrl, id] of [['https://status.cohere.com', 'cohere'], ['https://groqstatus.com', 'groq']] as const) {
      const page = rosterAuditPages().find((p) => p.statusUrl === statusUrl)
      expect(page).toBeDefined()
      expect(page!.services.map((s) => s.id)).toEqual([id])
      expect(page!.fixedScope).toBe(true)
    }
  })
})
