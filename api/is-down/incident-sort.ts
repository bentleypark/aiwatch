// Server-side sort helper for /is-X-down SSR pages.
//
// Mirrors `compareGroupedRows` from `src/utils/incidentSort.js` — duplicated
// rather than shared because Vercel Edge bundling cannot import from `src/`.
// Tier semantics (investigating/identified/ongoing → monitoring → resolved)
// must stay aligned with the SPA file. If you need other helpers from the
// SPA file here, port them deliberately rather than re-deriving locally.
//
// Why this exists: `groupIncidents` re-sorts purely by representative date,
// so an active investigating/monitoring incident can land below newer
// resolved rows. `compareGroupedRows` lifts active rows back above resolved
// by tier — keep this implementation in lockstep with the SPA copy.

import type { GroupedRow } from './incident-grouping'

const STATUS_PRIORITY: Record<string, number> = {
  investigating: 0,
  identified: 0,
  ongoing: 0,
  monitoring: 1,
  resolved: 2,
}

// Includes both the normalized 'ongoing' alias and raw worker statuses so
// `dominantGroupStatus` works whether the caller pre-normalizes or not.
// Kept aligned with the SPA `STATUS_ORDER` for the same reason.
const STATUS_ORDER = ['ongoing', 'investigating', 'identified', 'monitoring', 'resolved']

function dominantGroupStatus(group: { uniformStatus?: boolean; statusCounts: Record<string, number> }): string {
  if (group.uniformStatus) {
    const keys = Object.keys(group.statusCounts)
    return keys[0] ?? 'resolved'
  }
  return STATUS_ORDER.find((s) => group.statusCounts[s]) ?? 'resolved'
}

/**
 * Comparator for `groupIncidents()` output rows. Sorts by tier
 * (ongoing → monitoring → resolved). Within a tier, the spec-stable
 * `Array.prototype.sort` (ES2019+) preserves input order — callers must
 * therefore pass `groupIncidents()` output (already newest-first); sorting
 * an unsorted list will not yield newest-first within tiers.
 */
export function compareGroupedRows(a: GroupedRow, b: GroupedRow): number {
  const aStatus = a.kind === 'single' ? a.incident.status : dominantGroupStatus(a)
  const bStatus = b.kind === 'single' ? b.incident.status : dominantGroupStatus(b)
  return (STATUS_PRIORITY[aStatus] ?? 2) - (STATUS_PRIORITY[bStatus] ?? 2)
}
