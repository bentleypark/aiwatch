// Pure rendering/derivation logic for the AIWatch Claude extension (#837).
// NO chrome.* dependencies — imported by both the service worker (badge) and the
// popup (DOM), and unit-tested in isolation (lib/render.test.js). Keep it pure.

// Worst-of ordering for the toolbar badge: down beats degraded beats UNKNOWN beats operational.
//
// #1233 — `unknown` (AIWatch could not read the provider's status source) has no rank without this
// entry, and `worstStatus`' `STATUS_RANK[st] != null` guard would SKIP those services entirely: a board
// where every service is unreadable would report `operational` — a green toolbar badge asserting health
// nobody checked. Written in the conditional deliberately: the worker did not publish this value before
// #1233, so this is a hole the new value would open, not a bug that already shipped.
//
// Ranked above `operational` and below `degraded` for the reason is-down-group.ts gives for the
// identical ordering (#1164): an unconfirmed status must not be masked by a confirmed-healthy one, but
// a CONFIRMED problem is still worse than an unconfirmed one.
//
// Unlike the fallback list — which `worker/src/ext-claude.ts` withholds server-side so the fix reaches
// every installed copy on a worker deploy — this one ships ONLY with an extension update. Until a user's
// Chrome updates them, an installed copy reads `unknown` as green here.
const STATUS_RANK = { operational: 0, unknown: 1, degraded: 2, down: 3 }

// Badge colors (standalone — the extension is not part of the SPA design system).
const BADGE_COLORS = {
  operational: '#16a34a', // green
  degraded: '#f59e0b', // amber
  down: '#dc2626', // red
  unknown: '#6b7280', // grey — no data yet / fetch failed
}

const STATUS_LABEL = {
  operational: 'Operational',
  degraded: 'Degraded',
  down: 'Down',
  unknown: 'Unknown',
}

const CATEGORY_LABEL = {
  outage: 'Outage',
  degraded: 'Degraded',
  errors: 'Errors',
  login: 'Login',
  other: 'Other',
}

// The worst status across the projected services. Empty/absent → 'unknown' (grey),
// distinguishing "no data yet" from a real all-operational board.
export function worstStatus(services) {
  if (!Array.isArray(services) || services.length === 0) return 'unknown'
  let worst = 'operational'
  for (const s of services) {
    const st = s && s.status
    if (STATUS_RANK[st] != null && STATUS_RANK[st] > STATUS_RANK[worst]) worst = st
  }
  return worst
}

// Badge appearance for a status. Always a solid color chip (the '●' glyph is painted
// in the same color as the background, so it reads as a filled colored dot).
export function badgeFor(status) {
  const color = BADGE_COLORS[status] || BADGE_COLORS.unknown
  return { color, text: '●' }
}

export function statusLabel(status) {
  return STATUS_LABEL[status] || STATUS_LABEL.unknown
}

export function categoryLabel(cat) {
  return CATEGORY_LABEL[cat] || CATEGORY_LABEL.other
}

// "66 · fair" / "—" when the Score is withheld (null, e.g. #713 low-confidence).
export function formatScore(score, grade) {
  if (score == null) return '—'
  return grade ? `${score} · ${grade}` : String(score)
}

// "99.87%" 30-day official uptime / "—" when no official uptime (#713 incident-only services).
export function formatUptime(uptime) {
  if (uptime == null || !Number.isFinite(uptime)) return '—'
  return `${uptime.toFixed(2)}%`
}

