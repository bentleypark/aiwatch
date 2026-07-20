import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// #1080 — source-scan wiring guard, in the repo's sync-test idiom (first-estimate-write-paths /
// api-tier-sync / feed-slug-sync).
//
// WHAT THIS IS NOT: proof that the #882 hold works. Nothing in this repo invokes the cron `scheduled`
// handler, so the hold/release path has no behavioral harness — that absence is precisely why #882 is
// production-gated in the first place, and this file does not change that. The pure folds
// (`applyAttempt` / `applyHoldEvent` / `timedOutAttribution` / `holdLedger`) are behaviorally tested and
// mutation-verified in `ai-analysis.test.ts`.
//
// WHAT THIS IS: a guard on the WIRING between those folds and the call sites, which is the half a pure-
// function test cannot see ("순수fn 초록 ≠ 배선 초록"). Two regressions are cheap to introduce and
// invisible to every other test:
//
//   1. Passing the display NAME where the id belongs. `ai:usage.timedOutBy` is only useful because it is
//      keyed the same way `TIER1_IDS` is (`alerts.ts`) — by id. A swap produces attribution that looks
//      populated and answers nothing, and no assertion on the pure fn would notice.
//   2. A NEW `recordUsage` call site that omits the service id. TypeScript catches a missing argument
//      today because the param is required — but a future author reaching for a defensive `''` or `any`
//      would slip through, re-creating the unattributed blind spot this issue exists to remove.
//
// Guards default to passing, so each assertion below is mutation-verified in both directions (see the
// PR): flip the wiring and the corresponding test must go red.

const SRC = join(__dirname, '..')
const read = (f: string) => readFileSync(join(SRC, f), 'utf8')

describe('#1080 — ai:usage attribution + #882 hold-ledger wiring', () => {
  const index = read('index.ts')

  it('passes the service ID (not just the display name) into the budgeted inline analysis', () => {
    // The one production call site. `{ id: svc.id, name: svc.name }` — an object precisely so the two
    // strings cannot be transposed positionally.
    expect(index).toMatch(/analyzeIncidentWithBudget\(\s*\n\s*env\.STATUS_CACHE,[^\n]*\{\s*id:\s*svc\.id,\s*name:\s*svc\.name\s*\}/)
  })

  it('gives every recordUsage call site in BOTH writer files a service id — no unattributed bookkeeping', () => {
    // Assert the LAST argument is an identifier-shaped service id. An earlier version of this guard
    // counted top-level commas after stripping `{ ... }` with a single `String.replace` pass — which
    // only collapses the INNERMOST braces, so the outer object literal's commas survived and a call
    // site that had dropped its id still counted 4 "arguments". It passed while genuinely blind; the
    // mutation that was supposed to prove it only happened to hit one of the two shapes. Match the
    // token instead of counting separators.
    // Scan BOTH writer files: `refreshOrReanalyze` in ai-analysis.ts books usage on its own paths, so
    // scanning only index.ts would leave the same regression free to land three call sites over.
    for (const file of ['index.ts', 'ai-analysis.ts']) {
      const src = read(file)
      // `await recordUsage(` — anchoring on the bare name also matched `export async function
      // recordUsage(...)`, whose non-greedy span ran into the body and passed only because that line
      // happens to end in `svcId)`. Every real call site is awaited, so this excludes the declaration
      // without losing coverage.
      const calls = [...src.matchAll(/await recordUsage\(([\s\S]*?)\)\s*$/gm)]
      expect(calls.length, `expected recordUsage call sites in ${file}`).toBeGreaterThan(0)
      for (const [whole] of calls) {
        expect(whole, `${file}: recordUsage call is missing its trailing service id: ${whole}`)
          .toMatch(/,\s*(svcId|svc\.id|service\.id)\s*\)\s*$/)
      }
    }
  })

  it('books the hold exactly once, and only inside the first-sight branch', () => {
    // Count is not enough: MOVING the single bump into the `} else {` re-hold branch keeps the count
    // at 1 and breaks the invariant this test is named for (re-holds fire every cron cycle). So also
    // anchor it — the bump must sit between the pending:ai stamp and the `} else {` that begins the
    // re-hold branch.
    const heldBumps = [...index.matchAll(/recordHoldEvent\([^)]*'held'\)/g)]
    expect(heldBumps.length, "expected exactly one 'held' bump (first-sight only)").toBe(1)

    const stamp = index.indexOf('kvPut(env.STATUS_CACHE, pendingAiKey(incId)')
    const bump = index.indexOf("recordHoldEvent(env.STATUS_CACHE, nowMs, 'held')")
    // NOT `indexOf('} else {')` — the first one after the stamp is the inner `if (!ok)` else, which is
    // where the bump correctly lives. Anchor on the OUTER re-hold branch by its own shape instead.
    const reHold = index.slice(stamp).search(/\n {8}\} else \{\n {10}heldNewAlertKeys\.add/)
    expect(stamp, 'pending:ai stamp not found').toBeGreaterThan(-1)
    expect(reHold, 're-hold else branch not found — has the hold block been restructured?').toBeGreaterThan(-1)
    expect(bump, 'the held bump must follow the first-sight stamp').toBeGreaterThan(stamp)
    expect(bump - stamp, 'the held bump must NOT live in the per-cycle re-hold branch').toBeLessThan(reHold)
  })

  it('distinguishes a release WITH the AI section from one without', () => {
    // This ternary IS #882's question. Collapsing it to a single constant would leave the ledger
    // unable to tell the fix working from the alert shipping AI-less anyway.
    expect(index).toMatch(/recordHoldEvent\([^)]*aiReady \? 'releasedWithAi' : 'releasedWithoutAi'\)/)
  })

  it('books the release before deleting the marker, so a failed delete cannot lose it', () => {
    const release = index.indexOf("aiReady ? 'releasedWithAi'")
    const del = index.indexOf('kvDel(env.STATUS_CACHE, pendingAiKey(incId))')
    expect(release, 'release bump not found').toBeGreaterThan(-1)
    expect(del, 'marker delete not found').toBeGreaterThan(-1)
    expect(release, 'the ledger write must precede the best-effort delete').toBeLessThan(del)
  })
})
