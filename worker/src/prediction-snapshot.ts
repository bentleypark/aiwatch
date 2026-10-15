// Prediction-time snapshots — #1695.
//
// The recovery estimate is made from an incident's text and timeline at one moment. `ai:analysis:*`
// lapses within 1-2h. This module keeps a compact snapshot per analysis, folds it into the durable
// `incident:history` record at resolution, and appends a copy to a monthly ledger that the
// per-service `HISTORY_CAP` cannot truncate.
//
// Keys:
//   ai:snaps:{svcId}:{incId}   — snapshots of one service's incident, appended per fresh analysis, capped, 30d TTL.
//   incident:ledger:{YYYY-MM}:{svcId} — that service's resolved incidents of that UTC month (month of
//                               `resolvedAt`), no TTL. One key per service because KV allows one write per
//                               second to a key, and several services can resolve in one cron cycle.

import type { KVLike } from './utils'
import { kvPut, sanitize } from './utils'
import type { IncidentHistoryRecord } from './incident-history'

export const SNAPSHOT_CAP = 6
export const SNAPSHOT_TTL_S = 30 * 86400
export const FIRST_UPDATE_MAX = 300
/** Upper bound on one service's month, so a runaway writer cannot grow a single KV value without limit. */
export const LEDGER_MAX_ENTRIES = 5000

export interface PredictionSnapshot {
  /** The analysis' own `analyzedAt` — also the dedup key within an incident's list. */
  at: string
  /** Minutes the incident had been open at analysis; null when its start is unparseable or in the future. */
  elapsedMin: number | null
  stage: string
  /** Timeline updates the provider had posted by then. */
  updates: number
  /** Minutes since the latest update; null when there was none. */
  sinceLastUpdateMin: number | null
  impact: 'minor' | 'major' | 'critical' | null
  scope?: string[]
  model?: 'gemma' | 'sonnet'
  /** The estimate this analysis made (upper bound, hours); null when the model gave none. */
  estimateHours: number | null
  /** How many similar past incidents the prompt carried from the durable corpus (0 = fallback list). */
  historyMatches: number
  /** First provider update, sanitized; kept on one snapshot per incident only. */
  firstUpdate?: string
}

export interface SnapshotIncident {
  status: string
  startedAt: string
  impact: string | null
  timeline?: Array<{ stage: string; text: string | null; at: string }>
}

export interface SnapshotResult {
  analyzedAt?: string
  model?: string
  estimatedRecoveryHours?: number
  affectedScope?: string[]
}

export function snapshotKey(svcId: string, incId: string): string {
  return `ai:snaps:${svcId}:${incId}`
}

export function ledgerKey(month: string, svcId: string): string {
  return `incident:ledger:${month}:${svcId}`
}

const minutesBetween = (laterMs: number, earlierMs: number): number | null => {
  if (Number.isNaN(laterMs) || Number.isNaN(earlierMs)) return null
  const diff = laterMs - earlierMs
  return diff >= 0 ? Math.floor(diff / 60_000) : null
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

export function buildPredictionSnapshot(
  inc: SnapshotIncident,
  result: SnapshotResult,
  ctx: { now: number; historyMatches: number },
): PredictionSnapshot {
  const timeline = inc.timeline ?? []
  const last = timeline.at(-1)
  const firstText = timeline.map(t => oneLine(sanitize(t.text ?? '', FIRST_UPDATE_MAX))).find(t => t.length > 0)
  const scope = (result.affectedScope ?? []).slice(0, 8).map(s => sanitize(s, 60)).filter(s => s.length > 0)
  const hours = result.estimatedRecoveryHours
  return {
    at: result.analyzedAt ?? new Date(ctx.now).toISOString(),
    elapsedMin: minutesBetween(ctx.now, new Date(inc.startedAt).getTime()),
    stage: sanitize(inc.status, 20),
    updates: timeline.length,
    sinceLastUpdateMin: last ? minutesBetween(ctx.now, new Date(last.at).getTime()) : null,
    impact: inc.impact === 'minor' || inc.impact === 'major' || inc.impact === 'critical' ? inc.impact : null,
    ...(scope.length > 0 && { scope }),
    ...(result.model === 'gemma' || result.model === 'sonnet' ? { model: result.model } : {}),
    estimateHours: typeof hours === 'number' && hours > 0 ? hours : null,
    historyMatches: Math.max(0, Math.floor(ctx.historyMatches)),
    ...(firstText && { firstUpdate: firstText }),
  }
}

function parseList(raw: string | null): PredictionSnapshot[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((s): s is PredictionSnapshot => !!s && typeof s === 'object' && typeof s.at === 'string') : []
  } catch {
    return []
  }
}

/**
 * Append one snapshot to a service's incident list. Idempotent on `at`; keeps the FIRST snapshot and the
 * most recent ones when over the cap; keeps `firstUpdate` on one
 * snapshot only. Best-effort: false on any KV failure, never throws.
 */
