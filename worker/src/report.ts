// Crowd "Report an issue" — #575 Phase A (COLLECT ONLY, no public display).
//
// A 1st-party "Report an issue" button on /is-X-down posts here. Phase A stores a per-service,
// per-UTC-day counter plus an IP-hash dedup marker, and exposes the counts ONLY internally
// (daily Discord summary). It NEVER surfaces a "N users reporting" verdict — at AIWatch's volume
// (~22 visitors/incident) a raw crowd banner would manufacture false signal and damage the
// correctness AIWatch is trusted for. Gated corroboration + a Status Confidence input is Phase B
// (only when the crowd signal cross-matches an independent degrade signal). See issue #575.
//
// Pure helpers here (keys, validation, IP hash) are unit-tested; the KV I/O lives in index.ts.

// Daily counters kept ~5 weeks so the internal demand signal has a short trend window.
export const REPORT_COUNT_TTL_SECONDS = 35 * 86_400
// One counted report per IP per service per UTC day (paired with the client-side localStorage guard).
export const REPORT_SEEN_TTL_SECONDS = 86_400
// Per-IP hourly cap (in-memory, same fixed-window limiter as the other endpoints). The real
// abuse ceilings are the per-day dedup + Phase B's baseline/cross-validation gating, not this.
export const REPORT_MAX_PER_HOUR = 20

/** UTC date key `YYYY-MM-DD` for an epoch-ms timestamp (matches the daily-counter convention). */
export function reportDateKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

/** KV key for the per-service per-day report counter. */
export function reportCountKey(svcId: string, date: string): string {
  return `report:count:${svcId}:${date}`
}

/** KV key for the per-IP per-service per-day dedup marker (presence = already counted today). */
export function reportSeenKey(svcId: string, ipHash: string, date: string): string {
  return `report:seen:${svcId}:${ipHash}:${date}`
}

/** #837 — KV key for the per-day count of reports submitted FROM the Chrome extension
 *  (`source:'ext'`). A consent-free engagement signal surfaced in the daily summary. */
export function extReportCountKey(date: string): string {
  return `report:ext:${date}`
}

/** #837 — report sources the collect endpoint recognizes. Only 'ext' is tallied separately
 *  (the extension); anything else (web/absent) counts only toward the normal per-service total. */
export function isExtReportSource(source: unknown): boolean {
  return source === 'ext'
}

/** Validate the reported service id against the known set (rejects unknown/garbage svcIds). */
export function isReportableService(svcId: unknown, knownIds: Set<string>): svcId is string {
  return typeof svcId === 'string' && knownIds.has(svcId)
}

// ── Report content (category + short description) ──────────────────────────────
// Richer input modeled on claudestatus.com's "Report an Issue" modal (category dropdown +
// 80-char description). The description is user-generated and DISPLAYED on a gated surface, so it
// is sanitized on store AND escaped on render (defense-in-depth against XSS/markup injection).

export const REPORT_CATEGORIES = ['outage', 'degraded', 'errors', 'login', 'other'] as const
export type ReportCategory = typeof REPORT_CATEGORIES[number]

/** Human labels for the category ids (used in the modal + the gated display). */
export const REPORT_CATEGORY_LABELS: Record<ReportCategory, string> = {
  outage: 'Outage',
  degraded: 'Degraded performance',
  errors: 'Errors',
  login: 'Login / Auth',
  other: 'Other',
}

export const REPORT_DESC_MAX = 80

export function isValidCategory(c: unknown): c is ReportCategory {
  return typeof c === 'string' && (REPORT_CATEGORIES as readonly string[]).includes(c)
}

/**
 * Sanitize a user-supplied description for storage: drop angle brackets and control chars, collapse
 * whitespace, trim, and hard-cap at REPORT_DESC_MAX. Optional (a category-only report is valid) →
 * returns '' for non-strings/empties. The render layer still HTML-escapes (defense-in-depth).
 */
export function sanitizeReportDescription(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw
    .replace(/[<>]/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')  // control chars -> space
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, REPORT_DESC_MAX)
}

// ── Report feed (per-service recent entries, for the GATED display) ─────────────
export const REPORT_FEED_TTL_SECONDS = 86_400        // entries are a rolling 24h window
export const REPORT_FEED_MAX = 20                    // cap stored entries (newest kept)
export const REPORT_FEED_WINDOW_MS = 86_400_000      // "last 24h" display window

export interface ReportFeedEntry {
  cat: ReportCategory
  desc: string
  ts: number // epoch ms
}

export function reportFeedKey(svcId: string): string {
  return `report:feed:${svcId}`
}

/** Prepend the new entry (newest-first) and cap the list. Pure. */
export function appendReportFeed(existing: ReportFeedEntry[], entry: ReportFeedEntry, cap = REPORT_FEED_MAX): ReportFeedEntry[] {
  return [entry, ...existing].slice(0, cap)
}

/** Drop entries older than the window (and any malformed ones). Pure. */
export function recentReportFeed(entries: ReportFeedEntry[], now: number, windowMs = REPORT_FEED_WINDOW_MS): ReportFeedEntry[] {
  return (Array.isArray(entries) ? entries : []).filter(
    (e) => e && typeof e.ts === 'number' && isValidCategory(e.cat) && now - e.ts <= windowMs,
  )
}

