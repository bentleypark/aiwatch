// Client for the server-side per-user Discord subscription endpoints (#486 PR2).
//
// PR1 added the worker endpoints (/api/webhook/subscribe|confirm|update|unsubscribe) that store the
// (AES-GCM-encrypted) webhook URL server-side and prove channel control via a confirm code sent
// THROUGH the channel. This module is the SPA's thin client for them, plus the local bookkeeping of
// "is this URL confirmed?" so Settings can show the right step.
//
// Identity model (no account): the user proves they control the channel by clicking the confirm link
// AIWatch posts into it. We keep the confirmation status keyed by the URL's sha256 hash in
// localStorage so the UI survives reloads — the server is the source of truth, this is just UX state.
//
// As of #486 PR3 this is the ONLY per-user delivery path: the legacy browser relay (webhookAlerts.js)
// + its registration ping (webhookRegistration.js) were removed and the worker cron now fans out
// alerts server-side, so delivery no longer depends on a tab being open.

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8788'
const API_BASE = API_URL.replace('/api/status', '')

// localStorage map: { [hash]: 'pending' | 'confirmed' } — UX hint only; server is authoritative.
const SUB_STATE_KEY = 'aiwatch-webhook-sub-state'

/** SHA-256 hex of the webhook URL — the same key the worker derives, so the UI can correlate a URL
 *  with its server-side subscription without ever sending anything but the URL itself. */
export async function hashWebhookUrl(url) {
  const data = new TextEncoder().encode(url)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

function readSubState() {
  try {
    const raw = localStorage.getItem(SUB_STATE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}

function writeSubState(map) {
  try { localStorage.setItem(SUB_STATE_KEY, JSON.stringify(map)) } catch { /* ignore */ }
}

/** Local UX status for a URL: 'confirmed' | 'pending' | 'none'. Server is the real source of truth;
 *  this only drives which Settings step to show. */
export async function getLocalSubStatus(url) {
  if (!url) return 'none'
  const hash = await hashWebhookUrl(url)
  return readSubState()[hash] ?? 'none'
}

function setLocalSubStatus(hash, status) {
  const map = readSubState()
  if (status === 'none') delete map[hash]
  else map[hash] = status
  writeSubState(map)
}

/** Shape the SPA filter object into the worker's SubscriptionFilters. */
function filtersFrom(settings) {
  return {
    alertCondition: settings.alertCondition,
    alertTarget: settings.alertTarget,
    alertServices: settings.alertServices,
    alertIncidents: settings.alertIncidents,
  }
}

// All four calls return { ok, status?, error? }. `status` on subscribe is 'sent'|'pending'|'confirmed'
// (the worker dedup result). Network/parse failures collapse to { ok:false, error }.

async function postJson(path, body) {
  try {
    const r = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    let data = {}
    try { data = await r.json() } catch { /* empty/non-json body */ }
    if (!r.ok) return { ok: false, error: data.error || `HTTP ${r.status}`, httpStatus: r.status }
    return { ok: true, ...data }
  } catch (err) {
    return { ok: false, error: err?.message || 'Network error' }
  }
}

/** Start a subscription: the worker posts a confirm link into the channel. Marks the URL 'pending'
 *  locally on success so the UI shows "check your channel" until the user confirms. */
export async function subscribeWebhook(url, settings) {
  const res = await postJson('/api/webhook/subscribe', { url, filters: filtersFrom(settings) })
  if (res.ok) {
    const hash = await hashWebhookUrl(url)
    // 'confirmed' is returned when the worker already had this channel confirmed (idempotent) — honor
    // it so a re-add of an already-active webhook doesn't drop the UI back to "pending".
    setLocalSubStatus(hash, res.status === 'confirmed' ? 'confirmed' : 'pending')
  }
  return res
}

/** Update filters on an already-confirmed subscription — no new confirm code (channel control already
 *  proven). The hash is recomputed from the URL; a URL change is a re-subscribe, not an update. */
export async function updateWebhookFilters(url, settings) {
  const hash = await hashWebhookUrl(url)
  return postJson('/api/webhook/update', { hash, filters: filtersFrom(settings) })
}

/** Remove a subscription (server deletes immediately). Clears local UX state ONLY on a confirmed
 *  server delete — an opt-out must reflect the real server outcome, not optimistically report success
 *  while the server keeps delivering (privacy-correct). On failure the caller keeps 'confirmed' + shows
 *  an error so the user can retry. */
export async function unsubscribeWebhook(url) {
  const hash = await hashWebhookUrl(url)
  const res = await postJson('/api/webhook/unsubscribe', { hash })
  if (res.ok) setLocalSubStatus(hash, 'none')
  return res
}

/** Reconcile local status against the server, called when the user returns from clicking the confirm
 *  link (the /confirm page is a separate document and can't signal the SPA, so we re-check on demand).
 *
 *  Uses `subscribe` as the authoritative status probe: PR1's subscribe short-circuits on an existing
 *  pending/confirmed record and returns its `status` WITHOUT re-posting a confirm message or charging
 *  budget — so this is a safe, side-effect-free re-check, not a re-send.
 *
 *  If the server now reports 'confirmed', we ALSO push the current filters via /update — this is how
 *  filter edits made during the pending window (which PR1's immutable pending record dropped) finally
 *  reach the server. `filtersSynced` reports whether that push actually landed: if /update fails
 *  (network blip, 500, or a 404 if the row was pruned between the two calls) the subscription IS
 *  confirmed but is still delivering with the OLD filters — the caller must surface that so the user
 *  knows to retry via [Update alert filters], rather than silently believing their edit took effect.
 *
 *  Returns a result object so the caller can distinguish "still pending" from "probe failed" and NOT
 *  destroy a healthy pending subscription on a transient error (a 502/network blip must not flip the
 *  user back to 'none'):
 *   - { ok: true, status: 'confirmed', filtersSynced: boolean }  — confirmed; filtersSynced=false ⇒ filter push failed
 *   - { ok: true, status: 'pending' }                            — still pending
 *   - { ok: false, error }                                       — probe failed; caller keeps its current status */
export async function reconcileSubscription(url, settings) {
  if (!url) return { ok: false, error: 'No webhook URL' }
  const res = await subscribeWebhook(url, settings)
  if (!res.ok) return { ok: false, error: res.error || 'Could not check status' }
  if (res.status === 'confirmed') {
    // Sync filters changed while pending. The status is authoritative ('confirmed') regardless, but
    // report whether the filter push landed so the caller doesn't claim "in sync" on a failed update.
    const upd = await updateWebhookFilters(url, settings)
    return { ok: true, status: 'confirmed', filtersSynced: upd.ok }
  }
  return { ok: true, status: 'pending' }
}
