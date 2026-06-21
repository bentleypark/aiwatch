// Weekly Briefing — Discord summary every Sunday UTC 00:00 (KST 09:00)
// Combines changelog RSS detection + incident summary + stability trends

import type { ChangelogEntry, StaleSourceInfo } from './changelog'
import { formatChangelogSection, formatStaleSourcesWarning } from './changelog'
import type { MonthlyIncidentEntry } from './monthly-archive'

export interface WeeklyIncidentSummary {
  serviceId: string
  serviceName: string
  count: number
  totalDurationMin: number
}

export interface WeeklyStabilityChange {
  serviceId: string
  serviceName: string
  prevUptime: number
  currUptime: number
}

export interface WeeklySecuritySummary {
  hnCount: number
  osvCount: number
  highlights: string[] // top security alert titles (max 5)
}

export interface WeeklyBriefingData {
  weekStart: string // ISO date (Mon)
  weekEnd: string   // ISO date (Sun)
  changelog: ChangelogEntry[]
  incidents: WeeklyIncidentSummary[]
  stabilityChanges: WeeklyStabilityChange[]
  /** #733 — false when the comparison inputs were unavailable (services:latest unreadable, or no
   *  prev-week history baseline). Distinguishes "data couldn't be compared" from a genuinely calm
   *  week so the section never silently reads as "No significant changes." Defaults to available. */
  stabilityDataAvailable?: boolean
  security?: WeeklySecuritySummary
  /** Per-source last-fetch staleness — surfaces silent collection gaps (#274) */
  staleSources?: StaleSourceInfo[]
}

/**
 * Filter accumulated changelog entries to the given week window (Mon 00:00Z – Sun 23:59:59Z).
 * changelog:entries KV keeps the last 50 entries over 14 days; without this filter
 * the briefing would include entries from before the current week.
 */
export function filterChangelogToWeek(entries: ChangelogEntry[], weekStart: string, weekEnd: string): ChangelogEntry[] {
  const startMs = new Date(weekStart).getTime()
  const endMs = new Date(weekEnd + 'T23:59:59Z').getTime()
  return entries.filter((e) => {
    if (!e.date) return false
    const ts = new Date(e.date).getTime()
    return !isNaN(ts) && ts >= startMs && ts <= endMs
  })
}

/**
 * Flatten incidents:monthly:YYYY-MM KV value into the flat array expected by
 * buildIncidentSummary. The KV format is { services: { [svcId]: { incidents: [] } } }
 * — incidents are nested per service, not at the root level.
 */
export function parseMonthlyIncidents(
  raw: unknown,
  serviceNames: Record<string, string>,
): Parameters<typeof buildIncidentSummary>[0] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    console.warn('[weekly-briefing] parseMonthlyIncidents: unexpected root type', typeof raw)
    return []
  }
  const services = (raw as Record<string, unknown>).services
  if (services !== undefined && (typeof services !== 'object' || Array.isArray(services) || services === null)) {
    console.warn('[weekly-briefing] parseMonthlyIncidents: services is not an object', typeof services)
    return []
  }
  const out: Parameters<typeof buildIncidentSummary>[0] = []
  for (const [svcId, svcData] of Object.entries((services ?? {}) as Record<string, { incidents?: MonthlyIncidentEntry[] }>)) {
    for (const inc of (svcData.incidents ?? [])) {
      if (!inc.id || !inc.startedAt || !inc.title) {
        console.warn(`[weekly-briefing] parseMonthlyIncidents: skipping ${svcId} incident with missing required fields`, { id: inc.id, startedAt: inc.startedAt })
        continue
      }
      const dm = inc.durationMin ?? 0
      const h = Math.floor(dm / 60), m = dm % 60
      const duration = dm > 0 ? (h > 0 && m > 0 ? `${h}h ${m}m` : h > 0 ? `${h}h` : `${m}m`) : null
      out.push({ id: inc.id, serviceId: svcId, serviceName: serviceNames[svcId] ?? svcId, title: inc.title, startedAt: inc.startedAt, duration })
    }
  }
  return out
}

/**
 * Compute week date range (Mon–Sun) for a given date.
 */
