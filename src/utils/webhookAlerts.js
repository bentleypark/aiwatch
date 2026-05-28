// Browser-side webhook alerting for a user's own Discord webhook (#467).
//
// History: client-side alerting was removed in #60 ("alerts now server-side only") to stop
// duplicate alerts. But the Worker's server-side path only posts to the operator's
// env.DISCORD_WEBHOOK_URL — it never delivers to a visitor's configured webhook (it stores only a
// hash of the URL, #467). So a user who set a Discord webhook in Settings got nothing. This module
// restores delivery for the *user's own* webhook, browser-side.
//
// Scope: Discord only. Slack moved to the native `/feed subscribe <rss>` flow (#467), so there is no
// Slack webhook to push to here. Delivery is best-effort and only fires while a dashboard tab is
// open (no raw URL is stored server-side — privacy by design). Cross-tab/poll dedup via a localStorage
// cooldown; the operator (Worker) posts to a *different* webhook, so there is no cross-source dupe.

import { SETTINGS_STORAGE_KEY } from './constants'

const ALERT_COOLDOWN_MS = 5 * 60_000
const COOLDOWN_STORAGE_KEY = 'aiwatch-alert-cooldowns'
const PREV_INCIDENTS_KEY = 'aiwatch-prev-incidents'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8788'
const API_BASE = API_URL.replace('/api/status', '')

