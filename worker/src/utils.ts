// Shared utility functions for AIWatch Worker

import type { Incident } from './types'

const IMPACT_RANK: Record<string, number> = { critical: 3, major: 2, minor: 1 }

/** Worst impact among a service's UNRESOLVED incidents, or null if none. */
export function worstUnresolvedImpact(
  incidents: Incident[] | undefined,
): 'critical' | 'major' | 'minor' | null {
  let worst: 'critical' | 'major' | 'minor' | null = null
  let rank = 0
  for (const inc of incidents ?? []) {
    if (inc.status === 'resolved') continue
    const imp = inc.impact
    if (imp !== 'critical' && imp !== 'major' && imp !== 'minor') continue
    const r = IMPACT_RANK[imp]
    if (r > rank) { rank = r; worst = imp }
  }
  return worst
}

/**
 * #733 — does this status snapshot count as UP for the daily uptime counter (ok/total)?
 *
 * `operational` → up; `down` → down. A `degraded` snapshot counts as DOWN only when a
 * **major/critical** unresolved incident backs it. A `degraded` from a minor/partial-scope
 * incident (e.g. OpenAI's FedRAMP "degraded performance", Deepgram's Voice-Agent downstream
 * component) — or from a transient no-incident fetch hiccup — is NOT a real service-wide outage, so it
 * counts as up. #1233 — that includes the `unknown` an unreadable source now publishes: it takes the
 * same path a no-incident `degraded` used to, and counts as up. Not because that is right (the poll
 * observed nothing, so neither answer is), but because the alternative — recording no sample — makes
 * `total === 0` reachable, and `computeMonthlyUptime` publishes that as 0%. See the note in `cacheWrite`
 * (`index.ts`), where the counter is written. This mirrors the official rolling-uptime weighting (minor impact
 * barely dents uptime) and stops a single sticky minor incident from cratering weekly uptime to
 * ~50% while the status page's own uptime reads ~100%. The counter feeds /api/uptime, the weekly
 * Stability Trend, AND the AIWatch Score's uptime component, so all three align with official.
 */
export function countsAsUptimeOk(status: string, incidents: Incident[] | undefined): boolean {
  if (status === 'operational') return true
  if (status === 'down') return false
  // degraded: down for uptime only when a major/critical unresolved incident justifies it
  const worst = worstUnresolvedImpact(incidents)
  return worst !== 'major' && worst !== 'critical'
}

export function formatDuration(start: Date, end: Date): string {
  const diffMs = end.getTime() - start.getTime()
  const totalMin = Math.max(1, Math.ceil(diffMs / 60_000))
  const hours = Math.floor(totalMin / 60)
  const minutes = totalMin % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

export function sanitize(s: string, maxLen = 1000): string {
  return s
    .replace(/@(everyone|here)/g, '@\u200b$1')
    .replace(/<@[!&]?\d+>/g, '[mention]')
    .replace(/```/g, '\\`\\`\\`')
    .slice(0, maxLen)
}

// SSRF allow-list for the /api/alert webhook proxy: HTTPS Discord webhook URLs only (#467 \u2014
// Slack moved to native /feed RSS, so the proxy no longer forwards to hooks.slack.com).
//
// Host (#468): `discordapp.com` (legacy host, still issued/saved) exact-match, plus `discord.com`
// and any real `*.discord.com` subdomain (`canary.`/`ptb.` beta clients hand these out), matched by
// DISCORD_HOST. Every name in Discord's zone is controlled by Discord's DNS, so the wildcard is
// safe; the regex requires non-empty labels + an exact `discord.com` suffix, so look-alikes
// (`evildiscord.com`, `discord.com.evil.tld`), the label-less `.discord.com`, and trailing-dot
// FQDNs (`discord.com.`) are all rejected. `URL.hostname` is already lowercased and strips any
// userinfo (`discord.com@evil.tld` \u2192 host `evil.tld`), so authority-confusion bypasses fail here.
//
// Path (#468): a webhook path, optionally version-prefixed \u2014 `/api/webhooks/...` or
// `/api/v{N}/webhooks/...` (some SDKs/tools emit the versioned form).
//
// Extracted as a pure predicate so the boundary is unit-testable (the rest of the proxy is inline
// in the fetch handler). HTTPS-only + the proxy's rate limit are unchanged.
const DISCORD_HOST = /^([a-z0-9-]+\.)*discord\.com$/
export function isAllowedAlertWebhook(webhookUrl: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(webhookUrl)
  } catch {
    return false
  }
  const host = parsed.hostname
  const hostAllowed = host === 'discordapp.com' || DISCORD_HOST.test(host)
  return (
    parsed.protocol === 'https:' &&
    hostAllowed &&
    /^\/api\/(v\d+\/)?webhooks\//.test(parsed.pathname)
  )
}

export interface KVLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
}

/** Safe KV write with error logging. Returns true on success, false on failure. */
export async function kvPut(kv: KVLike | KVNamespace, key: string, value: string, opts?: { expirationTtl?: number }): Promise<boolean> {
  try {
    await kv.put(key, value, opts)
    return true
  } catch (err) {
    console.warn('[kv] write failed:', key, err instanceof Error ? err.message : err)
    return false
  }
}

/** Safe KV delete with error logging. */
export async function kvDel(kv: KVLike | KVNamespace, key: string): Promise<void> {
  try {
    await kv.delete(key)
  } catch (err) {
    console.warn('[kv] delete failed:', key, err instanceof Error ? err.message : err)
  }
}

