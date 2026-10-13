// #1118 — an incident we announced that a card no longer carries and that was never closed.

import { ALERTED_NEW_TTL_S, parseAlertedRoster } from './alerts'
import { PHANTOM_PRUNE_AFTER_MISSED_RUNS, type MonthlyIncidentEntry, type MonthlyIncidents } from './monthly-archive'
import { isSuppressedByIdTitle, readSuppressionsFreshOrNull, type SuppressionEntry } from './suppression'
import type { ServiceStatus } from './types'
import { kvPut } from './utils'
import { liveIncidentIds } from './withdrawn'

export const GONE_HANDLED_PREFIX = 'alerted:gone:'
export const GONE_SEEN_PREFIX = 'gone:seen:'
export const GONE_SEEN_TTL_S = 3600
export const GONE_DAILY_PREFIX = 'incident-gone:'
export const GONE_DAILY_TTL_S = 30 * 86400
export const GONE_BATCH_MAX = 10

const CRON_MS = 5 * 60_000
/** One cron tick longer than the phantom prune takes to tombstone a withdrawn incident. */
export const GONE_HOLD_MS = (PHANTOM_PRUNE_AFTER_MISSED_RUNS + 1) * CRON_MS
/** A candidate unseen for longer than this starts its hold again. */
export const GONE_GAP_MS = 8 * 60_000

export type GoneOutcome = 'reported' | 'resolved' | 'suppressed' | 'withdrawn' | 'unverified'
const OUTCOMES: readonly GoneOutcome[] = ['reported', 'resolved', 'suppressed', 'withdrawn', 'unverified']

/** Announced and never closed, minus the ids another path owns. Pure. */
export function goneAlertedIds(
  announced: Iterable<string>,
  closed: ReadonlySet<string>,
  owned: ReadonlySet<string>,
): string[] {
  return [...announced].filter((id) => !closed.has(id) && !owned.has(id))
}

type Carrier = Pick<ServiceStatus, 'incidents' | 'status' | 'sourceDead' | 'sourceUnknown' | 'liveIncidentsActiveOnly' | 'incidentSourceStale'>

/** The announced services whose own list does not carry the incident. A service absent from this
 *  cycle's list counts as missing. */
export function servicesMissing(incId: string, svcIds: readonly string[], byId: ReadonlyMap<string, Carrier>): string[] {
  return svcIds.filter((id) => !byId.get(id)?.incidents?.some((i) => i.id === incId))
}

/** Every one of these services was read this cycle, from a list that shows resolved incidents. */
export function sourcesReadable(svcIds: readonly string[], byId: ReadonlyMap<string, Carrier>): boolean {
  return svcIds.length > 0 && svcIds.every((id) => {
    const s = byId.get(id)
    return !!s && s.status !== 'unknown' && !s.sourceDead && !s.sourceUnknown && !s.liveIncidentsActiveOnly && !s.incidentSourceStale
  })
}

export interface GoneHold { first: number; last: number }

/** Advance a candidate's hold by one cycle. Continuous absence only: a gap restarts it. */
export function advanceHold(prev: GoneHold | null, nowMs: number): { next: GoneHold; confirmed: boolean } {
  if (!prev || nowMs - prev.last > GONE_GAP_MS) {
    return { next: { first: nowMs, last: nowMs }, confirmed: false }
  }
  return { next: { first: prev.first, last: nowMs }, confirmed: nowMs - prev.first >= GONE_HOLD_MS }
}

export function parseHold(raw: string | null): GoneHold | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Partial<GoneHold>
    return typeof v?.first === 'number' && typeof v?.last === 'number' ? { first: v.first, last: v.last } : null
  } catch {
    return null
  }
}

export interface AccumulatorRow extends Pick<MonthlyIncidentEntry, 'title' | 'finalStatus'> {
  /** From a month that is closed: the accumulator no longer updates it. */
  frozen: boolean
}

