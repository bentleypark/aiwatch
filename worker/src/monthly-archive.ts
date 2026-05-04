// Monthly Archive — permanent per-month service reliability snapshot
// Triggered on 1st of each month (cron), aggregates previous month's daily data.
// Stored as archive:monthly:{YYYY-MM} with NO TTL (permanent).
//
// Incident data: accumulated daily via accumulateMonthlyIncidents() in daily summary cron,
// stored in incidents:monthly:{YYYY-MM} KV key (60d TTL). This ensures accurate monthly
// incident counts, unlike services:latest which is a point-in-time snapshot.

import type { ProbeDailyData } from './probe-archival'
import type { ServiceStatus, Incident } from './types'
import type { OsvTimeline, OsvTimelineEntry } from './security-monitor'
import { osvTimelineKey } from './security-monitor'

export type ScoreGrade = 'excellent' | 'good' | 'fair' | 'degrading' | 'unstable'

/** Per-incident snapshot kept in the permanent monthly archive (#375).
 *  Sourced from accumulated incidents:monthly:{period} at archive build time, before its
 *  60d TTL lapses — so the archive becomes a long-window incident-list source for the
 *  dashboard's 90-day filter when the upstream status pages only return ~5-30 days. */
export interface MonthlyIncidentEntry {
  id: string                     // status-page incident id (deduped during accumulation)
  title: string
  startedAt: string              // ISO
  resolvedAt: string | null      // ISO; null if still open at archive time
  durationMin: number            // last-known duration in minutes (0 if unresolved)
  // Last-seen status from the most recent accumulation that touched this entry.
  // Equals the resolution status once the incident is `resolved`; otherwise the most-recent
  // in-progress state (`investigating` / `identified` / `monitoring`).
  finalStatus: 'resolved' | 'monitoring' | 'investigating' | 'identified'
}

export interface MonthlyServiceData {
  uptime: number | null          // uptime% from daily counters (null if no data)
  score: number | null           // AIWatch Score at archive time (null if unavailable)
  grade: ScoreGrade | null       // Score grade (null if score unavailable)
  incidents: number              // incident count for the month (from accumulated data)
  avgResolutionMin: number | null // average resolution time in minutes (null if no resolved incidents)
  totalDowntimeMin: number | null // sum of all incident durations for the month (null if no resolved incidents — unresolved durations are tracked as 0 upstream)
  longestIncidentMin: number | null // max single-incident duration for the month (null if no resolved incidents)
  avgLatencyMs: number | null    // average probe RTT p75 in ms (null if no probe data)
  // Per-incident detail (#375). Capped at MAX_INCIDENTS_PER_SERVICE_IN_ARCHIVE to bound KV size;
  // when the cap is hit, oldest entries are truncated (the most-recent-N policy keeps the
  // dashboard's 30-90d filter useful even on high-frequency services like Together AI).
  // Optional/null for archives written before this feature shipped — frontend must handle absence.
  incidentList?: MonthlyIncidentEntry[]
}

export interface MonthlyArchive {
  period: string                 // YYYY-MM
  generatedAt: string            // ISO timestamp
  daysCollected: number          // number of days with actual uptime data
  services: Record<string, MonthlyServiceData>
  // Optional — null for months before this feature shipped (or no detections).
  // Sourced from security:monthly:{period} at archive build time before its 60d TTL lapses (#290).
  security?: MonthlySecuritySummary | null
}

// ── Monthly security summary ─────────────────────────────────────────
//
// Shape stored in security:monthly:{YYYY-MM} (60d TTL) by the hourly security cron.
// The archive snapshots this into a permanent summary before TTL expiry (#290).

export type SecuritySeverityBucket = 'critical' | 'high' | 'medium' | 'low'

export interface MonthlySecurityEntry {
  title: string
  url: string
  source: 'osv' | 'hackernews'
  severity?: string
  service?: string
  detectedAt: string             // ISO 8601
}

export interface MonthlySecurityTopFinding extends MonthlySecurityEntry {
  // #291: optional per-alert timeline ("detected → fix_released → severity_changed").
  // Populated only for OSV findings that have a permanent security:timeline:osv:{id} KV
  // entry at archive build time; HN findings never carry this field.
  timeline?: OsvTimelineEntry[]
}

