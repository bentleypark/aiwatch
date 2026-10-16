// #1711 — the latest PUBLISHED monthly report, summarised for the Claude extension popup.
//
// The archive (`archive:monthly:{YYYY-MM}`) is built on the 1st, but the report page is published
// later by hand, so a month is only offered once `ai-watch.dev/reports/{YYYY-MM}/` answers 200.

import type { KVLike } from './utils'
import { kvPut, fetchWithTimeout } from './utils'

export const LATEST_REPORT_KEY = 'report:latest-summary'
export const REPORT_SITE = 'https://ai-watch.dev/reports'

export interface LatestReportSummary {
  month: string
  url: string
  services: Array<{ id: string; incidents: number | null; downtimeMin: number | null }>
}

/** The two most recent closed UTC months, newest first. */
export function reportCandidates(now: Date): string[] {
  return [1, 2].map((back) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1))
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
  })
}

export function reportUrl(month: string): string {
  return `${REPORT_SITE}/${month}/`
}

/** 200 → published, 404 → not yet; anything else, or no answer → null (unknown). */
export async function isReportPublished(url: string, fetchFn: (url: string) => Promise<Response> = (u) => fetchWithTimeout(u, 8000)): Promise<boolean | null> {
  try {
    const res = await fetchFn(url)
    return res.status === 200 ? true : res.status === 404 ? false : null
  } catch {
    return null
  }
}

function count(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
}

/** Pure. Picks the report's own figures (`incidents`, `totalDowntimeMin`) for `ids` from an archive. */
export function buildLatestReportSummary(archive: unknown, month: string, ids: readonly string[]): LatestReportSummary | null {
  const services = (archive as { services?: Record<string, { incidents?: unknown; totalDowntimeMin?: unknown }> } | null)?.services
  if (!services || typeof services !== 'object') return null
  const rows = ids.filter((id) => services[id]).map((id) => ({
    id,
    incidents: count(services[id].incidents),
    downtimeMin: count(services[id].totalDowntimeMin),
  }))
  return rows.length > 0 ? { month, url: reportUrl(month), services: rows } : null
}

function isSummary(v: unknown): v is LatestReportSummary {
  const s = v as LatestReportSummary
  return !!s && typeof s.month === 'string' && /^\d{4}-\d{2}$/.test(s.month)
    && s.url === reportUrl(s.month) && Array.isArray(s.services) && s.services.length > 0
}

export async function readLatestReportSummary(kv: KVLike): Promise<LatestReportSummary | null> {
  try {
    const raw = await kv.get(LATEST_REPORT_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return isSummary(parsed) ? parsed : null
  } catch (err) {
    console.warn('[latest-report] read failed:', err instanceof Error ? err.message : err)
    return null
  }
}

export type RefreshOutcome = 'current' | 'written' | 'none-published' | 'unreadable' | 'write-failed'

/**
 * Walks the candidate months newest first and stops at the first one that is already stored, or is
 * published and has an archive. A page check, archive read or stored-value read that cannot be
 * answered leaves the stored summary as it was.
 */
export async function refreshLatestReportSummary(
  kv: KVLike,
  now: Date,
  ids: readonly string[],
  isPublished: (url: string) => Promise<boolean | null>,
): Promise<RefreshOutcome> {
  let stored: LatestReportSummary | null
  try {
    const raw = await kv.get(LATEST_REPORT_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    stored = isSummary(parsed) ? parsed : null
  } catch {
    return 'unreadable'
  }
  for (const month of reportCandidates(now)) {
    if (stored?.month === month) return 'current'
    const published = await isPublished(reportUrl(month))
    if (published === null) return 'unreadable'
    if (!published) continue
    let archive: unknown
    try {
      const raw = await kv.get(`archive:monthly:${month}`)
      archive = raw ? JSON.parse(raw) : null
    } catch {
      return 'unreadable'
    }
    const summary = buildLatestReportSummary(archive, month, ids)
    if (!summary) continue
    return (await kvPut(kv, LATEST_REPORT_KEY, JSON.stringify(summary))) ? 'written' : 'write-failed'
  }
  return 'none-published'
}
