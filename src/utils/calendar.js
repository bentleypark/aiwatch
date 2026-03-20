// Build 30-day status calendar from incident data
// Uses UTC dates to avoid timezone-related off-by-one errors
// Returns array of 30 statuses: 'operational' | 'degraded' | 'down'
// Index 0 = 29 days ago, index 29 = today
//
// Color logic mirrors Statuspage (e.g. status.claude.com) calendar:
//   red (down)       — component had major_outage (impact=critical), or currently active
//   orange (degraded) — component had partial_outage (impact=major)
//   green (operational) — no outage, or only degraded_performance (impact=minor)

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
      status = 'down' // major_outage → red
    } else if (inc.impact === 'major') {
      status = 'degraded' // partial_outage → orange
    } else {
      return // minor (degraded_performance) or null → no outage, skip
    }
    // Only escalate: down > degraded > operational
    if (!dayStatus[key] || status === 'down') dayStatus[key] = status
  })
  return Array.from({ length: 30 }, (_, i) => {
    const key = new Date(today.getTime() - (29 - i) * 86_400_000).toISOString().split('T')[0]
    return dayStatus[key] ?? 'operational'
  })
}
