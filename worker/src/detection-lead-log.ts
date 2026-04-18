// Detection Lead audit log — persists every Detection Lead occurrence for daily summary + retrospective inspection.
// Per-day KV array (7d TTL) keyed by `detection:lead:{YYYY-MM-DD}`. Dedup by incidentId so retries don't double-count.
//
// Window contract (#256 review): MIN_LEAD_MS = 60_000 (1m), MAX_LEAD_MS = 60min. Both alerts.ts:formatDetectionLead
// and this module call computeLeadMs() so display + audit log can never drift on sub-minute or 60min+ leads.
//
// Failure semantics:
// - All KV writes go through kvPut helper (logs failures with [kv] tag, returns false).
// - Read failures (KV throw, JSON parse, non-array, malformed entries) all log via console.error/warn so silent
//   corruption is visible in production logs.
// - On read/parse/non-array failure, appendDetectionLead aborts (returns 'failed') instead of
//   overwriting — prevents data loss from transient KV blips. Append outcome is a tagged union
//   AppendResult = 'persisted' | 'duplicate' | 'failed' so callers can distinguish benign idempotent
//   re-runs from real persist failures.
// - Per-entry shape validated on read; malformed entries are filtered out + warned (prevents NaNm in Discord).

import { kvPut } from './utils'

export interface DetectionLeadEntry {
  svcId: string
  incId: string
  leadMs: number
  detectedAt: string  // ISO — when AIWatch (probe) first noticed
  officialAt: string  // ISO — incident.startedAt from status page
}

export const MIN_LEAD_MS = 60_000          // 1m — sub-minute leads aren't displayed in Discord, so don't audit them either
export const MAX_LEAD_MS = 60 * 60_000     // 60m — formatDetectionLead caps at <60min to filter stale `detected:` entries
export const DAYS_FOR_DAILY_SUMMARY = 2    // today + yesterday — covers the 24h window ending at UTC 09:00 cron run

export function detectionLeadKey(date: Date = new Date()): string {
  return `detection:lead:${date.toISOString().split('T')[0]}`
}

const READ_FAILED = Symbol('detection-lead-read-failed')

/** Read KV with one retry (50ms backoff) — converts most transient failures into success
 *  without compromising abort-on-corruption guarantees (parse/non-array still abort hard).
 *  Backoff intentionally short: cron has a sub-30s budget, and KV blips are typically eventual-
 *  consistency races (sub-100ms), not throttling. Don't bloat unless evidence of real backpressure. */
