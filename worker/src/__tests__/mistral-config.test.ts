// #761 / #1381 — pin the Mistral service config.
//
// Mistral MIGRATED its status page from Instatus (Nuxt) to **Rootly** (verified 2026-09-10 from the
// page's own Datadog CSP report, `service:external-sp-rootly`). Everything this file guarded still
// needs guarding, but against different values: the component ids rotated wholesale (zero overlap
// between the 12 Instatus ids and the 14 Rootly resource UUIDs) and several components were RENAMED
// — "Chat Completions API" → "Completion API", "Embeddings API" → "Embedding API", "AI Registry
// Prompts/Skills API" → "Prompts/Skills API".
//
// The two load-bearing, otherwise-unguarded things are unchanged:
//
//   1. The hardcoded `displayComponentIds`. Nothing else in the suite references them. If an id
//      rotates upstream, `resolveSvcComponents` matches <2 → returns [] → the breakdown card empties
//      AND `routingTier` returns null (comps.length === 0), silently reverting the #1062 facet-B
//      routing, with every other test green. That is exactly what the migration did, undetected.
//
//   2. The component NAMES → capability mapping. `capabilityOfComponent` is a name-KEYWORD match, so
//      routing survives only while the live names still contain the keyword. The rename above is the
//      live proof this seam is real: `/embed/i` still matches "Embedding API" and "Completion API"
//      still falls through to `llm`, so routing held — but nothing except this test would have said so.
//
// Ids/names read from the Rootly v3 status.mistral.ai page on 2026-10-21.
// Mirrors fal-config.test.ts (#758) / kimi-config.test.ts (#989).

import { describe, it, expect } from 'vitest'
import { SERVICES, filterIncidents } from '../services'
import { API_TIER, EXCLUDE_FALLBACK, capabilityOfComponent, CAPABILITY_TIER } from '../fallback'

// The 13 API components, in the order the config lists them. The page also carries non-API
// components, which are deliberately absent from this list — see below.
const API_GROUP: Array<[string, string]> = [
  ['38c479d8-b68b-4259-8361-0f52c7cc5abd', 'Completion API'],
  ['ca6957e1-6702-46d6-a315-c5c2705ea904', 'Embedding API'],
  ['02854346-5ace-4d07-8060-fbce92868dee', 'OCR API'],
  ['040448d1-a48a-46a2-b902-738630eb3dc0', 'Agents API'],
  ['54557689-02de-44ef-93a0-b1623fd0e2d8', 'Conversations API'],
  ['1682e120-dca1-4fea-b344-e2f8dd12ebd9', 'Fine-Tuning API'],
  ['42f444f1-0899-4c61-8700-4deff117fbb9', 'Audio API'],
  ['f1e6b7cd-e1fc-44ab-8b7e-f3cfde127193', 'Integrations API'],
  ['dd45369c-fe82-4a81-b177-248cecec6fd8', 'Files API'],
  ['9bee7300-775f-4cb7-b181-d4efa024c4ca', 'Batch API'],
  ['ba78005e-a0b7-498b-8688-dd3529e9780c', 'Workflows API'],
  ['5550b7f7-8d2b-4a86-89d7-d842c94f365a', 'Prompts API'],
  ['9f221a35-eb8a-411d-8767-3686dbd7881d', 'Skills API'],
]

// Not an API surface, so it stays out of the breakdown for the same reason the old "Services" group
// did — the card is an API-surface card.
const CONSOLE_ID = 'e08a5be3-c333-4874-9a51-01c2683fe9dd'

