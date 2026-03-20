// Build 30-day status calendar from incident data
// Uses UTC dates to avoid timezone-related off-by-one errors
// Returns array of 30 statuses: 'operational' | 'degraded' | 'down'
// Index 0 = 29 days ago, index 29 = today

export function buildCalendarFromIncidents(incidents) {
  const today = new Date()
  const dayStatus = {}
  ;(incidents ?? []).forEach((inc) => {
    if (!inc.startedAt) return
    const key = new Date(inc.startedAt).toISOString().split('T')[0]
    const status = inc.status === 'resolved' ? 'degraded' : 'down'
    if (!dayStatus[key] || status === 'down') dayStatus[key] = status
  })
  return Array.from({ length: 30 }, (_, i) => {
    const key = new Date(today.getTime() - (29 - i) * 86_400_000).toISOString().split('T')[0]
    return dayStatus[key] ?? 'operational'
  })
}
