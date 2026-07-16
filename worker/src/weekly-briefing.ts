// Weekly Briefing — Discord summary every Sunday UTC 00:00 (KST 09:00)
// Combines changelog RSS detection + incident summary + stability trends

import type { ChangelogEntry, StaleSourceInfo } from './changelog'
import { formatChangelogSection, formatStaleSourcesWarning } from './changelog'
import type { MonthlyIncidentEntry } from './monthly-archive'
import type { AiUsageTrend } from './ai-analysis'
import { formatAiUsageTrendLine } from './ai-analysis'

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
  nvdCount: number // #949 — first-party product CVEs
  highlights: string[] // top security alert titles (max 5)
}

/** #917 — operator-authored strategy status, mirroring the active initiative page's `Status` +
 *  `Next action`. Lives in the `strategy:brief` KV key (the worker cannot read the memory bundle
 *  the initiative page lives in). Deliberately carries NO metrics: the growth counters already ship
 *  in the daily summary (#986); this is the judgment layer above them, which moves on the ~monthly
 *  cadence the weekly briefing matches. */
export interface StrategyBrief {
  status: string
  nextAction: string
  updatedAt: string // ISO date the operator last set it (YYYY-MM-DD)
}

/** A brief older than this (relative to the briefing's week-end) renders a refresh nudge instead of
 *  reading as current — the initiative-thread cadence is ~30d, so a note that hasn't moved in a
 *  month is likely stale, not stable. */
export const STRATEGY_STALE_DAYS = 30

/** Tolerant parse of the `strategy:brief` KV value. Returns null on any missing/empty/non-string
 *  required field so a malformed write omits the section rather than throwing the whole briefing. */
export function parseStrategyBrief(raw: string): StrategyBrief | null {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const o = obj as Record<string, unknown>
  const { status, nextAction, updatedAt } = o
  if (typeof status !== 'string' || typeof nextAction !== 'string' || typeof updatedAt !== 'string') return null
  if (!status.trim() || !nextAction.trim() || !updatedAt.trim()) return null
  return { status: status.trim(), nextAction: nextAction.trim(), updatedAt: updatedAt.trim() }
}

/** True when the brief is older than `horizonDays` relative to `refDateISO` (the briefing's
 *  week-end). An unparseable date counts as stale — fail toward surfacing the nudge rather than
 *  silently presenting a possibly-frozen note as current (#733 principle). */