async function getWithRetry(kv: KVNamespace, key: string): Promise<string | null | typeof READ_FAILED> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await kv.get(key)
    } catch (err) {
      if (attempt === 1) {
        console.error('[detection-lead] KV read failed after retry:', key, '-', err instanceof Error ? err.message : err)
        return READ_FAILED
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  return READ_FAILED
}

/** Compute lead in ms from detection + official timestamps.
 *  Returns null when timestamps are invalid OR lead is outside [MIN_LEAD_MS, MAX_LEAD_MS).
 *  Single source of truth so the audit log and Discord display never disagree on the window. */
export function computeLeadMs(detectedAt: string, officialAt: string): number | null {
  const detected = new Date(detectedAt).getTime()
  const official = new Date(officialAt).getTime()
  if (isNaN(detected) || isNaN(official)) return null
  const diff = official - detected
  if (diff < MIN_LEAD_MS || diff >= MAX_LEAD_MS) return null
  return diff
}

// Tolerance for clock skew between AIWatch (Cloudflare PoP NTP) and upstream status pages.
// 5min is conservative: rejects obvious garbage (status page "future" timestamps, manual backdates)
// while not rejecting legitimate near-real-time incidents. Sub-second NTP drift fits comfortably.
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60_000
// Tolerance for leadMs ↔ (officialMs - detectedMs) drift — 1s covers JSON serialization rounding
// and Date arithmetic between calls. Producers compute leadMs directly from the same timestamp pair,
// so drift is normally 0; the slack exists for future writers, not as a defense against real corruption.
const LEAD_MS_DRIFT_TOLERANCE_MS = 1000

/** Validates a parsed JSON object matches the DetectionLeadEntry shape including:
 *  - parseable ISO timestamps
 *  - leadMs consistent with (officialAt - detectedAt) within 1s tolerance
 *  - officialAt not meaningfully in the future (rejects clock-skew/garbage timestamps that would
 *    otherwise produce fictitious "Detection Lead: 45m" entries from synthesized timestamps) */
function isValidEntry(e: unknown, now: number = Date.now()): e is DetectionLeadEntry {
  if (!e || typeof e !== 'object') return false
  const o = e as Record<string, unknown>
  if (typeof o.svcId !== 'string' || o.svcId.length === 0) return false
  if (typeof o.incId !== 'string' || o.incId.length === 0) return false
  if (typeof o.leadMs !== 'number' || !Number.isFinite(o.leadMs)) return false
  if (o.leadMs < MIN_LEAD_MS || o.leadMs >= MAX_LEAD_MS) return false
  if (typeof o.detectedAt !== 'string') return false
  if (typeof o.officialAt !== 'string') return false
  const detectedMs = new Date(o.detectedAt).getTime()
  const officialMs = new Date(o.officialAt).getTime()
  if (isNaN(detectedMs) || isNaN(officialMs)) return false
  // Reject future timestamps beyond skew tolerance (prevents fabricated leads from clock-skewed sources)
  if (officialMs > now + CLOCK_SKEW_TOLERANCE_MS) return false
  // leadMs must agree with timestamp diff within tolerance — defends against drift between fields
  if (Math.abs((officialMs - detectedMs) - o.leadMs) > LEAD_MS_DRIFT_TOLERANCE_MS) return false
  return true
}

/** Outcome of an append attempt. 'duplicate' is benign (idempotent re-run), 'failed' indicates real
 *  drift between Discord display and audit log that the caller should warn on. */
export type AppendResult = 'persisted' | 'duplicate' | 'failed'

/** Append a Detection Lead occurrence to today's KV array.
 *  Idempotent on (svcId, incId) — re-running the same cron won't duplicate.
 *  Rejects entries with leadMs outside the window — mirrors Discord display rules.
 *  ABORTS on KV read/parse/non-array failure ('failed') instead of overwriting prior data. */
export async function appendDetectionLead(
  kv: KVNamespace,
  entry: DetectionLeadEntry,
  now: Date = new Date(),
): Promise<AppendResult> {
  // Defensive: enforce all DetectionLeadEntry invariants at the write boundary so corrupt entries
  // never reach KV. isValidEntry runs the same checks downstream readers apply, keeping append +
  // read symmetry — a future producer bug can't write garbage that read silently drops.
  if (!isValidEntry(entry, now.getTime())) {
    console.warn('[detection-lead] rejecting invalid entry at append:', { svcId: entry.svcId, incId: entry.incId, leadMs: entry.leadMs })
    return 'failed'
  }
  const key = detectionLeadKey(now)
  // Distinguish "KV read failed" from "key absent". On failure, abort instead of overwriting.
  // getWithRetry already retries once on transient KV errors before declaring failure.
  const raw = await getWithRetry(kv, key)
  if (raw === READ_FAILED) return 'failed'
  let entries: DetectionLeadEntry[] = []
  if (raw) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      // JSON parse failure means stored value is corrupt — abort rather than overwrite. Manual KV
      // inspection can recover; silent overwrite cannot. Same for non-array (different schema entirely).
      console.error('[detection-lead] existing log unparseable, aborting append:', err instanceof Error ? err.message : err)
      return 'failed'
    }
    if (!Array.isArray(parsed)) {
      console.error('[detection-lead] existing log is not an array, aborting append:', typeof parsed)
      return 'failed'
    }
    entries = parsed.filter((e) => isValidEntry(e, now.getTime()))
  }
  // Idempotent: skip if this incident already logged today
  if (entries.some(e => e.incId === entry.incId && e.svcId === entry.svcId)) return 'duplicate'
  entries.push(entry)
  const ok = await kvPut(kv, key, JSON.stringify(entries), { expirationTtl: 7 * 86400 })
  if (!ok) {
    console.error('[detection-lead] PERSIST FAILED — daily summary will be missing entry:', { svcId: entry.svcId, incId: entry.incId, leadMs: entry.leadMs })
    return 'failed'
  }
  return 'persisted'
}

