// Atlassian-style impact weights for uptime calculation.
// Shared by statuspage.ts (official component_uptimes) and incident-io.ts
// (estimate from incident durations) so both sources produce comparable uptime%.
// Reference: Statuspage's `(major × 1.0 + partial × 0.3) / windowSec` formula. (#259)

export const MAJOR_WEIGHT = 1.0
export const MINOR_WEIGHT = 0.3

/** Maps incident.io impact severity strings to weights.
 *  null = informational (skipped); missing key = unknown level (skipped + logged by caller). */
export const INCIDENT_IO_IMPACT_WEIGHTS: Record<string, number> = {
  critical: MAJOR_WEIGHT,
  major: MAJOR_WEIGHT,
  minor: MINOR_WEIGHT,
}

/** #1006 — incident.io `component_impacts[].status` → the SAME weights Atlassian's uptimeData uses, so
 *  both parser families compute uptime with one formula (the precondition the Reliability Ranking has
 *  always implicitly claimed). Atlassian's own buckets are `m` (major outage, 1.0) and `p` (partial,
 *  0.3); incident.io's three states map onto them:
 *    full_outage        → a full outage of the component            → MAJOR_WEIGHT
 *    partial_outage     → some capacity affected                    → MINOR_WEIGHT
 *    degraded_performance → slow but serving                        → MINOR_WEIGHT
 *  `under_maintenance` is EXCLUDED (weight 0): planned maintenance is not downtime, and Atlassian's
 *  uptimeData excludes it too — counting it would penalise providers for announcing their windows.
 *  An unknown status is skipped and warned about by the caller (a new incident.io state would otherwise
 *  silently read as zero downtime). */
export const INCIDENT_IO_STATUS_WEIGHTS: Record<string, number> = {
  full_outage: MAJOR_WEIGHT,
  partial_outage: MINOR_WEIGHT,
  degraded_performance: MINOR_WEIGHT,
  under_maintenance: 0,
}
