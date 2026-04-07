// Probe RTT daily archival — aggregates 24h probe snapshots into daily summaries
// Called by Daily Summary cron (UTC 09:00). Stored with 90d TTL for monthly reports.

import type { ProbeSnapshot } from './probe'
import type { ProbeSummary } from './types'

export interface ProbeDailyStat {
  p50: number
  p75: number
  p95: number
  min: number
  max: number
  count: number
  spikes: number // count of rtt > 3×median or rtt=-1
}

export type ProbeDailyData = Record<string, ProbeDailyStat>

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.ceil(sorted.length * p / 100) - 1
  return sorted[Math.max(0, idx)]
}

/** Aggregate probe snapshots into per-service daily stats */
export function aggregateProbeDaily(snapshots: ProbeSnapshot[]): ProbeDailyData {
  // Collect RTT values per service
  const rttMap: Record<string, number[]> = {}
  for (const snap of snapshots) {
    for (const [svcId, result] of Object.entries(snap.data)) {
      if (!rttMap[svcId]) rttMap[svcId] = []
      rttMap[svcId].push(result.rtt)
    }
  }

  const result: ProbeDailyData = {}
  for (const [svcId, allRtt] of Object.entries(rttMap)) {
    // Separate valid RTTs from failures (rtt=-1)
    const valid = allRtt.filter(r => r > 0).sort((a, b) => a - b)
    const failures = allRtt.filter(r => r <= 0).length

    if (valid.length === 0) {
      result[svcId] = { p50: 0, p75: 0, p95: 0, min: 0, max: 0, count: allRtt.length, spikes: failures }
      continue
    }

    const median = percentile(valid, 50)
    const threshold = median * 3
    const spikeCount = failures + valid.filter(r => r > threshold).length

    result[svcId] = {
      p50: percentile(valid, 50),
      p75: percentile(valid, 75),
      p95: percentile(valid, 95),
      min: valid[0],
      max: valid[valid.length - 1],
      count: allRtt.length,
      spikes: spikeCount,
    }
  }

  return result
}

/** Compute 7-day probe summary per service from daily archives.
 *  Returns Map<serviceId, ProbeSummary> for Responsiveness scoring. */
export async function computeProbeSummaries(kv: KVNamespace, days = 7): Promise<Map<string, ProbeSummary>> {
  const result = new Map<string, ProbeSummary>()

  // Read daily archives in parallel (skip today — not yet archived)
  const keys = Array.from({ length: days }, (_, i) => {
    return `probe:daily:${new Date(Date.now() - (i + 1) * 86_400_000).toISOString().split('T')[0]}`
  })
  const rawValues = await Promise.all(keys.map(k => kv.get(k)))
  const dailyData: ProbeDailyData[] = []
  for (const raw of rawValues) {
    if (!raw) continue
    try {
      dailyData.push(JSON.parse(raw))
    } catch (err) { console.warn('[probe-archival] malformed daily data:', err instanceof Error ? err.message : err) }
  }

  if (dailyData.length < 2) return result // need at least 2 days for CV

  // Collect per-service daily p50 and p95 values
  const svcStats: Record<string, { p50s: number[]; p95s: number[] }> = {}
  for (const day of dailyData) {
    for (const [svcId, stat] of Object.entries(day)) {
      if (stat.p50 <= 0) continue // skip days with no valid data
      if (!svcStats[svcId]) svcStats[svcId] = { p50s: [], p95s: [] }
      svcStats[svcId].p50s.push(stat.p50)
      svcStats[svcId].p95s.push(stat.p95)
    }
  }

  for (const [svcId, stats] of Object.entries(svcStats)) {
    if (stats.p50s.length < 2) continue

    const p50Avg = stats.p50s.reduce((a, b) => a + b, 0) / stats.p50s.length
    const p95Avg = stats.p95s.reduce((a, b) => a + b, 0) / stats.p95s.length

    // Day-to-day CV of p50 values (σ/μ)
    const p50Variance = stats.p50s.reduce((acc, v) => acc + (v - p50Avg) ** 2, 0) / stats.p50s.length
    const cvDaily = Math.sqrt(p50Variance) / p50Avg

    // p95/p50 spread ratio
    const spreadRatio = p50Avg > 0 ? (p95Avg - p50Avg) / p50Avg : 0

    // Combined CV: 50% day-to-day + 50% spread
    const cvCombined = 0.5 * cvDaily + 0.5 * spreadRatio

    result.set(svcId, {
      p50: Math.round(p50Avg),
      p95: Math.round(p95Avg),
      cvCombined: Math.round(cvCombined * 1000) / 1000, // 3 decimal places
    })
  }

  return result
}

/** Archive yesterday's probe data to KV (called by daily summary cron)
 *  Note: cron runs at UTC 09:00, so archived data covers ~UTC 00:00–23:59 of the target date
 *  (early hours may be partially missing depending on probe:24h trim timing) */
export async function archiveProbeDaily(kv: KVNamespace, now?: Date): Promise<boolean> {
  const yesterday = new Date((now ?? new Date()).getTime() - 86_400_000).toISOString().split('T')[0]
  const destKey = `probe:daily:${yesterday}`

  // Skip if already archived
  const existing = await kv.get(destKey)
  if (existing) return false

  const raw = await kv.get('probe:24h')
  if (!raw) return false

  try {
    const parsed = JSON.parse(raw)
    const snapshots: ProbeSnapshot[] = parsed.snapshots ?? []

    // Filter to yesterday's snapshots only
    const yesterdaySnapshots = snapshots.filter(s => s.t.startsWith(yesterday))
    if (yesterdaySnapshots.length === 0) return false

    const daily = aggregateProbeDaily(yesterdaySnapshots)
    await kv.put(destKey, JSON.stringify(daily), { expirationTtl: 90 * 86400 }) // 90 days
    return true
  } catch (err) {
    console.error('[probe-archival] Failed:', err instanceof Error ? err.message : err)
    return false
  }
}