export async function appendPredictionSnapshot(kv: KVLike, svcId: string, incId: string, snap: PredictionSnapshot): Promise<boolean> {
  const key = snapshotKey(svcId, incId)
  try {
    const list = parseList(await kv.get(key))
    if (list.some(s => s.at === snap.at)) return true
    const hasText = list.some(s => !!s.firstUpdate)
    const { firstUpdate, ...rest } = snap
    list.push(hasText || !firstUpdate ? rest : snap)
    const kept = list.length > SNAPSHOT_CAP ? [list[0], ...list.slice(list.length - (SNAPSHOT_CAP - 1))] : list
    return await kvPut(kv, key, JSON.stringify(kept), { expirationTtl: SNAPSHOT_TTL_S })
  } catch (err) {
    console.warn('[prediction-snapshot] append failed:', key, err instanceof Error ? err.message : err)
    return false
  }
}

export async function readPredictionSnapshots(kv: KVLike, svcId: string, incId: string): Promise<PredictionSnapshot[]> {
  try {
    return parseList(await kv.get(snapshotKey(svcId, incId)))
  } catch (err) {
    console.warn('[prediction-snapshot] read failed:', svcId, incId, err instanceof Error ? err.message : err)
    return []
  }
}

/** One resolved incident in the ledger: the history record without its AI prose. */
export type LedgerEntry = Omit<IncidentHistoryRecord, 'predictedSummary'>

export function toLedgerEntry(rec: IncidentHistoryRecord): LedgerEntry {
  const { predictedSummary: _summary, ...rest } = rec
  return rest
}

/**
 * Append one service's resolved records to its monthly ledger shards (month = UTC month of `resolvedAt`).
 * One read-modify-write per month touched; idempotent by `incId` (a repeat may fill in snapshots the
 * first copy lacked). Best-effort: false on any KV failure and the stored ledger is left as it was — a
 * failed read is never treated as an empty ledger.
 */
export async function appendLedger(kv: KVLike, svcId: string, records: IncidentHistoryRecord[]): Promise<boolean> {
  const byMonth = new Map<string, IncidentHistoryRecord[]>()
  for (const rec of records) {
    if (rec.svcId !== svcId) continue
    const month = /^\d{4}-\d{2}/.exec(rec.resolvedAt)?.[0]
    if (!month) continue
    byMonth.set(month, [...(byMonth.get(month) ?? []), rec])
  }
  let ok = true
  for (const [month, recs] of byMonth) {
    const key = ledgerKey(month, svcId)
    try {
      const raw = await kv.get(key)
      let list: LedgerEntry[] = []
      if (raw) {
        try {
          const parsed = JSON.parse(raw)
          if (Array.isArray(parsed)) list = parsed
        } catch {
          // corrupt value — start fresh rather than lose this write
        }
      }
      const byInc = new Map(list.map(e => [e.incId, e]))
      let changed = false
      for (const rec of recs) {
        const existing = byInc.get(rec.incId)
        if (!existing) {
          if (list.length >= LEDGER_MAX_ENTRIES) continue
          const entry = toLedgerEntry(rec)
          list.push(entry)
          byInc.set(rec.incId, entry)
          changed = true
        } else if (!existing.predictionSnapshots?.length && rec.predictionSnapshots?.length) {
          existing.predictionSnapshots = rec.predictionSnapshots
          changed = true
        }
      }
      if (!changed) continue
      if (!(await kvPut(kv, key, JSON.stringify(list)))) ok = false
    } catch (err) {
      console.warn('[prediction-snapshot] ledger append failed:', key, err instanceof Error ? err.message : err)
      ok = false
    }
  }
  return ok
}

export interface SnapshotCoverage {
  /** Resolved incidents in the window that carried an AI prediction (so a snapshot was expected). */
  forecasts: number
  withSnapshot: number
}

/** Coverage over the last `windowMs` of resolutions, one record per incident (siblings count once). */
export function summarizeSnapshotCoverage(records: IncidentHistoryRecord[], nowMs: number, windowMs = 86_400_000): SnapshotCoverage {
  const byInc = new Map<string, IncidentHistoryRecord>()
  for (const r of records) {
    const t = new Date(r.resolvedAt).getTime()
    if (Number.isNaN(t) || nowMs - t > windowMs || t > nowMs) continue
    if (!((r.predictedRecoveryHours ?? 0) > 0)) continue
    const existing = byInc.get(r.incId)
    if (!existing || (!existing.predictionSnapshots?.length && r.predictionSnapshots?.length)) byInc.set(r.incId, r)
  }
  const all = [...byInc.values()]
  return { forecasts: all.length, withSnapshot: all.filter(r => (r.predictionSnapshots?.length ?? 0) > 0).length }
}
