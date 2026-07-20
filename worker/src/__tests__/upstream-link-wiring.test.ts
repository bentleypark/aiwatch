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
    ['/api/status (live)', 'buildUpstreamLinks(servicesWithScore, upstreamFeeds, Date.now())'],
    ['/api/status/cached (the path is-down reads)', 'buildUpstreamLinks(scoredCached, cached.upstreamFeeds ?? [], Date.now())'],
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

// #1072 — the feeds must survive every path that writes the snapshot is-down reads.
//
// This is the pin that matters most in this change, and it is deliberately a SOURCE pin rather than a
// behavioural one. The three writers each rewrite CACHE_KEY wholesale, so a writer that omits the
// feeds does not degrade the note — it ERASES the feeds from KV until the next full write. Two of the
// three fire only on a status EDGE, i.e. when an outage starts, so the erasure would happen precisely
// when the note is worth rendering, and would look like flakiness rather than a bug. Required
// parameters on `writeStatusCache` (the two edge refreshes) AND on `cacheWrite` (the throttled main
// writer, which deliberately does NOT route through writeStatusCache — see its own comment) make
// omission a compile error; this pins that no call site satisfies the type by passing an empty
// literal instead of the real value. The writer BODIES are covered separately, by round-trip
// assertions in cache-refresh.test.ts — a source pin cannot see a key dropped inside the writer.
describe('upstreamFeeds cache wiring (#1072)', () => {
  it('fetchAllServices destructures upstreamFeeds on BOTH the cron and live paths', () => {
    const destructures = INDEX_SRC.match(/upstreamFeeds(?::\s*\w+)?\s*\}\s*=\s*await fetchAllServices/g) ?? []
    expect(destructures.length).toBeGreaterThanOrEqual(2)
  })

  it.each([
    ['throttled cacheWrite (the main writer)', 'cacheWrite(env.STATUS_CACHE, raw, upstreamFeeds, env.DISCORD_WEBHOOK_URL)'],
    ['#488 cron alert-edge refresh', 'refreshStatusCacheOnChange(env.STATUS_CACHE, services, upstreamFeeds, sent.length'],
    ['#1057 live-edge refresh', 'refreshStatusCacheOnLiveEdge(env.STATUS_CACHE, wrote, raw, upstreamFeeds'],
  ])('passes the real feeds through %s', (_label, call) => {
    expect(INDEX_SRC).toContain(call)
  })

  it('no cache writer passes an empty literal instead of the real feeds', () => {
    // The cheapest way to satisfy the required param while still erasing the feeds. A variable that
    // happens to hold [] does it too, and this regex cannot see that.
    expect(INDEX_SRC).not.toMatch(/(cacheWrite|refreshStatusCacheOnChange|refreshStatusCacheOnLiveEdge)\([^)]*,\s*\[\]\s*,/)
  })

  it('the cron carries the CACHED feeds forward when it did not live-fetch', () => {
    // A fresh-cache cron never calls fetchAllServices, so its feeds must come from the snapshot it
    // read — otherwise the #488 write replaces them with nothing on the alert edge.
    expect(INDEX_SRC).toContain('upstreamFeeds: cachedFeeds')
    expect(INDEX_SRC).toMatch(/let upstreamFeeds = cachedFeeds as UpstreamCandidate\[\]/)
  })

  it('the throttled cacheWrite persists the key into the snapshot', () => {
    const writeBlock = INDEX_SRC.slice(INDEX_SRC.indexOf('kv.put(CACHE_KEY'))
    expect(writeBlock.slice(0, writeBlock.indexOf('}), {'))).toContain('upstreamFeeds')
  })
})
