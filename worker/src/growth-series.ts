// Durable daily series for the consent-free growth metrics (#986, refs #547 · #842).
//
// WHY: #547's remaining item is "measure lift vs the 3→0 baseline" — did making the low-friction
// channel the primary CTA raise conversion? Conversion IS already measured server-side and
// consent-free (`webhook:sub:count` completions, `referral:out` clicks, WAE `isdown-view` views),
// unlike the cookie-gated GA4 events, which only see visitors who accepted a banner mid-outage.
//
// The blocker was never the analysis. It was that nothing kept a SERIES:
//   referral:out:{date}       2d TTL
//   webhook:sub:count:{date}  7d TTL
//   monthly-archive           does not store any of them
// The cron read each once, printed it into the Discord daily report, and let it expire. A lift
// comparison needs weeks of daily rows ("outage days vs quiet days", "before vs after #567"), so the
// measurement was un-runnable both retroactively (already expired) and going forward (would expire
// before enough accrued). A single failed cron day was an unrecoverable hole.
//
// This mirrors the pattern `probe-degradation:monthly` / `security:monthly` already use: at the moment
// the cron holds the values for the Discord report, append one row to a permanent monthly key. Zero
// extra reads; one KV write per day; one key per month.
//
// SNAPSHOT, NOT DELTA: we store `subscribers` (the confirmed-subscription count) rather than only
// `subscriberNewToday`. A delta is comparable solely against the day before it; a snapshot lets any
// later window be differenced — which is exactly what a lift comparison needs.
//
// ATTRIBUTION CAVEAT: rows dated before 2026-07-08 would be attribution-blind (#936 closed the UTM
// leaks that collapsed inbound to `(direct)`). Accrual starts after it, so every row here is clean.

import type { KVLike } from './utils'
import { kvPut } from './utils'
import type { AudienceCounts } from './outage-audience'

/** Rows kept per monthly key. ~31 days; the cap is a corruption guard, not a retention policy. */
export const GROWTH_SERIES_CAP = 40

export interface GrowthDailyRow {
  date: string // YYYY-MM-DD
  // The outage-day axis. These are alerts SENT TODAY, read from the `alert:count:{date}` daily
  // accumulator — NOT the cron cycle's own counters. The daily report runs in a single 09:00-09:04 UTC
  // window, so a cycle-scoped count would record an 04:00 outage as a quiet day, which is exactly the
  // classification this dataset exists to make.
  alertedIncidents: number | null // null = could not read the accumulator (≠ a quiet day)
  alertedResolved: number | null
  referralTotal: number | null // consent-free outbound clicks (#842). null = read failed; 0 = nobody clicked
  subscribers: number | null // consent-free completion SNAPSHOT. null = read failed
  subscriberNewToday: number | null // null on a first day or a corrupt baseline (#548 semantics)
  audienceTotal: number | null // is-down views, 24h (WAE)
  audienceActiveTotal: number | null // views during an active outage — the sponsor evidence
  audienceBySource: Record<string, number> | null
}

/**
 * The caller resolves null-vs-zero, because only the caller knows which happened. "No referrals
 * today" and "the referral key could not be read" are different facts, and a lift comparison that
 * cannot tell them apart will read a broken day as a quiet one — the precise error this dataset is
 * built to avoid. So every field arrives already disambiguated.
 */
export interface GrowthDailyInputs {
  date: string
  alertCounts: { incidents?: number; resolved?: number } | null | undefined
  referralTotal: number | null
  subscribers: number | null
  subscriberNewToday: number | null
  audience: AudienceCounts | null | undefined
}

/** `growth:daily:{YYYY-MM}` — permanent, no TTL. One key per month. */
export function growthSeriesKey(period: string): string {
  return `growth:daily:${period}`
}

/** `2026-07-10` → `2026-07`. Pure. */
export function periodOf(date: string): string {
  return date.slice(0, 7)
}

/** One day's row from what the cron already holds at daily-summary time. Pure. */
export function buildGrowthDailyRow(i: GrowthDailyInputs): GrowthDailyRow {
  // An ABSENT `alert:count:{date}` key means no alert fired today — a genuine quiet day, so 0.
  // A failed READ is the caller's job to surface as `null` (it passes `alertCounts: undefined`
  // only when the key was absent; on a read error it must pass a row-skipping decision instead).
  return {
    date: i.date,
    alertedIncidents: i.alertCounts ? (i.alertCounts.incidents ?? 0) : 0,
    alertedResolved: i.alertCounts ? (i.alertCounts.resolved ?? 0) : 0,
    referralTotal: i.referralTotal,
    subscribers: i.subscribers,
    subscriberNewToday: i.subscriberNewToday,
    audienceTotal: i.audience?.total ?? null,
    audienceActiveTotal: i.audience?.activeTotal ?? null,
    audienceBySource: i.audience?.bySource ?? null,
  }
}

/**
 * Append (or replace) one row, keeping the series sorted and capped. Pure and **idempotent**: a
 * catch-up cron re-running the same date overwrites that row instead of duplicating it.
 * A corrupt/absent existing value degrades to a fresh series rather than throwing — losing history is
 * bad, aborting the Discord report is worse.
 */
export function appendGrowthDaily(existing: unknown, row: GrowthDailyRow): GrowthDailyRow[] {
  const rows = Array.isArray(existing) ? existing.filter((r): r is GrowthDailyRow => isRow(r)) : []
  const merged = [...rows.filter((r) => r.date !== row.date), row]
  merged.sort((a, b) => a.date.localeCompare(b.date))
  return merged.slice(-GROWTH_SERIES_CAP)
}

function isRow(r: unknown): r is GrowthDailyRow {
  return !!r && typeof r === 'object' && typeof (r as GrowthDailyRow).date === 'string'
}

/** Parse a stored series, tolerating absence and corruption. Pure. */
export function parseGrowthSeries(raw: string | null | undefined): GrowthDailyRow[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter(isRow) : []
  } catch {
    return []
  }
}

/**
 * Read-modify-write today's row into the permanent monthly key. Best-effort for the *write*; strict
 * about the *read*.
 *
 * A thrown `kv.get` (5xx, rate-limit, network blip) must NOT be collapsed to `null`: this key is an
 * accumulator with no TTL and no recovery path, so treating a failed read as "absent" would rewrite
 * the whole month as a single row and silently destroy every day accrued so far. On a read failure we
 * skip the write entirely and lose one day, which is recoverable; overwriting is not.
 *
 * A genuinely absent key (first day of the month) is `null` and correctly seeds an empty series.
 */
export async function recordGrowthDaily(kv: KVLike, row: GrowthDailyRow): Promise<boolean> {
  const key = growthSeriesKey(periodOf(row.date))
  let raw: string | null
  try {
    raw = await kv.get(key)
  } catch (err) {
    console.warn('[growth-series] read failed, skipping write to protect history:', err instanceof Error ? err.message : err)
    return false
  }
  const next = appendGrowthDaily(parseGrowthSeries(raw), row)
  return await kvPut(kv, key, JSON.stringify(next)) // no expirationTtl → permanent
}