export function isStrategyBriefStale(updatedAt: string, refDateISO: string, horizonDays = STRATEGY_STALE_DAYS): boolean {
  const updated = Date.parse(updatedAt)
  const ref = Date.parse(refDateISO)
  if (Number.isNaN(updated) || Number.isNaN(ref)) return true
  return (ref - updated) / 86_400_000 > horizonDays
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
  /** #995 — 7-day AI-analysis usage roll-up (Gemma/Sonnet/timedOut/failed), from the retained
   *  `ai:usage:{date}` keys. Absent/null → the section is omitted (no analyses that week). */
  aiUsageTrend?: AiUsageTrend | null
  /** #917 — operator-authored strategy status from the `strategy:brief` KV key. Absent/null → the
   *  section is omitted; stale (>STRATEGY_STALE_DAYS) → rendered with a refresh nudge. */
  strategyBrief?: StrategyBrief | null
  /** #917 — true when the `strategy:brief` key WAS set but `parseStrategyBrief` rejected it (bad
   *  JSON / missing field). Surfaces a fix nudge instead of a silent omission — a present-but-broken
   *  write is operator error worth showing, distinct from an unset key. Ignored when strategyBrief
   *  is non-null. */
  strategyBriefMalformed?: boolean
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

/**
 * #995 — enumerate every `YYYY-MM-DD` from `weekStart`..`weekEnd` INCLUSIVE (used to read the week's
 * `ai:usage:{date}` keys for the trend line). Pure + UTC-only (no DST/local drift). Returns `[]` when
 * the range is inverted, so a bad range yields an empty (omitted) trend rather than a hang.
 */
export function weekDateStrings(weekStart: string, weekEnd: string): string[] {
  const dates: string[] = []
  const end = new Date(`${weekEnd}T00:00:00Z`)
  for (let d = new Date(`${weekStart}T00:00:00Z`); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    dates.push(d.toISOString().split('T')[0])
  }
  return dates
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

  // Section 3.5: AI Analysis usage trend (#995) — only when there were analyses this week.
  if (data.aiUsageTrend) {
    const aiLine = formatAiUsageTrendLine(data.aiUsageTrend)
    if (aiLine) lines.push(`\n${aiLine}`)
  }

  // Section 4: Security
  if (data.security && (data.security.hnCount > 0 || data.security.osvCount > 0 || data.security.nvdCount > 0)) {
    lines.push(`\n🔒 **Security**`)
    const parts: string[] = []
    if (data.security.osvCount > 0) parts.push(`${data.security.osvCount} SDK vulnerabilities`)
    if (data.security.nvdCount > 0) parts.push(`${data.security.nvdCount} first-party CVEs`)
    if (data.security.hnCount > 0) parts.push(`${data.security.hnCount} security news`)
    lines.push(parts.join(', '))
    if (data.security.highlights.length > 0) {
      for (const h of data.security.highlights.slice(0, 5)) {
        lines.push(`• ${h}`)
      }
    }
  }

  // Section 5: Strategy (#917) — operator-authored initiative status, NOT derived metrics (those
  // ship daily via #986). This is the judgment layer above the numbers; it moves on a ~monthly
  // cadence, which is why it rides the weekly briefing rather than the daily summary.
  if (data.strategyBrief) {
    const b = data.strategyBrief
    lines.push(`\n📈 **Strategy**`)
    if (isStrategyBriefStale(b.updatedAt, data.weekEnd)) {
      lines.push(`⚠️ Brief last updated ${b.updatedAt} (>${STRATEGY_STALE_DAYS}d ago) — refresh the \`strategy:brief\` KV key.`)
    }
    // Cap each field: the fields are operator-authored and unbounded, but Discord's embed
    // description hard-caps at 4096 chars across ALL sections — an over-long brief would make the
    // send fail and drop the ENTIRE briefing, not just this section.
    lines.push(capField(b.status))
    lines.push(`**Next:** ${capField(b.nextAction)}`)
  } else if (data.strategyBriefMalformed) {
    lines.push(`\n📈 **Strategy**`)
    lines.push('⚠️ `strategy:brief` is set but malformed — check the JSON (see kv-schema.md).')
  }

  return lines.join('\n')
}

/** Max chars per operator-authored strategy field before ellipsis — bounds the Strategy section
 *  well under Discord's 4096-char embed-description cap so one long brief can't drop the briefing. */
export const STRATEGY_FIELD_MAX = 600
function capField(s: string): string {
  return s.length > STRATEGY_FIELD_MAX ? s.slice(0, STRATEGY_FIELD_MAX - 1) + '…' : s
}

/**
 * Build security summary from KV keys list (security:seen:hn:*, security:seen:osv:*,
 * security:seen:nvd:*). Called by cron with the list of security KV keys created this week.
 */
export function buildSecuritySummary(
  keys: Array<{ name: string; metadata?: unknown }>,
  highlights: string[],
): WeeklySecuritySummary {
  let hnCount = 0
  let osvCount = 0
  let nvdCount = 0
  for (const k of keys) {
    if (k.name.startsWith('security:seen:hn:')) hnCount++
    else if (k.name.startsWith('security:seen:osv:')) osvCount++
    else if (k.name.startsWith('security:seen:nvd:')) nvdCount++
  }
  return { hnCount, osvCount, nvdCount, highlights: highlights.slice(0, 5) }
}
