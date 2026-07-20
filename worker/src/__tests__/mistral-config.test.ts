// #761 — pin the Mistral service config. Mistral's status page is Instatus **Nuxt**, the format that
// publishes NO per-component status, so its `components[]` is DERIVED (component tree × ongoing-incident
// attribution). That makes two things load-bearing and otherwise unguarded:
//
//   1. The 12 hardcoded `displayComponentIds`. Nothing else in the suite references them — the Nuxt
//      parser tests mint synthetic ids from their own fixture builder, so they exercise the derivation
//      but never the config. If an id rotates upstream, `resolveSvcComponents` matches <2 → returns []
//      → the breakdown card empties AND `routingTier` returns null (comps.length === 0), silently
//      reverting the #1062 facet-B routing this work exists to enable, with every other test green.
//
//   2. The component NAMES → capability mapping. `capabilityOfComponent` is a name-KEYWORD match, so
//      routing is correct only while the live names still contain the keyword. Without this test the
//      parser tests and the RSS tests merely agree on a string literal the author chose ('Audio API'),
//      not on what Mistral actually publishes. A rename to e.g. "Voxtral" would keep both green while
//      the routing silently died.
//
// Names/ids verified against the live status.mistral.ai __NUXT_DATA__ payload on 2026-07-20.
// Mirrors fal-config.test.ts (#758) / kimi-config.test.ts (#989).

import { describe, it, expect } from 'vitest'
import { SERVICES } from '../services'
import { API_TIER, EXCLUDE_FALLBACK, capabilityOfComponent, CAPABILITY_TIER } from '../fallback'

// The 12 members of Mistral's own "API" group, in the order the config lists them.
const API_GROUP: Array<[string, string]> = [
  ['c4869a5a-054c-4c1b-88d1-3d195ba58511', 'Chat Completions API'],
  ['6d1417e5-81f5-44f4-bfd4-d2eb44d95988', 'Embeddings API'],
  ['09f74bbf-a6e6-4751-a057-70da6c502c06', 'OCR API'],
  ['d7e0541d-b743-4cad-96cb-dd1395422904', 'Agents API'],
  ['9f01cfda-c067-426b-b1aa-081541169174', 'Conversations API'],
  ['d8e1e02e-48a4-4d97-8168-a8aabc1c51fb', 'Audio API'],
  ['033ab409-a16e-4574-aef5-f2f0afc1f6cd', 'Integrations API'],
  ['4051fbf9-fea4-434a-90c1-b347c16e02ba', 'Files API'],
  ['78e74758-aa8f-4067-9147-d7f1ab90849a', 'Batch API'],
  ['02a249ad-72d5-432a-8937-a5ab69a0b7f8', 'Workflows API'],
  ['7fadf202-f02f-40a2-84a4-c4f4041b7865', 'AI Registry Prompts API'],
  ['bd64fd4f-286c-4a86-bd31-006a7ea5aa03', 'AI Registry Skills API'],
]

// The "Services" group — deliberately NOT in displayComponentIds, so the breakdown stays an
// API-surface card. NOT because incidentExclude covers them: that is a title substring match
// (['le chat','le console','documentation','website']) and only 3 of these 5 are dropped by it.
const SERVICES_GROUP_IDS = [
  '69c33753-b109-4a61-a281-0b52e7b41db4', // Le Console (developer tools)
  'c3a1efcb-24a2-4b8e-99da-bb28a4cd5af8', // Documentation
  'edb2d9fb-f852-4b73-8fd4-e0465b90f4a1', // Vibe
  '0180149f-f9e6-4cfd-9819-26e2f7f53258', // Document Library
  '24adc35f-5fc7-4ed8-89e3-abb57a11ba74', // Mistral.ai Website
]

describe('#761 Mistral (Instatus Nuxt) service config', () => {
  const svc = () => SERVICES.find((x) => x.id === 'mistral')!

  it('is an Instatus service scraping the CURRENT incidents path, not a redirect', () => {
    const s = svc()
    expect(s, 'mistral missing from SERVICES').toBeDefined()
    expect(s.apiUrl).toBeNull()
    expect(s.statusUrl).toBe('https://status.mistral.ai')
    // /incidents/page/1 now 301s here. fetchWithTimeout follows redirects so a stale value still
    // "works", which is exactly why it needs pinning — the drift is otherwise invisible.
    expect(s.instatusUrl).toBe('https://status.mistral.ai/activity/page/1')
    expect(s.instatusUrl).not.toContain('/incidents/')
    // statusComponent 'API' drives the official uptime% (the Nuxt group rollup), NOT the breakdown.
    expect(s.statusComponent).toBe('API')
  })

  it('displays exactly the 12 API-group components, and none of the Services group', () => {
    const ids = svc().displayComponentIds!
    expect(ids).toEqual(API_GROUP.map(([id]) => id))
    expect(new Set(ids).size).toBe(12) // no duplicates
    for (const excluded of SERVICES_GROUP_IDS) expect(ids).not.toContain(excluded)
    // No componentGroups: one shared label would collapse all 12 into a single collapsed row in
    // ServiceDetails, destroying the per-component visibility the card exists for.
    expect(svc().componentGroups).toBeUndefined()
  })

  it('maps its component names to exactly ONE routable capability — audio (#1062 facet B)', () => {
    // THE seam this file exists for. If Mistral renames a component, this fails loudly instead of the
    // routing silently reverting to LLM peers.
    const byCapability = new Map<string, string[]>()
    for (const [, name] of API_GROUP) {
      const cap = capabilityOfComponent(name)
      byCapability.set(cap, [...(byCapability.get(cap) ?? []), name])
    }
    expect(byCapability.get('audio')).toEqual(['Audio API'])
    expect(byCapability.get('embeddings')).toEqual(['Embeddings API'])
    // Everything else must read as the PRIMARY capability, or it would hijack routing: routingTier
    // only routes when exactly ONE distinct non-llm capability is degraded.
    expect(byCapability.get('llm')).toHaveLength(10)
    expect([...byCapability.keys()].sort()).toEqual(['audio', 'embeddings', 'llm'])
    // No component may map to a capability with no peer tier other than the known embeddings case.
    const unroutable = [...byCapability.keys()].filter((c) => c !== 'llm' && !(c in CAPABILITY_TIER))
    expect(unroutable).toEqual(['embeddings'])
  })

  it('routes audio to the Voice tier and SUPPRESSES embeddings until #880', () => {
    // Recorded as a decision, not an emergent side effect: an embeddings-only Mistral outage emits no
    // fallback anywhere (rather than the pre-#1062 default LLM peers), matching OpenAI + Cohere.
    expect(CAPABILITY_TIER[capabilityOfComponent('Audio API')]).toBe(4)
    expect(capabilityOfComponent('Embeddings API') in CAPABILITY_TIER).toBe(false)
  })

  it('stays a tier-2 LLM service eligible for fallback recommendations', () => {
    expect(API_TIER.mistral).toBe(2)
    expect(EXCLUDE_FALLBACK).not.toContain('mistral')
  })
})
