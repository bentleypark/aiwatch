// Build 30-day status calendar from service data
// Uses UTC dates consistently to match Statuspage uptimeData and provide
// deterministic behavior across timezones.
// Returns array of 30 statuses matching 5-level calendar:
//   'down'               — red: full/major outage
//   'degraded'           — orange: partial outage
//   'degraded_perf'      — yellow: degraded performance (minor impact)
//   'operational'        — green: no incidents
// Index 0 = 29 days ago, index 29 = today

const STATUS_RANK = { operational: 0, degraded_perf: 1, degraded: 2, down: 3 }

function escalate(dayStatus, key, status) {
  if ((STATUS_RANK[status] ?? 0) > (STATUS_RANK[dayStatus[key]] ?? 0)) {
    dayStatus[key] = status
  }
}

export function buildCalendarFromIncidents(incidents, dailyImpact) {
  const today = new Date()
  const dayStatus = {}

  // Phase 1: Apply dailyImpact (Statuspage uptimeData — keys are UTC dates)
  if (dailyImpact) {
    const impactToStatus = { critical: 'down', major: 'degraded', minor: 'degraded_perf' }
    for (const [utcDay, impact] of Object.entries(dailyImpact)) {
      const status = impactToStatus[impact]
      if (status) escalate(dayStatus, utcDay, status)
    }
  }

  // Phase 2: Apply per-incident data (non-Statuspage services without dailyImpact)
  if (!dailyImpact) {
    ;(incidents ?? []).forEach((inc) => {
      if (!inc.startedAt) return
      const key = new Date(inc.startedAt).toISOString().split('T')[0]
      if (inc.status !== 'resolved') {
        escalate(dayStatus, key, 'down')
      } else if (inc.impact === 'critical') {
        escalate(dayStatus, key, 'down')
      } else if (inc.impact === 'major') {
        escalate(dayStatus, key, 'degraded')
      } else if (inc.impact === 'minor') {
        escalate(dayStatus, key, 'degraded_perf')
      }
    })
  }

  return Array.from({ length: 30 }, (_, i) => {
    const key = new Date(today.getTime() - (29 - i) * 86_400_000).toISOString().split('T')[0]
    return dayStatus[key] ?? 'operational'
  })
}
