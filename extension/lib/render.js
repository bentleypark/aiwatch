// Pure rendering/derivation logic for the AIWatch Claude extension (#837).
// NO chrome.* dependencies — imported by both the service worker (badge) and the
// popup (DOM), and unit-tested in isolation (lib/render.test.js). Keep it pure.

// Worst-of ordering for the toolbar badge: down beats degraded beats operational.
const STATUS_RANK = { operational: 0, degraded: 1, down: 2 }

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
  return status != null && status !== 'operational'
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
