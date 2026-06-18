// Build status calendar from service data
// Uses local dates to match how official status pages display dates to users.
// Returns array of N cell statuses (default 30, incident.io services use 14). The cell keys are
// IMPACT-ALIGNED and frontend-internal (NOT the wire `service.status`) — #663 renamed them from the
// old degraded_perf/degraded/down so the key name matches the incident impact and the severity order
// is self-evident, decoupling the calendar from the 3-state badge that shares the `status.*` i18n:
//   'critical'    — red:    critical impact (major/full outage)
//   'major'       — orange: major impact (partial outage)
//   'minor'       — yellow: minor / null / unknown impact (degraded)
//   'operational' — green:  no incidents
// User-facing labels (#674: Critical / Major / Minor / Operational — the Statuspage impact axis) via the
// `cal.status.*` i18n keys. Index 0 = oldest, last index = today.

const STATUS_RANK = { operational: 0, minor: 1, major: 2, critical: 3 }

function escalate(dayStatus, key, status) {
  if ((STATUS_RANK[status] ?? 0) > (STATUS_RANK[dayStatus[key]] ?? 0)) {
    dayStatus[key] = status
  }
}

// Map an incident impact to a calendar cell status (single source of truth for Phase 1/2/3). The cell
// keys now equal the impact name (critical/major), with minor/null/unknown → 'minor' (yellow).
function impactToCellStatus(impact) {
  if (impact === 'critical') return 'critical'
  if (impact === 'major') return 'major'
  return 'minor'
}

// Convert Date to local YYYY-MM-DD string
function toLocalDateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function buildCalendarFromIncidents(incidents, dailyImpact, days = 30, currentStatus = undefined) {
  const today = new Date()
  const dayStatus = {}

  // Phase 1: Apply dailyImpact (keys are UTC dates from Worker — remap to local). dailyImpact values
  // are impact names (critical/major/minor), which now equal the cell keys — so map via the shared
  // impactToCellStatus (skips any unknown impact by returning 'minor', but dailyImpact only emits the
  // three known levels).
  if (dailyImpact) {
    const KNOWN_IMPACT = new Set(['critical', 'major', 'minor'])
    for (const [utcDay, impact] of Object.entries(dailyImpact)) {
      if (!KNOWN_IMPACT.has(impact)) continue
      // UTC date key → local date key (may shift ±1 day depending on timezone)
      const localKey = toLocalDateKey(new Date(utcDay + 'T12:00:00Z'))
      escalate(dayStatus, localKey, impactToCellStatus(impact))
    }
  }

  // Phase 2: Apply per-incident data.
  // Statuspage (30-day, dailyImpact from uptimeData): skip — Phase 1 is 100% accurate,
  // adding incidents would introduce noise from unrelated components.
  // incident.io (14-day) and others: supplement Phase 1 with keyword-filtered incidents.
  if (!(dailyImpact && days === 30)) {
    const windowStart = new Date(today.getTime() - (days - 1) * 86_400_000)
    ;(incidents ?? []).forEach((inc) => {
      if (!inc.startedAt) return
      const start = new Date(inc.startedAt)
      if (isNaN(start.getTime())) return
      const status = impactToCellStatus(inc.impact) // same map for ongoing/resolved (minor/null → yellow)
      // dailyImpact services (incident.io 14-day): the official per-day record (Phase 1) owns the
      // days — supplement only the START day to avoid spanning noise across unrelated components.
      // Ongoing incidents likewise paint only the start day here (Phase 3 extends them to today).
      // no-dailyImpact services (RSS/JSON-only: Bedrock/Azure) with a RESOLVED incident have no
      // per-day record, so the incident must span its OWN days startedAt→resolvedAt (window-clamped),
      // else a multi-day outage shows only its start day (#691 — surfaced by #677's real durations).
      if (dailyImpact || !inc.resolvedAt) {
        escalate(dayStatus, toLocalDateKey(start), status)
        return
      }
      const end = new Date(inc.resolvedAt)
      // A malformed OR inverted (resolvedAt < startedAt) range can't be spanned — paint the start
      // day only, never nothing (an inverted range would make the loop run zero times otherwise).
      if (isNaN(end.getTime()) || end.getTime() < start.getTime()) {
        escalate(dayStatus, toLocalDateKey(start), status)
        return
      }
      const from = start < windowStart ? windowStart : start
      const endClamped = end.getTime() > today.getTime() ? today : end // guard a future resolvedAt
      const endKey = toLocalDateKey(endClamped)
      // step day-by-day (noon-anchored, DST-safe) from start → resolved, inclusive
      for (let cur = new Date(from.getFullYear(), from.getMonth(), from.getDate(), 12);
           toLocalDateKey(cur) <= endKey;
           cur.setDate(cur.getDate() + 1)) {
        escalate(dayStatus, toLocalDateKey(cur), status)
      }
    })
  }

  // Phase 3 (#662): extend ONGOING incidents forward to "today" — source-aware, so the official
  // record stays authoritative for finalized past days.
  //   • services WITH an official daily record (dailyImpact: statuspage / incident.io / betterstack /
  //     aistudio / flashduty-DeepSeek): official buckets own past days; fill ONLY today's (local) cell
  //     from the live ongoing status — today's official bucket isn't finalized yet, so this
  //     contradicts nothing. Without this an active incident leaves today green.
  //   • services with NO daily record (no dailyImpact — RSS-only, e.g. Bedrock/Azure): nothing to
  //     contradict → span startedAt→today (clamped to the window), the only multi-day signal.
  // GATED on the live badge: only when the service is actually non-operational. A service can stay
  // `operational` with an open informational/minor incident (e.g. claude); painting the calendar for
  // those is noise (mirrors the old worker-augment `svcStatus !== 'operational'` guard, #662).
  if (currentStatus && currentStatus !== 'operational') {
    const todayKey = toLocalDateKey(today)
    const windowStart = new Date(today.getTime() - (days - 1) * 86_400_000)
    ;(incidents ?? []).forEach((inc) => {
      if (inc.status === 'resolved' || !inc.startedAt) return
      const start = new Date(inc.startedAt)
      if (isNaN(start.getTime())) return // skip a malformed startedAt explicitly (don't rely on key ordering)
      const status = impactToCellStatus(inc.impact)
      if (dailyImpact) {
        escalate(dayStatus, todayKey, status) // today only — defer past days to the official record
      } else {
        const from = start < windowStart ? windowStart : start
        // step day-by-day (noon-anchored, DST-safe) from start → today, inclusive
        for (let cur = new Date(from.getFullYear(), from.getMonth(), from.getDate(), 12);
             toLocalDateKey(cur) <= todayKey;
             cur.setDate(cur.getDate() + 1)) {
          escalate(dayStatus, toLocalDateKey(cur), status)
        }
      }
    })
  }

  return Array.from({ length: days }, (_, i) => {
    const d = new Date(today.getTime() - (days - 1 - i) * 86_400_000)
    return dayStatus[toLocalDateKey(d)] ?? 'operational'
  })
}
