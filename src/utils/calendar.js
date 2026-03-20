// Build 30-day status calendar from incident data
// Uses UTC dates to avoid timezone-related off-by-one errors
// Returns array of 30 statuses: 'operational' | 'degraded' | 'down'
// Index 0 = 29 days ago, index 29 = today
//
// Color logic mirrors Statuspage (e.g. status.claude.com):
//   red (down)    — critical impact incident, or currently active (non-resolved)
//   orange (degraded) — major/minor impact incident (resolved)
//   green (operational) — no incidents

export function buildCalendarFromIncidents(incidents) {
  const today = new Date()
  const dayStatus = {}
  ;(incidents ?? []).forEach((inc) => {
    if (!inc.startedAt) return
    const key = new Date(inc.startedAt).toISOString().split('T')[0]
    let status
    if (inc.status !== 'resolved') {
      status = 'down' // active incident → always red
    } else if (inc.impact === 'critical') {
      status = 'down' // critical impact → red
    } else {
      status = 'degraded' // major/minor/null → orange
    }
    // Only escalate: down > degraded > operational
    if (!dayStatus[key] || status === 'down') dayStatus[key] = status
  })
  return Array.from({ length: 30 }, (_, i) => {
    const key = new Date(today.getTime() - (29 - i) * 86_400_000).toISOString().split('T')[0]
    return dayStatus[key] ?? 'operational'
  })
}
