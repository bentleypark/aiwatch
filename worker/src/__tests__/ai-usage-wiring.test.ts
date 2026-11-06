import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// #1080 — source-scan wiring guard, in the repo's sync-test idiom (first-estimate-write-paths /
// feed-slug-sync).
//
// WHAT THIS IS: a guard on the WIRING between `applyAttempt` and its call sites, which is the half a pure-
// function test cannot see ("순수fn 초록 ≠ 배선 초록"). Two regressions are cheap to introduce and
// invisible to every other test:
//
//   1. Passing the display NAME where the id belongs. `ai:usage.timedOutBy` is only useful because it is
//      keyed the same way the alert-scope sets are (`alerts.ts`) — by id. A swap produces attribution that looks
//      populated and answers nothing, and no assertion on the pure fn would notice.
//   2. A NEW `recordUsage` call site that omits the service id. TypeScript catches a missing argument
//      today because the param is required — but a future author reaching for a defensive `''` or `any`
//      would slip through, re-creating the unattributed blind spot this issue exists to remove.
//
// Guards default to passing, so each assertion below is mutation-verified in both directions (see the
// PR): flip the wiring and the corresponding test must go red.

const SRC = join(__dirname, '..')
const read = (f: string) => readFileSync(join(SRC, f), 'utf8')

describe('#1080 — ai:usage attribution wiring', () => {
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
})
