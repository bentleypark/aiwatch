// #1697 — how long a service's past incidents took to recover, from our own `incident:history:*`
// corpus. Shown beside the AI recovery estimate (is-down card, dashboard modal, Discord new-incident
// alert, Slack /feed), never fed into it (#827).
//
// Computed once a day in the cron into ONE small KV value, so a reader adds one read instead of one
// per service (#1531).

import type { KVLike } from './utils'
import { kvPut } from './utils'
import type { IncidentHistoryRecord } from './incident-history'
import type { DurationOverride } from './overrides'
import type { ServiceConfig } from './types'
import { readOverridesFreshResult } from './overrides'
import { isAutoMonitorIncident } from './services'
import { isFeedEventTitle } from './parsers/betterstack'
import type { RecoveryBaseline } from './recovery-baseline-text'

export type { RecoveryBaseline }

export const RECOVERY_BASELINE_KEY = 'incident:recovery-baseline'
export const RECOVERY_BASELINE_MIN_N = 10

/**
 * Pure. Counts an incident once (by `incId`) and only when its duration is an editorial record of the
 * incident: auto-monitor records (stamped, or for records written before the stamp, matched against
 * the service's `autoMonitorTitles`), feed-reconstructed ones and zero-length ones are left out. A
 * duration override replaces the stored duration. Below `RECOVERY_BASELINE_MIN_N` → null.
 */
export function summarizeRecoveryHistory(
  records: IncidentHistoryRecord[],
  overrides: DurationOverride[],
  config: Pick<ServiceConfig, 'autoMonitorTitles' | 'titleMap'> = {},
): RecoveryBaseline | null {
  const overrideMin = new Map(overrides.map((o) => [o.id, o.durationMin]))
  const originalTitles = new Map<string, string[]>()
  for (const [original, translated] of Object.entries(config.titleMap ?? {})) {
    originalTitles.set(translated, [...(originalTitles.get(translated) ?? []), original])
  }
  const isPreStampAutoMonitor = (title: string) =>
    [title, ...(originalTitles.get(title) ?? [])].some((t) => isAutoMonitorIncident({ title: t }, config))
  const byIncId = new Map<string, { startedAt: string; durationMin: number }>()
  for (const r of records) {
    if (byIncId.has(r.incId)) continue
    if (r.autoMonitor || isPreStampAutoMonitor(r.title) || isFeedEventTitle(r.title)) continue
    const durationMin = overrideMin.get(r.incId) ?? r.durationMin
    if (!(durationMin > 0)) continue
    byIncId.set(r.incId, { startedAt: r.startedAt, durationMin })
  }
  const kept = [...byIncId.values()]
  if (kept.length < RECOVERY_BASELINE_MIN_N) return null
  const sorted = kept.map((k) => k.durationMin).sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
  return {
    n: kept.length,
    medianMin: Math.round(median),
    p80Min: sorted[Math.ceil(0.8 * sorted.length) - 1],
    since: kept.map((k) => k.startedAt).sort()[0].slice(0, 10),
  }
}

/** Pure. One entry per service that clears the floor; services below it are absent. */
export function buildRecoveryBaselines(
  historyBySvc: Map<string, IncidentHistoryRecord[]>,
  overrides: DurationOverride[],
  configs: Array<Pick<ServiceConfig, 'id' | 'autoMonitorTitles' | 'titleMap'>>,
): Record<string, RecoveryBaseline> {
  const out: Record<string, RecoveryBaseline> = {}
  for (const config of configs) {
    const baseline = summarizeRecoveryHistory(historyBySvc.get(config.id) ?? [], overrides, config)
    if (baseline) out[config.id] = baseline
  }
  return out
}

export function writeRecoveryBaselines(kv: KVLike, baselines: Record<string, RecoveryBaseline>): Promise<boolean> {
  return kvPut(kv, RECOVERY_BASELINE_KEY, JSON.stringify(baselines))
}

export async function rebuildRecoveryBaselines(
  kv: KVNamespace,
  historyBySvc: Map<string, IncidentHistoryRecord[]>,
  configs: Array<Pick<ServiceConfig, 'id' | 'autoMonitorTitles' | 'titleMap'>>,
): Promise<'written' | 'write-failed' | 'unreadable' | 'malformed'> {
  const overrides = await readOverridesFreshResult(kv)
  if (overrides.state !== 'ok') return overrides.state
  return (await writeRecoveryBaselines(kv, buildRecoveryBaselines(historyBySvc, overrides.list, configs))) ? 'written' : 'write-failed'
}

function isBaseline(v: unknown): v is RecoveryBaseline {
  const b = v as RecoveryBaseline
  return !!b && Number.isInteger(b.n) && b.n >= RECOVERY_BASELINE_MIN_N
    && Number.isFinite(b.medianMin) && b.medianMin > 0
    && Number.isFinite(b.p80Min) && b.p80Min >= b.medianMin
    && typeof b.since === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.since)
}

/** `{}` on a miss, a KV error or an unusable value — the line is then hidden. */
export async function readRecoveryBaselines(kv: KVLike): Promise<Record<string, RecoveryBaseline>> {
  try {
    const raw = await kv.get(RECOVERY_BASELINE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => isBaseline(v)))
  } catch (err) {
    console.warn('[recovery-baseline] read failed:', err instanceof Error ? err.message : err)
    return {}
  }
}
