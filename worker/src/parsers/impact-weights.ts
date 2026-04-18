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