export function getWeekRange(date: Date): { start: string; end: string } {
  const d = new Date(date)
  const day = d.getUTCDay()
  // Monday = start of week (day 0=Sun → offset 6, day 1=Mon → offset 0, ...)
  const diffToMon = day === 0 ? 6 : day - 1
  const mon = new Date(d)
  mon.setUTCDate(d.getUTCDate() - diffToMon)
  const sun = new Date(mon)
  sun.setUTCDate(mon.getUTCDate() + 6)

  return {
    start: mon.toISOString().split('T')[0],
    end: sun.toISOString().split('T')[0],
  }
}

function formatDateRange(start: string, end: string): string {
  const s = new Date(start)
  const e = new Date(end)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${months[s.getUTCMonth()]} ${s.getUTCDate()} – ${months[e.getUTCMonth()]} ${e.getUTCDate()}`
}

/**
 * Build incident summary from incidents:monthly KV data.
 * Filters to incidents that started within the week range.
 */
export function buildIncidentSummary(
  monthlyIncidents: Array<{ id: string; serviceId: string; serviceName: string; title: string; startedAt: string; duration: string | null }>,
  weekStart: string,
  weekEnd: string,
): WeeklyIncidentSummary[] {
  const startMs = new Date(weekStart).getTime()
  const endMs = new Date(weekEnd + 'T23:59:59Z').getTime()

  const byService = new Map<string, { name: string; count: number; totalMin: number }>()
  for (const inc of monthlyIncidents) {
    const ts = new Date(inc.startedAt).getTime()
    if (ts < startMs || ts > endMs) continue
    const entry = byService.get(inc.serviceId) ?? { name: inc.serviceName, count: 0, totalMin: 0 }
    entry.count++
    if (inc.duration) {
      const match = inc.duration.match(/(?:(\d+)h\s*)?(?:(\d+)m)?/)
      if (match && (match[1] || match[2])) entry.totalMin += (parseInt(match[1] ?? '0') * 60) + parseInt(match[2] ?? '0')
    }
    byService.set(inc.serviceId, entry)
  }

  return Array.from(byService.entries())
    .map(([id, v]) => ({ serviceId: id, serviceName: v.name, count: v.count, totalDurationMin: v.totalMin }))
    .sort((a, b) => b.count - a.count)
}

/**
 * Build stability changes from daily uptime counters.
 * Compares this week's uptime vs previous week.
 */
export interface WeeklyUptimeCounter {
  ok: number
  total: number
  // #733 — most-recent non-null status-page rolling-30d uptime snapshot in the week window.
  officialUptime?: number | null
}

/**
 * #733 — Weekly stability = change in OFFICIAL status-page uptime (rolling-30d), NOT the AIWatch
 * ok/total served-status counter (which is noise for incident-only / probeless / sticky-degraded
 * services — Bedrock logged 0–5% on flap days, ElevenLabs 72% vs an official 99%).
 *
 * `currentUptime` is the LIVE `uptime30d` per service read from `services:latest`, with no-official-
 * uptime / stale-source services already set to `null` (= the dashboard's `isUnreliableUptime`,
 * #713). Using the live value as "this week" — rather than a historical snapshot — is what reliably
 * excludes a service like Bedrock whose past `officialUptime` snapshots were intermittently non-null
 * (a pre-#713 estimate residue) even though it currently publishes no uptime. `prevWeek` supplies the
 * ~7-day-ago official snapshot. A service is reported only when BOTH figures exist and differ > 0.5%.
 */
export function buildStabilityChanges(
  currentUptime: Record<string, number | null>,
  prevWeek: Record<string, WeeklyUptimeCounter>,
  serviceNames: Record<string, string>,
): WeeklyStabilityChange[] {
  const changes: WeeklyStabilityChange[] = []
  for (const [id, currUptime] of Object.entries(currentUptime)) {
    if (currUptime == null) continue // no official uptime now (isUnreliableUptime) → excluded
    const prevUptime = prevWeek[id]?.officialUptime
    if (prevUptime == null) continue
    const diff = currUptime - prevUptime
    // Only report changes > 0.5% (a meaningful move in a slow rolling-30d figure)
    if (Math.abs(diff) > 0.5) {
      changes.push({
        serviceId: id,
        serviceName: serviceNames[id] ?? id,
        prevUptime,
        currUptime,
      })
    }
  }
  return changes.sort((a, b) => (a.currUptime - a.prevUptime) - (b.currUptime - b.prevUptime))
}

/**
 * Format the weekly briefing as a Discord embed description.
 */
export function buildWeeklyBriefing(data: WeeklyBriefingData): string {
  const lines: string[] = []
  const dateRange = formatDateRange(data.weekStart, data.weekEnd)

  // Section 1: Changelog (with stale-source warning when applicable, #274)
  lines.push(`\n🔄 **Service Changes**`)
  const staleWarning = formatStaleSourcesWarning(data.staleSources ?? [])
  if (staleWarning) lines.push(staleWarning)
  lines.push(formatChangelogSection(data.changelog))

  // Section 2: Incident Summary
  lines.push(`\n⚠️ **Incident Summary**`)
  if (data.incidents.length === 0) {
    lines.push('No incidents this week.')
  } else {
    const totalInc = data.incidents.reduce((s, i) => s + i.count, 0)
    const totalMin = data.incidents.reduce((s, i) => s + i.totalDurationMin, 0)
    const svcCount = data.incidents.length
    lines.push(`${totalInc} incidents across ${svcCount} services`)
    const top3 = data.incidents.slice(0, 3).map((i) => `${i.serviceName} (${i.count})`).join(', ')
    lines.push(`Most affected: ${top3}`)
    if (totalMin > 0) {
      const h = Math.floor(totalMin / 60)
      const m = totalMin % 60
      lines.push(`Total downtime: ${h > 0 && m > 0 ? `${h}h ${m}m` : h > 0 ? `${h}h` : `${m}m`}`)
    }
  }

  // Section 3: Stability Trend
  lines.push(`\n📊 **Stability Trend**`)
  if (data.stabilityDataAvailable === false) {
    // #733 — inputs missing (services:latest unreadable / no prev-week baseline). Don't print the
    // reassuring "No significant changes." which would hide a possible decline (same principle as
    // the changelog stale-source warning).
    lines.push('Stability data unavailable this week.')
  } else if (data.stabilityChanges.length === 0) {
    lines.push('No significant changes.')
  } else {
    const improved = data.stabilityChanges.filter((c) => c.currUptime > c.prevUptime)
    const declined = data.stabilityChanges.filter((c) => c.currUptime < c.prevUptime)
    if (improved.length > 0) {
      const list = improved.slice(0, 3).map((c) => `${c.serviceName} (${c.prevUptime.toFixed(1)}% → ${c.currUptime.toFixed(1)}%)`).join(', ')
      lines.push(`Improved: ${list}`)
    }
    if (declined.length > 0) {
      const list = declined.slice(0, 3).map((c) => `${c.serviceName} (${c.prevUptime.toFixed(1)}% → ${c.currUptime.toFixed(1)}%)`).join(', ')
      lines.push(`Declined: ${list}`)
    }
  }

  // Section 4: Security
  if (data.security && (data.security.hnCount > 0 || data.security.osvCount > 0)) {
    lines.push(`\n🔒 **Security**`)
    const parts: string[] = []
    if (data.security.osvCount > 0) parts.push(`${data.security.osvCount} SDK vulnerabilities`)
    if (data.security.hnCount > 0) parts.push(`${data.security.hnCount} security news`)
    lines.push(parts.join(', '))
    if (data.security.highlights.length > 0) {
      for (const h of data.security.highlights.slice(0, 5)) {
        lines.push(`• ${h}`)
      }
    }
  }

  return lines.join('\n')
}

/**
 * Build security summary from KV keys list (security:seen:hn:*, security:seen:osv:*).
 * Called by cron with the list of security KV keys created this week.
 */
export function buildSecuritySummary(
  keys: Array<{ name: string; metadata?: unknown }>,
  highlights: string[],
): WeeklySecuritySummary {
  let hnCount = 0
  let osvCount = 0
  for (const k of keys) {
    if (k.name.startsWith('security:seen:hn:')) hnCount++
    else if (k.name.startsWith('security:seen:osv:')) osvCount++
  }
  return { hnCount, osvCount, highlights: highlights.slice(0, 5) }
}
