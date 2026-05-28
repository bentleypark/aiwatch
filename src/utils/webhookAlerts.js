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

import { SETTINGS_STORAGE_KEY, getGroupedFallbacks } from './constants'

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
    // 'down' → only transitions involving a Major Outage, which still covers recovery FROM down
    // (prevStatus==='down'); 'all' → every status change. ('degraded' was removed in #470 — it was
    // identical to 'all' and is migrated to it in useSettings.)
    if (alertCondition === 'down' && svc.status !== 'down' && prevStatus !== 'down') continue
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

// Neutralize @everyone/@here pings, user/role mentions, and code fences in provider-sourced text
// before POSTing to the user's Discord channel (#474). Mirrors the operator's worker sanitize()
// (worker/src/utils.ts) — the operator applies it to incident titles, so the per-user path must too.
function sanitizeForDiscord(s, maxLen = 1000) {
  return String(s ?? '')
    .replace(/@(everyone|here)/g, '@​$1')
    .replace(/<@[!&]?\d+>/g, '[mention]')
    .replace(/```/g, '\\`\\`\\`')
    .slice(0, maxLen)
}

/** Find the AI analysis entry for a grouped incident across its affected services (#474). */
function findAiAnalysis(aiAnalysis, svcIds, incId) {
  for (const svcId of svcIds) {
    const arr = aiAnalysis?.[svcId]
    if (!Array.isArray(arr)) continue
    const match = arr.find((a) => a && a.incidentId === incId)
    if (match) return match
  }
  return null
}

/** Build a rich, grouped incident embed (#474) matching the operator alert: provider-grouped
 *  display name for multi-service incidents, a Suggested fallback line for impaired services, and
 *  an AI-analysis section when available. `group` = { kind, incId, title, duration, svcIds[], names[] }. */
function incidentEmbed(group, services, aiAnalysis, byId) {
  const { kind, incId, title, duration, svcIds, names } = group
  const resolved = kind === 'resolved'
  const first = byId.get(svcIds[0])
  // Operator parity: "Anthropic (Claude API, claude.ai, Claude Code)" when >1 service shares the incident.
  const displayName = names.length > 1 && first?.provider ? `${first.provider} (${names.join(', ')})` : names[0]
  const durationText = duration ? ` (${duration})` : ''

  const sections = [sanitizeForDiscord(title)]
  if (!resolved) {
    const ai = findAiAnalysis(aiAnalysis, svcIds, incId)
    if (ai?.summary) {
      const aiLines = [`🤖 ${sanitizeForDiscord(ai.summary)}`]
      // Mirror formatRecoveryDisplay / AnalysisModal: 'N/A' means no estimate → show the friendly
      // phrasing rather than a bare "N/A"; skip the line for the other non-estimate sentinel.
      const recovery = ai.estimatedRecovery === 'N/A' ? 'Exceeded typical pattern' : ai.estimatedRecovery
      if (recovery && recovery !== 'No historical data for estimation') aiLines.push(`⏱ Est. recovery: ${recovery}`)
      if (ai.affectedScope?.length) aiLines.push(`📡 Scope: ${sanitizeForDiscord(ai.affectedScope.join(', '), 200)}`)
      sections.push(aiLines.join('\n'))
    }
    // Per-category fallback for ALL impaired services in this (possibly multi-category) incident,
    // mirroring the dashboard/operator grouped fallback (#474). A multi-surface Anthropic incident
    // (Claude API = LLM, claude.ai = app, Claude Code = agent) shows one alternative line per
    // category — not just the first service's. getGroupedFallbacks handles tier subdivision,
    // EXCLUDE_FALLBACK, operational filtering, and same-provider exclusion.
    const affected = svcIds.map((id) => byId.get(id)).filter((s) => s && s.status !== 'operational')
    const fbGroups = getGroupedFallbacks(affected, services)
    if (fbGroups.length > 0) {
      const fmt = (items) => items.map((i) => (i.aiwatchScore != null ? `${i.name} (Score ${i.aiwatchScore})` : i.name)).join(' · ')
      if (fbGroups.length === 1) {
        sections.push(`👉 Suggested fallback: ${fmt(fbGroups[0].items)}`)
      } else {
        sections.push(`👉 Suggested fallback\n${fbGroups.map((g) => `• ${g.label}: ${fmt(g.items)}`).join('\n')}`)
      }
    }
  }

  return {
    title: resolved ? `🟢 ${displayName} — Incident resolved${durationText}` : `🔴 ${displayName} — New incident`,
    url: `https://ai-watch.dev/#${svcIds[0]}`,
    description: sections.join('\n\n'),
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

/** Group per-(service, incident) alerts from computeIncidentAlerts into one entry per incident
 *  (kind + incId), collecting all affected service ids/names — so a multi-service incident becomes
 *  a single grouped embed (#474). svcIds[0] (the first service seen in currentServices order)
 *  anchors the embed's provider, url, and fallback source; currentServices order is stable. */
function groupIncidentAlerts(incidentAlerts) {
  const groups = new Map()
  for (const a of incidentAlerts) {
    const k = `${a.kind}:${a.incId}`
    const g = groups.get(k)
    if (g) {
      if (!g.svcIds.includes(a.svcId)) { g.svcIds.push(a.svcId); g.names.push(a.name) }
    } else {
      groups.set(k, { kind: a.kind, incId: a.incId, title: a.title, duration: a.duration, svcIds: [a.svcId], names: [a.name] })
    }
  }
  return [...groups.values()]
}

/** Run browser-side Discord alerting for one poll. No-op unless a Discord webhook is configured. */
export function runWebhookAlerts(prevServices, currentServices, aiAnalysis = {}) {
  const settings = readAlertSettings()
  const discordUrl = settings?.discordUrl
  if (!discordUrl) return

  const currSnap = buildIncidentSnapshot(currentServices)

  // Incident alerts are computed first so status alerts can dedup against them (#473). On the first
  // poll we only baseline the incident snapshot (never alert on already-open incidents), so
  // incidentGroups stays empty — but status alerts still process (production's first poll has an
  // empty prevServices ⇒ computeStatusAlerts returns [] anyway; a later poll is the real first diff).
  let incidentGroups = []
  if (incidentFirstRun) {
    incidentFirstRun = false
  } else {
    let prevSnap = {}
    try {
      const raw = localStorage.getItem(PREV_INCIDENTS_KEY)
      if (raw) { const parsed = JSON.parse(raw); prevSnap = parsed.data ?? parsed }
    } catch { /* ignore */ }
    incidentGroups = groupIncidentAlerts(computeIncidentAlerts(prevSnap, currSnap, currentServices, settings))
  }
  const incidentSvcIds = new Set(incidentGroups.flatMap((g) => g.svcIds))
  const byId = new Map(currentServices.map((s) => [s.id, s]))

  for (const a of computeStatusAlerts(prevServices, currentServices, settings)) {
    // Suppress the status embed when an incident embed covers the same service: a new/resolved
    // incident alert this cycle (incidentSvcIds), or an ongoing incident from a prior cycle still
    // covering a down/degraded (operator-parity hasOngoingIncident). Status changes with NO incident
    // (e.g. down before the status page posts one) still fire — that signal isn't duplicated.
    if (incidentSvcIds.has(a.svcId)) continue
    if (a.status !== 'operational' && (byId.get(a.svcId)?.incidents ?? []).some((i) => i.status !== 'resolved')) continue
    const key = `${a.svcId}:${a.status}`
    if (isInCooldown(key)) continue
    setCooldown(key)
    sendDiscord(discordUrl, statusEmbed(a))
  }
  for (const g of incidentGroups) {
    const key = g.kind === 'new' ? `inc:${g.incId}` : `inc-resolve:${g.incId}`
    if (isInCooldown(key)) continue
    setCooldown(key)
    sendDiscord(discordUrl, incidentEmbed(g, currentServices, aiAnalysis, byId))
  }
  try { localStorage.setItem(PREV_INCIDENTS_KEY, JSON.stringify(currSnap)) } catch { /* ignore */ }
}

// test-only reset for the per-session incident guard
export function __resetIncidentFirstRun() { incidentFirstRun = true }
