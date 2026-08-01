// Shared reliability predicates for a service's score/uptime data (#591). Centralized so every
// surface (Ranking, Uptime, Overview, Sidebar, ServiceDetails; mirrored in api/is-down.ts) makes the
// SAME include/exclude decision — the #591 bug was three surfaces drifting from the original copy.
//
// Two distinct "no reliable uptime" cases:
//   • no-official-uptime (#713) — the service has NO official rolling uptime % (Bedrock/Azure are
//     incident-feed-only; a rare incident.io component lacks `component_uptimes`; or a transient gap).
//     AIWatch no longer INVENTS a value for these (the old `uptimeSource: 'estimate'` was removed) —
//     the worker leaves `uptime30d` null. The service is still incident-tracked and scored on
//     incidents + recovery (low confidence), but has no uptime % to display or rank.
//   • stale-source (#591) — the status page migrated to a server-side-unreachable platform, so the
//     feed AIWatch reads is FROZEN (DeepSeek → Flashduty, #507). uptime30d + incidents read as
//     current but aren't; an empty 30-day window would inflate the Score from MISSING data. Flagged
//     per-service by the worker via ServiceStatus.incidentSourceStale.

/** No official uptime % to show — `uptime30d` is null and the feed is NOT frozen/stale. The honest
 *  "official-first, no invented value" state (#713): display "No official uptime — incident-tracked". */
export const noOfficialUptime = (s) => s.uptime30d == null && !s.incidentSourceStale

/** Uptime30d is not a reliable current figure — either no official uptime, or a frozen stale source.
 *  Use to exclude from uptime ranking/sort/averages and to blank uptime displays. */
export const isUnreliableUptime = (s) => s.uptime30d == null || !!s.incidentSourceStale

/** #802 — minimum days of AIWatch coverage before a service is eligible for the Reliability Ranking
 *  (mirror of worker MIN_COVERAGE_DAYS). */
export const MIN_COVERAGE_DAYS = 30

/** #802 — the service has been monitored long enough to rank fairly. `coverageDays` is absent for an
 *  established service (added well before the window) → full coverage; a recently-added service carries
 *  `coverageDays < 30` and is held out of the ranking (its incident/recovery/responsiveness Score
 *  components are based on a thin observed window → would rank off insufficient data). */
export const hasSufficientCoverage = (s) => s.coverageDays == null || s.coverageDays >= MIN_COVERAGE_DAYS

/** The AIWatch Score is trustworthy enough to RANK this service (#713). Needs a live (non-stale) feed
 *  AND `scoreConfidence !== 'low'` — i.e. at least one SUBSTANTIAL measured signal beyond incidents+
 *  recovery. score.ts sets confidence `high` (official uptime), `medium` (no uptime but a real probe),
 *  `low` (NEITHER uptime nor probe — e.g. Bedrock/Azure, scored on only 2 components → over-scores
 *  under the rescale). A `low` service is shown on its detail page but kept OUT of the ranking. #802 —
 *  ALSO requires ≥30d of coverage (a recently-added service is shown on its detail page but kept out of
 *  the ranking until it accrues a full window). Mirror of api/is-down.ts:hasReliableData. */
export const hasReliableScoreData = (s) =>
  !s.incidentSourceStale && s.scoreConfidence !== 'low' && hasSufficientCoverage(s)

/** #1186 — split an already-`hasReliableScoreData`-filtered array into confidence tiers for the
 *  ranking. A 'high' score (official uptime measured) and a 'medium' score (no official uptime — the
 *  #713 rescale fills the missing Uptime component at the FIXED ratio 40/60 of the other three (not an
 *  empirical average — it's `UPTIME_SCORE_MAX / (INCIDENTS+RECOVERY+RESPONSIVENESS_SCORE_MAX)`), which is
 *  mathematically an imputed uptime figure, not an absence of one) are NOT on the same scale despite
 *  sharing a 0-100 range: the rescale is systematically more generous than a real, moderately-bad measured
 *  uptime would be (verified: holding I/R/P at 25/15/12.5, the rescaled medium score is 87.5, while a
 *  service genuinely MEASURED at 96% uptime with the same I/R/P scores only 60.5 — score.ts's uptime curve
 *  maps 95-100% linearly onto 0-40, so 96% actual uptime is a mere uptimeScore of 8 — i.e. the rescaled
 *  score sits **27 points above** the real one, not below; a "no value assumed" score should not routinely
 *  outscore a real-but-imperfect measurement). Two ranked tables, never merged into one shared rank
 *  sequence — `scored` is assumed pre-filtered to `high`/`medium` only (never `low`, which
 *  `hasReliableScoreData` already excludes), so this only partitions; the caller re-derives rank per tier
 *  (array index), same as the existing tied-rank logic. */
export const splitByConfidence = (scored) => ({
  high: scored.filter((s) => s.scoreConfidence === 'high'),
  medium: scored.filter((s) => s.scoreConfidence === 'medium'),
})