// ── #1224 — consolidated per-service tracking state ─────────────────────────────────────────────
//
// `trackFetchFailure`/`resetFetchFailure`/`trackComponentMiss`/`resetComponentMiss` sit on the hot
// per-service path (`fetchServiceUntagged`, `services.ts`), reached on every live `/api/status`
// request (60s browser polling). Cron rarely reaches it independently — `cronAlertCheck` only
// re-runs `fetchAllServices` when the cache is >10min stale, and the live handler's throttled
// `cacheWrite` refreshes that cache every ~10min whenever there is any traffic at all — so the live
// path is effectively the primary driver. Previously each of the 45 services read up to 3 separate
// KV keys per invocation (`fetch-fail:{id}`, `fetch-fail:since:{id}`, `component-missing:{id}`) — an
// estimated dominant share of the account's ~1.9M KV reads/day (measured via Cloudflare's GraphQL
// Analytics API at the namespace level, not per call site; #1224's issue body has the derivation).
//
// An isolate-local read cache (an earlier version of this fix) cuts *repeated* reads within a warm
// isolate, but its ceiling still scales with distinct-keys × concurrently-warm-isolates — Cloudflare
// can spread this account's modest traffic (~11-14k requests/day) across many colos, each with its
// own cold isolate, so the achievable reduction is traffic-topology-dependent and not something this
// code can guarantee to land under a target. This design removes the dependency instead of mitigating
// it: ALL services' tracking state lives in ONE aggregate KV value (`TRACKING_STATE_KEY`, mirroring
// how `services:latest` already aggregates all services into one key), read ONCE and written AT MOST
// once per `fetchAllServices` invocation — 1 read + ≤1 write per request, regardless of isolate
// residency or service count. `readTrackingState`/`writeTrackingStateIfChanged` are the only two real
// KV operations; every function below operates purely on the in-memory object passed through them.
//
// The daily crossing-counter (`fetch-fail:daily:{id}:{date}`) stays a SEPARATE, un-consolidated KV
// key — it's written only on the rare threshold-crossing edge (once per failure episode, not once
// per request), so it was never part of the read-volume problem, and folding a per-DATE key into an
// evergreen blob would tangle two different expiry semantics for no benefit.
//
// A lost update under two concurrent writers is possible (isolate A and B each read the blob, each
// mutates its own copy, whichever writes LAST wins) — and unlike the pre-#1224 per-key design, this
// is not merely "narrower blast radius, same risk": a per-key write only ever touched keys IT
// mutated, so two invocations touching different services never interfered. Here the loser's write
// carries whatever it read at its OWN read time — so any service A recorded that B's read predates
// is silently ERASED by B's write, not just left stale. Given `/api/status` runs `fetchAllServices`
// per request and invocations regularly overlap, this is the common case, not an edge case. The
// practical cost stays bounded — a climbing streak is retried on the next overlapping cycle, so the
// visible effect is a delayed escalation — and, since #1232, a `degraded` that was already published
// can be withdrawn to `operational` for the cycles the streak takes to re-climb (the clobbered write
// loses `failSince` with the count). A real behavioral difference from the old design, not just a
// relabeling of the same risk.
export interface ServiceTrackingState {
  failCount?: number
  // ISO timestamp of the last `failCount` write. Mirrors the pre-#1224 `fetch-fail:{id}` key's 30-min
  // `expirationTtl` — see `TRACKING_COUNT_DECAY_MS` below for why this exists. Doubles as the ONLY
  // liveness signal for `failSince`, which otherwise has no expiry of its own — see
  // `TRACKING_ALERT_STALE_MS` and its callers.
  failCountAt?: string
  failSince?: string
  componentMissCount?: number
  // Same role as `failCountAt`, for `componentMissCount` — mirrors the pre-#1224
  // `component-missing:{id}` key's own 30-min `expirationTtl`, and is what `detectComponentMismatches`
  // checks so a miss count frozen by a dead source doesn't re-alert forever either.
  componentMissAt?: string
}
export type TrackingStateBlob = Record<string, ServiceTrackingState>

const TRACKING_STATE_KEY = 'tracking:state'

/** A stored value that parses as an object but carries the wrong field TYPES (a hand-edited KV
 *  value, a future field rename, `wrangler kv put` typo) must not silently corrupt arithmetic —
 *  `"3" + 1 === "31"` would cross any threshold instantly and never self-heal, since a value that
 *  never gets a numeric write back stays a string forever. Coerces per-entry; an entry that fails
 *  entirely becomes `{}` rather than dropping the whole blob (mirrors `parsePartialResolve`'s
 *  per-record tolerance). */
function sanitizeTrackingState(parsed: Record<string, unknown>): TrackingStateBlob {
  const clean: TrackingStateBlob = {}
  for (const [svcId, value] of Object.entries(parsed)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const v = value as Record<string, unknown>
    const entry: ServiceTrackingState = {}
    // failCount and failCountAt are written together by trackFetchFailure and cleared together by
    // resetFetchFailure — in normal operation they can never appear separately, so a stored value
    // carrying one without the other is itself evidence of corruption. Reject BOTH rather than keep
    // the numeric half: a `failCount` with no `failCountAt` would read as never-decaying (trusted
    // forever) instead of self-healing on the next write, reintroducing the sticky-count bug this
    // sanitizer exists to prevent. Same reasoning for componentMissCount/componentMissAt.
    if (typeof v.failCount === 'number' && Number.isFinite(v.failCount) && typeof v.failCountAt === 'string') {
      entry.failCount = v.failCount
      entry.failCountAt = v.failCountAt
    }
    if (typeof v.failSince === 'string') entry.failSince = v.failSince
    if (typeof v.componentMissCount === 'number' && Number.isFinite(v.componentMissCount) && typeof v.componentMissAt === 'string') {
      entry.componentMissCount = v.componentMissCount
      entry.componentMissAt = v.componentMissAt
    }
    if (Object.keys(entry).length > 0) clean[svcId] = entry
  }
  return clean
}

/** Reads the aggregate tracking blob. Fail-open to `{}` on a missing/corrupt/unreadable value — every
 *  service's streak restarts at 0, the same fail-open posture the pre-#1224 per-key reads already had
 *  (a failed `kv.get` there also defaulted to count=0 via `?? '0'`). Since #1232 that also drops
 *  `failSince`, and the blob is written back without it — so a mid-outage read hiccup publishes
 *  `operational` + `sourceUnknown` for the cycles the streak takes to re-climb. It withdraws the
 *  verdict; it does not just delay an escalation. */