export interface MonthlySecuritySummary {
  totalAlerts: number
  bySource: { osv: number; hackernews: number }
  bySeverity: Record<SecuritySeverityBucket, number>
  byService: Record<string, number>                // service name → count
  topFindings: MonthlySecurityTopFinding[]         // sorted by severity desc, max 10
}

// ── Incident accumulation (written daily by daily summary cron) ──────

export interface MonthlyIncidentEntry {
  title: string
  startedAt: string
  status: string
  durationMin: number            // 0 if unresolved at accumulation time
}

export interface MonthlyIncidentServiceData {
  count: number
  totalMinutes: number
  longestMinutes: number
  dates: string[]                // unique affected dates (YYYY-MM-DD)
  incidentIds: string[]          // for dedup
  durations: Record<string, number> // incidentId → last known duration in minutes (for delta updates)
  // Per-incident detail accumulated alongside the aggregates so the permanent archive
  // can carry full incident lists past the upstream status-page response window (#375).
  // Optional for backward compat with existing KV entries written before this field shipped.
  incidents?: MonthlyIncidentEntry[]
}

/** Cap on incidents kept per service in the monthly accumulator (and thus in the archive).
 *  Services emit at most ~140 incidents/month in observed data (Together AI 139 in April).
 *  200 leaves headroom for outliers without inflating KV value size — at ~250B per entry
 *  it caps each service at ~50KB, and the full archive at ~1.5MB even when every service
 *  is at the cap. KV value limit is 25MB, so this is comfortable. */
export const MAX_INCIDENTS_PER_SERVICE_IN_ARCHIVE = 200

export interface MonthlyIncidents {
  lastUpdated: string
  services: Record<string, MonthlyIncidentServiceData>
}

/** Accumulate current service incidents into monthly totals. Deduplicates by incident ID. */
export function accumulateMonthlyIncidents(
  existing: MonthlyIncidents | null,
  services: ServiceStatus[],
  period: string, // YYYY-MM
): MonthlyIncidents {
  const result: MonthlyIncidents = existing
    ? { lastUpdated: new Date().toISOString(), services: structuredClone(existing.services) }
    : { lastUpdated: new Date().toISOString(), services: {} }

  for (const svc of services) {
    const incidents = (svc.incidents ?? []).filter(
      i => i.startedAt.startsWith(period),
    )
    if (incidents.length === 0) continue

    if (!result.services[svc.id]) {
      result.services[svc.id] = { count: 0, totalMinutes: 0, longestMinutes: 0, dates: [], incidentIds: [], durations: {}, incidents: [] }
    }
    const data = result.services[svc.id]
    // Ensure durations + incidents map/array exist (backward compat with pre-feature data)
    if (!data.durations) data.durations = {}
    if (!data.incidents) data.incidents = []

    for (const inc of incidents) {
      const dur = inc.duration ? parseDurationMin(inc.duration) : 0
      const finalStatus = mapIncidentStatus(inc.status)

      if (data.incidentIds.includes(inc.id)) {
        // Update duration delta if incident resolved since last accumulation
        const oldDur = data.durations[inc.id] ?? 0
        if (dur > oldDur) {
          data.totalMinutes += (dur - oldDur)
          data.durations[inc.id] = dur
          if (dur > data.longestMinutes) data.longestMinutes = dur
        }
        // Update detail entry (status / resolvedAt / durationMin) when the incident has progressed.
        // This lets a still-open incident get its resolvedAt + final status snapshotted on a later
        // accumulator run, without changing dedup behavior.
        const existingDetail = data.incidents.find(e => e.id === inc.id)
        if (existingDetail) {
          existingDetail.durationMin = dur
          existingDetail.finalStatus = finalStatus
          existingDetail.resolvedAt = inc.resolvedAt ?? existingDetail.resolvedAt
        }
        continue
      }

      // New incident
      data.incidentIds.push(inc.id)
      data.durations[inc.id] = dur
      data.count++
      data.totalMinutes += dur
      if (dur > data.longestMinutes) data.longestMinutes = dur
      data.incidents.push({
        id: inc.id,
        title: inc.title,
        startedAt: inc.startedAt,
        resolvedAt: inc.resolvedAt ?? null,
        durationMin: dur,
        finalStatus,
      })

      const date = inc.startedAt.slice(0, 10)
      if (!data.dates.includes(date)) data.dates.push(date)
    }

    // Cap incident detail to the most-recent N (oldest dropped first). Aggregate fields
    // (count / totalMinutes / longestMinutes) intentionally keep counting truncated entries
    // — only the per-incident detail loses tail items when the cap binds. dedup state in
    // incidentIds / durations is also preserved untruncated so a re-accumulation pass for an
    // already-counted-but-truncated incident still updates its aggregate, just without
    // re-adding it to the detail array.
    if (data.incidents.length > MAX_INCIDENTS_PER_SERVICE_IN_ARCHIVE) {
      data.incidents.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      data.incidents.splice(0, data.incidents.length - MAX_INCIDENTS_PER_SERVICE_IN_ARCHIVE)
    }
  }

  return result
}

