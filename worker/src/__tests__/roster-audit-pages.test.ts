import { describe, it, expect } from 'vitest'
import { rosterAuditPages, incidentIoUptimeScopeOf } from '../services'
import { rosterAgedInFindings } from '../roster-audit'
import type { ServiceConfig } from '../types'

describe('incidentIoUptimeScopeOf (#1518 — the same expression fetchService computes uptime over)', () => {
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
  it('puts aged Fireworks GLM models in the uptime scope (#1561)', () => {
    const fireworks = rosterAuditPages().find((page) => page.statusUrl === 'https://status.fireworks.ai')!
    const ids = ['01M1DFY7G1ZJQNNZWX0Y0APVX6', '01M1DFY7G1JXWQQQ852G0PAQCP']

    expect(fireworks.scopeIds).toEqual(expect.arrayContaining(ids))
    expect(rosterAgedInFindings(
      ids.map((id) => ({ id, dataAvailableSince: '2026-09-01T03:24:23Z' })),
      fireworks.scopeIds,
      fireworks.excludeIds,
      fireworks.fixedScope,
      Date.parse('2026-10-02T00:00:00Z'),
    )).toEqual([])
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