export async function readTrackingState(kv: KVLike | undefined): Promise<TrackingStateBlob> {
  if (!kv) return {}
  try {
    const raw = await kv.get(TRACKING_STATE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? sanitizeTrackingState(parsed) : {}
  } catch (err) {
    console.warn('[kv] tracking state read failed, starting fresh:', err instanceof Error ? err.message : err)
    return {}
  }
}

/** Writes the blob back ONLY if it changed since `before` — the common case (every service already
 *  healthy) costs zero writes. No TTL on the KEY itself: `failCount`/`componentMissCount` decay
 *  in-value against their own `*At` timestamp (see `TRACKING_COUNT_DECAY_MS`), `failSince` is bounded
 *  by the same `*At` field going stale (see `TRACKING_ALERT_STALE_MS`), and an orphaned per-service
 *  entry (a retired/renamed service id) is pruned by the caller before this ever sees it — see
 *  `fetchAllServices`'s `currentIds` filter. */
export async function writeTrackingStateIfChanged(kv: KVLike | undefined, before: TrackingStateBlob, after: TrackingStateBlob): Promise<void> {
  if (!kv) return
  if (JSON.stringify(before) === JSON.stringify(after)) return
  await kvPut(kv, TRACKING_STATE_KEY, JSON.stringify(after))
}

function entryFor(store: TrackingStateBlob, svcId: string): ServiceTrackingState {
  return store[svcId] ?? (store[svcId] = {})
}

/** A service with no fail/miss state left is dropped from the blob entirely, so a long-healthy
 *  service costs nothing in the serialized size. */
function pruneIfEmpty(store: TrackingStateBlob, svcId: string): void {
  const entry = store[svcId]
  if (entry && Object.keys(entry).length === 0) delete store[svcId]
}

/** Mirrors the pre-#1224 `fetch-fail:{id}`/`component-missing:{id}` KV keys' `expirationTtl: 1800`
 *  (30 min): the old keys stopped being refreshed once their tracker stopped writing (past
 *  threshold, `next <= threshold` goes false), so each expired ~30 min after its crossing write, and
 *  the NEXT failure restarted the climb at 1 — which is what makes `fetch-fail:daily` count distinct
 *  EPISODES ("structural: 10+ crossings/day, one per ~45-min cycle",
 *  `docs/reference/status-determination.md`) instead of one permanent crossing. Losing this silently
 *  would make a day-2+ structural block invisible to the daily summary (`daily-summary.ts` only lists
 *  a service `if (failCount > 0)`, and a sticky sub-threshold-of-1 sitting at the cap is
 *  indistinguishable from a single blip). */
export const TRACKING_COUNT_DECAY_MS = 1_800_000 // 30 min

/** Has a COUNT (`failCount`/`componentMissCount`) decayed relative to `nowMs`? A MISSING `at` counts
 *  as NOT decayed — trust the stored count as-is. This is deliberately permissive: `failCount` and
 *  `failCountAt` are always written together by `trackFetchFailure` and always cleared together by
 *  `resetFetchFailure` (same for the component-miss pair), and `sanitizeTrackingState` rejects a count
 *  read from KV whose paired timestamp didn't survive — so in normal operation this function is never
 *  actually asked to judge a genuinely orphaned count. Only an unparseable (corrupt) timestamp counts
 *  as decayed. */
function isCountDecayed(at: string | undefined, nowMs: number, maxAgeMs: number): boolean {
  if (at === undefined) return false
  const t = new Date(at).getTime()
  return isNaN(t) || nowMs - t > maxAgeMs
}

/** Is a TIMESTAMP-ONLY signal (no paired count to fall back on) still fresh? Used only for the
 *  alert-liveness gates (`isFailSinceLive`, `detectComponentMismatches`'s miss-count gate) — there, a
 *  MISSING `at` must count as stale (fail toward NOT alerting), the opposite bias from
 *  `isCountDecayed` above: an absent corroborating timestamp is not evidence an alert should fire. */
function isTimestampStale(at: string | undefined, nowMs: number, maxAgeMs: number): boolean {
  if (at === undefined) return true
  const t = new Date(at).getTime()
  return isNaN(t) || nowMs - t > maxAgeMs
}

/**
 * Track consecutive fetch failures per service.
 * Returns true when the service should publish the UNREADABLE verdict (`status: 'unknown'` since
 * #1233 — this used to be `degraded`, and the local `shouldDegrade` variable names at the call sites
 * still carry the old word) — either this call reached the threshold, or an earlier crossing's
 * `failSince` is still live (`isFailSinceLive`).
 * Returns false while still climbing toward the first crossing (treat as operational / no data).
 */
export async function trackFetchFailure(store: TrackingStateBlob, kv: KVLike | undefined, svcId: string, threshold = 3, nowMs = Date.now()): Promise<boolean> {
  const entry = entryFor(store, svcId)
  // #1232 — the published verdict follows `failSince`, not the decaying count below. The count cannot
  // answer "is this source still unread?": its `failCountAt` stops being refreshed once the count
  // reaches the threshold (`next <= threshold`) while the decay clock keeps running from that frozen
  // stamp, so ~30 min later the count resets to 0 and `next` is 1 again — which published
  // `operational` with `sourceUnknown` still set, in a loop, for a source that never came back
  // (2026-08-14, `status.claude.com`; #1232). The count keeps its exact decay behaviour because a
  // SECOND consumer depends on it — `fetch-fail:daily` counts distinct EPISODES, which is what the
  // TRACKING_COUNT_DECAY_MS comment above protects — so this splits the two consumers rather than
  // retuning one number for both.
  //
  // Read BEFORE the crossing block below sets it, and gated by `isFailSinceLive` — the SAME rule the
  // #500 alert already applies to this field, reused rather than duplicated. A bare
  // `failSince !== undefined` would inherit what that gate exists to exclude: the field has no expiry
  // of its own, and the paths that stop calling `trackFetchFailure`/`resetFetchFailure` altogether (the
  // #689 dead-source and flashduty-feed early returns) leave it frozen, so a single later failure would
  // degrade on strike 1 for the rest of that source's life. During a genuine ongoing outage
  // `failCountAt` is rewritten at least every ~31 min (the decay → `next = 1` write), inside
  // TRACKING_ALERT_STALE_MS.
  //
  // KNOWN RESIDUAL, deliberately not paid for here: `failSince` is shared with the #500 alert, and any
  // crossing arms it — including one reached only by a failing SECONDARY leg (`services.ts`'
  // `parseErrors > 0` sites, whose verdict is discarded). A service whose secondary leg fails every
  // cycle therefore keeps `failSince` armed and `failCountAt` fresh without `resetFetchFailure` ever
  // running, so its next primary failure degrades earlier than the third strike. That errs toward the
  // neutral "we cannot read this source" badge, never toward a green one. Separating the two consumers
  // needs a second timestamp written on the per-request path, which would cost a `tracking:state` write
  // per request for the whole outage and break #1224's steady-state-zero invariant.
  const stillUnrecovered = isFailSinceLive(entry, nowMs)
  const decayed = isCountDecayed(entry.failCountAt, nowMs, TRACKING_COUNT_DECAY_MS)
  const count = decayed ? 0 : (entry.failCount ?? 0)
  const next = count + 1
  if (next <= threshold) {
    entry.failCount = next
    entry.failCountAt = new Date(nowMs).toISOString()
  }
  const shouldDegrade = next >= threshold || stillUnrecovered
  if (next === threshold) {
    // Daily accumulator: counts threshold *crossings* (distinct failure episodes), not polling cycles.
    // Fires only on the rising edge (count going from threshold-1 → threshold) — the TRACKING_COUNT_DECAY_MS
    // comment above is what keeps that true now that the counter lives in a TTL-less blob. Expected scale:
    //   transient: 1–3 crossings/day  (occasional blips that recover quickly)
    //   structural: 10+ crossings/day (URL blocked — one crossing per ~45-min cycle all day)
    // Deliberately NOT part of the consolidated blob above — rare enough that a direct KV
    // read/write here was never the read-volume problem.
    if (kv) {
      const date = new Date(nowMs).toISOString().split('T')[0]
      const dailyKey = `fetch-fail:daily:${svcId}:${date}`
      const dailyCount = parseInt(await kv.get(dailyKey).catch(() => null) ?? '0', 10) || 0
      await kvPut(kv, dailyKey, String(dailyCount + 1), { expirationTtl: 172800 }) // 48h
    }

    // #500: record the FIRST-failure timestamp for the persistent (1h+) structural-block alert.
    // Set only if absent so it survives re-climb cycles — immune to call frequency by construction,
    // since it's a wall-clock timestamp, not a cycle count. resetFetchFailure clears it on recovery.
    // Unlike the pre-#1224 key, `failSince` itself has no expiry — `checkPersistentFetchFailures`
    // (persistent-failure.ts) and, since #1232, the degraded verdict above are what bound its
    // lifetime — both through `isFailSinceLive`, i.e. by requiring `failCountAt` to still be fresh
    // (TRACKING_ALERT_STALE_MS below) before trusting this timestamp at all.
    if (!entry.failSince) entry.failSince = new Date(nowMs).toISOString()
  }
  // A threshold <= 0 (no production call site does this) writes nothing above, so `entryFor` could
  // otherwise leave a bare `{}` behind — a spurious diff against `trackingBefore` that forces a write
  // for a service nothing actually happened to.
  pruneIfEmpty(store, svcId)
  return shouldDegrade
}

/**
 * Reset fetch failure counter on successful fetch. Also clears the #500 persistent
 * first-failure timestamp so a later failure episode times its own fresh hour.
 */
export function resetFetchFailure(store: TrackingStateBlob, svcId: string): void {
  const entry = store[svcId]
  if (!entry) return
  delete entry.failCount
  delete entry.failCountAt
  delete entry.failSince
  pruneIfEmpty(store, svcId)
}

/** Bounds how long a frozen `failSince`/`componentMissCount` may still trigger an alert — and, since
 *  #1232, a published `degraded` — once its
 *  paired `*At` timestamp stops being refreshed — the case a dead/unreachable source produces, since
 *  neither `trackFetchFailure`/`resetFetchFailure` nor `trackComponentMiss`/`resetComponentMiss` is
 *  called again for it (`services.ts`'s #689 dead-source and flashduty-feed early-return paths).
 *  Sized at 2× `TRACKING_COUNT_DECAY_MS`, not 1×: a service that is GENUINELY still failing every
 *  cycle only refreshes its `*At` field on writes at-or-below threshold, so `*At` can legitimately sit
 *  up to ~`TRACKING_COUNT_DECAY_MS` old mid-way through its own decay-and-reclimb cycle — gating on
 *  exactly that window would flicker the #500 alert off during an unbroken outage. The 2x margin
 *  covers one full decay window plus the reclimb back to threshold. */
export const TRACKING_ALERT_STALE_MS = 2 * TRACKING_COUNT_DECAY_MS // 60 min

/** Is `entry`'s `failSince` still corroborated by a recently-refreshed `failCountAt`? A `failSince`
 *  with no supporting recent write is not evidence of an ONGOING block — it's a frozen leftover from
 *  a path (dead source, feed failure) that stopped calling `trackFetchFailure` entirely. */
export function isFailSinceLive(entry: ServiceTrackingState | undefined, nowMs: number): boolean {
  if (!entry?.failSince) return false
  return !isTimestampStale(entry.failCountAt, nowMs, TRACKING_ALERT_STALE_MS)
}

/** Threshold for the #500 persistent structural-block alert: a status page unreachable this long
 *  is a structural block (URL/IP), not a transient blip. */
export const PERSISTENT_FAILURE_THRESHOLD_MS = 3_600_000 // 1h

/**
 * Pure: has a condition first observed at `sinceIso` persisted for >= `thresholdMs`?
 *
 * Frequency-INDEPENDENT — it keys off a first-observation wall-clock timestamp, not a count of
 * polling cycles. That property is the whole point: `fetchAllServices` runs on every `/api/status`
 * request (60s browser polling), as well as the cron when its snapshot is stale, so a
 * consecutive-cycle counter measures traffic, not duration. Absent/unparseable timestamp → false:
 * it never alerts off a garbage timestamp (the caller is responsible for repairing the record).
 *
 * Two named callers share this: #500 persistent status-page failure and #1179 partial component
 * resolve. Extracted at the second one rather than copied.
 */
export function elapsedAtLeast(
  sinceIso: string | null | undefined,
  nowMs: number,
  thresholdMs: number,
): boolean {
  if (!sinceIso) return false
  const sinceMs = new Date(sinceIso).getTime()
  if (isNaN(sinceMs)) return false
  return nowMs - sinceMs >= thresholdMs
}

/** Pure decision: has the status page been continuously unreachable for >= threshold? Frequency-
 *  independent — keys off the first-failure wall-clock timestamp, not a count of polling cycles. */
export function shouldAlertPersistentFailure(
  sinceIso: string | null | undefined,
  nowMs: number,
  thresholdMs: number = PERSISTENT_FAILURE_THRESHOLD_MS,
): boolean {
  return elapsedAtLeast(sinceIso, nowMs, thresholdMs)
}

/** Operator Discord alert body for a persistent (structural) status-page block (#500). */
export function formatPersistentFailureAlert(serviceName: string, sinceIso: string, nowMs: number): string {
  const elapsedH = Math.floor((nowMs - new Date(sinceIso).getTime()) / 3_600_000)
  return `⚠️ **${serviceName}** status page has been unreachable for **${elapsedH}h+** — likely a structural block (URL moved / IP blocked), not a transient blip. Probe-based status may still be accurate; verify the configured status-page URL.`
}

/**
 * Track consecutive component ID misses per service.
 * Returns true if miss count has reached the threshold (alert should fire).
 */
export function trackComponentMiss(store: TrackingStateBlob, svcId: string, threshold = 3, nowMs = Date.now()): boolean {
  const entry = entryFor(store, svcId)
  const decayed = isCountDecayed(entry.componentMissAt, nowMs, TRACKING_COUNT_DECAY_MS)
  const count = decayed ? 0 : (entry.componentMissCount ?? 0)
  const next = count + 1
  if (next <= threshold) {
    entry.componentMissCount = next
    entry.componentMissAt = new Date(nowMs).toISOString()
  }
  pruneIfEmpty(store, svcId) // see trackFetchFailure's identical guard — threshold <= 0 only
  return next >= threshold
}

/**
 * Reset component miss counter on successful component lookup.
 */
export function resetComponentMiss(store: TrackingStateBlob, svcId: string): void {
  const entry = store[svcId]
  if (!entry) return
  delete entry.componentMissCount
  delete entry.componentMissAt
  pruneIfEmpty(store, svcId)
}

/**
 * Detect component ID mismatches that need alerting.
 * Returns list of services that have reached the miss threshold and haven't been alerted yet.
 * Reads the consolidated tracking blob directly (ground truth, #1224) plus the separate per-service
 * alert-dedup key (`alerted:component-missing:{id}`, unaffected by the consolidation) — this runs
 * once per cron cycle, not per service per invocation, so a fresh `readTrackingState` call here costs
 * one extra KV read per cron cycle, not per service. A miss count whose `componentMissAt` has gone
 * stale (TRACKING_ALERT_STALE_MS — the dead-source path stops calling trackComponentMiss/
 * resetComponentMiss entirely, so nothing else would ever clear it) is treated as 0, the same
 * liveness gate `checkPersistentFetchFailures` applies to `failSince`.
 */
export async function detectComponentMismatches(
  services: { id: string; name: string; statusComponentId: string }[],
  kv: KVLike,
  threshold = 3,
  nowMs = Date.now(),
): Promise<{ id: string; name: string; statusComponentId: string; missCount: number; alertKey: string }[]> {
  const store = await readTrackingState(kv)
  const results: { id: string; name: string; statusComponentId: string; missCount: number; alertKey: string }[] = []
  for (const svc of services) {
    const entry = store[svc.id]
    const missCount = isTimestampStale(entry?.componentMissAt, nowMs, TRACKING_ALERT_STALE_MS) ? 0 : (entry?.componentMissCount ?? 0)
    if (missCount < threshold) continue
    const alertKey = `alerted:component-missing:${svc.id}`
    const alreadyAlerted = await kv.get(alertKey).catch(() => null)
    if (alreadyAlerted) continue
    results.push({ ...svc, missCount, alertKey })
  }
  return results
}

// ── Partial `statusComponentIds` resolve (#1179) ────────────────────────────────────────────────
//
// `resolveSvcStatus` drops the configured ids it cannot find and badges off the survivors, so its
// return value cannot say that it judged only some of them — and the #135 alert cannot see it,
// because that path watches the primary `statusComponentId` only. Rationale, and why this is not an
// extension of #135: docs/reference/discord-alert-paths.md.
//
// The record is REFRESHED while the drift is live and EXPIRES on its own; nothing deletes it. A
// design that cleared on the first clean cycle could not fire on a flapping `components.json` at
// all, because every clean poll reset a clock the previous partial poll had just started.

export const PARTIAL_RESOLVE_THRESHOLD_MS = 6 * 3_600_000
/** Minimum gap between refresh writes for one service, so a drift does not write on every poll. A
 *  cycle in which every id resolves neither reads nor writes. */
export const PARTIAL_RESOLVE_REFRESH_MS = 10 * 60_000
/** A record not refreshed for this long is not evidence of a live drift and must not page. Above the
 *  worst-case gap between two `fetchAllServices` runs — the cron re-fetches on a >10min-stale
 *  snapshot, so ~15min — with room for a missed cycle. */
export const PARTIAL_RESOLVE_STALE_MS = 40 * 60_000
/**
 * Expiry is what retires a record once reports stop. It is ALSO the longest gap between two reports
 * that still counts as one condition: further apart than this and the record expires between them,
 * so `since` restarts. Both directions bite, which is why it sits just above
 * PARTIAL_RESOLVE_THRESHOLD_MS rather than far above it — below, a real-but-sparse drift could never
 * reach the threshold at any duration; well above, two isolated blips hours apart merge into one
 * reported span.
 */
export const PARTIAL_RESOLVE_TTL_S = 7 * 3600

/**
 * `since` — when the service was FIRST seen resolving incompletely, preserved across every refresh.
 * `updatedAt` — the most recent cycle that observed it, which is what makes "still happening"
 * decidable. `missing` — the union of every id seen unresolved since `since` (a union, not the
 * latest snapshot, so a page rotating which ids it serves does not rewrite the record every poll).
 * `viaSummary` — whether the resolve was EVER observed falling back to `summary.json` on a service
 * that configures a `componentsUrl`, i.e. a recorded #1175 revert rather than a guess from config.
 * Monotone within a record's life for the same reason `missing` is.
 */
export type PartialResolveEntry = { since: string; updatedAt: string; missing: string[]; viaSummary: boolean }

const partialResolveKey = (svcId: string) => `component-partial:${svcId}`

/**
 * Pure: parse a stored record. Returns null on absent/corrupt/wrong-shape/empty-`missing`, and on a
 * `since` or `updatedAt` that is not a parseable date — that last one matters: `elapsedAtLeast`
 * would answer false on a bad timestamp forever while the refresh throttle declined to rewrite it,
 * so one bad value would make the service permanently unalertable. Null makes the next partial cycle
 * write a fresh record instead, so the record self-heals.
 *
 * Every rejection warns. Silently dropping a record is the failure mode this mechanism exists to
 * remove, so it must not be reintroduced in the mechanism's own parser.
 */
export function parsePartialResolve(raw: string | null, svcId?: string): PartialResolveEntry | null {
  if (!raw) return null
  const reject = (why: string): null => {
    console.warn(`[partial-resolve] discarding ${svcId ?? 'unknown'}'s component-partial record (${why}) — the ${PARTIAL_RESOLVE_THRESHOLD_MS / 3_600_000}h clock restarts: ${raw.slice(0, 120)}`)
    return null
  }
  let parsed: Partial<PartialResolveEntry>
  try {
    parsed = JSON.parse(raw) as Partial<PartialResolveEntry>
  } catch {
    return reject('unparseable JSON')
  }
  if (typeof parsed?.since !== 'string' || !Array.isArray(parsed.missing)) return reject('wrong shape')
  // `updatedAt` defaults to `since` so a record written before this field existed still reads.
  const updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : parsed.since
  if (!Number.isFinite(new Date(parsed.since).getTime())) return reject('unparseable `since`')
  if (!Number.isFinite(new Date(updatedAt).getTime())) return reject('unparseable `updatedAt`')
  const missing = parsed.missing.filter((id): id is string => typeof id === 'string')
  if (missing.length === 0) return reject('no usable missing ids')
  if (missing.length !== parsed.missing.length) {
    console.warn(`[partial-resolve] ${svcId ?? 'unknown'}'s record carried ${parsed.missing.length - missing.length} non-string id(s); they were dropped rather than rendered into an alert`)
  }
  return { since: parsed.since, updatedAt, missing, viaSummary: parsed.viaSummary === true }
}

/** Pure: is every id in `next` already in `prev`? When true the stored union needs no growth. */
export function coversIdSet(prev: string[], next: string[]): boolean {
  const have = new Set(prev)
  return next.every((id) => have.has(id))
}

/** Pure: the stored union plus anything newly unresolved, in a stable (sorted) order. */
export function unionIds(prev: string[], next: string[]): string[] {
  return [...new Set([...prev, ...next])].sort()
}

/**
 * Pure: given the stored record (or null) and this cycle's observation, the record to write — or
 * `null` for "nothing to write this cycle". Split out from the KV plumbing so the write-bound rule,
 * which is the whole reason this mechanism is affordable, is directly testable.
 *
 * Writes on: a first sighting, a newly-unresolved id, a first observed `summary.json` fallback, or
 * the refresh throttle elapsing. `since` and the monotone `missing`/`viaSummary` all survive; only
 * `updatedAt` moves. (The throttle is evaluated against the `updatedAt` this cycle READ, so
 * concurrent readers of a not-yet-visible write can each refresh once — it bounds the cadence, not
 * the exact count.)
 */
export function nextPartialResolveEntry(
  prev: PartialResolveEntry | null,
  missing: string[],
  viaSummary: boolean,
  nowMs: number,
): PartialResolveEntry | null {
  const nowIso = new Date(nowMs).toISOString()
  if (!prev) return { since: nowIso, updatedAt: nowIso, missing: [...missing].sort(), viaSummary }
  const grewMissing = !coversIdSet(prev.missing, missing)
  const grewViaSummary = viaSummary && !prev.viaSummary
  const dueForRefresh = elapsedAtLeast(prev.updatedAt, nowMs, PARTIAL_RESOLVE_REFRESH_MS)
  if (!grewMissing && !grewViaSummary && !dueForRefresh) return null
  return {
    since: prev.since,
    updatedAt: nowIso,
    missing: unionIds(prev.missing, missing),
    viaSummary: prev.viaSummary || viaSummary,
  }
}

/**
 * Record that this cycle resolved a service's badge from an incomplete component list.
 *
 * Call ONLY on a genuine partial resolve. There is deliberately no "clear" call: a clean cycle does
 * nothing at all (no read, no write, so the steady state is free), and the record retires by TTL
 * once refreshes stop. Clearing eagerly is what made an earlier revision of this unable to fire on a
 * flapping `components.json`.
 *
 * Fails CLOSED on a KV read fault. Treating a rejected `get` as "no record" would rewrite `since` to
 * now on every failing cycle — the clock could never mature, the alert would never fire, and the
 * write bound would be lost. Same posture as the #992 detector's `component-seen` read.
 */
export async function trackPartialResolve(
  kv: KVLike | undefined,
  svcId: string,
  missing: string[],
  nowMs: number,
  viaSummary = false,
): Promise<void> {
  if (!kv || missing.length === 0) return
  const key = partialResolveKey(svcId)
  let readFailed = false
  const raw = await kv.get(key).catch((err) => {
    readFailed = true
    console.warn(`[partial-resolve] KV read failed for ${svcId} — skipping this cycle, clock NOT restarted:`, err instanceof Error ? err.message : err)
    return null
  })
  if (readFailed) return
  const entry = nextPartialResolveEntry(parsePartialResolve(raw, svcId), missing, viaSummary, nowMs)
  if (!entry) return
  const wrote = await kvPut(kv, key, JSON.stringify(entry), { expirationTtl: PARTIAL_RESOLVE_TTL_S })
  if (!wrote) {
    console.error(`[partial-resolve] could not record ${svcId}'s partial resolve — the ${PARTIAL_RESOLVE_THRESHOLD_MS / 3_600_000}h alert clock did not start or advance (missing: ${missing.join(', ')})`)
  }
}

/**
 * Which services have been resolving incompletely for >= the threshold and are STILL doing so, with
 * no live alert dedup. Mirrors `detectComponentMismatches`' shape (the cron sends + writes `alertKey`).
 *
 * The two reads take deliberately opposite postures. A fault on the RECORD read is reported and
 * skips the service — treating it as "no drift" would silently disarm the alert this whole mechanism
 * is. A fault on the DEDUP read is fail-open: it re-pages rather than dropping the page, so it is
 * also reported, since a read that keeps faulting re-pages every cron tick.
 */
export async function detectPartialResolves(
  services: { id: string; name: string }[],
  kv: KVLike,
  nowMs: number,
  thresholdMs = PARTIAL_RESOLVE_THRESHOLD_MS,
): Promise<{ id: string; name: string; since: string; missing: string[]; viaSummary: boolean; alertKey: string }[]> {
  const results: { id: string; name: string; since: string; missing: string[]; viaSummary: boolean; alertKey: string }[] = []
  for (const svc of services) {
    // The `.catch` is load-bearing twice over: it stops one faulting key from rejecting the whole
    // cron pass (this runs at the top level of `cronAlertCheck`, ahead of the #992 detector), and it
    // reports the fault, which a bare `?? null` would not. Returning null then skips the service via
    // the `!entry` guard below — no separate flag, which would be a branch no mutation can reach.
    const raw = await kv.get(partialResolveKey(svc.id)).catch((err) => {
      console.error(`[partial-resolve] KV read failed for ${svc.id} — cannot tell a drift record from none, so it is UNCHECKED this cycle:`, err instanceof Error ? err.message : err)
      return null
    })
    const entry = parsePartialResolve(raw, svc.id)
    if (!entry) continue
    if (!elapsedAtLeast(entry.since, nowMs, thresholdMs)) continue
    // Still live? A record whose last observation is old means the drift stopped (or polling did);
    // TTL will retire it shortly, and until then it must not page.
    if (elapsedAtLeast(entry.updatedAt, nowMs, PARTIAL_RESOLVE_STALE_MS)) continue
    const alertKey = `alerted:component-partial:${svc.id}`
    const alreadyAlerted = await kv.get(alertKey).catch((err) => {
      console.warn(`[partial-resolve] dedup read failed for ${svc.id} — paging again rather than dropping it; a repeating fault here re-pages every cron tick:`, err instanceof Error ? err.message : err)
      return null
    })
    if (alreadyAlerted) continue
    results.push({ ...svc, since: entry.since, missing: entry.missing, viaSummary: entry.viaSummary, alertKey })
  }
  return results
}

/**
 * Operator Discord body for a persistent partial resolve (#1179).
 *
 * Every claim is scoped to the window, because the record is a union over it: `missing` lists every
 * id seen unresolved since `since`, so some may be resolving again right now — the body says so
 * rather than asserting a present-tense blind spot for all of them, which would invite the operator
 * to delete a healthy id from the config.
 *
 * The `viaSummary` line is likewise a window claim, gated on the OBSERVATION recorded at resolve
 * time rather than on the presence of a `componentsUrl` in config: a provider deleting one id from a
 * perfectly readable `components.json` produces the same missing set, and sending the operator to
 * debug a working fetch would be the wrong root cause.
 */
export function formatPartialResolveAlert(
  serviceName: string,
  missing: string[],
  sinceIso: string,
  nowMs: number,
  viaSummary: boolean,
): string {
  const elapsedH = Math.floor((nowMs - new Date(sinceIso).getTime()) / 3_600_000)
  const cause = viaSummary
    ? `\n\nAt least once in that window it resolved off \`summary.json\` despite configuring a \`componentsUrl\` — check whether that read is failing, which would mean the #1175 fix has reverted.`
    : ''
  return `⚠️ **${serviceName}** has been resolving its badge from an INCOMPLETE component list since **${elapsedH}h+** ago.\n\n\`statusComponentIds\` seen unresolved in that window (some may resolve again intermittently): ${missing.map((id) => `\`${id}\``).join(', ')}\n\nWhile an id is unresolved the badge is a worst-of over the others, so an outage on it reads as operational.${cause}\n\n**Action**: check the provider's component list and reconcile \`worker/src/services.ts\`.`
}

