// #1053 — pin the WIRING, not just the logic.
//
// `buildUpstreamLinks` being green proves nothing about whether index.ts ever calls it. There are TWO
// status paths that must both emit `upstreamLinks`:
//   /api/status         → buildUpstreamLinks(servicesWithScore)
//   /api/status/cached  → buildUpstreamLinks(scoredCached)      ← the one is-down actually reads
// Emitting on only one is a silent half-feature: the dashboard would work while the is-down SSR page
// stayed permanently linkless (or vice-versa), with every unit test still green. That failure mode is
// #1003's "half-migrated dual path" and #1032's "pure fn green ≠ wiring green" — both shipped from a
// suite that only tested the pure function.
//
// index.ts can't be imported here (it pulls the Workers runtime + every binding), so read it via fs —
// the `api-tier-sync.test.ts` (#403) precedent for cross-surface pins.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const INDEX_SRC = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8')

describe('upstreamLinks wiring (#1053)', () => {
  it('imports buildUpstreamLinks', () => {
    expect(INDEX_SRC).toMatch(/import\s*\{[^}]*buildUpstreamLinks[^}]*\}\s*from\s*'\.\/upstream-link'/)
  })

  it.each([
    ['/api/status (live)', 'buildUpstreamLinks(servicesWithScore, Date.now())'],
    ['/api/status/cached (the path is-down reads)', 'buildUpstreamLinks(scoredCached, Date.now())'],
  ])('computes the links on %s', (_label, call) => {
    expect(INDEX_SRC).toContain(call)
  })

  it('puts upstreamLinks on BOTH status response payloads', () => {
    const emits = INDEX_SRC.match(/^\s*upstreamLinks,$/gm) ?? []
    expect(emits).toHaveLength(2)
  })

  it('emits the key UNCONDITIONALLY — presence of the key is the deploy signal', () => {
    // Deliberate divergence from the alertFeed/reportFeed/supplyChainBanner neighbours, which omit
    // their key when empty. This gate fires only during a rare live cross-provider outage, so a
    // conditional key would make "no #1053 worker deployed" byte-identical to "deployed and correctly
    // quiet" — forever. #574's banner has the conditional shape and has sat verify-blocked ever since.
    expect(INDEX_SRC).not.toMatch(/upstreamLinks\.length > 0 \?/)
  })

  it('emits upstreamLinks in the same payload that carries `cached: true`', () => {
    // Guards against both emits landing on the live path while the cached path silently lacks it —
    // the shape a copy-paste wiring bug actually takes.
    const cachedPayload = INDEX_SRC.slice(INDEX_SRC.indexOf('cached: true'))
    const end = cachedPayload.indexOf('}), {')
    expect(end).toBeGreaterThan(-1)
    expect(cachedPayload.slice(0, end)).toContain('upstreamLinks')
  })
})
