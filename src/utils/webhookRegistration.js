// Webhook registration ping (#467) — LEGACY, removed in the #486 PR3 cutover. The Worker stores only
// a SHA-256 hash of the webhook URL (webhook:reg:{hash}, 30d TTL) purely to COUNT active webhooks in
// the daily summary — this `reg` path never stores the raw URL. `pingWebhookRegistration` runs on a
// successful Subscribe (register/unregister on change). `refreshWebhookRegistration` runs on app load
// so a set-and-forget user's registration keeps refreshing its 30d TTL each visit — otherwise the
// "active webhooks" count decays and under-reports (#467). "Active" therefore means: configured +
// opened AIWatch within 30 days.
//
// NOTE (#486): the new server-side subscription path (worker/src/webhook-subscriptions.ts,
// webhook:sub:{hash}) DOES persist an AES-GCM-*encrypted* URL — a different KV key + a deliberate
// reversal of #467's hash-only posture, gated by channel-control confirmation. The two coexist only
// until #486 PR3 removes this legacy ping + the browser relay (webhookAlerts.js). The "count-only, no
// URL" statement above is scoped to webhook:reg: and stays accurate for it.

const WORKER_BASE = (import.meta.env.VITE_API_URL || 'http://localhost:8788').replace('/api/status', '')

export async function hashWebhookUrl(url) {
  const data = new TextEncoder().encode(url)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

function postRegistration(hash, type) {
  fetch(`${WORKER_BASE}/api/webhook/ping`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hash, type }),
  }).then((r) => { if (!r.ok) console.warn(`[webhook-ping] POST failed: ${r.status}`) })
    .catch((err) => console.warn('[webhook-ping] POST error:', err.message))
}

/** On Settings save: unregister the old URL (if changed) and register the new one. No-op if unchanged. */
export function pingWebhookRegistration(currentUrl, type, previousUrl) {
  if (currentUrl === previousUrl) return
  if (previousUrl) {
    hashWebhookUrl(previousUrl).then((hash) => {
      fetch(`${WORKER_BASE}/api/webhook/ping`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hash }),
      }).then((r) => { if (!r.ok) console.warn(`[webhook-ping] DELETE failed: ${r.status}`) })
        .catch((err) => console.warn('[webhook-ping] DELETE error:', err.message))
    }).catch((err) => console.warn('[webhook-ping] Hash error:', err.message))
  }
  if (currentUrl) {
    hashWebhookUrl(currentUrl).then((hash) => postRegistration(hash, type)).catch((err) => console.warn('[webhook-ping] Hash error:', err.message))
  }
}

// The registration's KV TTL is 30 days, so refreshing more than once a day is wasted KV writes.
// A per-hash localStorage timestamp throttles refreshes to ~1/day even if the user reloads often
// (the KV-schema budget assumes ~1 write/user/day — without this, every page load would write).
const REFRESH_THROTTLE_KEY = 'aiwatch-webhook-refresh'
const REFRESH_THROTTLE_MS = 24 * 60 * 60_000

function readRefreshLog() {
  try {
    const raw = localStorage.getItem(REFRESH_THROTTLE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}

/** On app load: refresh the registration's 30d TTL so set-and-forget users stay counted (#467).
 *  Throttled to once per 24h per webhook (keyed by hash) to stay within the KV write budget. */
export function refreshWebhookRegistration(url, type) {
  if (!url) return
  hashWebhookUrl(url).then((hash) => {
    const log = readRefreshLog()
    const now = Date.now()
    if (log[hash] && now - log[hash] < REFRESH_THROTTLE_MS) return // refreshed within the last 24h
    postRegistration(hash, type)
    // Keep only this hash's marker — a changed URL produces a new hash, and stale entries
    // are harmless but pruned here so the log can't grow unbounded.
    try { localStorage.setItem(REFRESH_THROTTLE_KEY, JSON.stringify({ [hash]: now })) } catch { /* ignore */ }
  }).catch((err) => console.warn('[webhook-ping] Hash error:', err.message))
}