/**
 * #992 — new-status-page-component change detection (the inverse of the #135 component-MISS alert:
 * that fires when a CONFIGURED id disappears; this fires when an UNSEEN id appears). Pure so it is
 * fully unit-testable; the cron does the KV read/write + Discord around it.
 *
 * Given a page's CURRENT components and `seen` (every component id ever recorded for this page; `null`
 * = first-ever sight), return the components that are genuinely NEW (id never seen) plus the next
 * `seen` set to persist. Semantics:
 *   - **bootstrap** (`seen === null`): record the current ids but flag NOTHING new — we only alert on
 *     components that appear AFTER we start watching a page, never on the initial snapshot (which would
 *     otherwise dump every existing component of a rich shared page like status.openai.com as "new").
 *   - `seen` UNIONS current ids (never shrinks), so a component removed then re-added does not re-alert,
 *     and a component we already alerted on stays suppressed forever (one alert per component, ever).
 * Provider component renames keep the Atlassian UUID → no false alert; a genuine id swap reads as new.
 */
export function diffPageComponents(
  current: Array<{ id: string; name: string }>,
  seen: string[] | null,
): { newComponents: Array<{ id: string; name: string }>; nextSeen: string[]; bootstrap: boolean } {
  const currentIds = current.map((c) => c.id)
  if (seen === null) {
    return { newComponents: [], nextSeen: [...new Set(currentIds)], bootstrap: true }
  }
  const seenSet = new Set(seen)
  const newComponents = current.filter((c) => !seenSet.has(c.id))
  const nextSeen = [...new Set([...seen, ...currentIds])]
  return { newComponents, nextSeen, bootstrap: false }
}