// ── cooldown (shared across tabs + reloads) ────────────────────────────
function getCooldowns() {
  try {
    const raw = localStorage.getItem(COOLDOWN_STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}

function setCooldown(key) {
  try {
    const cooldowns = getCooldowns()
    cooldowns[key] = Date.now()
    const now = Date.now()
    for (const k of Object.keys(cooldowns)) {
      if (now - cooldowns[k] > ALERT_COOLDOWN_MS * 2) delete cooldowns[k]
    }
    localStorage.setItem(COOLDOWN_STORAGE_KEY, JSON.stringify(cooldowns))
  } catch { /* ignore */ }
}

function isInCooldown(key) {
  const last = getCooldowns()[key]
  return Boolean(last && Date.now() - last < ALERT_COOLDOWN_MS)
}

function readAlertSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

// ── pure decision logic (unit-tested) ──────────────────────────────────

/** Status transitions that should alert, honoring alertCondition + alertTarget.
 *  Pure: no cooldown, no I/O. Returns [{ svcId, name, prevStatus, status }]. */
export function computeStatusAlerts(prev, current, settings) {
  if (!prev || prev.length === 0) return []
  const { alertCondition, alertTarget, alertServices } = settings
  const prevMap = new Map(prev.map((s) => [s.id, s.status]))
  const out = []
  for (const svc of current) {
    const prevStatus = prevMap.get(svc.id)
    if (!prevStatus || prevStatus === svc.status) continue
    // 'down'     → only down entry/recovery; 'degraded' → any non-operational entry/recovery; 'all' → every change
    if (alertCondition === 'down' && svc.status !== 'down' && prevStatus !== 'down') continue
    if (alertCondition === 'degraded' && svc.status === 'operational' && prevStatus === 'operational') continue
    if (alertTarget === 'custom' && !alertServices?.includes(svc.id)) continue
    out.push({ svcId: svc.id, name: svc.name, prevStatus, status: svc.status })
  }
  return out
}

/** Snapshot of current incidents keyed by service → incident id. Pure. */
export function buildIncidentSnapshot(services) {
  const snap = {}
  for (const svc of services) {
    snap[svc.id] = {}
    for (const inc of svc.incidents ?? []) {
      snap[svc.id][inc.id] = { status: inc.status, title: inc.title, duration: inc.duration }
    }
  }
  return snap
}

/** New / resolved incidents between two snapshots, honoring alertIncidents + alertTarget.
 *  Pure. Returns [{ kind:'new'|'resolved', svcId, name, incId, title, duration? }]. */
export function computeIncidentAlerts(prevSnap, currSnap, services, settings) {
  if (settings.alertIncidents === false) return []
  const { alertTarget, alertServices } = settings
  const nameMap = new Map(services.map((s) => [s.id, s.name]))
  const out = []
  for (const svcId of Object.keys(currSnap)) {
    if (alertTarget === 'custom' && !alertServices?.includes(svcId)) continue
    const prev = prevSnap[svcId] ?? {}
    const curr = currSnap[svcId] ?? {}
    const name = nameMap.get(svcId) ?? svcId
    for (const [incId, inc] of Object.entries(curr)) {
      const p = prev[incId]
      if (!p) out.push({ kind: 'new', svcId, name, incId, title: inc.title })
      else if (p.status !== 'resolved' && inc.status === 'resolved') {
        out.push({ kind: 'resolved', svcId, name, incId, title: inc.title, duration: inc.duration })
      }
    }
    // Incident vanished from the feed → treat as resolved
    for (const [incId, p] of Object.entries(prev)) {
      if (!curr[incId] && p.status !== 'resolved') {
        out.push({ kind: 'resolved', svcId, name, incId, title: p.title })
      }
    }
  }
  return out
}

// ── Discord embeds + dispatch ───────────────────────────────────────────
function statusEmbed({ svcId, name, prevStatus, status }) {
  const isRecovery = status === 'operational'
  const emoji = isRecovery ? '🟢' : status === 'down' ? '🔴' : '🟡'
  const label = isRecovery ? 'Recovered' : status === 'down' ? 'Down' : 'Degraded'
  return {
    title: `${emoji} ${name} — ${label}`,
    url: `https://ai-watch.dev/#${svcId}`,
    description: `${prevStatus} → ${status}`,
    color: isRecovery ? 0x57F287 : status === 'down' ? 0xED4245 : 0xFEE75C,
    timestamp: new Date().toISOString(),
    footer: { text: 'AIWatch Alert' },
  }
}

function incidentEmbed({ kind, svcId, name, title, duration }) {
  const resolved = kind === 'resolved'
  const durationText = duration ? ` (${duration})` : ''
  return {
    title: resolved ? `🟢 ${name} — Incident resolved${durationText}` : `🔴 ${name} — New incident`,
    url: `https://ai-watch.dev/#${svcId}`,
    description: title,
    color: resolved ? 0x57F287 : 0xED4245,
    timestamp: new Date().toISOString(),
    footer: { text: 'AIWatch Alert' },
  }
}

function sendDiscord(discordUrl, embed) {
  // Best-effort (fire-and-forget — can't block the 60s poll), but log delivery failures so a user
  // whose webhook silently stops working can diagnose it: 403 = bad/non-Discord URL, 429 = their
  // own proxy rate limit during an incident storm, 502 = Discord rejected (dead/revoked webhook).
  // Without this the configured-but-failing case is evidence-free (#467 review finding).
  fetch(`${API_BASE}/api/alert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ webhookUrl: discordUrl, channel: 'discord', payload: { embeds: [embed] } }),
  })
    .then((r) => { if (!r.ok) console.warn(`[webhook-alert] delivery failed (${r.status}): ${embed.title}`) })
    .catch((err) => console.warn('[webhook-alert] delivery error:', err.message))
}

// Per-session guard: don't alert on the snapshot captured at first poll (would fire for
// every already-open incident on page load). Module-scoped, reset on full reload.
let incidentFirstRun = true

/** Run browser-side Discord alerting for one poll. No-op unless a Discord webhook is configured. */
export function runWebhookAlerts(prevServices, currentServices) {
  const settings = readAlertSettings()
  const discordUrl = settings?.discordUrl
  if (!discordUrl) return

  for (const a of computeStatusAlerts(prevServices, currentServices, settings)) {
    const key = `${a.svcId}:${a.status}`
    if (isInCooldown(key)) continue
    setCooldown(key)
    sendDiscord(discordUrl, statusEmbed(a))
  }

  const currSnap = buildIncidentSnapshot(currentServices)
  if (incidentFirstRun) {
    incidentFirstRun = false
    try { localStorage.setItem(PREV_INCIDENTS_KEY, JSON.stringify(currSnap)) } catch { /* ignore */ }
    return
  }
  let prevSnap = {}
  try {
    const raw = localStorage.getItem(PREV_INCIDENTS_KEY)
    if (raw) { const parsed = JSON.parse(raw); prevSnap = parsed.data ?? parsed }
  } catch { /* ignore */ }
  for (const a of computeIncidentAlerts(prevSnap, currSnap, currentServices, settings)) {
    const key = a.kind === 'new' ? `inc:${a.incId}` : `inc-resolve:${a.incId}`
    if (isInCooldown(key)) continue
    setCooldown(key)
    sendDiscord(discordUrl, incidentEmbed(a))
  }
  try { localStorage.setItem(PREV_INCIDENTS_KEY, JSON.stringify(currSnap)) } catch { /* ignore */ }
}

// test-only reset for the per-session incident guard
export function __resetIncidentFirstRun() { incidentFirstRun = true }
