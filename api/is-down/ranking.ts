// #787 — competition-ranking position for a service within the reliability-ranked set, extracted
// from is-down.ts so the rank + tie DERIVATION is unit-testable WITHOUT live score data. The old
// e2e (tests/is-down.spec.js) asserted a LIVE score tie existed among 6 services, which false-failed
// whenever scores drifted apart (it blocked unrelated PR #786's Edge E2E). This pure helper lets the
// derivation be guarded deterministically; the render branch is guarded separately in
// api/is-down/__tests__/html-template.test.ts.
//
// `scoredDesc` = the services that passed the rank filters (finite aiwatchScore + reliable data),
// already sorted by score DESCENDING. `targetScore` = the target service's ROUNDED aiwatchScore.
// Ranking is by ROUNDED score (competition ranking: tied services share the FIRST position — the
// findIndex gives that first-tied slot), matching the dashboard Ranking page.
export function computeRankPosition(
  scoredDesc: Array<{ aiwatchScore: number }>,
  targetScore: number,
): { rank: number; tied: boolean; total: number } {
  const rounded = scoredDesc.map((s) => Math.round(s.aiwatchScore))
  const rank = rounded.findIndex((s) => s === targetScore) + 1 // 0 = not found (caller guards rank > 0)
  const tied = rounded.filter((s) => s === targetScore).length > 1
  return { rank, tied, total: scoredDesc.length }
}
