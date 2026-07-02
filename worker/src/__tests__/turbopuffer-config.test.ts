// #857 — pin the turbopuffer service config. turbopuffer is a serverless vector-search DB added as the
// Vector fallback sibling for Pinecone (un-blocks the vector sub-tier, #601). Its status page is a
// region-only Atlassian Statuspage with NO functional "API" component and NO showcase uptime, so several
// load-bearing fields are intentionally ABSENT — a regression that silently ADDS them (or drops addedAt)
// has no other runtime signal. Mirrors fal-config.test.ts (#758) / image-services-config.test.ts (#756).

import { describe, it, expect } from 'vitest'
import { SERVICES, SERVICE_ADDED_AT } from '../services'
import { EXCLUDE_FALLBACK, API_TIER, TIER_LABEL, getFallbacks, tierLabelFor } from '../fallback'
import { PROBE_TARGETS } from '../probe'

describe('#857 turbopuffer vector service config', () => {
  it('turbopuffer is an Atlassian Statuspage service with the overall-indicator badge (no statusComponentId)', () => {
    const s = SERVICES.find((x) => x.id === 'turbopuffer')
    expect(s, 'turbopuffer missing from SERVICES').toBeDefined()
    expect(s!.name).toBe('turbopuffer')
    expect(s!.provider).toBe('turbopuffer')
    expect(s!.category).toBe('api')
    expect(s!.statusUrl).toBe('https://status.turbopuffer.com')
    expect(s!.apiUrl).toBe('https://status.turbopuffer.com/api/v2/summary.json')
    // The page's only components are per-region endpoints, so the badge rides the overall page indicator
    // (status-determination step 4) and no uptime is parsed. These MUST stay absent — adding a
    // statusComponentId would silently point the badge/calendar at a single region.
    expect(s!.statusComponentId, 'turbopuffer must have no statusComponentId (region-only page)').toBeUndefined()
    expect(s!.statusComponentIds).toBeUndefined()
    expect(s!.displayComponentIds, 'no per-component breakdown for v1 (regions belong on a Region card)').toBeUndefined()
  })

  it('turbopuffer carries addedAt so the #802 coverage gate holds it out of the ranking for 30 days', () => {
    // Dropping addedAt would let turbopuffer rank immediately on a thin observed window.
    const s = SERVICES.find((x) => x.id === 'turbopuffer')!
    expect(s.addedAt).toBe('2026-07-01')
    expect(SERVICE_ADDED_AT['turbopuffer']).toBe('2026-07-01')
  })

  it('turbopuffer is probed (its sole substantial measured signal — no official uptime)', () => {
    const t = PROBE_TARGETS.find((x) => x.id === 'turbopuffer')
    expect(t, 'turbopuffer probe target missing').toBeDefined()
    expect(t!.url).toBe('https://api.turbopuffer.com')
  })

  it('#857 — pinecone + turbopuffer form the Tier 8 "Vector" fallback pair (both un-excluded)', () => {
    expect(EXCLUDE_FALLBACK.includes('turbopuffer'), 'turbopuffer must NOT be excluded').toBe(false)
    expect(EXCLUDE_FALLBACK.includes('pinecone'), 'pinecone must be un-excluded (#857)').toBe(false)
    expect(API_TIER['turbopuffer']).toBe(8)
    expect(API_TIER['pinecone']).toBe(8)
    expect(TIER_LABEL[8]).toBe('Vector')
    expect(tierLabelFor(8)).toBe('Vector')
  })

  it('a down vector DB recommends its vector sibling even with a null (withheld) score', () => {
    // turbopuffer has no official uptime → its score can be null during the confidence ramp; it must
    // still be recommendable (getFallbacks filters on status/incident, not score).
    const services = [
      { id: 'pinecone', name: 'Pinecone', category: 'api', status: 'down', aiwatchScore: 40 },
      { id: 'turbopuffer', name: 'turbopuffer', category: 'api', status: 'operational', aiwatchScore: null },
      { id: 'claude', name: 'Claude API', category: 'api', status: 'operational', aiwatchScore: 95 },
    ]
    expect(getFallbacks('pinecone', 'api', services)[0].name).toBe('turbopuffer')
    expect(getFallbacks('turbopuffer', 'api', services.map(s => s.id === 'turbopuffer' ? { ...s, status: 'down' } : s.id === 'pinecone' ? { ...s, status: 'operational' } : s))[0].name).toBe('Pinecone')
  })
})
