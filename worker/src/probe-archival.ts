// Probe RTT daily archival — aggregates 24h probe snapshots into daily summaries
// Called by Daily Summary cron (UTC 09:00). Stored with 90d TTL for monthly reports.

import type { ProbeSnapshot } from './probe'

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
