// Shared reliability predicates for a service's score/uptime data (#591). Centralized so every
// surface (Ranking, Uptime, Overview, Sidebar, ServiceDetails; mirrored in api/is-down.ts) makes the
// SAME include/exclude decision — the #591 bug was three surfaces drifting from the original copy.
//
// Two distinct "unreliable" cases:
//   • estimate-no-data — `uptimeSource: 'estimate'` with no measured basis: the WORKER computes the
//     estimate over the 90-day incident set (live RSS ∪ archived `incidents:monthly`, #653) and only
//     emits `uptime30d` when that set has an IMPACTFUL incident; an informational-only / empty set
//     leaves `uptime30d` null (no baseless 100%). So the basis check is simply "estimate source with a
//     null uptime" — the worker is the single source of truth for the 90-day basis (card incident
//     COUNT stays live; only the uptime% spans 90 days).
//   • stale-source (#591) — the status page migrated to a server-side-unreachable platform, so the
//     feed AIWatch reads is FROZEN (DeepSeek → Flashduty, #507). uptime30d + incidents read as
//     current but aren't; an empty 30-day window inflates the Score (full incidents+recovery from
//     MISSING data). Flagged per-service by the worker via ServiceStatus.incidentSourceStale.

/** Estimate-uptime service with no measured basis — the worker leaves `uptime30d` null when its
 *  90-day incident set (live ∪ archive) has no impactful incident (#591, #653). */
export const isEstimateNoData = (s) => s.uptimeSource === 'estimate' && s.uptime30d == null

/** Estimate service whose source is WORKING (not frozen/stale) but had NO impactful incident in the
 *  90-day basis — so the null uptime means "no reliability incidents in this period", NOT "no data
 *  source". Drives the honest display wording (#707): "No reliability incidents in this period" instead
 *  of "Not provided". (A null-impact advisory like the AWS compliance access-revocation, #707, is not an
 *  impactful incident, so a service whose only event is such an advisory lands here.) */
export const isEstimateNoIncidents = (s) => isEstimateNoData(s) && !s.incidentSourceStale

/** Uptime30d is not a reliable current figure — either estimate-no-data or a frozen stale source.
 *  Use to exclude from uptime ranking/sort/averages and to blank uptime displays. */
export const isUnreliableUptime = (s) => isEstimateNoData(s) || !!s.incidentSourceStale

/** The AIWatch Score is trustworthy enough to RANK this service. Excludes estimate-no-data and
 *  stale-source services (a frozen empty incident window scores full incidents+recovery from
 *  missing data). Mirror of api/is-down.ts:hasReliableData. */
export const hasReliableScoreData = (s) => !isEstimateNoData(s) && !s.incidentSourceStale