// #772 — anchor SURFACED reports to the CURRENT problem, not the flat 24h KV retention. A report from
// a PRIOR incident lingers in the 24h feed and would otherwise resurface during a new, unrelated
// incident (observed: a 23h-old Claude report reappearing on a fresh Anthropic incident — hidden all
// day while operational, then surfaced when status flipped). These bound how far BACK a surfaced
// report may be relative to the current incident.
export const REPORT_PRE_INCIDENT_BUFFER_MS = 2 * 3_600_000  // 2h — keep EARLY reporters who flagged the
                                                            // problem before the official (often backdated) startedAt
export const REPORT_SPIKE_FALLBACK_MS = 3 * 3_600_000       // 3h — probeSpike/partial with no dated incident

/**
 * #772 — lower bound (epoch ms) for surfacing a service's crowd reports, anchored to the current
 * problem. The caller keeps reports with `ts >= floor` (still inside the 24h retention via
 * recentReportFeed). Pure + unit-tested.
 *
 *  - Active (non-resolved) incident(s): floor = EARLIEST `startedAt` − PRE_INCIDENT_BUFFER. The buffer
 *    preserves an early reporter who flagged the problem before the official (usually backdated)
 *    start — the #575 early-signal value — while still excluding a prior-incident report from hours
 *    earlier. Providers backdate `startedAt` to the real start, so reports during the actual problem
 *    already fall after it; the buffer covers the rest.
 *  - No dated active incident (probeSpike / partial only): floor = now − SPIKE_FALLBACK. The crowd
 *    report IS the early signal here, so surface only genuinely recent ones (not the full 24h).
 */
export function reportWindowFloor(
  svc: { incidents?: Array<{ status: string; startedAt?: string | null }> },
  now: number,
  bufferMs: number = REPORT_PRE_INCIDENT_BUFFER_MS,
  fallbackMs: number = REPORT_SPIKE_FALLBACK_MS,
): number {
  const activeStarts = (svc.incidents ?? [])
    .filter((i) => i.status !== 'resolved')
    .map((i) => (i.startedAt ? new Date(i.startedAt).getTime() : NaN))
    .filter((t) => Number.isFinite(t)) as number[]
  if (activeStarts.length === 0) return now - fallbackMs
  // A future-dated startedAt (clock skew / a scheduled-maintenance entry mislabeled active) yields a
  // future floor → every report is excluded → the service surfaces ZERO reports. That's a graceful
  // no-op (no WRONG/stale report is ever shown), so it's left unclamped — clamping to `now − fallback`
  // would instead over-widen a genuinely fresh incident's window back to 3h.
  return Math.min(...activeStarts) - bufferMs
}

/**
 * Privacy-preserving client fingerprint: SHA-256 of `salt + ip`, truncated to 128 bits (hex).
 * The raw IP is NEVER stored — only this hash, and only as a short-TTL dedup key. The salt (a
 * server secret) defeats the trivial precompute of the small IPv4 space; absent a salt (local dev)
 * it degrades to an unsalted hash, which is acceptable there.
 */
export async function hashIp(ip: string, salt = ''): Promise<string> {
  const data = new TextEncoder().encode(`${salt}:${ip}`)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32)
}

/** Increment one parsed counter value. Tolerates missing/garbage stored values (→ 0). */
export function nextCount(stored: string | null): number {
  const n = parseInt(stored ?? '0', 10)
  return (Number.isFinite(n) && n > 0 ? n : 0) + 1
}

/**
 * Format the internal "Reports (24h)" line for the daily Discord summary. Internal-only — this is
 * the demand signal (which services users report most → coverage priority), NOT a public verdict.
 * Returns '' when there are no reports (omit the section entirely).
 *
 * @param counts  svcId → report count for the day
 * @param nameOf  svcId → display name
 * @param topN    cap the listed services (busiest first)
 */
export function formatReportCountsSection(
  counts: Record<string, number>,
  nameOf: (id: string) => string,
  topN = 8,
): string {
  const entries = Object.entries(counts).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])
  if (entries.length === 0) return ''
  const total = entries.reduce((sum, [, n]) => sum + n, 0)
  const list = entries.slice(0, topN).map(([id, n]) => `${nameOf(id)} ${n}`).join(' · ')
  // "today" not "24h": the daily cron reads the current-UTC-day counter (a partial day at send time).
  return `\n🗳️ **User Reports (today)**: ${total} total · ${list}`
}

// ── Display gate (#575 Phase B) ────────────────────────────────────────────────
// Crowd reports surface on a service's page ONLY when an INDEPENDENT signal corroborates a problem,
// so a public list can never contradict an `operational` status (the load-bearing #575 constraint):
//   - official: status degraded/down OR a sub-threshold `partialCount` (#722), OR
//   - probe: an active RTT spike (`probeSpike`) with the crowd clearing REPORT_DISPLAY_MIN.
// Crowd-alone (operational + clean probe) NEVER surfaces. Pure + unit-tested; the worker uses this to
// decide which services' feeds to include in the /api/status `reportFeed` map.
export const REPORT_DISPLAY_MIN = 3

export function shouldSurfaceReports(opts: {
  status: string
  partialCount?: number
  probeSpike?: boolean
  reportCount: number
}): boolean {
  if (opts.reportCount <= 0) return false
  const officialProblem = opts.status !== 'operational' || (opts.partialCount ?? 0) > 0
  if (officialProblem) return true
  // operational page → require an independent probe spike AND baseline crowd volume.
  return !!opts.probeSpike && opts.reportCount >= REPORT_DISPLAY_MIN
}
