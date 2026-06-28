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
 * component) — or from a transient no-incident fetch hiccup — is NOT a real service-wide
 * outage, so it counts as up. This mirrors the official rolling-uptime weighting (minor impact
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

/**
 * Track consecutive RSS fetch failures per service.
 * Returns true if failure count has reached the threshold (service should be degraded).
 * Returns false if still below threshold (treat as operational / no data).
 */
export async function trackFetchFailure(kv: KVLike | undefined, svcId: string, threshold = 3): Promise<boolean> {
  if (!kv) return false
  const failKey = `fetch-fail:${svcId}`
  const count = parseInt(await kv.get(failKey).catch(() => null) ?? '0', 10) || 0
  const next = count + 1
  if (next <= threshold) {
    await kvPut(kv, failKey, String(next), { expirationTtl: 1800 })
  }
  const shouldDegrade = next >= threshold
  if (next === threshold) {
    // Daily accumulator: counts threshold *crossings* (distinct failure episodes), not polling cycles.
    // Fires only on the rising edge (count going from threshold-1 → threshold) so each 30-min
    // fetch-fail TTL cycle contributes exactly one crossing. Expected scale:
    //   transient: 1–3 crossings/day  (occasional blips that recover quickly)
    //   structural: 10+ crossings/day (URL blocked — one crossing per ~45-min cycle all day)
    const date = new Date().toISOString().split('T')[0]
    const dailyKey = `fetch-fail:daily:${svcId}:${date}`
    const dailyCount = parseInt(await kv.get(dailyKey).catch(() => null) ?? '0', 10) || 0
    await kvPut(kv, dailyKey, String(dailyCount + 1), { expirationTtl: 172800 }) // 48h

    // #500: record the FIRST-failure timestamp for the persistent (1h+) structural-block alert.
    // Set only if absent so it survives the short fetch-fail key's 30-min expiry + re-climb cycles
    // (and is immune to call frequency — trackFetchFailure also runs on every /api/status request,
    // not just the 5-min cron, so a count-of-cycles would alert well under an hour). resetFetchFailure
    // clears it on recovery. 25h TTL > the alert's 24h dedup window so it can't lapse mid-incident.
    const sinceKey = `fetch-fail:since:${svcId}`
    const existingSince = await kv.get(sinceKey).catch(() => null)
    if (existingSince === null) {
      await kvPut(kv, sinceKey, new Date().toISOString(), { expirationTtl: 90_000 }) // 25h
    }
  }
  return shouldDegrade
}

/**
 * Reset fetch failure counter on successful fetch. Also clears the #500 persistent
 * first-failure timestamp so a later failure episode times its own fresh hour.
 */
export async function resetFetchFailure(kv: KVLike | undefined, svcId: string): Promise<void> {
  if (!kv) return
  const key = `fetch-fail:${svcId}`
  const existing = await kv.get(key).catch(() => null)
  if (existing !== null) await kvDel(kv, key)
  const sinceKey = `fetch-fail:since:${svcId}`
  const sinceExisting = await kv.get(sinceKey).catch(() => null)
  if (sinceExisting !== null) await kvDel(kv, sinceKey)
}

/** Threshold for the #500 persistent structural-block alert: a status page unreachable this long
 *  is a structural block (URL/IP), not a transient blip. */
export const PERSISTENT_FAILURE_THRESHOLD_MS = 3_600_000 // 1h

/** Pure decision: has the status page been continuously unreachable for >= threshold? Frequency-
 *  independent — keys off the first-failure wall-clock timestamp, not a count of polling cycles. */
export function shouldAlertPersistentFailure(
  sinceIso: string | null | undefined,
  nowMs: number,
  thresholdMs: number = PERSISTENT_FAILURE_THRESHOLD_MS,
): boolean {
  if (!sinceIso) return false
  const sinceMs = new Date(sinceIso).getTime()
  if (isNaN(sinceMs)) return false
  return nowMs - sinceMs >= thresholdMs
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
export async function trackComponentMiss(kv: KVLike | undefined, svcId: string, threshold = 3): Promise<boolean> {
  if (!kv) return false
  const key = `component-missing:${svcId}`
  const count = parseInt(await kv.get(key).catch(() => null) ?? '0', 10) || 0
  const next = count + 1
  if (next <= threshold) {
    await kvPut(kv, key, String(next), { expirationTtl: 1800 })
  }
  return next >= threshold
}

/**
 * Reset component miss counter on successful component lookup.
 */
export async function resetComponentMiss(kv: KVLike | undefined, svcId: string): Promise<void> {
  if (!kv) return
  const key = `component-missing:${svcId}`
  const existing = await kv.get(key).catch(() => null)
  if (existing !== null) await kvDel(kv, key)
}

/**
 * Detect component ID mismatches that need alerting.
 * Returns list of services that have reached the miss threshold and haven't been alerted yet.
 */
export async function detectComponentMismatches(
  services: { id: string; name: string; statusComponentId: string }[],
  kv: KVLike,
  threshold = 3,
): Promise<{ id: string; name: string; statusComponentId: string; missCount: number; alertKey: string }[]> {
  const results: { id: string; name: string; statusComponentId: string; missCount: number; alertKey: string }[] = []
  for (const svc of services) {
    const missCount = parseInt(await kv.get(`component-missing:${svc.id}`).catch(() => null) ?? '0', 10) || 0
    if (missCount < threshold) continue
    const alertKey = `alerted:component-missing:${svc.id}`
    const alreadyAlerted = await kv.get(alertKey).catch(() => null)
    if (alreadyAlerted) continue
    results.push({ ...svc, missCount, alertKey })
  }
  return results
}

/** Check if cached data is stale (strictly older than threshold, or missing cachedAt). */
export function isCacheStale(raw: string | null, thresholdMs: number, now = Date.now()): { stale: boolean; services: unknown[] } {
  if (!raw) return { stale: true, services: [] }
  try {
    const parsed = JSON.parse(raw)
    const services = Array.isArray(parsed) ? parsed : parsed?.services
    if (!Array.isArray(services) || services.length === 0) return { stale: true, services: [] }
    const cachedAt = parsed?.cachedAt ? new Date(parsed.cachedAt).getTime() : 0
    return { stale: now - cachedAt > thresholdMs, services }
  } catch {
    return { stale: true, services: [] }
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

// #548 — UTM tags for outage-share links so GA4 cleanly attributes consent-free, channel-specific
// inflow (the X tweet path already carries its own `X_UTM` in alerts.ts; this covers the RSS feed
// item links + Reddit promote links). campaign=outage matches the X constant so all share channels
// roll up under one campaign. `source` is the channel (rss/reddit); medium groups feed vs social.
const UTM_MEDIUM: Record<'rss' | 'reddit', string> = { rss: 'feed', reddit: 'social' }
export function appendUtm(url: string, source: 'rss' | 'reddit'): string {
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}utm_source=${source}&utm_medium=${UTM_MEDIUM[source]}&utm_campaign=outage`
}

// #707/#811 — classify an incident's TEXT as a NON-reliability advisory (compliance / export-control /
// access revocation OR SUSPENSION / deprecation / scheduled change) rather than a service fault. Two uses:
//   (a) #707 — down-classify an AWS Health advisory to `null` impact (aws.ts) so it doesn't tank the Score
//   (b) #811 — keep an operational service whose ONLY unresolved incident is such an advisory eligible as a
//       fallback candidate (a Claude model-access SUSPENSION must not exclude Claude Code when ChatGPT is
//       down). Mirrored in src/utils/constants.js (frontend getFallbacks); parity pinned by a sync test.
// An OUTAGE_SIGNAL term ALWAYS wins (never down-classify a real fault — the false-positive that would HIDE
// an outage is the dangerous direction). `suspend` (the #811 incident.io wording) joins #707's `revoke`.
export const NON_RELIABILITY_RE =
  /export control|compliance|regulatory|revoke|revoked|revoking|suspend(?:ed|ing|s)?|deprecat|end[ -]of[ -]life|retir(?:e|ed|ing|ement)|sunset|discontinu|scheduled (?:maintenance|change)/i
export const OUTAGE_SIGNAL_RE =
  /error rate|elevated error|5xx|disruption|outage|partial outage|degraded|unable to|throttl|increased latency|timeouts?|failure|not responding|impair/i
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
