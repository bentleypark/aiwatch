// #601 — pin the LLM-observability sibling configs (Helicone + Langfuse) added so LangSmith is no
// longer a single-service category. A wrong source URL / component id would silently break incident
// or uptime matching with no runtime signal, so pin the load-bearing fields (verified 2026-06-23).

import { describe, it, expect } from 'vitest'
import { SERVICES } from '../services'
import { API_TIER, EXCLUDE_FALLBACK, TIER_LABEL } from '../fallback'

describe('#601 observability sibling configs (Helicone + Langfuse)', () => {
  it('Helicone is a Better Stack service (official uptime source)', () => {
    const s = SERVICES.find((x) => x.id === 'helicone')
    expect(s, 'helicone missing from SERVICES').toBeDefined()
    expect(s!.name).toBe('Helicone')
    expect(s!.betterStackUrl).toBe('https://status.helicone.ai')
    expect(s!.category).toBe('api')
  })

  it('Langfuse is an incident.io service with a scoped component', () => {
    const s = SERVICES.find((x) => x.id === 'langfuse')
    expect(s, 'langfuse missing from SERVICES').toBeDefined()
    expect(s!.name).toBe('Langfuse')
    expect(s!.apiUrl).toBe('https://status.langfuse.com/api/v2/summary.json')
    expect(s!.incidentIoBaseUrl).toBe('https://status.langfuse.com/incidents')
    expect(s!.statusComponentId).toBeTruthy()
  })

  it('all three observability services share fallback tier 6 (Observability) and none are excluded', () => {
    for (const id of ['langsmith', 'helicone', 'langfuse']) {
      expect(API_TIER[id], `${id} tier`).toBe(6)
      expect(EXCLUDE_FALLBACK.includes(id), `${id} must NOT be in EXCLUDE_FALLBACK`).toBe(false)
    }
    expect(TIER_LABEL[6]).toBe('Observability')
  })
})
