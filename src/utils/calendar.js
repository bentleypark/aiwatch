// Build 30-day status calendar from service data
// Uses local dates so the calendar aligns with the user's timezone.
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

function toLocalDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function buildCalendarFromIncidents(incidents, dailyImpact) {
  const today = new Date()
  const dayStatus = {}

  // Phase 1: Apply dailyImpact (pre-filter, most accurate for Statuspage services)
  // Keys are UTC dates from the worker — convert to local dates for display.
  // A UTC date at noon maps to the correct local date for most timezones (UTC-12 to UTC+11).
  if (dailyImpact) {
    for (const [utcDay, impact] of Object.entries(dailyImpact)) {
      const localDay = toLocalDate(new Date(utcDay + 'T12:00:00Z'))
      if (impact === 'critical') {
        if (dayStatus[localDay] !== 'down') dayStatus[localDay] = 'down'
      } else if (impact === 'major') {
        if (!dayStatus[localDay]) dayStatus[localDay] = 'degraded'
      }
    }
  }

  // Phase 2: Apply per-incident data (handles active incidents + non-Statuspage services)
  ;(incidents ?? []).forEach((inc) => {
    if (!inc.startedAt) return
    const key = toLocalDate(new Date(inc.startedAt))
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
    const d = new Date(today)
    d.setDate(d.getDate() - (29 - i))
    const key = toLocalDate(d)
    return dayStatus[key] ?? 'operational'
  })
}
