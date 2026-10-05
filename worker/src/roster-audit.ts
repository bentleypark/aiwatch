// #1518 — uptime-roster audit (incident.io and Atlassian): reads the LIVE page, not a recorded
// snapshot, so a config drift is caught the same day it happens rather than waiting for a human to
// re-check its age by hand. Over a common `{id, dataAvailableSince}` shape each platform's own reader
// produces (`component_uptimes` for incident.io, `created_at` for Atlassian), it reports an AGED-IN id
// still OUT of scope — a component left out of the uptime scope contributes nothing to the worst-of, so
// an outage on it is invisible in the reported percentage. Nothing previously alerted when such an id
// crossed 30 days; #992's new-component alert fires once, on first sight, and for a
// `displayAllComponents` page says "Action: none" regardless of age.
//
// A REMOVED id (one the page no longer serves at all) is not this check's job — it is absent from the
// page's `component_uptimes` entirely, so it never appears in the `entries` list this check reads,
// and the existing "Component ID Mismatch" (#135) / "Partial Component Resolve" (#957) alerts already
// own that case. Duplicating it here would double the notification and let two checks disagree.

export const ROSTER_AUDIT_WINDOW_DAYS = 30

export interface RosterAuditEntry {
  id: string
  /** `null` = the page carries an entry for this id but no usable `data_available_since` (absent,
   *  empty, or unparseable) — the same "cannot prove an age" case `computeIncidentIoUptime` withholds
   *  uptime for. Treated as unproven, not as clean, below. */
  dataAvailableSince: string | null
}

/**
 * #1518(b) — page components 30+ days old that are neither in `scopeIds` nor `excludeIds`
 * (`ServiceConfig.rosterAuditExclude` — out of scope on purpose, for a reason specific to that service;
 * see its own comment in `services.ts`). An id absent from `entries`,
 * or present with no usable `data_available_since`, is skipped — under-30-days-proven is not the same
 * claim as proven-30-plus, and this check must not invent the latter from the former.
 */
export function auditAgedInOutOfScope(
  entries: RosterAuditEntry[],
  scopeIds: string[],
  excludeIds: string[],
  nowMs: number,
  windowDays: number = ROSTER_AUDIT_WINDOW_DAYS,
): string[] {
  const scope = new Set(scopeIds)
  const exclude = new Set(excludeIds)
  const agedIn: string[] = []
  for (const { id, dataAvailableSince } of entries) {
    if (scope.has(id) || exclude.has(id)) continue
    if (!dataAvailableSince) continue
    const ageDays = (nowMs - Date.parse(dataAvailableSince)) / 86_400_000
    if (ageDays >= windowDays) agedIn.push(id)
  }
  return agedIn
}

/**
 * Which ids in `currentIds` are NEW since the last cycle (absent from `prevSeen`), and the seen set to
 * persist. Unlike #992's `diffPageComponents`, `nextSeen` SHRINKS to exactly `currentIds`: a finding is
 * a live, re-checkable FACT about today's config and today's page (an id can leave scope, age past the
 * window, or gain an exclusion, and later regress), not a one-time sighting to suppress forever. So an
 * id that stops being a finding and later recurs alerts again — `diffPageComponents`' "once per
 * component, ever" semantics would silently swallow that regression.
 */
export function nextRosterFindingSeen(
  prevSeen: string[] | null,
  currentIds: string[],
): { toAlert: string[]; nextSeen: string[] } {
  const prev = new Set(prevSeen ?? [])
  return { toAlert: currentIds.filter((id) => !prev.has(id)), nextSeen: [...currentIds].sort() }
}

/**
 * #1518 — the (b) call every cron branch makes: `auditAgedInOutOfScope`, unless `fixedScope` suppresses
 * it entirely (cohere/groq/bfl — a permanently-pinned anchor id whose page is a structurally unbounded
 * per-model catalog with nothing to reconcile it against). Extracted so the fixedScope gate itself is a
 * pure, directly mutation-testable unit rather than an inline ternary at each of the two cron call
 * sites (incident.io, Atlassian) — a dropped `fixedScope ? [] :` would otherwise pass the whole suite,
 * since nothing else in the tree exercises the cron wiring itself.
 */
export function rosterAgedInFindings(
  entries: RosterAuditEntry[],
  scopeIds: string[],
  excludeIds: string[],
  fixedScope: boolean,
  nowMs: number,
  windowDays: number = ROSTER_AUDIT_WINDOW_DAYS,
): string[] {
  return fixedScope ? [] : auditAgedInOutOfScope(entries, scopeIds, excludeIds, nowMs, windowDays)
}

/** Operator Discord body for a page's roster audit. `names` resolves an id to a display name when
 *  known (the page's own component list); an id absent from it (a name lookup failure, or a
 *  `component_uptimes`-only entry with no matching `components.json` row) falls back to the bare id
 *  so the alert is never silently empty. Only the ids that are NEW this cycle (`toAlert` from
 *  `nextRosterFindingSeen`) are rendered — a finding still true from a prior cycle stays silent. */
export function formatRosterAuditAlert(
  serviceNames: string[],
  agedIn: string[],
  names: Map<string, string>,
): string {
  const who = serviceNames.length > 0 ? serviceNames.join(', ') : '(no AIWatch service)'
  const line = (id: string) => `• \`${names.get(id) ?? id}\` (\`${id}\`)`
  return (
    `Roster audit for **${who}**:\n\n` +
    `**Aged in, out of scope** (30+ days old, not tracked — an outage on it is invisible in the reported uptime):\n${agedIn.map(line).join('\n')}\n\n` +
    `**Action**: reconcile \`worker/src/services.ts\` — add an aged-in id to the uptime scope, or to ` +
    `\`rosterAuditExclude\` if it should never be tracked.`
  )
}
