// Build 30-day status calendar from service data
// Timezone handling differs by platform:
//   - Statuspage (dailyImpact present): UTC dates (uptimeData keys are UTC)
//   - incident.io (no dailyImpact): local timezone (incident.io renders in user's TZ)
// Returns array of 30 statuses matching 5-level calendar:
//   'down'               — red: full/major outage
//   'degraded'           — orange: partial outage
//   'degraded_perf'      — yellow: degraded performance (minor impact)
//   'operational'        — green: no incidents
// Index 0 = 29 days ago, index 29 = today

const STATUS_RANK = { operational: 0, degraded_perf: 1, degraded: 2, down: 3 }

function toUTCDate(d) {
  return d.toISOString().split('T')[0]
}

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
  // Statuspage → UTC, incident.io → local
  const toDateKey = dailyImpact ? toUTCDate : toLocalDate

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
      const key = toDateKey(new Date(inc.startedAt))
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

  // Generate 30-day range using the same timezone as the data
  return Array.from({ length: 30 }, (_, i) => {
    if (dailyImpact) {
      // UTC range for Statuspage
      const key = new Date(today.getTime() - (29 - i) * 86_400_000).toISOString().split('T')[0]
      return dayStatus[key] ?? 'operational'
    } else {
      // Local range for incident.io
      const d = new Date(today)
      d.setDate(d.getDate() - (29 - i))
      return dayStatus[toLocalDate(d)] ?? 'operational'
    }
  })
}
