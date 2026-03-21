// Build 30-day status calendar from service data
// Uses local dates so the calendar aligns with the user's timezone.
// Returns array of 30 statuses matching Statuspage 4-level calendar:
//   'down'               — red: major_outage (impact=critical), or currently active
//   'degraded'           — orange: partial_outage (impact=major)
//   'degraded_perf'      — yellow: incidents occurred but no outage (impact=degraded)
//   'operational'        — green: no incidents
// Index 0 = 29 days ago, index 29 = today

const STATUS_RANK = { operational: 0, degraded_perf: 1, degraded: 2, down: 3 }

function toLocalDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function escalate(dayStatus, key, status) {
  if ((STATUS_RANK[status] ?? 0) > (STATUS_RANK[dayStatus[key]] ?? 0)) {
    dayStatus[key] = status
  }
}

export function buildCalendarFromIncidents(incidents, dailyImpact) {
  const today = new Date()
  const dayStatus = {}

  // Phase 1: Apply dailyImpact (pre-filter, most accurate for Statuspage services)
  // Keys are UTC dates from the worker — convert to local dates for display.
  if (dailyImpact) {
    const impactToStatus = { critical: 'down', major: 'degraded', minor: 'degraded', degraded: 'degraded_perf' }
    for (const [utcDay, impact] of Object.entries(dailyImpact)) {
      const localDay = toLocalDate(new Date(utcDay + 'T12:00:00Z'))
      const status = impactToStatus[impact]
      if (status) escalate(dayStatus, localDay, status)
    }
  }

  // Phase 2: Apply per-incident data (handles active incidents + non-Statuspage services)
  ;(incidents ?? []).forEach((inc) => {
    if (!inc.startedAt) return
    const key = toLocalDate(new Date(inc.startedAt))
    if (inc.status !== 'resolved') {
      escalate(dayStatus, key, 'down')
    } else if (!dailyImpact) {
      if (inc.impact === 'critical' || inc.impact === 'major') escalate(dayStatus, key, 'degraded')
      else if (inc.impact === 'minor') escalate(dayStatus, key, 'degraded_perf')
    }
  })

  return Array.from({ length: 30 }, (_, i) => {
    const d = new Date(today)
    d.setDate(d.getDate() - (29 - i))
    const key = toLocalDate(d)
    return dayStatus[key] ?? 'operational'
  })
}