/**
 * #1125 — split the components `diffPageComponents` reports as never-before-seen into the ones worth an
 * operator's attention and the ones AIWatch already reads (`TRACKED_COMPONENT_IDS`).
 *
 * The alert's whole ask is "decide whether to track it", so an already-tracked id is not a quieter
 * alert — it is a question with no answer, and it is what fired on `Images` (2026-07-22) and `Sora`
 * (2026-07-27). Kept out of `diffPageComponents` on purpose: `seen` must still union EVERY current id
 * (that is what makes the alert once-per-component-ever), so this splits what we SAY, not what we
 * record. Consequently an id that is untracked today and tracked tomorrow does not re-alert.
 *
 * Returns both halves because the cron needs both: `alertable` decides whether to send, `absorbed` is
 * the only record that a suppression happened at all.
 */
export function partitionFirstSeen<T extends { id: string }>(
  newComponents: T[],
  trackedIds: ReadonlySet<string>,
): { alertable: T[]; absorbed: T[] } {
  const alertable: T[] = []
  const absorbed: T[] = []
  for (const c of newComponents) (trackedIds.has(c.id) ? absorbed : alertable).push(c)
  return { alertable, absorbed }
}

/**
 * #992 — operator Discord body for a page that gained ≥1 new component. `pageServices` are the AIWatch
 * service names monitoring the page (context: which service's config to update); `dynamic` flags a
 * displayAllComponents page where the component is ALREADY auto-tracked (informational, no action).
 */
