// #1186 — pin the cross-mirror sync of `orderForFallback`, the candidate-ordering algorithm behind
// every fallback recommendation surface (Discord alerts, dashboard Action banner/AnalysisModal, is-down
// SEO pages). src/utils/constants.js imports the worker's copy (#1191); api/is-down.ts still carries
// an inline copy (read via fs — can't be imported). Its behaviour is unit-tested in fallback.test.ts.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(__dirname, '..', '..', '..')

describe('orderForFallback cross-mirror sync (#1186)', () => {
  it('api/is-down.ts carries an inline orderForFallback with the same proportional-interleave structure', () => {
    // Can't import (separate compilation surface — see file header). String-match the load-bearing
    // shape: the confidence-aware proportional merge, not just "a function with this name exists".
    // Catches the failure mode that actually happened TWICE here (the mirror never being updated at
    // all, and — the second time — being updated to an earlier, since-rejected design), not a rewrite
    // that reaches the same behavior through different code shape.
    const isDownSource = readFileSync(join(REPO_ROOT, 'api', 'is-down.ts'), 'utf8')
    expect(isDownSource, 'api/is-down.ts is missing an inline orderForFallback').toMatch(/orderForFallback\s*=/)
    // The rank-fraction formula — a reasonable proxy for "the proportional interleave is actually wired
    // in", not just declared.
    expect(isDownSource).toMatch(/\(rank \+ 0\.5\)\s*\/\s*bucket\.length/)
    // Every REMAINING bucket (not a hardcoded ['low', '__none__'] pair) must sink after the high/medium
    // interleave — a hardcoded 2-key list is exactly the shape of the regression this pins: a candidate
    // whose scoreConfidence is neither 'high'/'medium' nor literally 'low'/undefined (a legacy KV
    // record predating a future confidence value) was bucketed but never pushed to the result.
    expect(isDownSource).toMatch(/for \(const \[key, bucket\] of byConfidence\)/)
    // #1682 — the uncorroborated predicate and its bucket are wired in, not just declared.
    expect(isDownSource).toMatch(/c\.scoreConfidence === 'high' && c\.scoreMetrics\?\.incidents30d === 0 && c\.scoreBreakdown\?\.responsivenessStatus === 'unsupported'/)
    expect(isDownSource).toMatch(/isUncorroborated\(c\) \? 'uncorroborated'/)
    expect(isDownSource).toMatch(/byConfidence\.get\('uncorroborated'\)/)
    expect(isDownSource).not.toMatch(/for \(const key of \['low',\s*'__none__'\]\)/)
    // The rejected 1-per-tier-per-round shape (attempt 3) must NOT reappear: it gave 'low' its own
    // round-0 slot via this exact 4-key priority array.
    expect(isDownSource).not.toMatch(/\['high',\s*'medium',\s*'low',\s*'__none__'\]/)
    // The old bug's shape must NOT reappear inside the fallback candidate sort: a raw cross-tier Score
    // comparison with no confidence check. This is deliberately narrow (matches the exact pre-#1186
    // one-liner) rather than banning `aiwatchScore ?? 0` outright, which the ranking-rank block above
    // this in the same file legitimately uses for an unrelated, already-tier-scoped comparison (#1186's
    // OTHER fix in this file).
    expect(isDownSource).not.toMatch(/return \(\(b as any\)\.aiwatchScore \?\? 0\) - \(\(a as any\)\.aiwatchScore \?\? 0\)/)
  })
})