describe('#1381 Mistral (Rootly) service config', () => {
  const svc = () => SERVICES.find((x) => x.id === 'mistral')!

  it('no longer claims an Instatus scrape path — that URL is 403 since the migration', () => {
    const s = svc()
    expect(s, 'mistral missing from SERVICES').toBeDefined()
    expect(s.apiUrl).toBeNull()
    expect(s.statusUrl).toBe('https://status.mistral.ai')
    // Leaving the old value would make `scrapeUrl` fetch a 403 every cycle. Pinned as absent so a
    // revert is loud rather than a silent per-cycle failure.
    expect(s.instatusUrl).toBeUndefined()
  })

  it('does NOT declare the source unreadable — the feed is the source now', () => {
    // The Worker still cannot fetch the Cloudflare-challenged page directly, but that is not what
    // this flag says to a reader: it drives "AIWatch can't currently read Mistral API's status
    // source" on `/is-mistral-down`, which is false on every cycle the feed is present. An
    // unreadable cycle still says so: the KV gate refuses that feed and the response carries the
    // flag from `withUnreadFeedFlag`, so the claim tracks the cycle instead of the config.
    expect(svc().incidentSourceStale).toBeUndefined()
  })

  it('displays exactly the 13 API components, and not Console', () => {
    const ids = svc().displayComponentIds!
    expect(ids).toEqual(API_GROUP.map(([id]) => id))
    expect(new Set(ids).size).toBe(13) // no duplicates
    expect(ids).not.toContain(CONSOLE_ID)
    // No componentGroups: one shared label would collapse all 13 into a single row in
    // ServiceDetails, destroying the per-component visibility the card exists for.
    expect(svc().componentGroups).toBeUndefined()
  })

  it('#1481 — keeps every Vibe incident off the API card', () => {
    // Titles as published by status.mistral.ai, read from /api/status on 2026-09-22. The last one
    // does not start with the product name, so a prefix rule would have let it through.
    const vibeTitles = [
      'Vibe Work - Degraded output quality',
      'Vibe Code Web model is experiencing failures in some existing sessions',
      'Vibe Code Web is unable to provision a sandbox in new sessions',
      'Vibe Code Web is failing to provision a sandbox in new sessions',
      'Vibe Code Web is unable to create sandboxes in new sessions',
      'Failing to start sandboxes in Vibe Code Web',
    ]
    const incidents = vibeTitles.map((title, i) => ({
      id: `vibe-${i}`, title, status: 'resolved', impact: null,
      startedAt: '2026-09-20T00:00:00.000Z', resolvedAt: '2026-09-20T01:00:00.000Z',
    })) as unknown as Parameters<typeof filterIncidents>[0]
    expect(filterIncidents(incidents, svc())).toEqual([])
  })

  it('#1481 — the Vibe exclusion does not swallow an API incident', () => {
    // The counter-case to the test above: `incidentExclude` is a substring match, so a rule that
    // over-matches would empty the card instead of scoping it.
    const apiTitles = [
      'Completion API Degraded - glm-5-2',
      'Availability drop for Mistral OCR 4',
      'Elevated error rates on Mistral Small 4',
    ]
    const incidents = apiTitles.map((title, i) => ({
      id: `api-${i}`, title, status: 'resolved', impact: 'minor',
      startedAt: '2026-09-20T00:00:00.000Z', resolvedAt: '2026-09-20T01:00:00.000Z',
    })) as unknown as Parameters<typeof filterIncidents>[0]
    expect(filterIncidents(incidents, svc()).map((i) => i.title)).toEqual(apiTitles)
  })

  it('carries none of the pre-migration Instatus ids', () => {
    // The migration rotated every id. A partial revert (some old, some new) is the shape that
    // silently half-empties the breakdown, so assert the old set is gone entirely.
    const ids = new Set(svc().displayComponentIds!)
    for (const stale of [
      'c4869a5a-054c-4c1b-88d1-3d195ba58511', '6d1417e5-81f5-44f4-bfd4-d2eb44d95988',
      '09f74bbf-a6e6-4751-a057-70da6c502c06', 'bd64fd4f-286c-4a86-bd31-006a7ea5aa03',
    ]) expect(ids.has(stale)).toBe(false)
  })

  it('maps its RENAMED component names to exactly ONE routable capability — audio (#1062 facet B)', () => {
    // THE seam this file exists for, and the migration is the case that proves it: the names changed
    // and the routing happened to survive. Without this the survival would be luck nobody checked.
    const byCapability = new Map<string, string[]>()
    for (const [, name] of API_GROUP) {
      const cap = capabilityOfComponent(name)
      byCapability.set(cap, [...(byCapability.get(cap) ?? []), name])
    }
    expect(byCapability.get('audio')).toEqual(['Audio API'])
    expect(byCapability.get('embeddings')).toEqual(['Embedding API'])
    // Everything else must read as the PRIMARY capability, or it would hijack routing: routingTier
    // only routes when exactly ONE distinct non-llm capability is degraded.
    expect(byCapability.get('llm')).toHaveLength(11)
    expect([...byCapability.keys()].sort()).toEqual(['audio', 'embeddings', 'llm'])
    const unroutable = [...byCapability.keys()].filter((c) => c !== 'llm' && !(c in CAPABILITY_TIER))
    expect(unroutable).toEqual([])
  })

  it('the rename did not move a component across a capability boundary', () => {
    // Stated as the before/after it actually is, so a future rename is compared against the same pair.
    expect(capabilityOfComponent('Embeddings API')).toBe(capabilityOfComponent('Embedding API'))
    expect(capabilityOfComponent('Chat Completions API')).toBe(capabilityOfComponent('Completion API'))
    expect(capabilityOfComponent('Completion API')).toBe('llm')
  })

  it('routes audio to the Voice tier and embeddings to the Embeddings tier (#880)', () => {
    expect(CAPABILITY_TIER[capabilityOfComponent('Audio API')]).toBe(4)
    expect(CAPABILITY_TIER[capabilityOfComponent('Embedding API')]).toBe(9)
  })

  it('is a tier-1 LLM service eligible for fallback recommendations', () => {
    expect(API_TIER.mistral).toBe(1)
    expect(EXCLUDE_FALLBACK).not.toContain('mistral')
  })
})