/** #870 — the service HAS a probe target but hasn't accrued ≥7d of samples yet, so score.ts marks its
 *  Responsiveness `insufficient` and confidence falls to `low`. `scoreBreakdown.responsivenessStatus`
 *  (score.ts `ProbeContext.kind`) distinguishes this WARMING state from `unsupported` (no probe target
 *  ever — Bedrock/Azure/apps/agents). It's the signal that a low-confidence service will become
 *  rankable once its probe warms, so the ranking page treats it as "recently added", not "no data". */
export const isProbeWarming = (s) => s.scoreBreakdown?.responsivenessStatus === 'insufficient'

/** #802/#870 — a NOT-YET-RANKED service is "Recently Added" (building data, `ranks in Nd`) — as opposed
 *  to "Insufficient Data" (genuinely un-measurable) — when it has a live feed + a <30d window AND either
 *  (a) it is ALREADY scorable (non-null score, non-low confidence) and only the 30d coverage gate holds
 *  it out, OR (b) its only disqualifier is a WARMING probe (a new probe target, e.g. turbopuffer days
 *  1-7): it has no official uptime yet by design + a probe that will reach `available` at ~7d, so it WILL
 *  rank — it must not be lumped with Bedrock/Azure (unsupported, no probe) or a stale feed. */
export const isRecentlyAdded = (s) =>
  !s.incidentSourceStale && s.coverageDays != null && s.coverageDays < MIN_COVERAGE_DAYS
  && ((s.aiwatchScore != null && s.scoreConfidence !== 'low') || isProbeWarming(s))

/** #1186 — rank one confidence tier's array independently. Sorted by score descending; `rank`/`isTied`
 *  are derived from the array (competition ranking: ties share a rank, the next distinct score skips
 *  ahead), same logic Ranking.jsx used pre-split. Callers pass ONE tier at a time (never a mixed
 *  high+medium array) — see splitByConfidence for why the two must never share a rank sequence. */
export const rankTier = (arr) => [...arr]
  .sort((a, b) => b.aiwatchScore - a.aiwatchScore)
  .map((svc, i, sorted) => {
    const score = Math.round(svc.aiwatchScore)
    const rank = sorted.findIndex((s) => Math.round(s.aiwatchScore) === score) + 1
    const isTied = sorted.filter((s) => Math.round(s.aiwatchScore) === score).length > 1
    return { ...svc, rank, isTied }
  })

// #1186 — warn-once set for buildRanking's orphaned-confidence guard below. `buildRanking` runs inside
// a `useMemo` keyed on a freshly-filtered `services` array every render (Ranking.jsx never memoizes
// input identity), so an un-deduped warn would fire on every render for as long as the page stays open
// — matching the warn-once shape already used elsewhere in this codebase (fallback.ts's tierFor, etc.).
const warnedOrphanedIds = new Set()

/** #1186 — the full Ranking-page assembly: filter to reliable-score services, split by confidence tier,
 *  rank each tier independently, and bucket the rest into "recently added" vs "insufficient data" by
 *  reason (#802/#870). Pulled out of Ranking.jsx as a pure function so the wiring #1186 exists to
 *  protect (tier split → independent rank sequences → podium sourced from `high` only) has direct test
 *  coverage, not just coverage of its pieces in isolation. */
export const buildRanking = (services) => {
  const eligible = services.filter((s) => s.aiwatchScore != null && hasReliableScoreData(s))
  const { high, medium } = splitByConfidence(eligible)
  const scoredHigh = rankTier(high)
  const scoredMedium = rankTier(medium)
  // #1186 — splitByConfidence only recognizes 'high'/'medium' by strict ===, and hasReliableScoreData
  // only excludes 'low' — so a service with any OTHER scoreConfidence (undefined, or a legacy/future
  // value) passes eligibility but lands in NEITHER bucket above. Pre-#1186 this partition was strictly
  // binary (scored vs not) and such a service still rendered; route it to `insufficient` instead of
  // letting it silently vanish from the page. Unreachable from a single score.ts compute (`confidence`
  // is a non-optional 'high'|'medium'|'low' union there, #713 — see monthly-archive.ts:801's analogous
  // #1016 `scoreConfidence == null` guard), but this app persists monthly-archive/KV snapshots across
  // deploys, and a legacy record predating this field is a plausible real vector.
  const orphaned = eligible.filter((s) => s.scoreConfidence !== 'high' && s.scoreConfidence !== 'medium')
  const newlyOrphaned = orphaned.filter((s) => !warnedOrphanedIds.has(s.id))
  if (newlyOrphaned.length > 0) {
    newlyOrphaned.forEach((s) => warnedOrphanedIds.add(s.id))
    console.warn(`[buildRanking] ${newlyOrphaned.map((s) => s.id).join(', ')} passed hasReliableScoreData but scoreConfidence is neither 'high' nor 'medium' — routed to insufficient instead of vanishing from the Ranking page`)
  }
  const na = services.filter((s) => s.aiwatchScore == null || !hasReliableScoreData(s))
  const recentlyAdded = na.filter(isRecentlyAdded)
  const recentIds = new Set(recentlyAdded.map((s) => s.id))
  const insufficient = [...na.filter((s) => !recentIds.has(s.id)), ...orphaned]
  return { scoredHigh, scoredMedium, recentlyAdded, insufficient }
}
