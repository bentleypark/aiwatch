// Shared reliability predicates for a service's score/uptime data (#591). Centralized so every
// surface (Ranking, Uptime, Overview, Sidebar, ServiceDetails; mirrored in api/is-down.ts) makes the
// SAME include/exclude decision — the #591 bug was three surfaces drifting from the original copy.
//
// Two distinct "unreliable" cases:
//   • estimate-no-data — `uptimeSource: 'estimate'` with no incidents (bedrock/azureopenai): no
//     measured basis, so uptime/score are an industry-average assumption, not a real figure.
//   • stale-source (#591) — the status page migrated to a server-side-unreachable platform, so the
//     feed AIWatch reads is FROZEN (DeepSeek → Flashduty, #507). uptime30d + incidents read as
//     current but aren't; an empty 30-day window inflates the Score (full incidents+recovery from
//     MISSING data). Flagged per-service by the worker via ServiceStatus.incidentSourceStale.

/** Estimate-uptime service with no incidents — no measured basis for uptime/score. */
export const isEstimateNoData = (s) => s.uptimeSource === 'estimate' && (s.incidents ?? []).length === 0

/** Uptime30d is not a reliable current figure — either estimate-no-data or a frozen stale source.
 *  Use to exclude from uptime ranking/sort/averages and to blank uptime displays. */
export const isUnreliableUptime = (s) => isEstimateNoData(s) || !!s.incidentSourceStale

/** The AIWatch Score is trustworthy enough to RANK this service. Excludes estimate-no-data and
 *  stale-source services (a frozen empty incident window scores full incidents+recovery from
 *  missing data). Mirror of api/is-down.ts:hasReliableData. */
export const hasReliableScoreData = (s) => !isEstimateNoData(s) && !s.incidentSourceStale