export function formatNewComponentAlert(
  pageServices: string[],
  newComponents: Array<{ id: string; name: string }>,
  dynamic: boolean,
): string {
  const list = newComponents.map((c) => `• \`${c.name}\` (\`${c.id}\`)`).join('\n')
  const who = pageServices.length > 0 ? pageServices.join(', ') : '(no AIWatch service)'
  const action = dynamic
    ? '**Action**: none — this page runs `displayAllComponents`, so the component is already auto-tracked. Heads-up only.'
    : `**Action**: decide whether to track it. To include, add the id to \`statusComponentIds\`/\`displayComponentIds\` for the relevant service in \`worker/src/services.ts\`; otherwise ignore (this fires once per component, ever).`
  return `Status page for **${who}** added ${newComponents.length} new component${newComponents.length === 1 ? '' : 's'}:\n${list}\n\n${action}`
}

/** Check if cached data is stale (strictly older than threshold, or missing cachedAt).
 *
 *  Also returns the snapshot's `upstreamFeeds` (#1072). This function is the cron's ONLY parser of the
 *  snapshot shape, and the cron's #488 alert-edge refresh REWRITES that snapshot — so without the feeds
 *  here, a fresh-cache cron (which never live-fetches) would have nothing to write back and would erase
 *  the feeds from KV on the very write that fires when an incident starts. Reading them out alongside
 *  `services` keeps the read and the write symmetric in the one place that parses the shape.
 *
 *  `[]` when absent — a snapshot written by a pre-#1072 worker (manual, batched deploys) legitimately
 *  has no such key, and an empty feed list is also the normal healthy state, so the two are correctly
 *  indistinguishable to every consumer: both mean "claim no upstream". */
