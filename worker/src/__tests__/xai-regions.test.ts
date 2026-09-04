import { describe, it, expect } from 'vitest'
import { XAI_REGION_RE, xaiRegionOf, xaiEventKey, collapseXaiRegionalIncidents, mergeXaiRegionalIncidents, xaiGrokSurfaceOf, xaiGrokEventKey, mergeXaiGrokSurfaceIncidents } from '../xai-regions'
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

    // #1337 — the region axis keeps its per-region echo. Its groups have NO time bound, so members
    // can come from outages months apart, where a repeated boilerplate sentence is two separate
    // announcements rather than one echoed; collapsing them there deleted a whole later outage's
    // timeline. The echo collapse is therefore scoped to the surface axis, whose groups are bounded.
    it('leaves a per-region echo alone — collapsing it is unsound without a time bound', () => {
      const RESOLVED = 'We have resolved the situation, and traffic is healthy again.'
      const out = mergeXaiRegionalIncidents([
        fullInc({ id: 'us1', title: `[API (us-east-1.api.x.ai)] ${T}`, startedAt: '2026-09-03T13:30:00.000Z', timeline: [
          { stage: 'investigating', text: RESOLVED, at: '2026-09-03T17:09:14.000Z' },
        ] }),
        fullInc({ id: 'uw2', title: `[API (us-west-2.api.x.ai)] ${T}`, startedAt: '2026-09-03T13:30:00.000Z', timeline: [
          { stage: 'investigating', text: RESOLVED, at: '2026-09-03T17:07:20.000Z' },
        ] }),
      ])
      expect(out[0].timeline).toHaveLength(2)
    })

    it('does not delete a later outage\'s rows when two same-title outages fuse', () => {
      // The region merge fuses same-title outages across time (pre-existing #940). Whatever else that
      // does, the fused incident must still carry both outages' updates.
      const SAME = 'We are investigating an issue.'
      const out = mergeXaiRegionalIncidents([
        fullInc({ id: 'jan-us', title: `[API (us-east-1.api.x.ai)] ${T}`, startedAt: '2026-01-21T11:19:00.000Z', timeline: [{ stage: 'investigating', text: SAME, at: '2026-01-21T11:19:00.000Z' }] }),
        fullInc({ id: 'jan-uw', title: `[API (us-west-2.api.x.ai)] ${T}`, startedAt: '2026-01-21T11:19:30.000Z', timeline: [{ stage: 'investigating', text: SAME, at: '2026-01-21T11:19:30.000Z' }] }),
        fullInc({ id: 'mar-us', title: `[API (us-east-1.api.x.ai)] ${T}`, startedAt: '2026-03-15T09:00:00.000Z', timeline: [{ stage: 'investigating', text: SAME, at: '2026-03-15T09:00:00.000Z' }] }),
        fullInc({ id: 'mar-uw', title: `[API (us-west-2.api.x.ai)] ${T}`, startedAt: '2026-03-15T09:02:00.000Z', timeline: [{ stage: 'investigating', text: SAME, at: '2026-03-15T09:02:00.000Z' }] }),
      ])
      expect(out[0].timeline).toHaveLength(4)
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

// ─── #1337 — the Grok SURFACE axis ───────────────────────────────────────────────────────────────
//
// The fixtures below are a mix: some are real shapes read off `status.x.ai` (the 2026-09-03 quartet
// keeps its guids, titles and timestamps verbatim), and some are constructed to reach a branch the
// live feed does not currently exercise. Each constructed one says so at its own test. They are
// fixtures rather than prose because the merge's correctness argument is "these must join, those must
// not", and only a fixture holds that claim without drifting.
describe('xai Grok surface merge (#1337)', () => {
  const GROK_CONFIG = SERVICES.find(s => s.id === 'grok')!

  /** The 2026-09-03 outage: one event, four surface incidents, identical startedAt. */
  const QUARTET_2026_09_03: Incident[] = [
    fullInc({ id: 'INCc33a8af', title: '[Grok (iOS)] Models outage', status: 'resolved', impact: 'major', startedAt: '2026-09-03T13:30:00.000Z', resolvedAt: '2026-09-03T17:08:11.000Z' }),
    fullInc({ id: 'INC3b127ff3', title: '[Grok (Android)] Models outage', status: 'resolved', impact: 'major', startedAt: '2026-09-03T13:30:00.000Z', resolvedAt: '2026-09-03T17:04:59.000Z' }),
    fullInc({ id: 'INC25664c15', title: '[Grok (Web)] Models outage', status: 'resolved', impact: 'major', startedAt: '2026-09-03T13:30:00.000Z', resolvedAt: '2026-09-03T17:07:07.000Z' }),
    fullInc({ id: 'INC4d558447', title: '[Grok (Office/Workspace Plugins)] Models outage', status: 'resolved', impact: 'major', startedAt: '2026-09-03T13:30:00.000Z', resolvedAt: '2026-09-03T17:06:10.000Z' }),
  ]

  describe('xaiGrokSurfaceOf / XAI_GROK_SURFACE_RE', () => {
    it('extracts the surface label', () => {
      expect(xaiGrokSurfaceOf('[Grok (iOS)] Models outage')).toBe('iOS')
      expect(xaiGrokSurfaceOf('[Grok (Office/Workspace Plugins)] Models outage')).toBe('Office/Workspace Plugins')
    })
    it('returns null for the page\'s other Grok-prefixed tags — the paren is the whole rule', () => {
      // `[Grok in X]` and `[Grok Build]` are real tags on status.x.ai and are the genuine near-misses:
      // both start with "Grok " and are excluded only by the required `(`.
      expect(xaiGrokSurfaceOf('[Grok in X] Something')).toBeNull()
      expect(xaiGrokSurfaceOf('[Grok Build] Grok Build 0.1 high error rate')).toBeNull()
      expect(xaiGrokSurfaceOf('[API (us-east-1.api.x.ai)] Models outage')).toBeNull()
      expect(xaiGrokSurfaceOf('[API Console] Console not loading')).toBeNull()
      expect(xaiGrokSurfaceOf('[Single Sign-On] Unable to Sign-In via X')).toBeNull()
    })
  })

  describe('xaiGrokEventKey', () => {
    it('strips the surface tag, lowercases, and normalizes the drift xAI writes across surfaces', () => {
      // 2026-01-23/24 published the SAME event with and without a trailing period.
      expect(xaiGrokEventKey('[Grok (Web)] Grok is Temporarily Unavailable.'))
        .toBe(xaiGrokEventKey('[Grok (iOS)] Grok is Temporarily Unavailable'))
      // 2026-03-10's iOS title carries a double space; collapse it so spacing is not a second axis.
      expect(xaiGrokEventKey('[Grok (iOS)] Grok on iOS  is Temporarily Unavailable'))
        .toBe('grok on ios is temporarily unavailable')
    })
    it('keeps genuinely different titles apart', () => {
      expect(xaiGrokEventKey('[Grok (iOS)] Grok on iOS is Temporarily Unavailable'))
        .not.toBe(xaiGrokEventKey('[Grok (Web)] Grok is Temporarily Unavailable'))
    })
  })

  describe('grouping', () => {
    it('collapses the 2026-09-03 quartet into ONE incident naming every surface', () => {
      const out = mergeXaiGrokSurfaceIncidents(QUARTET_2026_09_03)
      expect(out).toHaveLength(1)
      expect(out[0].title).toBe('[Grok (iOS, Android, Web, Office/Workspace Plugins)] Models outage')
    })

    it('merges across a UTC midnight boundary, and across the trailing-period drift', () => {
      // Real: Web opened 3m21s before midnight, Android + iOS just after, iOS without the period.
      const out = mergeXaiGrokSurfaceIncidents([
        fullInc({ id: 'ios', title: '[Grok (iOS)] Grok is Temporarily Unavailable', startedAt: '2026-01-24T00:01:13.000Z' }),
        fullInc({ id: 'and', title: '[Grok (Android)] Grok is Temporarily Unavailable.', startedAt: '2026-01-24T00:01:02.000Z' }),
        fullInc({ id: 'web', title: '[Grok (Web)] Grok is Temporarily Unavailable.', startedAt: '2026-01-23T23:57:52.000Z' }),
      ])
      expect(out).toHaveLength(1)
      expect(out[0].startedAt).toBe('2026-01-23T23:57:52.000Z') // earliest wins
    })

    it('keeps two same-title events on DIFFERENT days apart', () => {
      // 2026-01-26 19:59 vs 2026-01-27 03:33 — the closest distinct same-key pair in the live feed (7.6h).
      const out = mergeXaiGrokSurfaceIncidents([
        fullInc({ id: 'a-ios', title: '[Grok (iOS)] Grok is Temporarily Unavailable', startedAt: '2026-01-26T19:59:39.000Z' }),
        fullInc({ id: 'a-web', title: '[Grok (Web)] Grok is Temporarily Unavailable.', startedAt: '2026-01-26T19:52:10.000Z' }),
        fullInc({ id: 'b-ios', title: '[Grok (iOS)] Grok is Temporarily Unavailable', startedAt: '2026-01-27T03:33:02.000Z' }),
        fullInc({ id: 'b-web', title: '[Grok (Web)] Grok is Temporarily Unavailable', startedAt: '2026-01-27T03:31:09.000Z' }),
      ])
      expect(out).toHaveLength(2)
      expect(out[0].id).not.toBe(out[1].id)
    })

    it('keeps two same-title events on the SAME UTC day apart — the case a day bucket cannot separate', () => {
      // 2026-01-27 carries the 03:33 event AND the 14:10 event, same key, same calendar day. A
      // `key + day` id would collide here; the window separates them and `startedAt` keys them apart.
      const out = mergeXaiGrokSurfaceIncidents([
        fullInc({ id: 'a-ios', title: '[Grok (iOS)] Grok is Temporarily Unavailable', startedAt: '2026-01-27T03:33:02.000Z' }),
        fullInc({ id: 'a-web', title: '[Grok (Web)] Grok is Temporarily Unavailable', startedAt: '2026-01-27T03:31:09.000Z' }),
        fullInc({ id: 'b-ios', title: '[Grok (iOS)] Grok is Temporarily Unavailable', startedAt: '2026-01-27T14:10:00.000Z' }),
        fullInc({ id: 'b-web', title: '[Grok (Web)] Grok is Temporarily Unavailable', startedAt: '2026-01-27T14:10:00.000Z' }),
      ])
      expect(out).toHaveLength(2)
      expect(new Set(out.map(i => i.id)).size).toBe(2)
    })

    it('leaves a genuinely per-platform outage split — the case #1165 declined to merge for', () => {
      // 2025-03-10: three surfaces, three DIFFERENT descriptions, one timestamp. The key, not a
      // special case, is what keeps them apart.
      const out = mergeXaiGrokSurfaceIncidents([
        fullInc({ id: 'ios', title: '[Grok (iOS)] Partial Outage of Grok iOS App', startedAt: '2025-03-10T20:30:00.000Z' }),
        fullInc({ id: 'and', title: '[Grok (Android)] Partial Outage of Grok Android App', startedAt: '2025-03-10T20:30:00.000Z' }),
        fullInc({ id: 'web', title: '[Grok (Web)] Partial Outage of grok.com', startedAt: '2025-03-10T20:30:00.000Z' }),
      ])
      expect(out).toHaveLength(3)
      expect(out.map(i => i.id)).toEqual(['ios', 'and', 'web'].map(() => expect.stringMatching(/^xai-grok:/)))
    })

    it('separates two same-key events by TIME even when their surfaces do not overlap', () => {
      // The window's own test — the surface rule cannot separate these, since the surfaces differ.
      // The pairing is constructed, but the shape is not: `Grok is Temporarily Unavailable` recurs
      // across months in the live feed, and removing the window really does fuse two of those
      // recurrences (2026-02-12 and 2026-03-10) whose surface sets do not overlap.
      const out = mergeXaiGrokSurfaceIncidents([
        fullInc({ id: 'feb', title: '[Grok (Android)] Grok is Temporarily Unavailable', startedAt: '2026-02-12T19:39:59.000Z' }),
        fullInc({ id: 'mar', title: '[Grok (iOS)] Grok is Temporarily Unavailable', startedAt: '2026-03-10T20:06:42.000Z' }),
      ])
      expect(out).toHaveLength(2)
    })

    it('refuses to fuse two incidents on the SAME surface', () => {
      const out = mergeXaiGrokSurfaceIncidents([
        fullInc({ id: 'a', title: '[Grok (Web)] Models outage', startedAt: '2026-09-03T13:30:00.000Z' }),
        fullInc({ id: 'b', title: '[Grok (Web)] Models outage', startedAt: '2026-09-03T13:35:00.000Z' }),
      ])
      expect(out).toHaveLength(2)
    })

    it('gives two same-surface incidents sharing a startedAt DISTINCT ids', () => {
      // Splitting the groups is only half of keeping both: identical (key, startedAt) hashes to one
      // id, and the SPA's raw-id dedupe would re-fuse them into a single row.
      const out = mergeXaiGrokSurfaceIncidents([
        fullInc({ id: 'a', title: '[Grok (iOS)] Grok is Temporarily Unavailable', startedAt: '2026-01-27T03:33:00.000Z' }),
        fullInc({ id: 'b', title: '[Grok (iOS)] Grok is Temporarily Unavailable', startedAt: '2026-01-27T03:33:00.000Z' }),
      ])
      expect(out).toHaveLength(2)
      expect(new Set(out.map(i => i.id)).size).toBe(2)
    })

    it('does not lose a group when two incidents share a guid', () => {
      // `parseXaiRssIncidents` passes `<guid>` through unchecked, so uniqueness is not guaranteed.
      // Keying the emit map on the id (rather than the position) silently dropped the first group.
      const out = mergeXaiGrokSurfaceIncidents([
        fullInc({ id: 'DUP', title: '[Grok (iOS)] Models outage', startedAt: '2026-09-03T13:30:00.000Z' }),
        fullInc({ id: 'DUP', title: '[Grok (iOS)] Models outage', startedAt: '2026-09-03T13:35:00.000Z' }),
      ])
      expect(out).toHaveLength(2)
    })
  })

  describe('identity', () => {
    it('does NOT collide with the region merge on the same outage', () => {
      // The two axes see the same event on 2026-09-03 and derive an id from the same words. Pin BOTH
      // guards separately, because either alone would let this pass while the other regressed: the
      // namespace, and the hash payload.
      const api = mergeXaiRegionalIncidents([
        fullInc({ id: 'us', title: '[API (us-east-1.api.x.ai)] Models outage', startedAt: '2026-09-03T13:30:00.000Z' }),
        fullInc({ id: 'uw', title: '[API (us-west-2.api.x.ai)] Models outage', startedAt: '2026-09-03T13:30:00.000Z' }),
      ])
      const grok = mergeXaiGrokSurfaceIncidents(QUARTET_2026_09_03)
      expect(api[0].id).toBe('xai-evt:1sc6h22')
      expect(grok[0].id).toMatch(/^xai-grok:/) // namespace
      expect(grok[0].id.split(':')[1]).not.toBe(api[0].id.split(':')[1]) // hash payload
    })

    it('is stable — the same event yields the same id regardless of feed order', () => {
      const a = mergeXaiGrokSurfaceIncidents(QUARTET_2026_09_03)
      const b = mergeXaiGrokSurfaceIncidents([...QUARTET_2026_09_03].reverse())
      expect(a[0].id).toBe(b[0].id)
    })

    it('gives a single-surface event a canonical id but leaves its title alone', () => {
      const out = mergeXaiGrokSurfaceIncidents([
        fullInc({ id: 'INC00b', title: '[Grok (Android)] embedding small collections failing to embed', startedAt: '2026-02-20T00:58:44.000Z' }),
      ])
      expect(out[0].title).toBe('[Grok (Android)] embedding small collections failing to embed')
      expect(out[0].id).toMatch(/^xai-grok:/)
    })
  })

  describe('filterIncidents survival — the #940-review failure class, on this axis', () => {
    it('a merged multi-surface incident SURVIVES the real grok config', () => {
      const merged = mergeXaiGrokSurfaceIncidents(QUARTET_2026_09_03)
      expect(merged).toHaveLength(1)
      expect(filterIncidents(merged, GROK_CONFIG).map(i => i.id)).toEqual(merged.map(i => i.id))
    })

    it('a single-surface incident SURVIVES the real grok config', () => {
      const merged = mergeXaiGrokSurfaceIncidents([QUARTET_2026_09_03[0]])
      expect(filterIncidents(merged, GROK_CONFIG)).toHaveLength(1)
    })

    it('the assertion has teeth — a merged title WITHOUT the `Grok (` marker is dropped', () => {
      // The mutation the test above is meant to catch: name the surfaces without the marker and the
      // whole outage disappears from the card, the feed and the alerts.
      const markerless = { ...QUARTET_2026_09_03[0], title: 'Models outage (surfaces: iOS, Android, Web)' }
      expect(filterIncidents([markerless], GROK_CONFIG)).toHaveLength(0)
    })

    it('a merged Grok title is NOT swept into the xai API card', () => {
      const merged = mergeXaiGrokSurfaceIncidents(QUARTET_2026_09_03)
      expect(filterIncidents(merged, XAI_CONFIG)).toHaveLength(0)
    })
  })

  describe('merge semantics', () => {
    it('takes worst-of status/impact and resolves only when every surface has', () => {
      const out = mergeXaiGrokSurfaceIncidents([
        fullInc({ id: 'ios', title: '[Grok (iOS)] Models outage', status: 'resolved', impact: 'minor', startedAt: '2026-09-03T13:30:00.000Z', resolvedAt: '2026-09-03T17:08:11.000Z' }),
        fullInc({ id: 'web', title: '[Grok (Web)] Models outage', status: 'investigating', impact: 'major', startedAt: '2026-09-03T13:30:00.000Z' }),
      ])
      expect(out[0].status).toBe('investigating')
      expect(out[0].impact).toBe('major')
      expect(out[0].resolvedAt).toBeNull()
      expect(out[0].duration).toBeNull()
    })

    it('stamps the LATEST resolvedAt + a duration once every surface has resolved', () => {
      const out = mergeXaiGrokSurfaceIncidents(QUARTET_2026_09_03)
      expect(out[0].status).toBe('resolved')
      expect(out[0].startedAt).toBe('2026-09-03T13:30:00.000Z')
      expect(out[0].resolvedAt).toBe('2026-09-03T17:08:11.000Z')
      // 13:30:00 → 17:08:11 is 219 displayed minutes (`displayedMinutes` rounds up).
      expect(out[0].duration).toBe('3h 39m')
    })

    it('unions + sorts the per-surface timelines, keeping each announcement ONCE', () => {
      // The real 2026-09-03 shape: every surface posts the same recovery sentence at its own instant.
      // Before #1337's key change this rendered four identical rows on the card.
      const line = (text: string, at: string) => ({ stage: 'investigating' as const, text, at })
      const RESOLVED = 'We have resolved the situation, and traffic is healthy again.'
      const out = mergeXaiGrokSurfaceIncidents([
        fullInc({ id: 'ios', title: '[Grok (iOS)] Models outage', startedAt: '2026-09-03T13:30:00.000Z', timeline: [
          line('Grok is experiencing issues.', '2026-09-03T13:30:00.000Z'),
          line(RESOLVED, '2026-09-03T17:08:11.000Z'),
        ] }),
        fullInc({ id: 'and', title: '[Grok (Android)] Models outage', startedAt: '2026-09-03T13:30:00.000Z', timeline: [
          line('Grok is experiencing issues.', '2026-09-03T13:30:00.000Z'),
          line(RESOLVED, '2026-09-03T17:04:59.000Z'),
        ] }),
        fullInc({ id: 'web', title: '[Grok (Web)] Models outage', startedAt: '2026-09-03T13:30:00.000Z', timeline: [
          line('Grok is experiencing issues.', '2026-09-03T13:30:00.000Z'),
          line(RESOLVED, '2026-09-03T17:07:07.000Z'),
        ] }),
      ])
      expect(out[0].timeline).toHaveLength(2)
      expect(out[0].timeline.map(t => t.at)).toEqual([
        '2026-09-03T13:30:00.000Z',
        '2026-09-03T17:04:59.000Z', // the EARLIEST echo survives, not the last
      ])
    })

    it('keeps two DIFFERENT opening sentences posted at the same instant', () => {
      // Real: the surfaces did not all use the same opening wording on 2026-09-03. Different text is
      // different content, so the dedupe must not touch it — this is the over-collapse guard.
      const out = mergeXaiGrokSurfaceIncidents([
        fullInc({ id: 'ios', title: '[Grok (iOS)] Models outage', startedAt: '2026-09-03T13:30:00.000Z', timeline: [
          { stage: 'investigating', text: 'Grok is experiencing issues. We are working on restoring service as quickly as possible.', at: '2026-09-03T13:30:00.000Z' },
        ] }),
        fullInc({ id: 'web', title: '[Grok (Web)] Models outage', startedAt: '2026-09-03T13:30:00.000Z', timeline: [
          { stage: 'investigating', text: 'We are experiencing issues with our models.', at: '2026-09-03T13:30:00.000Z' },
        ] }),
      ])
      expect(out[0].timeline).toHaveLength(2)
    })

    it('KEEPS a genuine repeat by the SAME member — the provider saying it is still going', () => {
      // The real 2026-01-21 xAI API outage posts this interim update three times in ONE incident.
      // A union-wide `(stage,text)` key deletes two of them and fabricates a 38-minute silence.
      const STILL = 'We are still working on a fix and will provide an update in approximately 15 minutes.'
      const line = (text: string, at: string) => ({ stage: 'investigating' as const, text, at })
      const out = mergeXaiGrokSurfaceIncidents([
        fullInc({ id: 'web', title: '[Grok (Web)] Models outage', startedAt: '2026-01-21T11:19:00.000Z', timeline: [
          line('Investigating.', '2026-01-21T11:19:00.000Z'),
          line(STILL, '2026-01-21T11:58:00.000Z'),
          line(STILL, '2026-01-21T12:13:00.000Z'),
          line(STILL, '2026-01-21T12:21:00.000Z'),
        ] }),
      ])
      expect(out[0].timeline.map(t => t.at)).toEqual([
        '2026-01-21T11:19:00.000Z',
        '2026-01-21T11:58:00.000Z',
        '2026-01-21T12:13:00.000Z',
        '2026-01-21T12:21:00.000Z',
      ])
    })

    it('drops EVERY echo by a non-owning member, not just its first', () => {
      // Both members repeat the same interim sentence three times. Web says it earliest, so Web owns
      // it and keeps all three; every one of iOS's copies is an echo.
      const STILL = 'We are still working on a fix.'
      const line = (text: string, at: string) => ({ stage: 'investigating' as const, text, at })
      const out = mergeXaiGrokSurfaceIncidents([
        fullInc({ id: 'web', title: '[Grok (Web)] Models outage', startedAt: '2026-09-03T13:30:00.000Z', timeline: [
          line(STILL, '2026-09-03T13:58:00.000Z'),
          line(STILL, '2026-09-03T14:13:00.000Z'),
          line(STILL, '2026-09-03T14:21:00.000Z'),
        ] }),
        fullInc({ id: 'ios', title: '[Grok (iOS)] Models outage', startedAt: '2026-09-03T13:30:00.000Z', timeline: [
          line(STILL, '2026-09-03T13:59:00.000Z'),
          line(STILL, '2026-09-03T14:14:00.000Z'),
          line(STILL, '2026-09-03T14:22:00.000Z'),
        ] }),
      ])
      expect(out[0].timeline.map(t => t.at)).toEqual([
        '2026-09-03T13:58:00.000Z',
        '2026-09-03T14:13:00.000Z',
        '2026-09-03T14:21:00.000Z',
      ])
    })

    it('keeps a same-member repeat while still collapsing another member\'s echo of it', () => {
      // Both rules at once: Web says it twice (kept twice), iOS echoes it once (dropped).
      const STILL = 'We are still working on a fix.'
      const line = (text: string, at: string) => ({ stage: 'investigating' as const, text, at })
      const out = mergeXaiGrokSurfaceIncidents([
        fullInc({ id: 'web', title: '[Grok (Web)] Models outage', startedAt: '2026-09-03T13:30:00.000Z', timeline: [
          line(STILL, '2026-09-03T13:40:00.000Z'),
          line(STILL, '2026-09-03T13:55:00.000Z'),
        ] }),
        fullInc({ id: 'ios', title: '[Grok (iOS)] Models outage', startedAt: '2026-09-03T13:30:00.000Z', timeline: [
          line(STILL, '2026-09-03T13:41:00.000Z'),
        ] }),
      ])
      expect(out[0].timeline.map(t => t.at)).toEqual([
        '2026-09-03T13:40:00.000Z',
        '2026-09-03T13:55:00.000Z',
      ])
    })

    it('the surviving copy of an echo is the EARLIEST, not whichever member the feed listed first', () => {
      // Feed order here is iOS (17:08:11) before Android (17:04:59); the kept row must be Android's.
      const RESOLVED = 'We have resolved the situation, and traffic is healthy again.'
      const line = (at: string) => ({ stage: 'investigating' as const, text: RESOLVED, at })
      const out = mergeXaiGrokSurfaceIncidents([
        fullInc({ id: 'ios', title: '[Grok (iOS)] Models outage', startedAt: '2026-09-03T13:30:00.000Z', timeline: [line('2026-09-03T17:08:11.000Z')] }),
        fullInc({ id: 'and', title: '[Grok (Android)] Models outage', startedAt: '2026-09-03T13:30:00.000Z', timeline: [line('2026-09-03T17:04:59.000Z')] }),
      ])
      expect(out[0].timeline.map(t => t.at)).toEqual(['2026-09-03T17:04:59.000Z'])
    })

    it('does not collapse the same sentence at a DIFFERENT stage', () => {
      const out = mergeXaiGrokSurfaceIncidents([
        fullInc({ id: 'ios', title: '[Grok (iOS)] Models outage', startedAt: '2026-09-03T13:30:00.000Z', timeline: [
          { stage: 'investigating', text: 'Service is degraded.', at: '2026-09-03T13:30:00.000Z' },
        ] }),
        fullInc({ id: 'web', title: '[Grok (Web)] Models outage', startedAt: '2026-09-03T13:30:00.000Z', timeline: [
          { stage: 'monitoring', text: 'Service is degraded.', at: '2026-09-03T13:31:00.000Z' },
        ] }),
      ])
      expect(out[0].timeline).toHaveLength(2)
    })
  })

  describe('no-op safety', () => {
    it('leaves the xAI API feed and non-xAI incidents untouched, in order', () => {
      const api = fullInc({ id: 'xai-evt:1sc6h22', title: '[API] Models outage (regions: us-east-1, us-west-2)', startedAt: '2026-09-03T13:30:00.000Z' })
      const console_ = fullInc({ id: 'con', title: '[API Console] Console not loading' })
      const other = fullInc({ id: 'c1', title: 'API returning 500s' })
      const out = mergeXaiGrokSurfaceIncidents([api, console_, other])
      expect(out).toEqual([api, console_, other])
    })

    it('leaves an incident with an unparseable startedAt unmerged rather than guessing', () => {
      const bad = fullInc({ id: 'bad', title: '[Grok (iOS)] Models outage', startedAt: 'not-a-date' })
      const good = fullInc({ id: 'good', title: '[Grok (Web)] Models outage', startedAt: '2026-09-03T13:30:00.000Z' })
      const out = mergeXaiGrokSurfaceIncidents([bad, good])
      expect(out).toHaveLength(2)
      expect(out[0]).toEqual(bad) // passed through verbatim, id and all
    })
  })

  describe('composition with the region merge (the real 2026-09-03 feed shape)', () => {
    it('yields exactly one API incident and one Grok incident, with distinct ids', () => {
      const feed: Incident[] = [
        ...QUARTET_2026_09_03,
        fullInc({ id: 'us', title: '[API (us-east-1.api.x.ai)] Models outage', status: 'resolved', impact: 'major', startedAt: '2026-09-03T13:30:00.000Z', resolvedAt: '2026-09-03T17:09:14.000Z' }),
        fullInc({ id: 'uw', title: '[API (us-west-2.api.x.ai)] Models outage', status: 'resolved', impact: 'major', startedAt: '2026-09-03T13:30:00.000Z', resolvedAt: '2026-09-03T17:07:20.000Z' }),
      ]
      const out = mergeXaiGrokSurfaceIncidents(mergeXaiRegionalIncidents(feed))
      expect(out).toHaveLength(2)
      expect(new Set(out.map(i => i.id)).size).toBe(2)
      // each card keeps only its own row
      expect(filterIncidents(out, GROK_CONFIG)).toHaveLength(1)
      expect(filterIncidents(out, XAI_CONFIG)).toHaveLength(1)
    })

    it('composes in either order — the two axes match disjoint title shapes', () => {
      const feed: Incident[] = [
        ...QUARTET_2026_09_03,
        fullInc({ id: 'us', title: '[API (us-east-1.api.x.ai)] Models outage', startedAt: '2026-09-03T13:30:00.000Z' }),
        fullInc({ id: 'uw', title: '[API (us-west-2.api.x.ai)] Models outage', startedAt: '2026-09-03T13:30:00.000Z' }),
      ]
      const a = mergeXaiGrokSurfaceIncidents(mergeXaiRegionalIncidents(feed))
      const b = mergeXaiRegionalIncidents(mergeXaiGrokSurfaceIncidents(feed))
      expect(a.map(i => i.id)).toEqual(b.map(i => i.id))
    })
  })
})
