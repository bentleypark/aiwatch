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

/** Monthly accumulator key (60d TTL) — written alongside the daily key so the monthly
 *  archive cron on the 1st can still see entries that the daily 7d-TTL keys lost long
 *  before. Same shape (DetectionLeadEntry[]) as the daily key, dedup by (svcId, incId).
 *  Mirrors the incidents:monthly:{period} pattern (#369). */
export function detectionLeadMonthlyKey(date: Date = new Date()): string {
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  return `detection:lead:monthly:${date.getUTCFullYear()}-${m}`
}

export const DETECTION_LEAD_MONTHLY_TTL_SECONDS = 60 * 86400 // 60 days — covers archive cron + late catch-up

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

/** Why a (detectedAt, officialAt) pair did or didn't produce a recordable lead — the diagnostic
 *  buckets behind the empty audit log (#464). Boundaries mirror computeLeadMs so the diagnostic can
 *  never disagree with what actually gets recorded:
 *  - no_detected: missing/invalid detection timestamp
 *  - negative:    detected at/after the official start (diff <= 0) — AIWatch was not earlier
 *  - below_min:   0 < diff < MIN_LEAD_MS (sub-minute — not displayed/audited)
 *  - in_window:   MIN_LEAD_MS <= diff < MAX_LEAD_MS (a real, recorded lead)
 *  - above_max:   diff >= MAX_LEAD_MS (stale `detected:` marker, filtered out) */
export type LeadOutcome = 'no_detected' | 'negative' | 'below_min' | 'in_window' | 'above_max'

export function classifyLead(detectedAt: string | null | undefined, officialAt: string): LeadOutcome {
  if (!detectedAt) return 'no_detected'
  const detected = new Date(detectedAt).getTime()
  const official = new Date(officialAt).getTime()
  if (isNaN(detected) || isNaN(official)) return 'no_detected'
  const diff = official - detected
  if (diff <= 0) return 'negative'
  if (diff < MIN_LEAD_MS) return 'below_min'
  if (diff >= MAX_LEAD_MS) return 'above_max'
  return 'in_window'
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
export function isValidEntry(e: unknown, now: number = Date.now()): e is DetectionLeadEntry {
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
  if (entries.some(e => e.incId === entry.incId && e.svcId === entry.svcId)) {
    // Daily already has the entry — but the monthly accumulator might still be missing it
    // (e.g., a previous attempt persisted to daily but failed at monthly). Re-attempt the
    // monthly side so the dual-write is eventually consistent without re-reporting in Discord.
    await appendToMonthlyAccumulator(kv, entry, now).catch((err) => {
      console.warn('[detection-lead] monthly accumulator write failed on duplicate-daily path:', {
        svcId: entry.svcId,
        incId: entry.incId,
        err: err instanceof Error ? err.message : err,
      })
    })
    return 'duplicate'
  }
  entries.push(entry)
  const ok = await kvPut(kv, key, JSON.stringify(entries), { expirationTtl: 7 * 86400 })
  if (!ok) {
    console.error('[detection-lead] PERSIST FAILED — daily summary will be missing entry:', { svcId: entry.svcId, incId: entry.incId, leadMs: entry.leadMs })
    return 'failed'
  }
  // After the daily key succeeds, mirror to the 60d monthly accumulator so the monthly
  // archive cron on the 1st can read entries the 7d daily keys have already lost (#369).
  // Failure here is non-fatal — the daily key is the source of truth for Discord; monthly
  // accumulator is best-effort. Log so operators see drift if it happens.
  await appendToMonthlyAccumulator(kv, entry, now).catch((err) => {
    console.warn('[detection-lead] monthly accumulator write failed:', {
      svcId: entry.svcId,
      incId: entry.incId,
      err: err instanceof Error ? err.message : err,
    })
  })
  return 'persisted'
}

/** Append `entry` to `detection:lead:monthly:{YYYY-MM}` (60d TTL).
 *  Idempotent on (svcId, incId) like the daily key. ABORTS on parse / non-array / KV
 *  read failure rather than overwriting — corruption isolation matches the daily path.
 *  Throws on unrecoverable corruption so the caller's `.catch` logs it; otherwise resolves. */
async function appendToMonthlyAccumulator(
  kv: KVNamespace,
  entry: DetectionLeadEntry,
  now: Date,
): Promise<void> {
  const monthlyKey = detectionLeadMonthlyKey(now)
  const raw = await getWithRetry(kv, monthlyKey)
  if (raw === READ_FAILED) {
    throw new Error(`monthly read failed: ${monthlyKey}`)
  }
  let entries: DetectionLeadEntry[] = []
  if (raw) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      throw new Error(`monthly accumulator unparseable at ${monthlyKey}: ${err instanceof Error ? err.message : err}`)
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`monthly accumulator not an array at ${monthlyKey}: ${typeof parsed}`)
    }
    entries = parsed.filter((e) => isValidEntry(e, now.getTime()))
  }
  // Idempotent: same dedup as daily
  if (entries.some(e => e.incId === entry.incId && e.svcId === entry.svcId)) return
  entries.push(entry)
  const ok = await kvPut(kv, monthlyKey, JSON.stringify(entries), { expirationTtl: DETECTION_LEAD_MONTHLY_TTL_SECONDS })
  if (!ok) {
    throw new Error(`monthly accumulator persist failed: ${monthlyKey}`)
  }
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

