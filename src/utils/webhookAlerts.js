// Browser-side delivery of a user's own Discord webhook alerts (#467, #475).
//
// History: client-side alerting was removed in #60 ("alerts now server-side only") to stop duplicate
// alerts. But the Worker's server-side path only posts to the operator's env.DISCORD_WEBHOOK_URL — it
// never delivers to a visitor's configured webhook (it stores only a hash of the URL, #467). So a
// user who set a Discord webhook in Settings got nothing. #467 restored delivery browser-side, but by
// re-implementing the operator's embed formatting in JS — which inevitably drifted (#473 dedup, #474
// grouping/fallback/AI).
//
// #475 fixes that at the root: the Worker is now the single source of truth. Its cron appends every
// embed it sends to the operator to a canonical KV feed, surfaced as `alertFeed` in /api/status. This
// module is a DUMB RELAY — it applies the per-user filter (alertTarget/alertCondition/alertIncidents)
// and POSTs the worker's prebuilt embed verbatim. Operator and user alerts are therefore byte-
// identical, and duplicate suppression (incl. the #473 cross-poll status/incident race) lives
// server-side, so it can't reappear here.
//
// Scope: Discord only. Slack moved to the native `/feed subscribe <rss>` flow (#467). Delivery is
// best-effort and only fires while a dashboard tab is open. No raw URL is stored server-side (the
// worker provides payloads; the browser does the POST) — privacy by design. The operator posts to a
// *different* webhook, so there is no cross-source dupe.

import { SETTINGS_STORAGE_KEY } from './constants'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8788'
const API_BASE = API_URL.replace('/api/status', '')

// Relayed-key bookkeeping, shared across tabs + reloads. Maps alert key → the latest relayed ts, so
// a re-fired operator alert (e.g. a still-down service whose 2h dedup expired) relays again, while an
// unchanged entry seen on the next poll does not.
const RELAYED_STORAGE_KEY = 'aiwatch-relayed-alerts'
const RELAYED_PRUNE_MS = 2 * 3600_000

