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
