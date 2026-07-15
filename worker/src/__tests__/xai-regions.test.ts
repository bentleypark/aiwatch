import { describe, it, expect } from 'vitest'
import { XAI_REGION_RE, xaiRegionOf, xaiEventKey, collapseXaiRegionalIncidents, mergeXaiRegionalIncidents } from '../xai-regions'
import { filterIncidents, SERVICES } from '../services'
import type { Incident } from '../types'

const XAI_CONFIG = SERVICES.find(s => s.id === 'xai')!

const inc = (id: string, title: string) => ({ id, title })

// Full-Incident builder for the #940 source-merge tests.
const fullInc = (over: Partial<Incident> & { id: string; title: string }): Incident => ({
  status: 'investigating',
  impact: 'minor',
  startedAt: '2026-07-08T00:00:00.000Z',
  resolvedAt: null,
  duration: null,
  timeline: [],
  ...over,
})

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

  describe('mergeXaiRegionalIncidents (#940 source merge)', () => {
    const T = 'Imagine Video 1.5 is experiencing lower success rate and higher latency'

    it('merges a same-event multi-region incident into ONE canonical incident naming all regions', () => {
      const out = mergeXaiRegionalIncidents([
        fullInc({ id: 'us1', title: `[API (us-east-1.api.x.ai)] ${T}` }),
        fullInc({ id: 'eu1', title: `[API (eu-west-1.api.x.ai)] ${T}` }),
        fullInc({ id: 'uw2', title: `[API (us-west-2.api.x.ai)] ${T}` }),
      ])
      expect(out).toHaveLength(1)
      expect(out[0].id).toMatch(/^xai-evt:/)
      // #940 review — the merged multi-region title MUST keep an `[API]` marker so it survives
      // filterIncidents' `api` keyword filter (asserted end-to-end below).
      expect(out[0].title).toBe(`[API] ${T} (regions: us-east-1, eu-west-1, us-west-2)`)
    })

    it('canonical id is STABLE across single- vs multi-region member sets for the same event', () => {
      const single = mergeXaiRegionalIncidents([fullInc({ id: 'us1', title: `[API (us-east-1.api.x.ai)] ${T}` })])
      const multi = mergeXaiRegionalIncidents([
        fullInc({ id: 'us1', title: `[API (us-east-1.api.x.ai)] ${T}` }),
        fullInc({ id: 'eu1', title: `[API (eu-west-1.api.x.ai)] ${T}` }),
      ])
      // same event key → same id whether 1 or 2 regions present (survives partial resolution / late join)
      expect(single[0].id).toBe(multi[0].id)
    })

    it('status is worst-of: still ACTIVE (resolvedAt null) while ANY region is unresolved', () => {
      const out = mergeXaiRegionalIncidents([
        fullInc({ id: 'us1', title: `[API (us-east-1.api.x.ai)] ${T}`, status: 'resolved', resolvedAt: '2026-07-08T01:00:00.000Z' }),
        fullInc({ id: 'eu1', title: `[API (eu-west-1.api.x.ai)] ${T}`, status: 'investigating' }),
      ])
      expect(out[0].status).toBe('investigating')
      expect(out[0].resolvedAt).toBeNull()
      expect(out[0].duration).toBeNull()
    })

    it('resolves only when ALL regions resolved; resolvedAt = latest, duration spans earliest→latest', () => {
      const out = mergeXaiRegionalIncidents([
        fullInc({ id: 'us1', title: `[API (us-east-1.api.x.ai)] ${T}`, status: 'resolved', startedAt: '2026-07-08T00:00:00.000Z', resolvedAt: '2026-07-08T00:57:00.000Z' }),
        fullInc({ id: 'eu1', title: `[API (eu-west-1.api.x.ai)] ${T}`, status: 'resolved', startedAt: '2026-07-08T00:10:00.000Z', resolvedAt: '2026-07-08T01:02:00.000Z' }),
      ])
      expect(out[0].status).toBe('resolved')
      expect(out[0].startedAt).toBe('2026-07-08T00:00:00.000Z')
      expect(out[0].resolvedAt).toBe('2026-07-08T01:02:00.000Z')
      expect(out[0].duration).toBe('1h 2m')
    })

    it('impact is worst-of across regions (major beats minor)', () => {
      const out = mergeXaiRegionalIncidents([
        fullInc({ id: 'us1', title: `[API (us-east-1.api.x.ai)] ${T}`, impact: 'minor' }),
        fullInc({ id: 'eu1', title: `[API (eu-west-1.api.x.ai)] ${T}`, impact: 'major' }),
      ])
      expect(out[0].impact).toBe('major')
    })

    it('merges + dedups + sorts timelines oldest-first', () => {
      const out = mergeXaiRegionalIncidents([
        fullInc({ id: 'us1', title: `[API (us-east-1.api.x.ai)] ${T}`, timeline: [
          { stage: 'investigating', text: 'looking', at: '2026-07-08T00:05:00.000Z' },
          { stage: 'monitoring', text: 'recovering', at: '2026-07-08T00:40:00.000Z' },
        ] }),
        fullInc({ id: 'eu1', title: `[API (eu-west-1.api.x.ai)] ${T}`, timeline: [
          { stage: 'investigating', text: 'looking', at: '2026-07-08T00:05:00.000Z' }, // dup (same at+stage+text)
          { stage: 'identified', text: 'found it', at: '2026-07-08T00:20:00.000Z' },
        ] }),
      ])
      expect(out[0].timeline.map(t => t.at)).toEqual([
        '2026-07-08T00:05:00.000Z',
        '2026-07-08T00:20:00.000Z',
        '2026-07-08T00:40:00.000Z',
      ])
    })

    it('keeps DISTINCT events separate (different canonical ids)', () => {
      const out = mergeXaiRegionalIncidents([
        fullInc({ id: 'a-us', title: `[API (us-east-1.api.x.ai)] ${T}` }),
        fullInc({ id: 'a-eu', title: `[API (eu-west-1.api.x.ai)] ${T}` }),
        fullInc({ id: 'b-us', title: '[API (us-east-1.api.x.ai)] grok-code-fast-1 unavailable' }),
        fullInc({ id: 'b-eu', title: '[API (eu-west-1.api.x.ai)] grok-code-fast-1 unavailable' }),
      ])
      expect(out).toHaveLength(2)
      expect(out[0].id).not.toBe(out[1].id)
    })

    // #940 review (Critical) — the merge runs at the SOURCE, BEFORE filterIncidents. The merged
    // multi-region title must survive xAI's `incidentKeywords: ['api']` filter, or a real multi-region
    // outage is silently dropped and the service reads operational (no card / no feed / no alert).
    it('a merged multi-region incident SURVIVES filterIncidents with the real xAI config', () => {
      const merged = mergeXaiRegionalIncidents([
        fullInc({ id: 'us1', title: `[API (us-east-1.api.x.ai)] ${T}` }),
        fullInc({ id: 'eu1', title: `[API (eu-west-1.api.x.ai)] ${T}` }),
      ])
      expect(merged).toHaveLength(1)
      const kept = filterIncidents(merged, XAI_CONFIG)
      expect(kept.map(i => i.id)).toEqual(merged.map(i => i.id)) // NOT dropped
    })

    it('a merged single-region incident SURVIVES filterIncidents (original [API (…)] title)', () => {
      const merged = mergeXaiRegionalIncidents([fullInc({ id: 'us1', title: `[API (us-east-1.api.x.ai)] ${T}` })])
      expect(filterIncidents(merged, XAI_CONFIG)).toHaveLength(1)
    })

    it('the [API] marker does NOT collide with the [API Console] / Test+Incident excludes', () => {
      // A console/test incident is never region-tagged (XAI_REGION_RE requires `.api.x.ai`), so it is
      // never merged — filterIncidents still excludes it normally. Guards the marker choice.
      const consoleInc = fullInc({ id: 'c', title: '[API Console] Console not loading' })
      expect(filterIncidents([consoleInc], XAI_CONFIG)).toHaveLength(0)
      // and the merged multi-region [API] title is not swept up by the console exclude
      const merged = mergeXaiRegionalIncidents([
        fullInc({ id: 'us1', title: `[API (us-east-1.api.x.ai)] ${T}` }),
        fullInc({ id: 'eu1', title: `[API (eu-west-1.api.x.ai)] ${T}` }),
      ])
      expect(filterIncidents(merged, XAI_CONFIG)).toHaveLength(1)
    })

    it('a single-region event keeps its original title but gets a canonical id', () => {
      const out = mergeXaiRegionalIncidents([fullInc({ id: 'us1', title: `[API (us-east-1.api.x.ai)] ${T}` })])
      expect(out[0].title).toBe(`[API (us-east-1.api.x.ai)] ${T}`)
      expect(out[0].id).toMatch(/^xai-evt:/)
    })

    it('passes non-region-tagged xAI + non-xAI incidents through untouched (id + order preserved)', () => {
      const global = fullInc({ id: 'global', title: 'Whole-service degradation' })
      const other = fullInc({ id: 'c1', title: 'API returning 500s' })
      const out = mergeXaiRegionalIncidents([
        fullInc({ id: 'us1', title: `[API (us-east-1.api.x.ai)] ${T}` }),
        global,
        other,
      ])
      expect(out.map(i => i.id)).toEqual([out[0].id, 'global', 'c1'])
      expect(out[1]).toEqual(global)
      expect(out[2]).toEqual(other)
    })
  })

  it('XAI_REGION_RE matches only the region shape (not [API Console])', () => {
    expect(XAI_REGION_RE.test('[API (us-east-1.api.x.ai)] x')).toBe(true)
    expect(XAI_REGION_RE.test('[API Console] x')).toBe(false)
  })
})
