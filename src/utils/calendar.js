// Build status calendar from service data
// Uses local dates to match how official status pages display dates to users.
// Returns array of N statuses (default 30, incident.io services use 14):
//   'down'               — red: full/major outage
//   'degraded'           — orange: partial outage
//   'degraded_perf'      — yellow: degraded performance (minor impact)
//   'operational'        — green: no incidents
// Index 0 = oldest, last index = today

const STATUS_RANK = { operational: 0, degraded_perf: 1, degraded: 2, down: 3 }

function escalate(dayStatus, key, status) {
  if ((STATUS_RANK[status] ?? 0) > (STATUS_RANK[dayStatus[key]] ?? 0)) {
    dayStatus[key] = status
  }
}

// Map an incident impact to a calendar cell status (single source of truth for Phase 2 + Phase 3).
// critical → down (red), major → degraded (orange), minor/null/unknown → degraded_perf (yellow).
function impactToCellStatus(impact) {
  if (impact === 'critical') return 'down'
  if (impact === 'major') return 'degraded'
  return 'degraded_perf'
}

// Convert Date to local YYYY-MM-DD string
function toLocalDateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function buildCalendarFromIncidents(incidents, dailyImpact, days = 30, currentStatus = undefined) {
  const today = new Date()
  const dayStatus = {}

  // Phase 1: Apply dailyImpact (keys are UTC dates from Worker — remap to local)
  if (dailyImpact) {
    const impactToStatus = { critical: 'down', major: 'degraded', minor: 'degraded_perf' }
    for (const [utcDay, impact] of Object.entries(dailyImpact)) {
      const status = impactToStatus[impact]
      if (!status) continue
      // UTC date key → local date key (may shift ±1 day depending on timezone)
      const localKey = toLocalDateKey(new Date(utcDay + 'T12:00:00Z'))
      escalate(dayStatus, localKey, status)
    }
  }

  // Phase 2: Apply per-incident data.
  // Statuspage (30-day, dailyImpact from uptimeData): skip — Phase 1 is 100% accurate,
  // adding incidents would introduce noise from unrelated components.
  // incident.io (14-day) and others: supplement Phase 1 with keyword-filtered incidents.
  if (!(dailyImpact && days === 30)) {
    ;(incidents ?? []).forEach((inc) => {
      if (!inc.startedAt) return
      const key = toLocalDateKey(new Date(inc.startedAt))
      // Same impact→status map for ongoing and resolved (minor/null/unknown → degraded_perf yellow).
      escalate(dayStatus, key, impactToCellStatus(inc.impact))
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
