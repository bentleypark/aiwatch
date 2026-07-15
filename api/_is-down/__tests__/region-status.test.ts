import { describe, test, expect } from 'vitest'
import { regionStatusOf } from '../region-status'

// Behavioral pin for the TS mirror of regionStatusOf. The SPA copy
// (src/utils/regionStatus.js) is tested in src/utils/__tests__/regionStatus.test.js;
// this file pins the EDGE/Worker mirror's `ongoing`-filter semantics, which the data-only
// region-status-sync.test.ts does NOT cover. This mirror also backs the Worker Discord
// region hint (buildRegionHint → alerts.ts), so its filter must behave identically (#693).

describe('region-status.ts mirror — FedRAMP exclusion (#693)', () => {
  test('openai with ONLY a FedRAMP incident → null (no card, not all-regions-down)', () => {
    const result = regionStatusOf({
      id: 'openai',
      status: 'degraded',
      incidents: [
        {
          id: 'fr1',
          status: 'investigating',
          title: 'FedRAMP workspaces and API orgs have degraded performance',
        },
      ],
    })
    expect(result).toBeNull()
  })

  test('a separate real us-east-1 incident still marks only that region (FedRAMP ignored)', () => {
    const result = regionStatusOf({
      id: 'openai',
      status: 'degraded',
      incidents: [
        { id: 'fr1', status: 'investigating', title: 'FedRAMP workspaces and API orgs have degraded performance' },
        { id: 'r1', status: 'investigating', title: 'Elevated errors in us-east-1' },
      ],
    })
    expect(result).not.toBeNull()
    expect(result!.ongoingCount).toBe(1)
    expect(result!.allDown).toBe(false)
    expect(result!.regions.find((r) => r.key === 'us-east-1')!.status).toBe('incident')
    expect(result!.regions.find((r) => r.key === 'us-west-2')!.status).toBe('ok')
  })

  test('a FedRAMP incident that co-names a real region is NOT dropped', () => {
    const result = regionStatusOf({
      id: 'openai',
      status: 'degraded',
      incidents: [
        { id: 'fr2', status: 'investigating', title: 'Elevated errors in us-east-1 and FedRAMP workspaces' },
      ],
    })
    expect(result).not.toBeNull()
    expect(result!.ongoingCount).toBe(1)
    expect(result!.regions.find((r) => r.key === 'us-east-1')!.status).toBe('incident')
    expect(result!.regions.find((r) => r.key === 'us-west-2')!.status).toBe('ok')
  })
})

// This mirror also backs the Worker Discord region hint (buildRegionHint), so the switchability
// gate must hold here too — otherwise Discord keeps recommending a region the reader cannot pick.
describe('region-status.ts mirror — region-aware but not region-switchable (#973)', () => {
  test('openai: regions still resolve, recommendedRegion is null, no docs link', () => {
    const result = regionStatusOf({
      id: 'openai',
      status: 'degraded',
      incidents: [{ id: 'r1', status: 'investigating', title: 'Elevated errors in us-east-1' }],
    })
    expect(result).not.toBeNull()
    expect(result!.hasRegionSpecific).toBe(true)
    expect(result!.regions.find((r) => r.key === 'us-east-1')!.status).toBe('incident')
    expect(result!.okRegions.map((r) => r.key)).toEqual(['us-west-2', 'eu-central-1'])
    expect(result!.recommendedRegion).toBeNull()
    expect(result!.docsUrl).toBeUndefined()
  })

  test('pinecone (switchable) still recommends the next healthy region', () => {
    const result = regionStatusOf({
      id: 'pinecone',
      incidents: [{ id: 'p1', status: 'investigating', title: 'AWS us-east-1 degraded' }],
    })
    expect(result!.recommendedRegion!.key).toBe('AWS us-west-2')
    expect(result!.docsUrl).toBe('https://docs.pinecone.io/guides/index-data/create-an-index#cloud-regions')
  })
})
