import { describe, it, expect } from 'vitest'
import { XAI_REGION_RE, xaiRegionOf, xaiEventKey, collapseXaiRegionalIncidents } from '../xai-regions'

const inc = (id: string, title: string) => ({ id, title })

describe('xai-regions (#686/#703)', () => {
  describe('xaiRegionOf', () => {
    it('extracts the region label from a tagged title', () => {
      expect(xaiRegionOf('[API (us-east-1.api.x.ai)] Increased Error rate')).toBe('us-east-1')
      expect(xaiRegionOf('[API (eu-west-1.api.x.ai)] Increased Error rate')).toBe('eu-west-1')
    })
    it('returns null for a non-region-tagged title', () => {
      expect(xaiRegionOf('Whole-service degradation')).toBeNull()
      expect(xaiRegionOf('[API Console] Console not loading')).toBeNull() // not the region shape
    })
  })

  describe('xaiEventKey', () => {
    it('strips the region prefix so same-event-different-region collapses to one key', () => {
      const a = xaiEventKey('[API (us-east-1.api.x.ai)] Increased Error rate on Image Generation Endpoint')
      const b = xaiEventKey('[API (eu-west-1.api.x.ai)] Increased Error rate on Image Generation Endpoint')
      expect(a).toBe('Increased Error rate on Image Generation Endpoint')
      expect(a).toBe(b)
    })
    it('returns the title unchanged when not region-tagged (never collapses)', () => {
      expect(xaiEventKey('Whole-service degradation')).toBe('Whole-service degradation')
    })
  })

  describe('collapseXaiRegionalIncidents', () => {
    it('collapses the same event across two regions to ONE (first kept) + annotates the title with all regions', () => {
      const out = collapseXaiRegionalIncidents([
        inc('us1', '[API (us-east-1.api.x.ai)] Increased Error rate on Image Generation Endpoint'),
        inc('eu1', '[API (eu-west-1.api.x.ai)] Increased Error rate on Image Generation Endpoint'),
      ])
      expect(out.map((i) => i.id)).toEqual(['us1']) // eu1 dropped (same stripped event)
      // the surviving incident's title names BOTH regions so the AI analysis covers both (#703)
      expect(out[0].title).toBe('Increased Error rate on Image Generation Endpoint (regions: us-east-1, eu-west-1)')
    })

    it('keeps DISTINCT events separate even when both span two regions (each title region-annotated)', () => {
      const out = collapseXaiRegionalIncidents([
        inc('a-us', '[API (us-east-1.api.x.ai)] Increased Error rate on Image Generation Endpoint'),
        inc('a-eu', '[API (eu-west-1.api.x.ai)] Increased Error rate on Image Generation Endpoint'),
        inc('b-us', '[API (us-east-1.api.x.ai)] grok-code-fast-1 unavailable'),
        inc('b-eu', '[API (eu-west-1.api.x.ai)] grok-code-fast-1 unavailable'),
      ])
      expect(out.map((i) => i.id)).toEqual(['a-us', 'b-us']) // one per distinct event
      expect(out[0].title).toBe('Increased Error rate on Image Generation Endpoint (regions: us-east-1, eu-west-1)')
      expect(out[1].title).toBe('grok-code-fast-1 unavailable (regions: us-east-1, eu-west-1)')
    })

    it('a SINGLE-region event keeps its original title (no annotation)', () => {
      const out = collapseXaiRegionalIncidents([
        inc('us1', '[API (us-east-1.api.x.ai)] Increased Error rate on Image Generation Endpoint'),
      ])
      expect(out.map((i) => i.id)).toEqual(['us1'])
      expect(out[0].title).toBe('[API (us-east-1.api.x.ai)] Increased Error rate on Image Generation Endpoint')
    })

    it('passes non-region-tagged incidents through untouched (no collapse)', () => {
      const out = collapseXaiRegionalIncidents([
        inc('x', 'Whole-service degradation'),
        inc('y', 'Another untagged incident'),
      ])
      expect(out.map((i) => i.id)).toEqual(['x', 'y'])
    })

    it('is a no-op for a non-xAI service incident list (no region-tagged titles)', () => {
      const list = [inc('c1', 'API returning 500s'), inc('c2', 'Elevated latency')]
      expect(collapseXaiRegionalIncidents(list)).toEqual(list)
    })

    it('a region-tagged + a non-tagged incident: tagged collapses by event, untagged kept', () => {
      const out = collapseXaiRegionalIncidents([
        inc('us1', '[API (us-east-1.api.x.ai)] Event A'),
        inc('eu1', '[API (eu-west-1.api.x.ai)] Event A'),
        inc('global', 'Whole-service degradation'),
      ])
      expect(out.map((i) => i.id)).toEqual(['us1', 'global'])
    })
  })

  it('XAI_REGION_RE matches only the region shape (not [API Console])', () => {
    expect(XAI_REGION_RE.test('[API (us-east-1.api.x.ai)] x')).toBe(true)
    expect(XAI_REGION_RE.test('[API Console] x')).toBe(false)
  })
})
