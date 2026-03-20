// Build 30-day status calendar from service data
// Uses UTC dates to avoid timezone-related off-by-one errors
// Returns array of 30 statuses: 'operational' | 'degraded' | 'down'
// Index 0 = 29 days ago, index 29 = today
//
// Color logic mirrors Statuspage (e.g. status.claude.com) calendar:
//   red (down)       — component had major_outage (impact=critical), or currently active
//   orange (degraded) — component had partial_outage (impact=major)
//   green (operational) — no outage, or only degraded_performance (impact=minor)
//
// Uses dailyImpact (computed from ALL incidents before keyword filtering) when available,
// falling back to per-incident impact for non-Statuspage services.

export function buildCalendarFromIncidents(incidents, dailyImpact) {
  const today = new Date()
  const dayStatus = {}

  // Phase 1: Apply dailyImpact (pre-filter, most accurate for Statuspage services)
  if (dailyImpact) {
    for (const [day, impact] of Object.entries(dailyImpact)) {
      if (impact === 'critical') dayStatus[day] = 'down'
      else if (impact === 'major') dayStatus[day] = 'degraded'
    }
  }

  // Phase 2: Apply per-incident data (handles active incidents + non-Statuspage services)
  ;(incidents ?? []).forEach((inc) => {
    if (!inc.startedAt) return
    const key = new Date(inc.startedAt).toISOString().split('T')[0]
    let status
    if (inc.status !== 'resolved') {
      status = 'down' // active incident → always red
    } else if (!dailyImpact && inc.impact === 'critical') {
      status = 'down'
    } else if (!dailyImpact && inc.impact === 'major') {
      status = 'degraded'
    } else {
      return
    }
    if (!dayStatus[key] || status === 'down') dayStatus[key] = status
  })

  return Array.from({ length: 30 }, (_, i) => {
    const key = new Date(today.getTime() - (29 - i) * 86_400_000).toISOString().split('T')[0]
    return dayStatus[key] ?? 'operational'
  })
}