/** What a gone incident is, given the accumulator row kept for it (null when none survives). */
export function classifyGone(
  incId: string,
  svcIds: readonly string[],
  row: AccumulatorRow | null,
  suppressions: SuppressionEntry[],
): 'reported' | 'resolved' | 'suppressed' | 'unverified' {
  if (row?.finalStatus === 'resolved') return 'resolved'
  const hidden = suppressions.some((e) => e.scope === 'incident' && e.incId === incId)
    || (row !== null && svcIds.some((svcId) => isSuppressedByIdTitle(incId, row.title, svcId, suppressions)))
  if (hidden) return 'suppressed'
  return row?.frozen ? 'unverified' : 'reported'
}

/** Key names under a prefix; `null` when the listing is incomplete or failed. */
export async function listIds(kv: KVNamespace, prefix: string): Promise<Set<string> | null> {
  try {
    const page = await kv.list({ prefix, limit: 1000 })
    if (!page.list_complete) return null
    return new Set(page.keys.map((k) => k.name.slice(prefix.length)))
  } catch (err) {
    console.warn('[gone] #1118 key list failed:', prefix, err instanceof Error ? err.message : err)
    return null
  }
}

export interface GoneReport {
  incId: string
  svcIds: string[]
  title: string | null
}

export function formatGoneAlert(reports: readonly GoneReport[], names: ReadonlyMap<string, string>): { title: string; description: string; color: number } {
  const lines = reports.slice(0, GONE_BATCH_MAX).map((r) => {
    const where = r.svcIds.map((id) => names.get(id) ?? id).join(', ')
    return `• **${r.title ?? '(title no longer held)'}** — missing from ${where}\n  \`${r.incId}\``
  })
  const more = reports.length > GONE_BATCH_MAX ? `\n…and ${reports.length - GONE_BATCH_MAX} more` : ''
  return {
    title: `⚠️ ${reports.length} announced incident${reports.length === 1 ? '' : 's'} no longer on the card, never closed`,
    description: `${lines.join('\n')}${more}\n\nNo Resolved alert and no withdrawal notice was sent for these. Check the provider's page.`,
    color: 0xF0B232,
  }
}

export interface GoneRun {
  candidates: number
  pending: number
  skipped: number
  outcomes: Record<GoneOutcome, number>
}

/** `'unreadable'` when a month that could hold the row failed to read or parse. */
async function accumulatorRow(kv: KVNamespace, months: readonly string[], incId: string): Promise<AccumulatorRow | null | 'unreadable'> {
  for (const [i, month] of months.entries()) {
    try {
      const raw = await kv.get(`incidents:monthly:${month}`)
      if (!raw) continue
      const data = JSON.parse(raw) as MonthlyIncidents
      for (const svc of Object.values(data.services ?? {})) {
        const row = (svc.incidents ?? []).find((e) => e.id === incId)
        if (row) return { title: row.title, finalStatus: row.finalStatus, frozen: i > 0 }
      }
    } catch (err) {
      console.warn('[gone] #1118 accumulator read failed:', month, err instanceof Error ? err.message : err)
      return 'unreadable'
    }
  }
  return null
}

async function bumpDaily(kv: KVNamespace, date: string, outcomes: Record<GoneOutcome, number>, reportedBySvc: Record<string, number>): Promise<void> {
  const key = `${GONE_DAILY_PREFIX}${date}`
  try {
    const prev = JSON.parse((await kv.get(key)) ?? '{}') as { outcomes?: Record<string, number>; reportedBySvc?: Record<string, number> }
    const merged = { outcomes: { ...(prev.outcomes ?? {}) } as Record<string, number>, reportedBySvc: { ...(prev.reportedBySvc ?? {}) } }
    for (const [k, n] of Object.entries(outcomes)) if (n > 0) merged.outcomes[k] = (merged.outcomes[k] ?? 0) + n
    for (const [k, n] of Object.entries(reportedBySvc)) merged.reportedBySvc[k] = (merged.reportedBySvc[k] ?? 0) + n
    await kvPut(kv, key, JSON.stringify(merged), { expirationTtl: GONE_DAILY_TTL_S })
  } catch (err) {
    console.warn('[gone] #1118 daily counter failed:', err instanceof Error ? err.message : err)
  }
}

