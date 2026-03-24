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

// Convert Date to local YYYY-MM-DD string
function toLocalDateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function buildCalendarFromIncidents(incidents, dailyImpact, days = 30) {
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
      if (inc.status !== 'resolved') {
        // Ongoing incidents: use impact level instead of always 'down'
        if (inc.impact === 'critical') escalate(dayStatus, key, 'down')
        else if (inc.impact === 'major') escalate(dayStatus, key, 'degraded')
        else escalate(dayStatus, key, 'degraded_perf')
      } else if (inc.impact === 'critical') {
        escalate(dayStatus, key, 'down')
      } else if (inc.impact === 'major') {
        escalate(dayStatus, key, 'degraded')
      } else {
        // minor, null, or unknown impact — show as degraded_perf (yellow)
        escalate(dayStatus, key, 'degraded_perf')
      }
    })
  }

  return Array.from({ length: days }, (_, i) => {
    const d = new Date(today.getTime() - (days - 1 - i) * 86_400_000)
    return dayStatus[toLocalDateKey(d)] ?? 'operational'
  })
}
