// Monthly Archive — permanent per-month service reliability snapshot
// Triggered on 1st of each month (cron), aggregates previous month's daily data.
// Stored as archive:monthly:{YYYY-MM} with NO TTL (permanent).
//
// Incident data: accumulated daily via accumulateMonthlyIncidents() in daily summary cron,
// stored in incidents:monthly:{YYYY-MM} KV key (60d TTL). This ensures accurate monthly
// incident counts, unlike services:latest which is a point-in-time snapshot.

import type { ProbeDailyData } from './probe-archival'
import type { ServiceStatus, Incident } from './types'

export type ScoreGrade = 'excellent' | 'good' | 'fair' | 'degrading' | 'unstable'

export interface MonthlyServiceData {
  uptime: number | null          // uptime% from daily counters (null if no data)
  score: number | null           // AIWatch Score at archive time (null if unavailable)
  grade: ScoreGrade | null       // Score grade (null if score unavailable)
  incidents: number              // incident count for the month (from accumulated data)
  avgResolutionMin: number | null // average resolution time in minutes (null if no resolved incidents)
  avgLatencyMs: number | null    // average probe RTT p75 in ms (null if no probe data)
}

export interface MonthlyArchive {
  period: string                 // YYYY-MM
  generatedAt: string            // ISO timestamp
  daysCollected: number          // number of days with actual uptime data
  services: Record<string, MonthlyServiceData>
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
}

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
      result.services[svc.id] = { count: 0, totalMinutes: 0, longestMinutes: 0, dates: [], incidentIds: [], durations: {} }
    }
    const data = result.services[svc.id]
    // Ensure durations map exists (backward compat with pre-durations data)
    if (!data.durations) data.durations = {}

    for (const inc of incidents) {
      const dur = inc.duration ? parseDurationMin(inc.duration) : 0

      if (data.incidentIds.includes(inc.id)) {
        // Update duration delta if incident resolved since last accumulation
        const oldDur = data.durations[inc.id] ?? 0
        if (dur > oldDur) {
          data.totalMinutes += (dur - oldDur)
          data.durations[inc.id] = dur
          if (dur > data.longestMinutes) data.longestMinutes = dur
        }
        continue
      }

      // New incident
      data.incidentIds.push(inc.id)
      data.durations[inc.id] = dur
      data.count++
      data.totalMinutes += dur
      if (dur > data.longestMinutes) data.longestMinutes = dur

      const date = inc.startedAt.slice(0, 10)
      if (!data.dates.includes(date)) data.dates.push(date)
    }
  }

  return result
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

    services[id] = {
      uptime: uptimeMap[id] ?? null,
      score: scoreSvc?.aiwatchScore ?? null,
      grade: scoreSvc?.scoreGrade ?? null,
      incidents: incSvc?.count ?? 0,
      avgResolutionMin,
      avgLatencyMs: latencyMap[id] ?? null,
    }
  }

  return {
    period,
    generatedAt: new Date().toISOString(),
    daysCollected,
    services,
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