/** One cron cycle. Never throws. */
export async function runGoneCheck(
  kv: KVNamespace,
  send: (embed: { title: string; description: string; color: number }) => Promise<boolean>,
  scored: ReadonlyArray<ServiceStatus>,
  withdrawnIncIds: ReadonlySet<string>,
  nowMs: number,
  noResolvedSignal: ReadonlySet<string>,
): Promise<GoneRun | null> {
  const run: GoneRun = { candidates: 0, pending: 0, skipped: 0, outcomes: Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<GoneOutcome, number> }
  try {
    const [announced, closed] = await Promise.all([listIds(kv, 'alerted:new:'), listIds(kv, 'alerted:res:')])
    if (!announced || !closed) return null
    const byId = new Map(scored.map((s) => [s.id, s]))
    const date = new Date(nowMs).toISOString().slice(0, 10)
    const month = date.slice(0, 7)
    const prevMonth = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7)

    const settled: Array<{ incId: string; outcome: GoneOutcome }> = []
    const reports: GoneReport[] = []
    let suppressions: SuppressionEntry[] | null | undefined
    const carriedAnywhere = liveIncidentIds(scored)
    const withdrawalPathOwns = new Set([...withdrawnIncIds].filter((id) => !carriedAnywhere.has(id)))
    for (const incId of goneAlertedIds(announced, closed, withdrawalPathOwns)) {
      const rosterRaw = await kv.get(`alerted:new:${incId}`).catch(() => null)
      const svcIds = rosterRaw ? parseAlertedRoster(rosterRaw, '').ids : []
      const missing = servicesMissing(incId, svcIds, byId)
      if (missing.length === 0 && svcIds.length > 0) continue
      run.candidates++
      if (await kv.get(`${GONE_HANDLED_PREFIX}${incId}`).catch(() => 'unreadable')) continue
      if (await kv.get(`alerted:wd:${incId}`).catch(() => null)) { settled.push({ incId, outcome: 'withdrawn' }); continue }
      if (missing.some((id) => noResolvedSignal.has(id)) || !sourcesReadable(missing, byId)) { run.skipped++; continue }

      const seenKey = `${GONE_SEEN_PREFIX}${incId}`
      const seenRaw = await kv.get(seenKey).catch(() => 'unreadable')
      if (seenRaw === 'unreadable') { run.skipped++; continue }
      const { next, confirmed } = advanceHold(parseHold(seenRaw), nowMs)
      await kvPut(kv, seenKey, JSON.stringify(next), { expirationTtl: GONE_SEEN_TTL_S })
      if (!confirmed) { run.pending++; continue }

      suppressions ??= await readSuppressionsFreshOrNull(kv)
      if (suppressions === null) { run.skipped++; continue }
      const row = await accumulatorRow(kv, [month, prevMonth], incId)
      if (row === 'unreadable') { run.skipped++; continue }
      const outcome = classifyGone(incId, missing, row, suppressions)
      settled.push({ incId, outcome })
      if (outcome === 'reported') reports.push({ incId, svcIds: missing, title: row?.title ?? null })
    }

    const reportedIds = new Set(reports.map((r) => r.incId))
    const delivered = reports.length === 0 || await send(formatGoneAlert(reports, new Map(scored.map((s) => [s.id, s.name]))))
    const reportedBySvc: Record<string, number> = {}
    for (const { incId, outcome } of settled) {
      if (reportedIds.has(incId) && !delivered) continue
      await kvPut(kv, `${GONE_HANDLED_PREFIX}${incId}`, outcome, { expirationTtl: ALERTED_NEW_TTL_S })
      run.outcomes[outcome]++
    }
    if (delivered) for (const r of reports) for (const id of r.svcIds) reportedBySvc[id] = (reportedBySvc[id] ?? 0) + 1
    if (OUTCOMES.some((o) => run.outcomes[o] > 0)) await bumpDaily(kv, date, run.outcomes, reportedBySvc)
    return run
  } catch (err) {
    console.warn('[gone] #1118 check failed:', err instanceof Error ? err.message : err)
    return null
  }
}