// ── Detection Lead diagnostics (#464) ───────────────────────────────
// Lossy daily counter (NOT source-of-truth like the audit log) measuring WHY leads are/aren't
// recorded, split by whether the service is a probe target. Answers: is the empty audit log a
// coverage problem (non-probe / no_detected) or a timing problem (negative / below_min)?
// Key: `detection:lead:diag:{YYYY-MM-DD}` (30d TTL). Best-effort: increment failures never block alerts.

export interface LeadDiagBuckets {
  no_detected: number
  negative: number
  below_min: number
  in_window: number
  above_max: number
}
export interface LeadDiag {
  probe: LeadDiagBuckets     // services in PROBE_TARGETS (direct RTT — can structurally lead)
  nonProbe: LeadDiagBuckets  // status-page-only services (detection can't precede the official post)
}

export const DETECTION_LEAD_DIAG_TTL_SECONDS = 30 * 86400

export function detectionLeadDiagKey(date: Date = new Date()): string {
  return `detection:lead:diag:${date.toISOString().split('T')[0]}`
}

function emptyBuckets(): LeadDiagBuckets {
  return { no_detected: 0, negative: 0, below_min: 0, in_window: 0, above_max: 0 }
}
function emptyDiag(): LeadDiag {
  return { probe: emptyBuckets(), nonProbe: emptyBuckets() }
}

/** Coerce an unknown parsed value into a well-formed LeadDiag, keeping only finite non-negative
 *  integer counts. Unlike the audit log (which aborts on corruption to avoid data loss), the diag
 *  counter is a disposable measurement — a corrupt/foreign value normalizes to zeros for that field. */
export function normalizeDiag(parsed: unknown): LeadDiag {
  const out = emptyDiag()
  if (!parsed || typeof parsed !== 'object') return out
  for (const group of ['probe', 'nonProbe'] as const) {
    const g = (parsed as Record<string, unknown>)[group]
    if (!g || typeof g !== 'object') continue
    for (const k of Object.keys(out[group]) as (keyof LeadDiagBuckets)[]) {
      const v = (g as Record<string, unknown>)[k]
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[group][k] = Math.floor(v)
    }
  }
  return out
}

/** Increment today's diagnostic counter for one classified outcome. Best-effort:
 *  - read failure → skip (return false) rather than overwrite the day's counts
 *  - unparseable existing value → reset that day (lossy counter, not audit data) and warn
 *  Returns whether the KV write succeeded. */
export async function appendLeadDiag(
  kv: KVNamespace,
  outcome: LeadOutcome,
  isProbeTarget: boolean,
  now: Date = new Date(),
): Promise<boolean> {
  const key = detectionLeadDiagKey(now)
  const raw = await getWithRetry(kv, key)
  if (raw === READ_FAILED) return false
  let diag = emptyDiag()
  if (raw) {
    try {
      diag = normalizeDiag(JSON.parse(raw))
    } catch (err) {
      console.warn('[detection-lead] diag counter unparseable, resetting day:', key, '-', err instanceof Error ? err.message : err)
      diag = emptyDiag()
    }
  }
  const group = isProbeTarget ? diag.probe : diag.nonProbe
  group[outcome]++
  return kvPut(kv, key, JSON.stringify(diag), { expirationTtl: DETECTION_LEAD_DIAG_TTL_SECONDS })
}

/** Sum the diagnostic counters across the most recent `days` (clamped [1,7]). */
export async function readLeadDiag(
  kv: KVNamespace,
  date: Date = new Date(),
  days: number = DAYS_FOR_DAILY_SUMMARY,
): Promise<LeadDiag> {
  const total = emptyDiag()
  const n = Math.max(1, Math.min(7, Math.floor(Number.isFinite(days) ? days : 1)))
  for (let offset = 0; offset < n; offset++) {
    const target = new Date(date.getTime() - offset * 86_400_000)
    const raw = await getWithRetry(kv, detectionLeadDiagKey(target))
    if (raw === READ_FAILED || !raw) continue
    let diag: LeadDiag
    try {
      diag = normalizeDiag(JSON.parse(raw))
    } catch {
      continue
    }
    for (const grp of ['probe', 'nonProbe'] as const) {
      for (const k of Object.keys(total[grp]) as (keyof LeadDiagBuckets)[]) {
        total[grp][k] += diag[grp][k]
      }
    }
  }
  return total
}

function bucketsTotal(b: LeadDiagBuckets): number {
  return b.no_detected + b.negative + b.below_min + b.in_window + b.above_max
}

/** Format the diagnostic counter as a Discord daily-summary line.
 *  Returns empty string when no incidents were classified (caller skips the section). */
export function formatLeadDiagSection(diag: LeadDiag): string {
  const p = diag.probe
  const probeTotal = bucketsTotal(p)
  const nonProbeTotal = bucketsTotal(diag.nonProbe)
  if (probeTotal + nonProbeTotal === 0) return ''
  return `\n🔍 **Detection diag** (~48h) — probe svcs: in-window ${p.in_window} · negative ${p.negative} · sub-min ${p.below_min} · >60m ${p.above_max} · no-detect ${p.no_detected}  |  non-probe incidents: ${nonProbeTotal}`
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