/** Read Detection Lead entries from KV, validating per-entry shape and dropping malformed.
 *  `opts.days` controls how many recent days to read (default 1 = today only). Clamped to [1, 7].
 *  `opts.windowMs` filters entries by `officialAt` to a sliding window ending at `date` — prevents
 *  entries from being re-reported across consecutive daily summaries (e.g., 24h window at UTC 09:00
 *  excludes yesterday's pre-09:00 entries already shown in yesterday's summary).
 *  Daily summary uses `{ days: DAYS_FOR_DAILY_SUMMARY, windowMs: 24*3600_000 }`.
 *  Internal dedup by (svcId, incId) handles same-incident overlap across day-key boundaries. */
export async function readDetectionLeadEntries(
  kv: KVNamespace,
  date: Date = new Date(),
  opts: { days?: number; windowMs?: number } = {},
): Promise<DetectionLeadEntry[]> {
  // Clamp days to [1, 7] — defends against NaN, Infinity, negative, or unbounded read attempts
  const rawDays = Number.isFinite(opts.days) ? (opts.days as number) : 1
  const days = Math.max(1, Math.min(7, Math.floor(rawDays)))
  const windowStart = Number.isFinite(opts.windowMs) ? date.getTime() - (opts.windowMs as number) : null
  const out: DetectionLeadEntry[] = []
  const seen = new Set<string>()
  for (let offset = 0; offset < days; offset++) {
    const target = new Date(date.getTime() - offset * 86_400_000)
    const targetKey = detectionLeadKey(target)
    const raw = await getWithRetry(kv, targetKey)
    if (raw === READ_FAILED || !raw) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      console.error('[detection-lead] read parse failed for', targetKey, '— daily summary will be incomplete:', err instanceof Error ? err.message : err)
      continue
    }
    if (!Array.isArray(parsed)) {
      console.warn('[detection-lead] non-array value at', targetKey)
      continue
    }
    let dropped = 0
    const nowMs = date.getTime()
    for (const entry of parsed) {
      if (!isValidEntry(entry, nowMs)) { dropped++; continue }
      // Time-window filter: skip entries outside the requested window (prevents cross-day re-reporting)
      if (windowStart !== null) {
        const officialMs = new Date(entry.officialAt).getTime()
        if (officialMs < windowStart) continue
      }
      const dedupKey = `${entry.svcId}::${entry.incId}`
      if (seen.has(dedupKey)) continue
      seen.add(dedupKey)
      out.push(entry)
    }
    if (dropped > 0) console.warn(`[detection-lead] dropped ${dropped} malformed entr${dropped === 1 ? 'y' : 'ies'} from ${targetKey}`)
  }
  return out
}

/** Format Detection Lead entries as a Discord embed section.
 *  Returns empty string if no entries (caller skips the section). */
export function formatDetectionLeadSection(
  entries: DetectionLeadEntry[],
  serviceNames: Map<string, string>,
): string {
  if (entries.length === 0) return ''
  // Sort by lead time descending — biggest wins first
  const sorted = [...entries].sort((a, b) => b.leadMs - a.leadMs)
  const lines = sorted.map(e => {
    const name = serviceNames.get(e.svcId) ?? e.svcId
    // Math.floor matches formatDetectionLead — never displays 60m for leads in [59m30s, 60m)
    const mins = Math.floor(e.leadMs / 60_000)
    return `   ${name}: ${mins}m lead`
  })
  return `\n⚡ **Detection Lead (last 24h)** (${entries.length} ${entries.length === 1 ? 'event' : 'events'})\n${lines.join('\n')}`
}
