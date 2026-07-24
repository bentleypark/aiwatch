import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// #1157 — source-scan wiring guard, in the repo's sync-test idiom (ai-usage-wiring / api-tier-sync /
// first-estimate-write-paths).
//
// WHAT THIS IS NOT: a substitute for daily-summary.test.ts's `buildDailySummary({...badgeTraffic})`
// unit test, which pins the pure data→output contract (does the formatter render given the field).
//
// WHAT THIS IS: a guard on the WIRING between `queryBadgeTraffic`'s result and that pure contract —
// the exact regression this PR originally shipped. `badgeTraffic` was computed in index.ts's daily-
// summary cron assembly but never threaded into the `buildDailySummary({...})` call object. Every
// unit test passed (formatBadgeTrafficSection tested in isolation, buildDailySummary tested with its
// own hand-built literal) because none of them touch index.ts's actual object literal — confirmed by
// two independent PR-review agents, who reverted the fix and reran the full suite green. A pure-fn
// test cannot see this class of bug ("순수fn 초록 ≠ 배선 초록"); only a scan of the real call site can.
const SRC = join(__dirname, '..')
const index = readFileSync(join(SRC, 'index.ts'), 'utf8')

describe('#1157 — badgeTraffic wiring into the production buildDailySummary(...) call', () => {
  it('threads badgeTraffic into the object literal, anchored right after feedTraffic', () => {
    // Anchored on the `feedTraffic,` line (its closest established sibling — same #518/#548 lineage)
    // so a reorder of unrelated fields above it doesn't break the match, but dropping or relocating
    // `badgeTraffic,` away from that anchor does. Mutation-verified: deleting the `badgeTraffic,` line
    // from index.ts (reproducing the original bug) fails this assertion; every other test in the suite
    // stays green.
    expect(index).toMatch(/buildDailySummary\(\{[\s\S]*?feedTraffic,\s*\n\s*badgeTraffic,/)
  })
})
