import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// #1158 — source-scan wiring guard, in the repo's sync-test idiom (badge-wiring.test.ts /
// ai-usage-wiring.test.ts / api-tier-sync.test.ts).
//
// #1157 shipped the exact failure mode this guards against: a `queryBadgeTraffic` result computed
// in index.ts's cron assembly but never threaded into the `buildDailySummary({...})` call object —
// every pure-function/unit test stayed green because none of them touch index.ts's actual object
// literal. Two PR-review agents proved it via mutation testing before it was caught. Writing this
// guard proactively, alongside the feature, rather than after a review catches the same class of
// bug again.
//
// A PR-review agent found this guard's FIRST version had the identical flaw one layer deeper: it
// confirmed `badgeRepoDiscovery` reaches `buildWeeklyBriefing`, but not that the KV-persisted
// `previouslySeen` set actually reaches `diffBadgeRepoDiscovery` — mutating the call to
// `diffBadgeRepoDiscovery(results, [])` (silently discarding history every week) left every
// assertion here green. The second test below closes that gap.
const SRC = join(__dirname, '..')
const index = readFileSync(join(SRC, 'index.ts'), 'utf8')

describe('#1158 — badgeRepoDiscovery wiring into the production buildWeeklyBriefing(...) call', () => {
  it('threads badgeRepoDiscovery into the object literal, anchored right after strategyBriefMalformed', () => {
    // Anchored on `strategyBriefMalformed,` (the field immediately preceding it in the call) so a
    // reorder of unrelated fields elsewhere doesn't break the match, but dropping or relocating
    // `badgeRepoDiscovery,` away from that anchor does.
    expect(index).toMatch(/buildWeeklyBriefing\(\{[\s\S]*?strategyBriefMalformed,\s*badgeRepoDiscovery\s*\}/)
  })

  it('the discovery step actually reads GH_CODE_SEARCH_TOKEN and persists to badge:repos:seen', () => {
    expect(index).toMatch(/searchBadgeEmbeds\(env\.GH_CODE_SEARCH_TOKEN\)/)
    expect(index).toContain("env.STATUS_CACHE.get('badge:repos:seen')")
    expect(index).toContain("env.STATUS_CACHE.put('badge:repos:seen'")
  })

  it('threads the KV-parsed previouslySeen (not a literal empty array) into diffBadgeRepoDiscovery', () => {
    // Anchors on the actual variable name `parseBadgeReposSeen` assigns to. If a future edit called
    // diffBadgeRepoDiscovery(results, []) — reproducing the exact regression a review agent found in
    // the first version of this feature — this fails while the test above (which only checks
    // `badgeRepoDiscovery` reaches buildWeeklyBriefing) would stay green.
    expect(index).toMatch(/const previouslySeen = parseBadgeReposSeen\(seenRaw\)/)
    expect(index).toMatch(/diffBadgeRepoDiscovery\(results, previouslySeen\)/)
  })

  it('skips the KV read result (fail-closed) rather than substituting an empty baseline on a read throw', () => {
    // Pins the #992 component-seen: precedent this deliberately follows — a caught .get() rejection
    // must set a flag the caller checks, not resolve to a bare `null` that reads identically to a
    // genuinely-absent key.
    expect(index).toMatch(/readFailed = true/)
    expect(index).toMatch(/if \(!readFailed\)/)
  })

  it('gates the badge:repos:seen write on there being something new (skip-write-when-unchanged)', () => {
    // Mirrors component-seen:'s `newComponents.length === 0` no-write branch. Cheap KV-budget
    // optimization, not a correctness guard (an unconditional write would be a harmless no-op — see
    // diffBadgeRepoDiscovery's tests) — pinned anyway so a future edit doesn't silently drop it.
    expect(index).toMatch(/if \(diff\.newRepos\.length > 0\)/)
  })
})