export function isCacheStale(raw: string | null, thresholdMs: number, now = Date.now()): { stale: boolean; services: unknown[]; upstreamFeeds: unknown[] } {
  if (!raw) return { stale: true, services: [], upstreamFeeds: [] }
  try {
    const parsed = JSON.parse(raw)
    const services = Array.isArray(parsed) ? parsed : parsed?.services
    // A bare-array snapshot (the legacy shape the line above still tolerates) has no room for feeds.
    const upstreamFeeds = (!Array.isArray(parsed) && Array.isArray(parsed?.upstreamFeeds)) ? parsed.upstreamFeeds : []
    if (!Array.isArray(services) || services.length === 0) return { stale: true, services: [], upstreamFeeds: [] }
    const cachedAt = parsed?.cachedAt ? new Date(parsed.cachedAt).getTime() : 0
    return { stale: now - cachedAt > thresholdMs, services, upstreamFeeds }
  } catch {
    return { stale: true, services: [], upstreamFeeds: [] }
  }
}

/**
 * Append a status/event hint to a public is-X-down share URL (#539). Social platforms
 * (Slack/Discord/KakaoTalk) cache the OG unfurl by PAGE URL, so a static `is-X-down` link shows a
 * stale card after a status flip (e.g. recovery still shows the cached outage card). Giving the
 * outage vs recovery share links DISTINCT URLs (`?e=degraded` vs `?e=resolved`) makes each a fresh
 * URL → fresh unfurl. The canonical page URL stays clean (this is only on shared message links);
 * the is-down Edge ignores unknown query params. Already-posted messages can't be fixed (external
 * cache) — this only affects future messages.
 */