/** Map a runtime ServiceStatus.incidents[].status to the archive's finalStatus enum.
 *  Defaults to 'investigating' when the upstream emits a value the archive doesn't
 *  recognize (defensive against future status-page schema additions). */
function mapIncidentStatus(s: Incident['status']): MonthlyIncidentEntry['finalStatus'] {
  if (s === 'resolved' || s === 'monitoring' || s === 'identified' || s === 'investigating') return s
  return 'investigating'
}

// ── Duration parsing ──────────────────────────────────────────────────

/** Parse duration string (e.g., "2h 30m", "45m", "3h") to minutes. Exported for testing. */
export function parseDurationMin(d: string): number {
  if (!d) return 0
  const h = d.includes('h') ? parseInt(d.split('h')[0]) : 0
  const afterH = d.includes('h') ? d.split('h')[1]?.trim() : d
  const m = afterH && afterH.includes('m') ? parseInt(afterH.replace('m', '').trim()) : 0
  const result = (isNaN(h) ? 0 : h) * 60 + (isNaN(m) ? 0 : m)
  return result
}

// ── Uptime / Latency computation ─────────────────────────────────────

type DailyCounters = Record<string, { ok: number; total: number }>

/** Compute per-service uptime% from daily counters */
export function computeMonthlyUptime(
  dailyData: Record<string, DailyCounters>,
): Record<string, number> {
  const totals: Record<string, { ok: number; total: number }> = {}
  for (const counters of Object.values(dailyData)) {
    for (const [id, { ok, total }] of Object.entries(counters)) {
      if (!totals[id]) totals[id] = { ok: 0, total: 0 }
      totals[id].ok += ok
      totals[id].total += total
    }
  }
  const result: Record<string, number> = {}
  for (const [id, { ok, total }] of Object.entries(totals)) {
    result[id] = total > 0 ? Math.round((ok / total) * 10000) / 100 : 0
  }
  return result
}

/** Compute per-service average probe RTT (p75) from daily probe summaries */
export function computeMonthlyLatency(
  probeData: Record<string, ProbeDailyData>,
): Record<string, number> {
  const sums: Record<string, number> = {}
  const counts: Record<string, number> = {}
  for (const daily of Object.values(probeData)) {
    for (const [id, stat] of Object.entries(daily)) {
      if (stat.p75 <= 0) continue
      sums[id] = (sums[id] ?? 0) + stat.p75
      counts[id] = (counts[id] ?? 0) + 1
    }
  }
  const result: Record<string, number> = {}
  for (const id of Object.keys(sums)) {
    result[id] = Math.round(sums[id] / counts[id])
  }
  return result
}

// ── Security summary builder ─────────────────────────────────────────

const SEVERITY_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 }

function normalizeSeverity(raw: string | undefined): SecuritySeverityBucket | null {
  if (!raw) return null
  const lower = raw.toLowerCase()
  return lower === 'critical' || lower === 'high' || lower === 'medium' || lower === 'low'
    ? lower
    : null
}

