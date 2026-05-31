// Canonical alert feed (#475) — single source of truth for per-user webhook content.
//
// The cron (cronAlertCheck) builds one rich Discord embed per operator alert (incident / status /
// recovery), assembling AI analysis, Detection Lead, fallback, region hint, and multi-service
// grouping server-side. The cron appends every embed it sends to a short rolling KV feed, then (since
// #486 PR3) fans those same entries out to confirmed per-user subscriptions server-side
// (deliverToSubscribers in webhook-subscriptions.ts), applying the per-user filter (alertTarget/
// alertCondition/alertIncidents) there. So operator and user alerts are byte-identical, future format
// changes propagate for free, and duplicate suppression (incl. the #473 cross-poll status/incident
// race) is resolved once, server-side. (#467/#475 originally relayed this from the browser; PR3
// retired that relay.) `alertFeed` is still surfaced on /api/status for external readers.
//
// Privacy: this feed stores no webhook URL — only the subscription store (webhook:sub:*) holds the
// user URL, AES-GCM-encrypted (#486 reversed #467's hash-only posture).

import { kvPut } from './utils'
import type { ServiceStatus } from './services'

export type AlertKind = 'new' | 'resolved' | 'down' | 'degraded' | 'recovered'

/** The verbatim Discord embed core shared by the operator send and the per-user relay (the #475
 *  "byte-identical" contract). Footer + timestamp are added at delivery, not stored here. */
export interface AlertEmbed {
  title: string
  description: string
  color: number
}

export interface AlertFeedEntry {
  /** Operator dedup key, e.g. `alerted:new:{incId}` / `alerted:down:{svcId}`. Invariant:
   *  `kind === kindFromKey(key)` (guaranteed by `buildFeedEntry`, the sole producer). */
  key: string
  kind: AlertKind
  /** Services this alert covers — for the per-user alertTarget/alertServices filter. */
  svcIds: string[]
  /** The exact embed sent to the operator. */
  embed: AlertEmbed
  /** When the alert was produced (cron send time), ms epoch — also the relayed Discord timestamp. */
  ts: number
}

export const ALERT_FEED_KEY = 'alert:feed:recent'
const FEED_TTL_S = 7200             // 2h — outlives any reasonable browser poll gap
const FEED_PRUNE_MS = 2 * 3600_000  // drop entries older than 2h on write
const FEED_MAX = 50                 // hard cap on stored entries (response-size guard)
const DEFAULT_WINDOW_MS = 30 * 60_000 // entries surfaced in /api/status (≫ hidden-tab 5min poll)

const KEY_PREFIXES: ReadonlyArray<readonly [string, AlertKind]> = [
  ['alerted:new:', 'new'],
  ['alerted:res:', 'resolved'],
  ['alerted:down:', 'down'],
  ['alerted:degraded:', 'degraded'],
  ['alerted:recovered:', 'recovered'],
]

export function kindFromKey(key: string): AlertKind | null {
  for (const [prefix, kind] of KEY_PREFIXES) {
    if (key.startsWith(prefix)) return kind
  }
  return null
}

/** Services covered by an alert, for the per-user alertTarget filter.
 *  - status (down/degraded/recovered): the `{svcId}` tail of each key.
 *  - incident (new/resolved): services whose incidents include the `{incId}` tail(s).
 *  `keys` is alert.key plus any `_mergedKeys` (Together AI model grouping). */
export function svcIdsForAlert(keys: string[], kind: AlertKind, services: ServiceStatus[]): string[] {
  // Tail after "alerted:{kind}:" — svcId for status, incId for incidents. slice(2) rejoins ids that
  // themselves contain ':' (e.g. aistudio:/vertex: incident ids).
  const tails = keys.map((k) => k.split(':').slice(2).join(':')).filter(Boolean)
  if (kind === 'down' || kind === 'degraded' || kind === 'recovered') {
    return [...new Set(tails)]
  }
  const incIds = new Set(tails)
  const out: string[] = []
  for (const svc of services) {
    if ((svc.incidents ?? []).some((i) => incIds.has(i.id))) out.push(svc.id)
  }
  return out
}

/** Build a feed entry from a sent operator alert + its final rendered description. Returns null for
 *  alert keys that aren't per-user-relevant (unknown prefix — e.g. operator-only digests). */
export function buildFeedEntry(
  alert: { key: string; title: string; color: number; _mergedKeys?: string[] },
  description: string,
  services: ServiceStatus[],
  ts: number = Date.now(),
): AlertFeedEntry | null {
  const kind = kindFromKey(alert.key)
  if (!kind) return null
  return {
    key: alert.key,
    kind,
    svcIds: svcIdsForAlert(alert._mergedKeys ?? [alert.key], kind, services),
    embed: { title: alert.title, description, color: alert.color },
    ts,
  }
}

/** Append entries to the rolling feed (single read-modify-write per cron). Prunes >2h and caps size.
 *  Best-effort: a feed write failure must never break operator alerting (caller ignores false). */
export async function appendAlertFeed(
  kv: KVNamespace,
  entries: AlertFeedEntry[],
  now: number = Date.now(),
): Promise<boolean> {
  if (entries.length === 0) return true
  let existing: AlertFeedEntry[] = []
  try {
    const raw = await kv.get(ALERT_FEED_KEY)
    if (raw) existing = JSON.parse(raw) as AlertFeedEntry[]
  } catch (err) {
    console.warn('[alert-feed] read failed, starting fresh:', err instanceof Error ? err.message : err)
  }
  const merged = [...existing, ...entries]
    .filter((e) => now - e.ts < FEED_PRUNE_MS)
    .slice(-FEED_MAX)
  return kvPut(kv, ALERT_FEED_KEY, JSON.stringify(merged), { expirationTtl: FEED_TTL_S })
}

/** Read recent feed entries (last `windowMs`) for the /api/status response. */
export async function readAlertFeed(
  kv: KVNamespace,
  windowMs: number = DEFAULT_WINDOW_MS,
  now: number = Date.now(),
): Promise<AlertFeedEntry[]> {
  try {
    const raw = await kv.get(ALERT_FEED_KEY)
    if (!raw) return []
    const entries = JSON.parse(raw) as AlertFeedEntry[]
    return entries.filter((e) => now - e.ts < windowMs)
  } catch (err) {
    console.warn('[alert-feed] read failed:', err instanceof Error ? err.message : err)
    return []
  }
}