function getRelayed() {
  try {
    const raw = localStorage.getItem(RELAYED_STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}

function writeRelayed(map) {
  try {
    const now = Date.now()
    for (const k of Object.keys(map)) {
      if (now - map[k] > RELAYED_PRUNE_MS) delete map[k]
    }
    localStorage.setItem(RELAYED_STORAGE_KEY, JSON.stringify(map))
  } catch { /* ignore */ }
}

function readAlertSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

// ── pure decision logic (unit-tested) ──────────────────────────────────

const INCIDENT_KINDS = new Set(['new', 'resolved'])
const STATUS_KINDS = new Set(['down', 'degraded', 'recovered'])

/** True if a feed entry's shape is safe to relay verbatim. The worker is the only producer, but the
 *  entry crosses a JSON boundary untyped, so guard structurally before POSTing: a contentless embed
 *  would post an empty Discord message, and a non-finite ts would throw in `new Date(ts)` and poison
 *  the relayed-key cursor (NaN comparisons are always false → infinite re-relay). */
function isWellFormed(entry) {
  if (!entry || typeof entry.key !== 'string' || !Number.isFinite(entry.ts)) return false
  const e = entry.embed
  return !!e && typeof e.title === 'string' && typeof e.description === 'string' && typeof e.color === 'number'
}

/** Whether a single feed entry should be relayed to this user, given their settings. Pure.
 *  - alertTarget 'custom' → at least one covered service must be in alertServices.
 *  - incident kinds (new/resolved) → gated by alertIncidents (default on).
 *  - status kinds (down/degraded/recovered) → gated by alertCondition: 'all' relays all; 'down'
 *    relays only down + recovered (skips degraded), mirroring the pre-#475 computeStatusAlerts.
 *    Note: the worker emits one `recovered` kind for a return-to-operational from EITHER down or
 *    degraded, so a 'down'-mode user can receive a "Recovered" whose preceding "Degraded" was
 *    filtered — intentional (operator parity; a real all-clear is worth surfacing). */
export function shouldRelay(entry, settings) {
  const { alertCondition, alertTarget, alertServices, alertIncidents } = settings
  if (alertTarget === 'custom' && !entry.svcIds?.some((id) => alertServices?.includes(id))) return false
  if (INCIDENT_KINDS.has(entry.kind)) return alertIncidents !== false
  if (STATUS_KINDS.has(entry.kind)) {
    if (alertCondition === 'down' && entry.kind === 'degraded') return false
    return true
  }
  return false // unknown kind — never relay
}

/** Select feed entries to relay this poll: well-formed, not already relayed at this-or-newer ts, and
 *  passing the per-user filter. Pure (no I/O). `relayed` is { key: ts }. Returns entries in feed order. */
export function selectFeedEntriesToRelay(feed, settings, relayed) {
  const out = []
  for (const entry of feed) {
    if (!isWellFormed(entry)) continue
    const last = relayed[entry.key]
    if (last != null && entry.ts <= last) continue
    if (!shouldRelay(entry, settings)) continue
    out.push(entry)
  }
  return out
}

// ── Discord delivery ────────────────────────────────────────────────────

function sendDiscord(discordUrl, entry) {
  // Relay the worker's canonical embed verbatim; add the channel-local footer + the alert's
  // production timestamp (entry.ts) so the Discord timestamp reflects when it actually fired.
  const embed = { ...entry.embed, timestamp: new Date(entry.ts).toISOString(), footer: { text: 'AIWatch' } }
  // Resolves true on confirmed delivery, false otherwise. The caller marks the entry relayed ONLY on
  // success, so a transient failure is retried on the next poll (bounded by the 30-min feed window)
  // rather than permanently dropped — at-least-once within the window. Log the status so a user whose
  // webhook silently stops working can diagnose it: 403 = bad/non-Discord URL, 429 = proxy rate limit
  // during an incident storm, 502 = Discord rejected (dead/revoked webhook).
  return fetch(`${API_BASE}/api/alert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ webhookUrl: discordUrl, channel: 'discord', payload: { embeds: [embed] } }),
  })
    .then((r) => {
      if (!r.ok) { console.warn(`[webhook-alert] delivery failed (${r.status}): ${entry.embed.title}`); return false }
      return true
    })
    .catch((err) => { console.warn('[webhook-alert] delivery error:', err.message); return false })
}

// Per-session guard: on the first poll after a load, baseline the current feed (don't relay the
// backlog — those alerts already fired while the tab was closed). Module-scoped, reset on full reload.
let relayFirstRun = true

/** Relay matching canonical alert-feed entries to the user's own Discord webhook. No-op unless a
 *  Discord webhook is configured. `alertFeed` is the /api/status `alertFeed` array (may be empty). */
export function runWebhookAlerts(alertFeed = []) {
  const settings = readAlertSettings()
  const discordUrl = settings?.discordUrl
  if (!discordUrl) return

  const relayed = getRelayed()

  // First poll with a webhook configured → baseline the backlog, never send.
  if (relayFirstRun) {
    relayFirstRun = false
    for (const entry of alertFeed) {
      if (entry?.key) relayed[entry.key] = Math.max(relayed[entry.key] ?? 0, entry.ts ?? 0)
    }
    writeRelayed(relayed)
    return
  }

  // At-least-once: mark relayed only on confirmed delivery (below), so a transient failure retries.
  // Tradeoff: the marking is deferred to the delivery microtask, so two overlapping polls (e.g. the
  // visibilitychange immediate poll racing an in-flight interval poll) could both relay the same key
  // before either marks it — a rare benign duplicate, chosen over the permanent drop of mark-before-send.
  const toRelay = selectFeedEntriesToRelay(alertFeed, settings, relayed)
  for (const entry of toRelay) {
    sendDiscord(discordUrl, entry).then((ok) => {
      if (!ok) return // leave unmarked → retried next poll while still within the feed window
      relayed[entry.key] = Math.max(relayed[entry.key] ?? 0, entry.ts ?? 0)
      writeRelayed(relayed)
    })
  }
}

// test-only reset for the per-session baseline guard
export function __resetRelayFirstRun() { relayFirstRun = true }