/**
 * Summarize a month's accumulated security alerts into the permanent archive shape.
 * Pure function — takes the parsed `security:monthly:{period}` contents, returns the summary.
 *
 * Top findings are sorted by severity descending (critical → low); unknown severities rank
 * below "low". Max 10 entries. Stable tie-breaker on detectedAt (more recent first) so a
 * re-generation of the same month always yields the same archive.
 */
export function summarizeSecurityAlerts(entries: MonthlySecurityEntry[]): MonthlySecuritySummary {
  const bySource: MonthlySecuritySummary['bySource'] = { osv: 0, hackernews: 0 }
  const bySeverity: MonthlySecuritySummary['bySeverity'] = { critical: 0, high: 0, medium: 0, low: 0 }
  const byService: Record<string, number> = {}

  for (const e of entries) {
    if (e.source === 'osv') bySource.osv++
    else if (e.source === 'hackernews') bySource.hackernews++
    const sev = normalizeSeverity(e.severity)
    if (sev) bySeverity[sev]++
    if (e.service) byService[e.service] = (byService[e.service] ?? 0) + 1
  }

  const topFindings = [...entries]
    .sort((a, b) => {
      const rankA = SEVERITY_RANK[normalizeSeverity(a.severity) ?? ''] ?? 0
      const rankB = SEVERITY_RANK[normalizeSeverity(b.severity) ?? ''] ?? 0
      if (rankA !== rankB) return rankB - rankA
      return b.detectedAt.localeCompare(a.detectedAt) // recent first on severity tie
    })
    .slice(0, 10)

  return { totalAlerts: entries.length, bySource, bySeverity, byService, topFindings }
}

/**
 * Extract the OSV vuln ID (GHSA-* or CVE-*) from a finding URL.
 * Works for the two shapes our writer currently produces: osv.dev/vulnerability/{id}
 * and github.com/advisories/{id}. Returns null if the URL doesn't carry a recognizable id.
 */
export function extractOsvVulnId(url: string | undefined): string | null {
  if (!url) return null
  const m = url.match(/(GHSA-[a-z0-9-]+|CVE-\d{4}-\d+)/i)
  return m ? m[1] : null
}

/**
 * For each OSV top finding, attach its permanent timeline (#291) when a
 * security:timeline:osv:{id} KV entry exists. HN findings and findings without a
 * resolvable vuln id pass through unchanged.
 */
export async function enrichTopFindingsWithTimelines(
  kv: KVNamespace,
  summary: MonthlySecuritySummary,
): Promise<MonthlySecuritySummary> {
  const enrichedTop = await Promise.all(
    summary.topFindings.map(async (f): Promise<MonthlySecurityTopFinding> => {
      if (f.source !== 'osv') return f
      const vulnId = extractOsvVulnId(f.url)
      if (!vulnId) return f
      const raw = await kv.get(osvTimelineKey(vulnId)).catch(() => null)
      if (!raw) return f
      try {
        const timeline = JSON.parse(raw) as OsvTimeline
        if (Array.isArray(timeline.entries) && timeline.entries.length > 0) {
          return { ...f, timeline: timeline.entries }
        }
      } catch { /* malformed timeline — skip enrichment, don't fail archive */ }
      return f
    }),
  )
  return { ...summary, topFindings: enrichedTop }
}

/** Get all dates in a given month (YYYY-MM-DD strings) */
export function getMonthDates(year: number, month: number): string[] {
  const dates: string[] = []
  const daysInMonth = new Date(year, month, 0).getDate()
  for (let d = 1; d <= daysInMonth; d++) {
    const mm = String(month).padStart(2, '0')
    const dd = String(d).padStart(2, '0')
    dates.push(`${year}-${mm}-${dd}`)
  }
  return dates
}

// ── Archive builder ──────────────────────────────────────────────────

export interface ArchiveScoreInput {
  id: string
  aiwatchScore?: number | null
  scoreGrade?: ScoreGrade | null
}