// Compact relative time: "just now" / "3m ago" / "2h ago" / "1d ago".
export function formatRelTime(ts, now) {
  if (!Number.isFinite(ts)) return '' // guard a missing ts → '' (not "NaNd ago")
  const diff = Math.max(0, now - ts)
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

// Community-report line with correct pluralization ("1 community report" / "3 community reports").
export function reportCountLabel(count) {
  return `${count} community report${count === 1 ? '' : 's'} · last 24h`
}

// Fallback recommendation text: "OpenAI API (91) · Gemini API (—)". A withheld Score
// (null, #713) renders the name alone. Empty list → '' (caller omits the row).
export function fallbackText(fallback) {
  if (!Array.isArray(fallback) || fallback.length === 0) return ''
  return fallback.map((f) => (f.score != null ? `${f.name} (${f.score})` : f.name)).join(' · ')
}

// Show a fallback recommendation only when the surface is actually degraded/down —
// mirrors the dashboard's status-gated recommendation (no alternatives when all is well).
export function shouldShowFallback(status) {
  // #1233 — `unknown` must NOT show alternatives. This is the defect in the form users actually hit: on
  // 2026-08-14, with status.claude.com unreadable, the extension told people to switch off Claude to
  // ChatGPT / Grok / Junie / Codex — a recommendation to abandon a service AIWatch had just admitted it
  // could not read. Recommending a switch is a claim about the current service, and there is none here.
  return status != null && status !== 'operational' && status !== 'unknown'
}

// Per-surface "Is X Down?" page path. Each Anthropic surface has its own SEO page
// (verified against api/_is-down/slug-map.ts + vercel.json), so a card deep-links to
// the RIGHT one instead of everything pointing at the same page. Unknown id → null.
// #1164 — 'claude' moved from 'claude' to 'claude-api' when /is-claude-down was repurposed as the
// Anthropic-family group page. NOTE: an already-installed extension keeps its OLD copy of this map
// until the user updates — its Claude API card will deep-link to the (still valid, just repurposed)
// group page until then, not a broken link.
const IS_DOWN_SLUG = { claude: 'claude-api', claudeai: 'claude-ai', claudecode: 'claude-code' }
export function isDownPath(id) {
  const slug = IS_DOWN_SLUG[id]
  return slug ? `/is-${slug}-down` : null
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

// #1711 — "2026-09" → "September 2026"; anything else → '' (caller omits the section).
export function monthLabel(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(month || '')
  const name = m && MONTHS[Number(m[2]) - 1]
  return name ? `${name} ${m[1]}` : ''
}

// #1711 — one surface's row in the monthly summary, in the report's own units: "9 incidents · 11h 27m down".
export function monthlyRowText(row) {
  const parts = []
  if (Number.isFinite(row && row.incidents)) parts.push(`${row.incidents} incident${row.incidents === 1 ? '' : 's'}`)
  const min = row && row.downtimeMin
  if (Number.isFinite(min) && min > 0) {
    const h = Math.floor(min / 60)
    const m = Math.round(min % 60)
    parts.push(`${h === 0 ? `${m}m` : m === 0 ? `${h}h` : `${h}h ${m}m`} down`)
  }
  return parts.join(' · ')
}

// #1772 — the three surfaces share one status page, so one incident id can sit on several cards. An id
// on two or more cards is listed once in `shared` (with the names it affects, in card order); each card
// keeps only its own incidents in `ownBy` plus a `sharedCountBy` count. Ongoing, then `monitoring`, then
// the recently resolved ones.
const PHASE_RANK = { monitoring: 1, resolved: 2 }

export function popupIncidentsOf(svc) {
  return [...((svc && svc.incidents) || []), ...((svc && svc.recentlyResolved) || [])]
}

export function splitSharedIncidents(services) {
  const list = Array.isArray(services) ? services : []
  const seen = new Map()
  for (const svc of list) {
    for (const inc of popupIncidentsOf(svc)) {
      const entry = seen.get(inc.id)
      if (!entry) seen.set(inc.id, { incident: inc, affects: [svc.name], ids: [svc.id] })
      else if (!entry.ids.includes(svc.id)) {
        entry.affects.push(svc.name)
        entry.ids.push(svc.id)
        if (!entry.incident.aiSummary && inc.aiSummary) entry.incident = { ...entry.incident, aiSummary: inc.aiSummary }
        if (!entry.incident.ai && inc.ai) entry.incident = { ...entry.incident, ai: inc.ai }
      }
    }
  }
  const sharedIds = new Set([...seen.values()].filter((e) => e.ids.length > 1).map((e) => e.incident.id))
  const shared = [...seen.values()]
    .filter((e) => sharedIds.has(e.incident.id))
  shared.sort((a, b) => (PHASE_RANK[a.incident.status] || 0) - (PHASE_RANK[b.incident.status] || 0))
  const ownBy = {}
  const sharedCountBy = {}
  for (const svc of list) {
    const incs = popupIncidentsOf(svc)
    ownBy[svc.id] = incs.filter((i) => !sharedIds.has(i.id))
    sharedCountBy[svc.id] = new Set(incs.filter((i) => sharedIds.has(i.id)).map((i) => i.id)).size
  }
  return { shared, ownBy, sharedCountBy }
}

// #1772 — hand copy of worker/src/recovery-baseline-text.ts (the bundle cannot import it); pinned by
// recovery-baseline-sync.test.js.
function minText(min) {
  const h = Math.floor(min / 60)
  const m = Math.round(min % 60)
  return h === 0 ? `${m}m` : m === 0 ? `${h}h` : `${h}h ${m}m`
}

export function recoveryBaselineText(b) {
  return `Past incidents on this service: median ${minText(b.medianMin)}, 80% resolved within ${minText(b.p80Min)} (based on ${b.n} recorded incidents since ${b.since})`
}

// #1772 — the past-recovery lines under an incident: only beside an AI analysis (as on is-down and the
// dashboard), one per affected surface that has a baseline, named when there is more than one surface.
// With `shown`, a surface already given its line earlier in the popup is skipped (the dashboard modal
// shows each service's line once, on its first card), and the ones emitted are added to it.
export function baselineLines(incident, surfaces, shown) {
  if (!incident || !(incident.ai || incident.aiSummary)) return []
  const list = (surfaces || []).filter((s) => s && s.recoveryBaseline && !(shown && shown.has(s.id)))
  if (shown) for (const s of list) shown.add(s.id)
  const named = (surfaces || []).length > 1
  return list.map((s) => `📊 ${named ? `${s.name} — ` : ''}${recoveryBaselineText(s.recoveryBaseline)}`)
}

// #1772 — the modal's analysis lines: summary, recovery + scope (rendered by the worker), recovered, updated.
// A worker without `ai` sends only `aiSummary`.
export function analysisLines(incident, now) {
  if (!incident) return []
  const ai = incident.ai
  if (!ai) return incident.aiSummary ? [{ kind: 'summary', text: `🤖 ${incident.aiSummary}` }] : []
  const out = [{ kind: 'summary', text: `🤖 ${ai.summary}` }]
  for (const line of ai.lines || []) out.push({ kind: 'detail', text: line })
  const resolvedTs = Date.parse(incident.resolvedAt)
  if (Number.isFinite(resolvedTs)) out.push({ kind: 'detail', text: `✅ Recovered: ${formatRelTime(resolvedTs, now)}` })
  const analyzedTs = Date.parse(ai.analyzedAt)
  if (Number.isFinite(analyzedTs)) out.push({ kind: 'detail', text: `🕐 Analysis updated ${formatRelTime(analyzedTs, now)}${ai.model ? ` · ${ai.model}` : ''}` })
  return out
}

export const AI_DISCLAIMER = '⚠️ AI-generated estimation based on historical data. Actual recovery time may vary. This analysis is provided for informational purposes only.'

export function sharedNoteText(count) {
  return `${count} shared incident${count === 1 ? '' : 's'} ↑`
}
