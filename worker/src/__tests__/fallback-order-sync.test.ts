// #1186 — pin the cross-mirror sync of `orderForFallback`, the candidate-ordering algorithm behind
// every fallback recommendation surface (Discord alerts, dashboard Action banner/AnalysisModal, is-down
// SEO pages). Same three independent copies as api-tier-sync.test.ts (see that file's header for why
// they can't share code — separate compilation surfaces: Worker / Vite SPA / Vercel Edge Function):
//   1. worker/src/fallback.ts     — canonical
//   2. src/utils/constants.js     — frontend
//   3. api/is-down.ts             — Edge SSR (inline, read via fs — can't be imported)
//
// #1186's own history is the reason this test exists: the fix (tier-distance first, then a
// confidence-aware ordering instead of a raw cross-tier Score comparison — see fallback.ts's
// orderForFallback doc comment for the full 4-design history) was implemented in the worker FIRST and
// only caught missing from the other two copies when asked directly whether it was live everywhere. A
// behavioral sync test — run the SAME fixtures through both importable copies and diff the output —
// would have failed loudly the moment either mirror lagged, instead of silently shipping a partial fix.
// It also would have caught the SECOND regression in this same feature: an early round-robin attempt
// gave a `low`-confidence (score-withheld) candidate its own guaranteed slot, resurrecting exactly what
// the pre-#1186 `?? 0` sink existed to prevent (see the 'low sinks below real scores' fixture below).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { orderForFallback as workerOrder } from '../fallback'
// Vitest resolves cross-package paths via the repo root — see api-tier-sync.test.ts for why this works.
import { orderForFallback as frontendOrder } from '../../../src/utils/constants'

const REPO_ROOT = join(__dirname, '..', '..', '..')

// Representative candidate sets covering every case #1186 had to reason through: a straight high-vs-
// medium score inversion, a same-confidence tiebreak, a lone medium candidate at various pool-size
// ratios against high peers (the boundary where the proportional interleave includes vs excludes it),
// the exact 3-candidate mix that broke an early comparator-based attempt's transitivity, and a
// low-confidence (score-withheld) candidate that must sink below both real-scored tiers. Ids are shared
// between the worker and frontend API_TIER maps (pinned by api-tier-sync.test.ts), so `sourceTier`
// (tier 1 or 2, as noted) is valid identically on both sides.
const FIXTURES: Array<{ label: string; sourceTier?: number; candidates: Array<{ id: string; aiwatchScore: number | null; scoreConfidence?: string }> }> = [
  {
    label: 'high(85) + medium(92, higher raw score)',
    candidates: [
      { id: 'claude', aiwatchScore: 85, scoreConfidence: 'high' },
      { id: 'gemini', aiwatchScore: 92, scoreConfidence: 'medium' },
    ],
  },
  {
    label: 'same confidence, different scores',
    candidates: [
      { id: 'claude', aiwatchScore: 70, scoreConfidence: 'high' },
      { id: 'gemini', aiwatchScore: 92, scoreConfidence: 'high' },
    ],
  },
  {
    label: '2 high + 1 medium (comparable pool sizes — medium competitive)',
    sourceTier: 2,
    candidates: [
      { id: 'mistral', aiwatchScore: 95, scoreConfidence: 'high' },
      { id: 'cohere', aiwatchScore: 90, scoreConfidence: 'high' },
      { id: 'xai', aiwatchScore: 60, scoreConfidence: 'medium' },
    ],
  },
  {
    label: 'lone medium among 3 high peers (lopsided pool — medium fades out)',
    sourceTier: 2,
    candidates: [
      { id: 'mistral', aiwatchScore: 95, scoreConfidence: 'high' },
      { id: 'cohere', aiwatchScore: 90, scoreConfidence: 'high' },
      { id: 'groq', aiwatchScore: 85, scoreConfidence: 'high' },
      { id: 'xai', aiwatchScore: 60, scoreConfidence: 'medium' },
    ],
  },
  {
    label: 'the exact A/B/C mix that broke the rejected 0-on-mismatch comparator\'s transitivity',
    sourceTier: 2,
    candidates: [
      { id: 'mistral', aiwatchScore: 90, scoreConfidence: 'high' },   // A
      { id: 'xai', aiwatchScore: 95, scoreConfidence: 'medium' },     // B
      { id: 'cohere', aiwatchScore: 70, scoreConfidence: 'high' },    // C
    ],
  },
  {
    label: 'low (score-withheld) sinks below both high and medium, never displaces a real score',
    sourceTier: 2,
    candidates: [
      { id: 'mistral', aiwatchScore: 95, scoreConfidence: 'high' },
      { id: 'cohere', aiwatchScore: 90, scoreConfidence: 'high' },
      { id: 'groq', aiwatchScore: null, scoreConfidence: 'low' },
    ],
  },
  {
    label: 'no scoreConfidence on any candidate (degrades to plain Score order)',
    candidates: [
      { id: 'claude', aiwatchScore: 70, scoreConfidence: undefined as unknown as string },
      { id: 'gemini', aiwatchScore: 92, scoreConfidence: undefined as unknown as string },
    ],
  },
  {
    label: 'an unrecognized scoreConfidence value sinks below high/medium, never vanishes',
    sourceTier: 2,
    candidates: [
      { id: 'mistral', aiwatchScore: 95, scoreConfidence: 'high' },
      { id: 'cohere', aiwatchScore: 90, scoreConfidence: 'high' },
      { id: 'groq', aiwatchScore: 99, scoreConfidence: 'insufficient' }, // would win #1 on raw Score alone
    ],
  },
]

describe('orderForFallback cross-mirror sync (#1186)', () => {
  it.each(FIXTURES)('worker/src/fallback.ts ≡ src/utils/constants.js — $label', ({ candidates, sourceTier: st }) => {
    const sourceTier = st ?? 1
    const workerResult = workerOrder(candidates, sourceTier).map(c => c.id)
    const frontendResult = frontendOrder(candidates, sourceTier).map(c => c.id)
    expect(frontendResult).toEqual(workerResult)
  })

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