/** Build monthly archive from daily KV data + accumulated incident data */
export async function buildMonthlyArchive(
  kv: KVNamespace,
  year: number,
  month: number,
  scoreData?: ArchiveScoreInput[],
): Promise<MonthlyArchive> {
  const mm = String(month).padStart(2, '0')
  const period = `${year}-${mm}`
  const dates = getMonthDates(year, month)

  // Read daily uptime counters (history:{date} for past days)
  const uptimeResults = await Promise.all(
    dates.map(d => kv.get(`history:${d}`).catch(() => null)),
  )
  const dailyData: Record<string, DailyCounters> = {}
  let daysCollected = 0
  let parseErrors = 0
  uptimeResults.forEach((raw, i) => {
    if (raw) {
      try {
        dailyData[dates[i]] = JSON.parse(raw)
        daysCollected++
      } catch (err) {
        parseErrors++
        console.warn(`[monthly-archive] corrupt daily data for ${dates[i]}:`, err instanceof Error ? err.message : err)
      }
    }
  })
  if (parseErrors > 0) {
    console.error(`[monthly-archive] ${parseErrors} days had corrupt data for ${period}`)
  }

  // Read daily probe summaries (probe:daily:{date})
  const probeResults = await Promise.all(
    dates.map(d => kv.get(`probe:daily:${d}`).catch(() => null)),
  )
  const probeData: Record<string, ProbeDailyData> = {}
  probeResults.forEach((raw, i) => {
    if (raw) {
      try { probeData[dates[i]] = JSON.parse(raw) } catch (err) {
        console.warn(`[monthly-archive] corrupt probe data for ${dates[i]}:`, err instanceof Error ? err.message : err)
      }
    }
  })

  // Read accumulated incident data
  const incRaw = await kv.get(`incidents:monthly:${period}`).catch(() => null)
  let incidentData: MonthlyIncidents | null = null
  if (incRaw) {
    try { incidentData = JSON.parse(incRaw) } catch (err) {
      console.warn(`[monthly-archive] corrupt incident accumulation for ${period}:`, err instanceof Error ? err.message : err)
    }
  }

  // Snapshot accumulated security alerts before their 60d TTL lapses (#290). Missing
  // or malformed data must not fail the archive — security is optional enrichment.
  const secRaw = await kv.get(`security:monthly:${period}`).catch(() => null)
  let security: MonthlySecuritySummary | null = null
  if (secRaw) {
    try {
      const parsed = JSON.parse(secRaw) as MonthlySecurityEntry[]
      if (Array.isArray(parsed) && parsed.length > 0) {
        security = summarizeSecurityAlerts(parsed)
        // Attach permanent per-alert timelines to OSV top findings (#291).
        security = await enrichTopFindingsWithTimelines(kv, security)
      }
    } catch (err) {
      console.warn(`[monthly-archive] corrupt security accumulation for ${period}:`, err instanceof Error ? err.message : err)
    }
  }

  const uptimeMap = computeMonthlyUptime(dailyData)
  const latencyMap = computeMonthlyLatency(probeData)

  // Guard: 0 days with data is almost certainly a KV failure
  if (daysCollected === 0) {
    console.error(`[monthly-archive] No daily data found for ${period} — possible KV read failure (checked ${dates.length} days)`)
  }

  // Build per-service archive
  const services: Record<string, MonthlyServiceData> = {}
  const allIds = new Set([...Object.keys(uptimeMap), ...Object.keys(latencyMap)])

  if (scoreData) {
    for (const svc of scoreData) allIds.add(svc.id)
  }
  if (incidentData) {
    for (const id of Object.keys(incidentData.services)) allIds.add(id)
  }

  for (const id of allIds) {
    const scoreSvc = scoreData?.find(s => s.id === id)
    const incSvc = incidentData?.services[id]

    let avgResolutionMin: number | null = null
    if (incSvc && incSvc.count > 0 && incSvc.totalMinutes > 0) {
      avgResolutionMin = Math.round(incSvc.totalMinutes / incSvc.count)
    }
    // totalMinutes / longestMinutes are already tracked per-service by accumulateMonthlyIncidents
    // — surface them in the permanent archive so monthly reports can render full Incident Summary
    // columns (Downtime, Longest) without losing data after the 60d incidents:monthly:* TTL lapses.
    const totalDowntimeMin = incSvc && incSvc.totalMinutes > 0 ? incSvc.totalMinutes : null
    const longestIncidentMin = incSvc && incSvc.longestMinutes > 0 ? incSvc.longestMinutes : null

    // Snapshot per-incident detail (#375) so the dashboard's 90-day filter can read it
    // post-archive. accumulateMonthlyIncidents already enforces the per-service cap and
    // dedup, so we just defensively-clone the array (avoids accidental mutation downstream).
    const incidentList = incSvc?.incidents && incSvc.incidents.length > 0
      ? incSvc.incidents.map(e => ({ ...e }))
      : undefined

    services[id] = {
      uptime: uptimeMap[id] ?? null,
      score: scoreSvc?.aiwatchScore ?? null,
      grade: scoreSvc?.scoreGrade ?? null,
      incidents: incSvc?.count ?? 0,
      avgResolutionMin,
      totalDowntimeMin,
      longestIncidentMin,
      avgLatencyMs: latencyMap[id] ?? null,
      ...(incidentList ? { incidentList } : {}),
    }
  }

  return {
    period,
    generatedAt: new Date().toISOString(),
    daysCollected,
    services,
    security,
  }
}