export function appendStatusHint(url: string, hint: string): string {
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}e=${encodeURIComponent(hint)}`
}

// #548/#936 — UTM tags for the links WE emit, so GA4 (and the #842-B outage-audience classifier)
// attribute consent-free, channel-specific inflow instead of collapsing it to (direct). The X tweet
// path carries its own `X_UTM` in alerts.ts; this covers RSS feed items + Reddit (#548) AND the three
// #936 leaks: the Discord alert "View on AIWatch" link, and statusline OSC-8 links. `campaign=outage`
// groups the outage-driven share/alert channels under one campaign; the always-on statusline nav link
// carries no outage campaign (it's not incident-scoped). The Chrome extension tags its own links in
// plain JS (extension/config.js) — it can't import worker code.
type UtmSource = 'rss' | 'reddit' | 'discord' | 'statusline'
const UTM_CONFIG: Record<UtmSource, { medium: string; campaign?: string }> = {
  rss: { medium: 'feed', campaign: 'outage' },
  reddit: { medium: 'social', campaign: 'outage' },
  discord: { medium: 'notification', campaign: 'outage' },
  statusline: { medium: 'referral' },
}
export function appendUtm(url: string, source: UtmSource): string {
  const { medium, campaign } = UTM_CONFIG[source]
  const params = `utm_source=${source}&utm_medium=${medium}${campaign ? `&utm_campaign=${campaign}` : ''}`
  // A hash-routed dashboard link (ai-watch.dev/#claude) needs the query BEFORE the '#' or GA4 — which
  // reads location.search — never sees it. Insert ahead of the fragment; is-down/root links have none.
  const hashIdx = url.indexOf('#')
  const base = hashIdx === -1 ? url : url.slice(0, hashIdx)
  const frag = hashIdx === -1 ? '' : url.slice(hashIdx)
  const sep = base.includes('?') ? '&' : '?'
  return `${base}${sep}${params}${frag}`
}

// #707/#811/#1021 — classify an incident's TEXT as a NON-reliability advisory (compliance / export-control /
// access revocation OR SUSPENSION / deprecation / scheduled change / usage-limit / quota / billing) rather
// than a service fault. Three uses:
//   (a) #707 — down-classify an AWS Health advisory to `null` impact (aws.ts) so it doesn't tank the Score
//   (b) #811 — keep an operational service whose ONLY unresolved incident is such an advisory eligible as a
//       fallback candidate (a Claude model-access SUSPENSION must not exclude Claude Code when ChatGPT is
//       down). Mirrored in src/utils/constants.js (frontend getFallbacks); parity pinned by a sync test.
//   (c) #1021 — generalize the #707 AWS carve-out to ALL providers: down-classify a usage-limits / quota /
//       billing advisory to `null` impact at the live-fetch choke point (fetchAllServices) so it never
//       inflates `totalDowntimeMin` or drops the Score (the Codex June "Usage Limits Depleting Faster Than
//       Expected" 72h case — 79% of its archived downtime, dropped its Score 86→76 — was a quota notice).
// An OUTAGE_SIGNAL term ALWAYS wins (never down-classify a real fault — the false-positive that would HIDE
// an outage is the dangerous direction). `suspend` (the #811 incident.io wording) joins #707's `revoke`;
// `usage limit|quota|deplet|billing|invoice` (#1021) join them. `model access` is deliberately NOT included
// — its concrete case (an access SUSPENSION) is already caught by `suspend`, and a bare "model access …"
// title collides too readily with a real access outage. #1021 also added `errors?` to OUTAGE_SIGNAL so a
// genuine fault titled "Quota errors" / "Billing errors" (no other outage word) still wins over the advisory.
export const NON_RELIABILITY_RE =
  /export control|compliance|regulatory|revoke|revoked|revoking|suspend(?:ed|ing|s)?|deprecat|end[ -]of[ -]life|retir(?:e|ed|ing|ement)|sunset|discontinu|scheduled (?:maintenance|change)|usage limit|quota|deplet|billing|invoice/i
export const OUTAGE_SIGNAL_RE =
  /error rate|elevated error|errors?|5xx|disruption|outage|partial outage|degraded|unable to|throttl|increased latency|timeouts?|failure|not responding|impair/i
export function isNonReliabilityAdvisory(text: string): boolean {
  return !!text && NON_RELIABILITY_RE.test(text) && !OUTAGE_SIGNAL_RE.test(text)
}

export async function fetchWithTimeout(
  url: string,
  timeoutMs = 8000,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal, redirect: 'follow' })
  } finally {
    clearTimeout(timer)
  }
}