/** Check if we should run monthly archive (1st of month, UTC 00:00-00:14 or catch-up 01:00-01:14) */
export function isInMonthlyArchiveWindow(
  utcDate: number,
  utcHours: number,
  utcMinutes: number,
): { inWindow: boolean; isCatchUp: boolean } {
  if (utcDate !== 1) return { inWindow: false, isCatchUp: false }
  const isNormal = utcHours === 0 && utcMinutes < 15
  const isCatchUp = utcHours === 1 && utcMinutes < 15
  if (!isNormal && !isCatchUp) return { inWindow: false, isCatchUp: false }
  return { inWindow: true, isCatchUp: !isNormal }
}

// ── Archive-ready Discord notification (aiwatch-reports#4) ───────────
//
// The aiwatch-reports `generate-report.yml` workflow is `workflow_dispatch`-only,
// so operators have to remember to click "Run workflow" on the 1st. This hook fires
// a one-shot Discord ping with the workflow URL the moment the monthly archive lands.

export const REPORTS_WORKFLOW_URL =
  'https://github.com/bentleypark/aiwatch-reports/actions/workflows/generate-report.yml'

export function archiveNotifiedKey(period: string): string {
  return `archive:notified:${period}`
}

/**
 * Build the Discord embed for "monthly archive ready — go generate the draft" pings.
 * Pure function for testability; the cron handler owns KV dedup + the send itself.
 *
 * `period` is the YYYY-MM covered by the archive (e.g. `"2026-04"` for April).
 * Invalid periods fall back to the raw string so a malformed call still produces a
 * readable embed rather than `"Invalid Date"`.
 */
export function buildArchiveReadyEmbed(
  period: string,
  serviceCount: number,
  daysCollected: number,
): { title: string; description: string; color: number } {
  let monthLabel = period
  const match = /^(\d{4})-(\d{2})$/.exec(period)
  if (match) {
    const y = Number(match[1])
    const m = Number(match[2])
    if (m >= 1 && m <= 12) {
      monthLabel = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', {
        month: 'long', year: 'numeric', timeZone: 'UTC',
      })
    }
  }
  const description = [
    `**${monthLabel}** archive is now available in KV (\`archive:monthly:${period}\`).`,
    ``,
    `• Services: ${serviceCount}`,
    `• Days collected: ${daysCollected}`,
    ``,
    `🚀 [**Generate report draft →**](${REPORTS_WORKFLOW_URL})`,
    ``,
    `*Click the link, press "Run workflow", enter month \`${period}\`, and a draft PR will open for review.*`,
  ].join('\n')
  return {
    title: `📦 Monthly Archive Ready — ${period}`,
    description,
    color: 0x9B59B6, // purple — consistent with daily summary / monthly ops
  }
}
