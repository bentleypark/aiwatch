// SSR HTML template for "Is X Down?" pages

import type { ServiceSEO } from './seo-content'
import { SERVICE_ID_TO_SLUG, SLUG_TO_SERVICE, RELATED_SLUGS, outboundReferralUrl } from './slug-map'
import { groupIncidents, type GroupingIncident, type GroupRow, type SingleRow } from './incident-grouping'
import { compareGroupedRows } from './incident-sort'
// #482 — is-down uses HASH-based CSP (not nonce): it stays edge-cached (s-maxage=60), and the
// handler hashes the rendered inline scripts per-response (a content hash survives caching, unlike a
// random nonce). So the no-nonce static script forms are used here; the inline handlers are still
// refactored to delegated listeners (CSP can't admit inline on*= via hashes cleanly).
import { CONSENT_INIT_COMMENT, consentInitScript } from '../_shared/consent-init'
import { cookieBannerHtml } from '../_shared/cookie-banner'
import type { RegionStatusResult } from './region-status'

/** Format recovery display — shared with worker/src/ai-analysis.ts */
function formatRecoveryDisplay(recovery: string): string {
  if (recovery === 'No historical data for estimation') return 'Monitoring recovery signals...'
  if (recovery === 'N/A') return 'Exceeded typical pattern'
  return recovery
}

export interface ServiceData {
  id: string
  name: string
  provider: string
  category: string
  status: string
  latency: number | null
  uptime30d: number | null
  uptimeSource?: string
  lastChecked: string
  incidents: Array<{
    id: string
    title: string
    status: string
    impact: string | null
    startedAt: string
    duration: string | null
  }>
  aiwatchScore: number | null
  scoreGrade: string | null
  scoreConfidence?: string
  rank?: number
  rankTied?: boolean
  totalRanked?: number
  incidentSourceStale?: boolean
  /** #722 — BetterStack sub-threshold affected-resource count (degraded+downtime). When the
   *  service reads operational but this is >0, the provider page shows "Some services are down";
   *  surfaced as a yellow "partial" note. SEO answer stays "operational" — the service IS up overall. */
  partialCount?: number
  /** #604/#606 — per-component snapshot. Curated subset or dynamic displayAllComponents set
   *  preserved by the worker; `group` (e.g. 'Models') marks components that collapse together. */
  components?: Array<{ id: string; name: string; status: 'operational' | 'degraded' | 'down'; group?: string }>
}

interface Fallback {
  id: string
  name: string
  score: number | null
  status: string
}

function esc(s: string | null | undefined): string {
  if (s == null) return ''
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function safeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c')
}

// (#482 removed escJsForAttr — the inline `onclick="...gtag(...JSON.stringify...)"` handlers it
//  guarded are gone; GA4 now fires from a delegated [data-ga] listener reading data-* attributes,
//  so there's no more JS-string-literal-inside-an-HTML-attribute to entity-escape.)

function statusEmoji(status: string): string {
  if (status === 'operational') return '&#x1F7E2;'
  if (status === 'partial') return '&#x1F7E1;'   // #722/#744 — yellow (visible header only)
  if (status === 'degraded') return '&#x1F7E1;'
  return '&#x1F534;'
}

function statusLabel(status: string): string {
  if (status === 'operational') return 'Operational'
  if (status === 'degraded') return 'Degraded Performance'
  return 'Down'
}

// #566 — SERP CTR. Answer the "Is X Down?" query directly in the <title>, <meta
// description>, and the on-page status line so Google's snippet (the meta OR an
// auto-generated one from page content) leads with the answer, like SaaSHub's "NO".
// Plain language only — "degraded" is dev jargon a panic visitor won't parse.
// Caveat: a SERP snippet reflects Google's last crawl, so during a fresh outage a
// stale "Operational" can show; accepted because services are operational ~99% of the
// time and the "updated every 5 minutes" freshness hint frames it as a live tracker.
function statusTitleLabel(status: string): string {
  if (status === 'operational') return 'Operational'
  if (status === 'degraded') return 'Having Issues'
  return 'Down Right Now'
}

// Direct answer word + sentence fragment. yesno answers "Is it down?"; phrase completes
// "${displayName} ${phrase}".
function statusAnswer(status: string): { yesno: string; phrase: string } {
  if (status === 'operational') return { yesno: 'No', phrase: 'is operational' }
  if (status === 'degraded') return { yesno: 'Issues', phrase: 'is having problems right now' }
  return { yesno: 'Yes', phrase: 'is down right now' }
}

// #572: the is-down header links the monthly reports. Was hardcoded to /reports/2026-03/
// "March 2026 Report" (stale). Reports publish on a LAGGING, variable cadence — as of
// 2026-06-04 the latest live report is April (May not generated yet) — so a date-derived
// "previous month" link 404s. Determining the latest *existing* report reliably would need a
// per-render network probe of the reports site (bad for fast SSR) or a worker-cached
// latest-month, both overkill for a header link. Instead link the /reports/ index, which is
// always live and lists reports newest-first → the reader lands on the latest published one.
const REPORTS_INDEX_HREF = '/reports/'

// #575 — crowd-report collect endpoint (worker). Hardcoded like the OG image URL above; a one-line
// swap to http://localhost:8788/api/report-issue is the only change needed for local verification.
const REPORT_ENDPOINT = 'https://aiwatch-worker.p2c2kbf.workers.dev/api/report-issue'

// Category labels for the gated report display. KEEP IN SYNC with worker/src/report.ts
// REPORT_CATEGORY_LABELS (the worker validates the ids; this only labels them for display).
const REPORT_CATEGORY_LABELS: Record<string, string> = {
  outage: 'Outage',
  degraded: 'Degraded performance',
  errors: 'Errors',
  login: 'Login / Auth',
  other: 'Other',
}
const REPORTS_INDEX_LABEL = 'Monthly Reports'

function statusColor(status: string): string {
  if (status === 'operational') return '#3fb950'
  if (status === 'partial') return '#d29922'   // #722/#744 — yellow (visible header only)
  if (status === 'degraded') return '#e86235'
  return '#f85149'
}

function timeAgo(iso: string): string {
  const time = new Date(iso).getTime()
  if (Number.isNaN(time)) return 'unknown'
  const diff = Date.now() - time
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'Unknown date'
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`
}

// #539→og-fix — maps the social share `?e=` hint to an OG card status the generator renders
// (operational/degraded/down). 'reddit'/unknown/absent → fall through to live status (see renderPage).
const HINT_TO_OG_STATUS: Record<string, string> = { down: 'down', degraded: 'degraded', active: 'operational', resolved: 'operational' }

function formatElapsed(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0 || Number.isNaN(ms)) return ''
  const min = Math.floor(ms / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h ${min % 60}m ago`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h ago`
}

export function renderPage(
  slug: string,
  service: ServiceData | null,
  seo: ServiceSEO,
  fallbacks: Fallback[],
  aiInsight?: { summary: string; estimatedRecovery: string; affectedScope: string[]; analyzedAt: string; needsFallback?: boolean; resolvedAt?: string; estimatedRecoveryHours?: number; startedAt?: string } | null,
  // Region recommendation (refs #422 Phase 2). When the affected service has
  // region-specific incidents AND at least one healthy region, surface an
  // actionable "Try region: X" line right under the AI Insight block. Null
  // when the service has no region map, no relevant incident, or every region
  // is hit (allDown — no useful recommendation).
  regionRec?: RegionStatusResult | null,
  // #575 — recent crowd "Report an issue" entries for the GATED display. The caller (api/is-down.ts)
  // only populates this when an independent signal already shows a problem, so a non-empty list here
  // is already corroborated; an operational page passes [] and the section renders nothing.
  reports?: Array<{ cat: string; desc: string; ts: number }>,
  // OG status hint (the `?e=` share param, #539→og-fix). When a tweet/social link carries a status
  // hint (an outage/recovery share built by buildTweetDrafts), PIN the OG card's status to it so the
  // unfurled card matches the post's moment — instead of the live status, which can have already
  // drifted (the incident resolved/flapped) by the time the platform fetches the card. The page body
  // still shows live status; only the social card is pinned. Absent / `reddit` → live status.
  ogStatusHint?: string | null,
  // #574 — supply-chain note for THIS service (set by api/is-down.ts when it's in the banner's
  // affectedNow/mayBeAffected). `confirmed` = currently degraded (vs estimated AWS-dependent). null otherwise.
  supplyChainNote?: { regions: string; confirmed: boolean } | null,
  // #804 — per-incident token (the share link's `&i=`). Included in og:url ONLY (alongside the `?e=`
  // hint) so a NEW outage is a distinct social-card identity from the prior `?e=down` share — platforms
  // cache/dedupe the card by og:url (not the fetched URL) for ~7d, so without it a fresh outage reused
  // the stale card. canonical / <title> / JSON-LD stay clean (SEO indexes those, not og:url). The caller
  // (api/is-down.ts) has already sanitized it to id-safe chars.
  ogIncidentToken?: string | null,
): string {
  // #566: lead the SERP title with the live status answer (falls back to "Live Status"
  // when status data is unavailable) so the result answers the query before the click.
  const title = service
    ? `Is ${seo.displayName} Down? ${statusTitleLabel(service.status)} | AIWatch`
    : `Is ${seo.displayName} Down? Live Status | AIWatch`
  const desc = buildMetaDescription(seo, service, aiInsight ?? null)
  const canonical = `https://ai-watch.dev/is-${slug}-down`

  // Dynamic OG image URL — cache busted per 10-min window.
  // Pin the card status to the share hint when present (so a tweet's card matches the post moment,
  // not the live status that may have drifted by unfurl time). HINT_TO_OG_STATUS (module scope) maps
  // the `?e=` hint → an og status the generator knows; 'reddit'/unknown/absent falls through to live.
  const pinnedHint = ogStatusHint && HINT_TO_OG_STATUS[ogStatusHint] ? ogStatusHint : null
  const ogStatus = (pinnedHint && HINT_TO_OG_STATUS[pinnedHint]) || service?.status || 'operational'
  const ogParams = new URLSearchParams({ service: seo.displayName, status: ogStatus })
  if (service?.aiwatchScore != null && Number.isFinite(service.aiwatchScore)) ogParams.set('score', String(service.aiwatchScore))
  if (typeof service?.uptime30d === 'number' && !Number.isNaN(service.uptime30d)) ogParams.set('uptime', service.uptime30d.toFixed(2))
  ogParams.set('v', String(Math.floor(Date.now() / 600_000))) // 10-min cache bust
  const ogImageUrl = `https://aiwatch-worker.p2c2kbf.workers.dev/api/og?${ogParams.toString()}`

  // og:url carries the `?e=` hint AND the #804 per-incident token so each share MOMENT/OUTAGE is a
  // distinct social-card identity. Social platforms (Twitter/FB/LinkedIn) cache + dedupe cards by
  // og:url, NOT by the URL actually fetched — so with a query-less og:url every `?e=down`/`?e=resolved`
  // share collapses onto the same cached card (#740: an outage tweet showed the stale operational
  // card), and even with `?e=down` pinned, a NEW outage reused the PRIOR outage's cached card because
  // the og:url was byte-identical across outages (#804: the `&i=<incId>` token fixes that). canonical
  // stays clean (`.../is-…-down`) for SEO — Google indexes that, not og:url.
  const ogQuery = new URLSearchParams()
  if (pinnedHint) ogQuery.set('e', pinnedHint)
  if (ogIncidentToken) ogQuery.set('i', ogIncidentToken)
  const ogUrl = [...ogQuery.keys()].length ? `${canonical}?${ogQuery.toString()}` : canonical
  // og:title / twitter:title pin to the hint too (via ogStatus) so the card headline matches the
  // pinned IMAGE — otherwise the card reads "Operational" (live) over a "Degraded" image. The page
  // <title>/canonical/JSON-LD stay LIVE (the body shows live status); only the social card is pinned.
  const ogTitle = service
    ? `Is ${seo.displayName} Down? ${statusTitleLabel(ogStatus)} | AIWatch`
    : title

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(canonical)}">
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="alternate" type="application/rss+xml" title="${esc(seo.displayName)} incidents — AIWatch" href="https://ai-watch.dev/feed/${esc(slug)}">

<!-- Open Graph -->
<meta property="og:type" content="website">
<meta property="og:url" content="${esc(ogUrl)}">
<meta property="og:title" content="${esc(ogTitle)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(ogImageUrl)}">
<meta property="og:site_name" content="AIWatch">

<!-- Twitter -->
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(ogTitle)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(ogImageUrl)}">

<meta name="theme-color" content="#080c10">

${CONSENT_INIT_COMMENT}
${consentInitScript()}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">

${renderJsonLd(slug, seo, service)}
${renderFaqJsonLd(seo, fallbacks)}

<style>
:root{color-scheme:dark}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'IBM Plex Sans',sans-serif;background:#080c10;color:#e6edf3;line-height:1.6}
.mono{font-family:'IBM Plex Mono',monospace}
a{color:#58a6ff;text-decoration:none}
a:hover{text-decoration:underline}
.container{max-width:720px;margin:0 auto;padding:24px 16px}
.header{text-align:center;padding:40px 0 32px}
.status-dot{display:inline-block;width:14px;height:14px;border-radius:50%;margin-right:8px;vertical-align:middle}
h1{font-size:28px;font-weight:600;margin-bottom:8px}
h2{font-size:18px;font-weight:600;margin:32px 0 16px;color:#e6edf3}
.meta{font-size:13px;color:#8b949e;margin:8px 0}
.card{background:#0d1117;border:1px solid rgba(255,255,255,0.07);border-radius:8px;padding:16px;margin:12px 0}
.score-badge{display:inline-block;padding:3px 10px;border-radius:4px;font-size:12px;font-weight:500}
.incident-item{padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.07)}
.incident-item:last-child{border-bottom:none}
.incident-title{font-size:14px;font-weight:500}
.incident-meta{font-size:12px;color:#8b949e;margin-top:4px}
.impact-major{color:#f85149}.impact-minor{color:#e86235}
.incident-group{padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.07)}
.incident-group:last-child{border-bottom:none}
.incident-group>summary{list-style:none;cursor:pointer;display:flex;justify-content:space-between;align-items:baseline;gap:12px}
.incident-group>summary::-webkit-details-marker{display:none}
.incident-group>summary::before{content:"▸";display:inline-block;color:#8b949e;margin-right:6px;transition:transform 0.15s}
.incident-group[open]>summary::before{transform:rotate(90deg)}
.incident-group-title{font-size:14px;font-weight:500;flex:1;min-width:0}
.incident-group-meta{font-size:12px;color:#8b949e;white-space:nowrap}
.incident-group-entries{margin:6px 0 0 20px;padding-left:10px;border-left:1px solid rgba(255,255,255,0.08)}
.incident-group-entries .incident-item{padding:6px 0}
/* #756 — component group (e.g. "Models · 11 components"): native <details> marker hidden, replaced
   by a larger (13px) custom chevron rendered next to the count text (NOT floated to the far right —
   margin-left:auto was dropped per UX feedback so the toggle reads as part of the label). */
.comp-group>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:8px;padding:4px 0}
.comp-group>summary::-webkit-details-marker{display:none}
.comp-group-chev{font-size:13px;line-height:1;color:#c9d1d9}
.comp-group-chev::after{content:"▾";display:inline-block;transition:transform 0.15s}
.comp-group:not([open]) .comp-group-chev::after{transform:rotate(-90deg)}
.ih-toggle{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
.ih-rest{display:none}
.ih-toggle:checked~.ih-rest{display:block}
.ih-more-label{display:inline-block;cursor:pointer;font-size:12px;color:#8b949e;padding:10px 0 2px;user-select:none}
.ih-more-label:hover{color:#c9d1d9}
.ih-more-label::before{content:"▾";display:inline-block;color:#8b949e;margin-right:6px;transition:transform 0.15s}
.ih-toggle:checked~.ih-more-label::before{transform:rotate(180deg)}
.ih-more-close{display:none}
.ih-toggle:checked~.ih-more-label .ih-more-open{display:none}
.ih-toggle:checked~.ih-more-label .ih-more-close{display:inline}
.ih-toggle:focus-visible~.ih-more-label{outline:2px solid #58a6ff;outline-offset:2px}
.faq-item{margin:16px 0}
.faq-q{font-weight:600;font-size:15px;margin-bottom:6px}
.faq-a{font-size:14px;color:#8b949e}
.fallback-item{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 14px;background:#161b22;border-radius:6px;margin:8px 0}
.fallback-name{font-weight:500;font-size:14px}
.fallback-score{font-size:12px;color:#8b949e}
.fallback-right{display:flex;align-items:center;gap:12px;flex-shrink:0}
.fallback-try{display:inline-block;padding:5px 11px;border:1px solid #2ea043;color:#3fb950;border-radius:6px;font-size:12px;font-weight:600;text-decoration:none;white-space:nowrap}
.fallback-try:hover{background:#2ea043;color:#fff}
.fallback-disclosure{font-size:11px;color:#8b949e;opacity:0.85;margin:10px 2px 0}
.footer{text-align:center;padding:32px 0;font-size:13px;color:#484f58;border-top:1px solid rgba(255,255,255,0.07);margin-top:40px}
.btn{display:inline-block;padding:8px 20px;background:#161b22;border:1px solid rgba(255,255,255,0.14);border-radius:6px;color:#e6edf3;font-size:13px;font-weight:500;transition:background 0.2s}
.btn:hover{background:#1c2230;text-decoration:none}
.btn-primary{background:#1a3d22;border-color:#3fb950;color:#3fb950}
.btn-primary:hover{background:#224a2a}
button.btn{cursor:pointer;font-family:inherit;line-height:inherit}
.cta{background:#0d1117;border:1px solid rgba(255,255,255,0.07);border-radius:8px;padding:16px 20px;text-align:center;margin:16px 0}
.cta-title{font-size:14px;font-weight:600;margin-bottom:10px}
.cta-buttons{display:flex;gap:8px;justify-content:center;flex-wrap:wrap}
.cta-help{font-size:11.5px;margin-top:8px;color:#8b949e;line-height:1.5}
.cta-alt{font-size:12px;margin-top:10px;color:#8b949e}
.cta-alt a{color:#8b949e;text-decoration:underline}
/* #575/#744 — floating "Report an issue" entry (mirrors the dashboard Overview FAB): always visible,
   decoupled from the alert CTA. Bottom-right, clears the share bar / mobile footer by scroll. */
.report-fab{position:fixed;bottom:20px;right:20px;z-index:40;display:inline-flex;align-items:center;gap:6px;padding:10px 16px;border-radius:999px;font-size:13px;font-weight:500;font-family:inherit;background:#161b22;color:#e6edf3;border:1px solid rgba(255,255,255,0.18);box-shadow:0 4px 12px rgba(0,0,0,0.4);cursor:pointer}
.report-fab:hover{filter:brightness(1.15)}
.report-fab:disabled{cursor:default;color:#3fb950;border-color:#3fb950}
.report-modal{position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;padding:16px;z-index:50}
.report-modal[hidden]{display:none}
.report-modal-card{background:#161b22;border:1px solid rgba(255,255,255,0.12);border-radius:10px;padding:24px;width:100%;max-width:460px;text-align:left}
.report-modal-card h2{font-size:20px;margin:0 0 16px}
.report-label{display:block;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#8b949e;margin:0 0 6px;font-weight:600}
.report-label-row{display:flex;justify-content:space-between;align-items:baseline;margin-top:14px}
.report-count{font-size:12px;color:#8b949e}
.report-input{width:100%;box-sizing:border-box;background:#0d1117;border:1px solid rgba(255,255,255,0.14);border-radius:6px;color:#e6edf3;font-size:14px;font-family:inherit;padding:10px 12px}
select.report-input{appearance:none;-webkit-appearance:none;padding-right:38px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M2 4l4 4 4-4' stroke='%238b949e' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 14px center}
textarea.report-input{min-height:72px;resize:vertical}
.report-actions{display:flex;gap:10px;margin-top:18px}
.report-actions .btn{flex:1}
.report-msg{margin:12px 0 0;font-size:13px;color:#3fb950}
.report-feed-note{font-size:12px;color:#8b949e;margin:0 0 10px;line-height:1.5}
.report-feed-desc{color:#c9d1d9}
.rep-toggle{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
.rep-rest{display:none}
.rep-toggle:checked~.rep-rest{display:block}
.rep-more-label{display:inline-block;cursor:pointer;font-size:12px;color:#8b949e;padding:10px 0 2px;user-select:none}
.rep-more-label:hover{color:#c9d1d9}
.rep-more-label::before{content:"▾";display:inline-block;color:#8b949e;margin-right:6px;transition:transform 0.15s}
.rep-toggle:checked~.rep-more-label::before{transform:rotate(180deg)}
.rep-more-close{display:none}
.rep-toggle:checked~.rep-more-label .rep-more-open{display:none}
.rep-toggle:checked~.rep-more-label .rep-more-close{display:inline}
.rep-toggle:focus-visible~.rep-more-label{outline:2px solid #58a6ff;outline-offset:2px}
.cta-alt a:hover{color:#c9d1d9}
.links{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.links a{font-size:13px;padding:6px 12px;background:#161b22;border:1px solid rgba(255,255,255,0.07);border-radius:4px;color:#8b949e}
.links a:hover{color:#e6edf3;text-decoration:none}
.share-bar{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin:24px 0}
.share-btn{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:6px;font-size:13px;font-weight:500;border:1px solid rgba(255,255,255,0.1);cursor:pointer;transition:opacity 0.2s}
.share-btn:hover{opacity:0.85;text-decoration:none}
.share-x{background:#000;color:#fff;border-color:#333}
.share-threads{background:#000;color:#fff;border-color:#333}
.share-kakao{background:#FEE500;color:#191919;border-color:#FEE500}
.share-copy{background:#161b22;color:#e6edf3;border-color:rgba(255,255,255,0.14)}
.share-copy.copied{background:#1a3d22;border-color:#3fb950;color:#3fb950}
@media(max-width:600px){h1{font-size:22px}.container{padding:16px 12px}.incident-group>summary{flex-direction:column;align-items:flex-start;gap:2px}.incident-group-title{flex:none}.incident-group-meta{white-space:normal}}
</style>
</head>
<body>
<div class="container">

${renderStatusHeader(service, seo)}
${renderCTA(seo, service?.status ?? 'operational', slug, service?.id ?? slug)}
${renderAIInsight(aiInsight, service?.status, fallbacks)}
${supplyChainNote ? `<p class="meta" style="color:#d29922">&#x26A0;&#xFE0F; AWS infrastructure issue (${esc(supplyChainNote.regions)}) &mdash; ${supplyChainNote.confirmed ? `${esc(seo.displayName)} is degraded and attributes it to an AWS/upstream issue` : `${esc(seo.displayName)} runs on AWS and may be affected`}</p>` : ''}
${renderRegionRecommendation(regionRec ?? null, slug)}
${renderComponents(service)}
${renderIncidents(service)}
${renderReportFeed(reports, seo)}
${renderDescription(seo, service)}
${renderFAQ(seo, fallbacks)}
${renderFallbacks(seo, fallbacks, service?.id)}
${renderShareButtons(seo, service, canonical, ogImageUrl, aiInsight)}
${renderBadgeEmbed(slug, seo)}
${renderFooter(slug)}

</div>
${renderDelegatedListeners()}
${cookieBannerHtml()}
</body>
</html>`
}

// #482 — one always-rendered, CSP-safe delegated-listener block replacing every inline on*= handler.
// GA4 link clicks fire from data-ga (+ data-ga-loc / -source / -svc / -region / -from / -to /
// -method / -item); the copy/share buttons fire from data-action, calling the global functions
// defined in the renderCTA / renderShareButtons inline scripts (looked up at click time, so script
// order doesn't matter). This <script> is hashed into the page CSP by the api/is-down.ts handler.
function renderDelegatedListeners(): string {
  return `<script>
document.addEventListener('click', function (e) {
  var g = e.target.closest('[data-ga]');
  if (g && typeof gtag === 'function') {
    var d = g.dataset, p = {};
    if (d.gaLoc) p.location = d.gaLoc;
    if (d.gaSource) p.source = d.gaSource;
    if (d.gaSvc) p.service_id = d.gaSvc;
    if (d.gaRegion) p.recommended_region = d.gaRegion;
    if (d.gaFrom) p.from_service = d.gaFrom;
    if (d.gaTo) p.to_service = d.gaTo;
    if (d.gaMethod) { p.method = d.gaMethod; p.content_type = 'is_x_down'; }
    if (d.gaItem) p.item_id = d.gaItem;
    gtag('event', d.ga, p);
  }
  var a = e.target.closest('[data-action]');
  if (!a) return;
  switch (a.getAttribute('data-action')) {
    case 'copy-rss': if (typeof copyRss === 'function') copyRss(a); break;
    case 'copy-slack': if (typeof copySlackFeed === 'function') copySlackFeed(a); break;
    case 'copy-link': if (typeof copyLink === 'function') copyLink(a); break;
    case 'copy-badge': if (typeof copyBadge === 'function') copyBadge(a); break;
    case 'share-kakao': if (typeof shareKakao === 'function') shareKakao(); break;
    case 'select': a.select(); break;
  }
});
</script>`
}

function renderJsonLd(slug: string, seo: ServiceSEO, service: ServiceData | null): string {
  const data: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    'name': `Is ${seo.displayName} Down?`,
    'url': `https://ai-watch.dev/is-${slug}-down`,
    'description': seo.description,
    'isPartOf': { '@type': 'WebApplication', 'name': 'AIWatch', 'url': 'https://ai-watch.dev' },
  }
  if (service) {
    data['dateModified'] = service.lastChecked
  }
  return `<script type="application/ld+json">${safeJsonLd(data)}</script>`
}

// Linkify the curated status/dashboard URLs in an FAQ answer for the ON-PAGE render only (the JSON-LD
// FAQ answer must stay plain text per schema.org). Targeted prefixes — ai-watch.dev / aistudio.google.com
// / status.<provider>.<tld> / <provider>status.com (groqstatus.com, replicatestatus.com) — so bare BRAND
// mentions in the prose (e.g. "claude.ai", "character.ai") are NOT turned into links. esc()s the non-URL
// segments; the matched URLs are our own curated content. `(?<!\/\/)` skips a domain already preceded by
// a scheme so we never emit a stray "https://" before the anchor (current FAQ answers use bare domains).
const FAQ_URL_RE = /(?<!\/\/)(ai-watch\.dev|aistudio\.google\.com|status\.[a-z0-9.-]+\.[a-z]{2,}|[a-z0-9-]+status\.com)(\/[#\w/-]*)?/gi
export function linkifyFaqAnswer(text: string): string {
  let out = ''
  let last = 0
  for (const m of text.matchAll(FAQ_URL_RE)) {
    const url = m[0]
    const start = m.index ?? 0
    out += esc(text.slice(last, start))
    out += `<a href="https://${url}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`
    last = start + url.length
  }
  out += esc(text.slice(last))
  return out
}

function enhanceFaqAnswer(faq: { q: string; a: string }, fallbacks: Fallback[]): string {
  if (fallbacks.length > 0 && /what should i do|alternative|instead/i.test(faq.q)) {
    const fbList = fallbacks.map(fb => `${fb.name}${fb.score != null ? ` (Score: ${fb.score})` : ''}`).join(' and ')
    return `Based on current AIWatch data, ${fbList} ${fallbacks.length === 1 ? 'is' : 'are'} the most reliable alternative${fallbacks.length === 1 ? '' : 's'} right now. ${faq.a}`
  }
  return faq.a
}

function renderFaqJsonLd(seo: ServiceSEO, fallbacks: Fallback[]): string {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    'mainEntity': seo.faqs.map(f => ({
      '@type': 'Question',
      'name': f.q,
      'acceptedAnswer': { '@type': 'Answer', 'text': enhanceFaqAnswer(f, fallbacks) },
    })),
  }
  return `<script type="application/ld+json">${safeJsonLd(data)}</script>`
}

// #827 F4 — English mirror of worker/src/incident-history.ts `predictedVsActualText` (+ `accuracyOf`
// bands + `formatDurationMin`). Parity matters: the dashboard, Discord, RSS and this SEO card must
// classify the same resolved incident identically ("within/over/faster than ~Xh est.").
function fmtMinEn(min: number): string {
  if (!Number.isFinite(min) || min <= 0) return '0m'
  const h = Math.floor(min / 60), m = Math.round(min % 60)
  return h === 0 ? `${m}m` : m === 0 ? `${h}h` : `${h}h ${m}m`
}
function predictedVsActualEn(predictedHours: number, actualMin: number): string | null {
  if (!(predictedHours > 0) || !(actualMin >= 0)) return null
  const pred = fmtMinEn(Math.round(predictedHours * 60))
  const actualH = actualMin / 60
  const within = actualH > predictedHours ? `over ~${pred} est.`
    : actualH < predictedHours * 0.5 ? `faster than ~${pred} est.`
    : `within ~${pred} est.`
  return `${fmtMinEn(actualMin)} (${within})`
}

function renderAIInsight(insight?: { summary: string; estimatedRecovery: string; affectedScope: string[]; analyzedAt: string; needsFallback?: boolean; resolvedAt?: string; estimatedRecoveryHours?: number; startedAt?: string } | null, serviceStatus?: string, fallbacks?: Fallback[]): string {
  if (!insight) return ''
  const ago = Math.floor((Date.now() - new Date(insight.analyzedAt).getTime()) / 60000)
  const agoText = ago < 1 ? 'just now' : ago < 60 ? `${ago}m ago` : `${Math.floor(ago / 60)}h ago`
  const recovery = formatRecoveryDisplay(insight.estimatedRecovery)
  const isResolved = serviceStatus === 'operational'
  const isRecentlyRecovered = isResolved && !!insight.resolvedAt
  // #827 F4 — once resolved, replace the bare estimate with "predicted vs actual" (actual = startedAt→
  // resolvedAt). Null until resolved or when the numeric estimate / startedAt isn't available.
  const outcome = isResolved && insight.estimatedRecoveryHours != null && insight.startedAt && insight.resolvedAt
    ? predictedVsActualEn(insight.estimatedRecoveryHours, Math.round((new Date(insight.resolvedAt).getTime() - new Date(insight.startedAt).getTime()) / 60000))
    : null
  const resolvedBadge = isResolved
    ? '<span class="mono" style="font-size:10px;color:#3fb950;background:rgba(63,185,80,0.15);padding:2px 8px;border-radius:4px">Resolved</span>'
    : ''
  // #641 — only render the Alternatives block when we actually have a recommendation; we don't
  // assert "No operational alternatives" (a subjective claim from our own incomplete coverage).
  const fallbackHtml = insight.needsFallback && !isResolved && fallbacks && fallbacks.length > 0
    ? `<div style="margin-top:8px;padding:8px 10px;background:#0d1117;border-radius:6px;border-left:3px solid #d29922">
<span class="mono" style="font-size:11px;color:#c9d1d9;font-weight:600">🔄 Alternatives</span>
${fallbacks.map(f => `<div class="mono" style="font-size:11px;color:#c9d1d9;margin-top:3px">• ${esc(f.name)}${f.score != null ? ` (Score: ${f.score})` : ''}</div>`).join('')}
</div>`
    : ''
  return `<div class="card" style="border-left:3px solid ${isResolved ? '#3fb950' : '#7C3AED'};margin:16px 0${isResolved && !isRecentlyRecovered ? ';opacity:0.75' : ''}">
<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
<span style="font-size:16px">🤖</span>
<span style="font-size:13px;font-weight:600;color:#e6edf3">${isResolved ? 'Post-Incident Analysis' : 'AI Analysis'}</span>
<span class="mono" style="font-size:10px;color:#7C3AED;background:rgba(124,58,237,0.15);padding:2px 8px;border-radius:4px">Beta</span>
${resolvedBadge}
</div>
<p style="font-size:13px;color:#c9d1d9;line-height:1.6;margin-bottom:8px">${esc(insight.summary)}</p>
<div class="mono" style="font-size:11px;color:#8b949e;display:flex;flex-direction:column;gap:4px">
${outcome
  ? `<span>🎯 <strong style="color:#c9d1d9">Predicted vs actual:</strong> ${esc(outcome)}</span>`
  : `<span>⏱ <strong style="color:#c9d1d9">Est. Recovery:</strong> ${esc(recovery)}</span>`}
${insight.affectedScope.length > 0 ? `<span>📡 <strong style="color:#c9d1d9">Scope:</strong> ${esc(insight.affectedScope.join(' · '))}</span>` : ''}
${insight.resolvedAt ? `<span>✅ Recovered: ${(() => { const m = Math.floor((Date.now() - new Date(insight.resolvedAt).getTime()) / 60000); return m < 1 ? 'just now' : m < 60 ? m + 'm ago' : Math.floor(m / 60) + 'h ago' })()}</span>` : ''}
<span>🕐 ${agoText}</span>
</div>
${fallbackHtml}
<p class="mono" style="font-size:9px;color:#484f58;margin-top:8px;opacity:0.7">⚠️ AI-generated estimation based on historical data. Actual time may vary.</p>
</div>`
}

// ── Region recommendation (refs #422 Phase 2) ─────────────────────────
//
// When the SSR page is rendered during a partial regional outage (e.g.
// Pinecone AWS us-east-1 down but other 5 regions healthy), surface a single
// "Try region: <label>" line BEFORE the cross-service fallback recommendation.
// Region-switch is structurally cheaper than service-switch (same SDK / IAM /
// billing — only the endpoint URL changes), so it deserves first-line
// visibility. Returns '' when there's nothing actionable to show.
//
// Exported (alongside other render helpers) so api/is-down/__tests__/html-template.test.ts
// can pin both the happy-path HTML structure and the three skip conditions.
export function renderRegionRecommendation(rec: RegionStatusResult | null, slug: string): string {
  if (!rec) return ''
  // Three skip conditions, same as ActionBanner (#422 Phase 1):
  //   - hasRegionSpecific=false → global incident hit every region; recommending
  //     a region would be misleading
  //   - allDown → no healthy region to switch to
  //   - !recommendedRegion → defensive, same as allDown in practice
  if (!rec.hasRegionSpecific || rec.allDown || !rec.recommendedRegion) return ''

  const affected = rec.incidentRegions.map((r) => esc(r.label)).join(', ')
  const recLabel = esc(rec.recommendedRegion.label)
  const docsHref = rec.docsUrl ? esc(rec.docsUrl) : ''

  // Inline styles match the AI Insight callout's visual language: bg #161b22,
  // 3px left border in the accent color (blue here, matching the region-card
  // theme on /#service detail pages). The GA4 `region_switch_intent` hook
  // (location=is_down_page) fires from the delegated [data-ga] listener (#482) —
  // the region key rides on data-ga-region (no JS-string-in-attribute escaping needed).
  return `
<div style="font-size:14px;margin:16px 0;padding:14px 16px;background:#161b22;border-left:3px solid #58a6ff;border-radius:0 6px 6px 0">
<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
<span style="font-size:16px">📍</span>
<strong style="color:#c9d1d9">Try region: ${recLabel}</strong>
</div>
<div style="font-size:12px;color:#8b949e;line-height:1.5">
<span>Currently affected: ${affected}.</span>
${docsHref ? `<br><a href="${docsHref}" target="_blank" rel="noopener noreferrer" data-ga="region_switch_intent" data-ga-svc="${esc(slug)}" data-ga-region="${esc(rec.recommendedRegion.key)}" data-ga-loc="is_down_page" style="color:#58a6ff">Region docs →</a>` : ''}
</div>
</div>`
}

function renderStatusHeader(service: ServiceData | null, seo: ServiceSEO): string {
  if (!service) {
    return `<div class="header">
<h1>Is ${esc(seo.displayName)} Down?</h1>
<p class="meta">Status data is temporarily unavailable. Please check back shortly.</p>
<p class="meta" style="margin-top:12px"><a href="https://ai-watch.dev" class="btn" data-ga="click_dashboard" data-ga-loc="is_down_page" data-ga-source="fallback">View AIWatch Dashboard</a></p>
</div>`
  }

  // #722 — provider reports a sub-threshold partial issue (some components down) while the service
  // reads operational. The VISIBLE header (dot + answer line) reflects this as a yellow "Partial"
  // state (#744 — it used to read flat green "operational", contradicting the partial badge/note),
  // but the SEO `<title>` + meta description stay on the raw status ("Is X down? → No, operational")
  // since the service IS up overall — only specific components are affected (no SERP-snippet flip).
  const partialCount = typeof service.partialCount === 'number' ? service.partialCount : 0
  const isPartial = service.status === 'operational' && partialCount > 0
  const displayStatus = isPartial ? 'partial' : service.status // VISIBLE header only — never the title/meta
  const color = statusColor(displayStatus)
  const compStr = `${partialCount} component${partialCount > 1 ? 's' : ''}`
  const answer = isPartial
    ? { yesno: 'Partial', phrase: `has ${compStr} affected (operational overall)` }
    : statusAnswer(service.status) // #566 — on-page direct answer (feeds Google's auto-snippet)
  const hasUptime = typeof service.uptime30d === 'number' && !Number.isNaN(service.uptime30d)
  const gradeStr = service.scoreGrade ? ` (${service.scoreGrade.charAt(0).toUpperCase() + service.scoreGrade.slice(1)})` : ''
  // #591 — a stale-source service carries a frozen uptime30d + an inflated score; omit both here
  // (the ⚠️ note below explains why). Status/last-checked stay — they're probe-measured + current.
  const stale = !!service.incidentSourceStale
  const metaParts = [`Last checked: ${esc(timeAgo(service.lastChecked))}`]
  if (hasUptime && !stale) metaParts.push(`Uptime: ${service.uptime30d!.toFixed(2)}%`)
  if (service.aiwatchScore != null && !stale) metaParts.push(`AIWatch Score: ${service.aiwatchScore}${esc(gradeStr)}`)
  const incidents = Array.isArray(service.incidents) ? service.incidents : []
  const lastIncident = incidents.length > 0 ? incidents[0] : null

  return `<div class="header">
<h1>${statusEmoji(displayStatus)} Is ${esc(seo.displayName)} Down?</h1>
<p style="font-size:20px;font-weight:600;color:${color};margin:12px 0">${answer.yesno} &mdash; ${esc(seo.displayName)} ${answer.phrase}</p>
<p class="meta mono">${metaParts.join(' &middot; ')}</p>
${lastIncident ? `<p class="meta">Last incident: ${esc(formatDate(lastIncident.startedAt))} &mdash; ${esc(lastIncident.title)}${lastIncident.duration ? ` (${esc(lastIncident.duration)})` : ' (ongoing)'}</p>` : '<p class="meta">No recent incidents</p>'}
${service.rank ? `<p class="meta">${esc(seo.displayName)} is ranked <strong>#${service.rank}${service.rankTied ? ' (tied)' : ''}</strong> of ${service.totalRanked} AI services by <a href="https://ai-watch.dev/#ranking" data-ga="click_ranking" data-ga-loc="is_down_page" data-ga-source="header">AIWatch reliability score</a> &middot; <a href="${REPORTS_INDEX_HREF}" data-ga="click_reports" data-ga-loc="is_down_page" data-ga-source="header">${REPORTS_INDEX_LABEL} &rarr;</a></p>` : ''}
${service.incidentSourceStale ? `<p class="meta" style="color:var(--amber)">⚠️ ${esc(seo.displayName)}'s status page moved to a source AIWatch can't reach, so its incident feed is frozen — uptime, score, and ranking are omitted until the source is reachable again. Live status above is still measured directly.</p>` : ''}
</div>`
}

type Comp = { id?: string; name: string; status: string; group?: string }

function componentRow(c: Comp): string {
  const color = statusColor(c.status)
  const label = statusLabel(c.status)
  // #606 — operational rows show the dot only (no repeated "Operational" text); the label
  // appears for degraded/down where it matters. Status kept on `title` for hover/a11y.
  const labelHtml = c.status !== 'operational'
    ? `<span class="mono" style="font-size:11px;color:${color};margin-left:auto">${esc(label)}</span>`
    : ''
  return `<div style="display:flex;align-items:center;gap:8px;padding:4px 0" title="${esc(c.name)} — ${esc(label)}">
<span style="width:7px;height:7px;border-radius:50%;background:${color};flex-shrink:0"></span>
<span class="mono" style="font-size:13px;color:#c9d1d9">${esc(c.name)}</span>${labelHtml}
</div>`
}

function worstComponentStatus(members: Comp[]): string {
  if (members.some((c) => c.status === 'down')) return 'down'
  if (members.some((c) => c.status === 'degraded')) return 'degraded'
  return 'operational'
}

// #606 — a grouped, collapsible section ("Models · 18 components"). Native <details> so the
// toggle is the header itself (no JS); the disclosure marker gives the expand/collapse affordance.
function componentGroup(name: string, members: Comp[]): string {
  const worst = worstComponentStatus(members)
  const wcolor = statusColor(worst)
  const statusBadge = worst !== 'operational'
    ? `<span class="mono" style="font-size:11px;color:${wcolor};margin-left:6px">${esc(statusLabel(worst))}</span>`
    : ''
  return `<details class="comp-group" style="margin-top:8px">
<summary>
<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${wcolor};flex-shrink:0"></span>
<span class="mono" style="font-size:13px;color:#c9d1d9">${esc(name)}</span>
<span class="mono" style="font-size:11px;color:#8b949e">${members.length} components</span>${statusBadge}
<span class="comp-group-chev" aria-hidden="true"></span>
</summary>
<div style="margin-top:6px;margin-left:14px;padding-left:12px;border-left:2px solid #30363d">${members.map(componentRow).join('')}</div>
</details>`
}

// #604/#606 — per-component breakdown. Reads service.components (curated subset or the dynamic
// displayAllComponents set). Ungrouped "surface" components render as individual rows; grouped
// components (group:'Models') collapse under a <details> header — the official Endpoints/Models split.
export function renderComponents(service: ServiceData | null): string {
  const components = service?.components as Comp[] | undefined
  if (!components || components.length === 0) return ''
  const surfaces = components.filter((c) => !c.group)
  const groupNames = [...new Set(components.filter((c) => c.group).map((c) => c.group!))]
  const anyIssue = components.some((c) => c.status !== 'operational')
  const border = anyIssue ? '#e86235' : '#3fb950'

  return `<div class="card" style="border-left:3px solid ${border}">
<div class="mono" style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#8b949e;margin-bottom:10px">Component Status</div>
${surfaces.map(componentRow).join('')}
${groupNames.map((g) => componentGroup(g, components.filter((c) => c.group === g))).join('')}
</div>`
}

/** Relative "Xm ago" / "Xh ago" for a report timestamp (SSR render time). */
function reportRelTime(ts: number, now: number): string {
  const m = Math.max(0, Math.round((now - ts) / 60_000))
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  return `${Math.round(m / 60)}h ago`
}

/**
 * #575 — GATED crowd-report display. `reports` is non-empty ONLY when the caller (api/is-down.ts)
 * confirmed an independent signal already shows a problem, so this list can't contradict an
 * operational page. Returns '' (renders nothing) otherwise. Descriptions are HTML-escaped (the
 * worker also sanitizes on store — defense-in-depth against UGC injection).
 */
const REPORT_FEED_PREVIEW = 5

function renderReportFeed(reports: Array<{ cat: string; desc: string; ts: number }> | undefined, _seo: ServiceSEO): string {
  const list = Array.isArray(reports) ? reports : []
  if (list.length === 0) return ''
  const now = Date.now()
  const row = (r: { cat: string; desc: string; ts: number }) => {
    const label = REPORT_CATEGORY_LABELS[r.cat] ?? 'Other'
    const desc = r.desc ? ` &mdash; <span class="report-feed-desc">${esc(r.desc)}</span>` : ''
    return `<div class="incident-item"><div class="incident-title">${esc(label)}${desc}</div><div class="incident-meta mono">${esc(reportRelTime(r.ts, now))}</div></div>`
  }
  const capped = list.slice(0, 20)
  // First 5 shown; the rest collapse behind a bottom-anchored CSS-only toggle (same UX as the
  // incident-history collapse). A `rep-` prefix keeps the ids/classes distinct from that list's.
  const preview = capped.slice(0, REPORT_FEED_PREVIEW).map(row).join('\n')
  const rest = capped.slice(REPORT_FEED_PREVIEW)
  const more = rest.length > 0
    ? `<input type="checkbox" id="rep-more" class="rep-toggle" aria-label="Show ${rest.length} more reports">
<div class="rep-rest">${rest.map(row).join('\n')}</div>
<label for="rep-more" class="rep-more-label mono"><span class="rep-more-open">Show ${rest.length} more</span><span class="rep-more-close">Show less</span></label>`
    : ''
  return `<h2>Recent user reports <span class="mono" style="font-size:12px;color:#8b949e;font-weight:400;margin-left:8px">&middot; Last 24h &middot; community-submitted</span></h2>
<div class="card"><p class="report-feed-note">Visitor-submitted and shown only because an independent signal also indicates a problem &mdash; not an official AIWatch verdict.</p><div id="report-feed-list">${preview}${more}</div></div>`
}

function renderCTA(seo: ServiceSEO, status: string, slug: string, svcId: string): string {
  const isDown = status === 'down' || status === 'degraded'
  // Positioned directly below the status header (#297) so the alert-subscription
  // prompt catches the visitor at peak intent — before they bounce after reading
  // the status. GA4 source='status_banner' distinguishes this placement from the
  // footer CTA for the 2-week conversion comparison.
  // #546: during an outage the visitor is here at peak intent for one reason \u2014
  // confirm it's down + be told when it's back. Lead with that exact need (status-
  // accurate: "down" vs "having issues" for degraded), label the button to match.
  const stateLead = status === 'down'
    ? `${seo.displayName} is down right now.`
    : `${seo.displayName} is having issues right now.`
  const message = isDown
    ? `${stateLead} Stop refreshing — we'll ping you when it's back.`
    : `Get notified the next time ${seo.displayName} goes down.`
  // #547/#696: the outage-day funnel leaked — 9 is-down sessions on the 6/11 Claude outage → 0
  // copy_rss / 0 click_cta_alerts. "Notify me via RSS" reads as power-user jargon (it copies a feed
  // URL the panic visitor can't use without an RSS reader). So #696 reframes around the lowest-friction
  // ACTION for this audience: Slack /feed (zero-config — paste a command into any channel) is the
  // PRIMARY button, the RSS link is secondary (explicitly "paste into Slack/Teams/any reader"), and
  // the heavy Discord per-user push (double opt-in) stays a de-emphasized text link. A one-line helper
  // makes each action's destination explicit. Success proxies: copy_slack_feed (primary) + copy_rss
  // (secondary), compared vs the 3→0 baseline on the next larger-n outage.
  // data-rss/data-slack use the page slug (feed URL is /feed/{slug}); data-svc uses the service ID
  // so the events key on the same id as fallback_click / click_service_detail (id and slug diverge
  // for claude-code, github-copilot, etc.).
  return `<div class="cta">
<p class="cta-title">${esc(message)}</p>
<div class="cta-buttons">
<!-- Slack subscribes via its native /feed RSS app (#467) — paste into any channel, zero webhook setup. -->
<button type="button" class="btn btn-primary" data-slack="/feed subscribe https://ai-watch.dev/feed/${esc(slug)}" data-svc="${esc(svcId)}" data-action="copy-slack">💬 Get alerts in Slack</button>
<button type="button" class="btn" data-rss="https://ai-watch.dev/feed/${esc(slug)}" data-svc="${esc(svcId)}" data-action="copy-rss">🔗 Copy alert link (RSS)</button>
</div>
<p class="cta-help">💬 Slack: paste the command into any channel — done. &middot; 🔗 RSS: paste the link into Slack, Teams, or any reader.</p>
<p class="cta-alt"><a href="https://ai-watch.dev/#settings?focus=alerts" data-ga="click_cta_alerts" data-ga-loc="is_down_page" data-ga-source="status_banner_secondary">Prefer Discord push alerts? Set up here &rarr;</a></p>
<!-- #575: 1st-party crowd report (category + short description). We COLLECT it; the recent-report
     list is shown ONLY on a gated surface (when an independent signal already shows a problem) — we
     never render a public "N reporting" verdict that could contradict an operational status. -->
<button type="button" class="report-fab" id="report-open" aria-label="Report an issue with ${esc(seo.displayName)}"><span aria-hidden="true">⚠️</span> Report an issue</button>
</div>
<div id="report-modal" class="report-modal" hidden>
<div class="report-modal-card" role="dialog" aria-modal="true" aria-labelledby="report-modal-title">
<h2 id="report-modal-title">Report an Issue</h2>
<label class="report-label" for="report-cat">Category</label>
<select id="report-cat" class="report-input">
<option value="outage">Outage</option>
<option value="degraded">Degraded performance</option>
<option value="errors">Errors</option>
<option value="login">Login / Auth</option>
<option value="other">Other</option>
</select>
<div class="report-label-row"><label class="report-label" for="report-desc">Description</label><span class="report-count"><span id="report-desc-n">0</span> / 80</span></div>
<textarea id="report-desc" class="report-input" maxlength="80" placeholder="Brief description, e.g. API 500 errors in EU"></textarea>
<div class="report-actions">
<button type="button" class="btn btn-primary" id="report-submit" data-svc="${esc(svcId)}">Submit</button>
<button type="button" class="btn" id="report-cancel">Cancel</button>
</div>
<p id="report-msg" class="report-msg" hidden></p>
</div>
</div>
<script>
function copyRss(b){
  var u=b.dataset.rss, orig=b.textContent;
  function done(){b.textContent='Copied! Paste into your RSS reader';setTimeout(function(){b.textContent=orig},2200);typeof gtag==='function'&&gtag('event','copy_rss',{location:'is_down_page',service_id:b.dataset.svc})}
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(u).then(done).catch(function(){prompt('Copy RSS URL:',u)})}
  else{prompt('Copy RSS URL:',u)}
}
function copySlackFeed(b){
  var c=b.dataset.slack, orig=b.textContent;
  function done(){b.textContent='Copied! Paste into any Slack channel';setTimeout(function(){b.textContent=orig},2200);typeof gtag==='function'&&gtag('event','copy_slack_feed',{location:'is_down_page',service_id:b.dataset.svc})}
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(c).then(done).catch(function(){prompt('Copy Slack command:',c)})}
  else{prompt('Copy Slack command:',c)}
}
// #575 crowd-report modal (no framework — plain DOM). The honest feedback NEVER shows a count; the
// localStorage guard mirrors the server's per-IP/day dedup. NOTE this adds an inline <script> like
// the existing copyRss/copySlackFeed ones — fine under today's report-only CSP, but it's part of the
// Phase-3 inline-handler refactor debt tracked in docs/reference/reference-csp.md.
(function(){
  var modal=document.getElementById('report-modal'), openBtn=document.getElementById('report-open');
  if(!modal||!openBtn) return;
  var submit=document.getElementById('report-submit'), cancel=document.getElementById('report-cancel');
  var cat=document.getElementById('report-cat'), desc=document.getElementById('report-desc');
  var descN=document.getElementById('report-desc-n'), msg=document.getElementById('report-msg');
  var svc=submit.dataset.svc, k='aiwatch-reported-'+svc;
  function reported(){try{return !!localStorage.getItem(k)}catch(e){return false}}
  function markDone(){openBtn.textContent='✓ Already reported — thanks';openBtn.disabled=true;}
  function close(){modal.hidden=true;}
  // Optimistic, XSS-safe prepend of the just-submitted report to the gated feed (only when the
  // feed is already on the page — i.e. an independent signal corroborated, so the gate holds).
  var REP_LABELS={outage:'Outage',degraded:'Degraded performance',errors:'Errors',login:'Login / Auth',other:'Other'};
  function prependReport(catId,descText){
    var listEl=document.getElementById('report-feed-list'); if(!listEl) return;
    var item=document.createElement('div'); item.className='incident-item';
    var t=document.createElement('div'); t.className='incident-title';
    var lab=document.createElement('span'); lab.textContent=REP_LABELS[catId]||'Other'; t.appendChild(lab);
    if(descText){var d=document.createElement('span'); d.className='report-feed-desc'; d.textContent=' — '+descText; t.appendChild(d);}
    var m=document.createElement('div'); m.className='incident-meta mono'; m.textContent='just now';
    item.appendChild(t); item.appendChild(m); listEl.insertBefore(item,listEl.firstChild);
  }
  openBtn.addEventListener('click',function(){if(reported()){markDone();return}modal.hidden=false;cat.focus();typeof gtag==='function'&&gtag('event','report_open',{location:'is_down_page',service_id:svc});});
  cancel.addEventListener('click',close);
  modal.addEventListener('click',function(e){if(e.target===modal)close();});
  document.addEventListener('keydown',function(e){if(e.key==='Escape'&&!modal.hidden)close();});
  desc.addEventListener('input',function(){descN.textContent=String(desc.value.length);});
  submit.addEventListener('click',function(){
    submit.disabled=true;
    fetch(${JSON.stringify(REPORT_ENDPOINT)},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({svcId:svc,category:cat.value,description:desc.value})})
      .then(function(r){return r.ok?r.json().catch(function(){return{}}):Promise.reject()})
      .then(function(){try{localStorage.setItem(k,'1')}catch(e){}prependReport(cat.value,desc.value.trim());msg.hidden=false;msg.textContent='✓ Thanks — we factor this into our monitoring';typeof gtag==='function'&&gtag('event','report_issue',{location:'is_down_page',service_id:svc,category:cat.value});markDone();setTimeout(close,1400);})
      .catch(function(){msg.hidden=false;msg.textContent='Could not send — please try again later';submit.disabled=false;});
  });
  if(reported())markDone();
})();
</script>`
}

// Upper bound on rendered rows (after grouping) — defense against pathological
// API responses. Real data (live /api/status on 2026-04-23) shows ≤35 rows pre-group
// for the busiest service (claudeai), and grouping further compresses high-churn feeds.
const INCIDENT_ROW_CAP = 20

// Rows shown before the "Show N more" collapse (#incident-history-collapse). Mirrors the
// dashboard ServiceDetails INCIDENT_HISTORY_PREVIEW so both surfaces preview the same count.
const INCIDENT_PREVIEW_ROWS = 5

function renderIncidentSingle(inc: GroupingIncident): string {
  const impactCls = inc.impact === 'major' || inc.impact === 'critical' ? 'impact-major' : inc.impact === 'minor' ? 'impact-minor' : ''
  const statusColor = inc.status === 'resolved' ? '#3fb950' : inc.status === 'monitoring' ? '#58a6ff' : '#e86235'
  const statusText = inc.status === 'resolved' ? 'Resolved' : inc.status === 'monitoring' ? 'Monitoring' : 'Investigating'
  const durationOrElapsed = inc.duration
    ? ` &middot; ${esc(inc.duration)}`
    : inc.status !== 'resolved' ? ` &middot; ${formatElapsed(inc.startedAt)}` : ''
  const impactMeta = impactCls ? ` &middot; <span class="${impactCls}">${esc(inc.impact ?? '')}</span>` : ''
  return `<div class="incident-item">
<div class="incident-title">${esc(inc.title)}</div>
<div class="incident-meta mono">${esc(formatDate(inc.startedAt))} &middot; <span style="color:${statusColor}">${statusText}</span>${durationOrElapsed}${impactMeta}</div>
</div>`
}

function renderIncidentGroup(g: GroupRow): string {
  // <details open> so crawlers always read the full entries. CSS in renderPage
  // styles the expanded/collapsed state; noscript users retain full access.
  const summary = `${esc(g.normalizedTitle)} <span class="mono" style="color:#8b949e">&middot; ${g.count}×</span>`
  const headMeta = g.uniformStatus
    ? `${esc(formatDate(g.rangeEnd))}`
    : `${esc(formatDate(g.rangeStart))} &rarr; ${esc(formatDate(g.rangeEnd))}`
  const entries = g.entries.map(renderIncidentSingle).join('\n')
  return `<details open class="incident-group">
<summary><span class="incident-group-title">${summary}</span><span class="incident-group-meta mono">${headMeta}</span></summary>
<div class="incident-group-entries">${entries}</div>
</details>`
}

/**
 * SERP-facing meta description — the copy Google displays below the page title.
 * Numbers lift CTR so uptime% and 30-day incident count are inlined when available.
 * Extracted from renderPage for unit-testability.
 */
export function buildMetaDescription(
  seo: ServiceSEO,
  service: ServiceData | null,
  aiInsight: { summary: string; estimatedRecovery: string } | null,
): string {
  if (aiInsight && service && service.status !== 'operational') {
    const a = statusAnswer(service.status)
    return `${a.yesno} — ${seo.displayName} ${a.phrase}. AI Analysis: ${aiInsight.summary.slice(0, 120)} Est. recovery: ${formatRecoveryDisplay(aiInsight.estimatedRecovery)}.`
  }
  if (!service) {
    return `Check if ${seo.displayName} is down right now. Real-time status monitoring by AIWatch.`
  }
  const thirtyDayIncidentCount = Array.isArray(service.incidents)
    ? service.incidents.filter((i) => new Date(i.startedAt).getTime() >= Date.now() - 30 * 86_400_000).length
    : 0
  // #591 — don't surface a stale-source service's frozen uptime in the SERP snippet.
  const uptimeStr = typeof service.uptime30d === 'number' && !Number.isNaN(service.uptime30d) && !service.incidentSourceStale
    ? `${service.uptime30d.toFixed(2)}%`
    : null
  const uptimeClause = uptimeStr ? ` Uptime: ${uptimeStr}.` : ''
  const incidentClause = thirtyDayIncidentCount > 0 ? ` ${thirtyDayIncidentCount} incidents tracked (30d).` : ''
  // #566: answer-first ("No — X is operational" / "Yes — X is down right now") so the
  // SERP snippet leads with the answer; freshness hint stays to frame it as a live tracker.
  const a = statusAnswer(service.status)
  return `${a.yesno} — ${seo.displayName} ${a.phrase}.${uptimeClause}${incidentClause} Live status, updated every 5 minutes.`
}

export function renderIncidents(service: ServiceData | null): string {
  const incidents = Array.isArray(service?.incidents) ? service.incidents : []
  // #591 — a stale-source service must still render the section (to say "unavailable"), even if its
  // frozen incident array is empty; only a non-stale service with no incidents renders nothing.
  if (!service || (incidents.length === 0 && !service.incidentSourceStale)) return ''

  // 7-day window to match the dashboard ServiceDetails "Incident History" (both surfaces
  // share the same recency horizon; #incident-history-collapse).
  const cutoff = Date.now() - 7 * 86_400_000
  const recent = incidents.filter((inc) => new Date(inc.startedAt).getTime() >= cutoff) as GroupingIncident[]
  const heading = `<h2>Recent Incidents <span class="mono" style="font-size:12px;color:#8b949e;font-weight:400;margin-left:8px">&middot; Last 7 days</span></h2>`

  // #591 — the incident feed is frozen, so we can't fetch recent incidents. A "No incidents" message
  // here would be a false all-clear; say the history is unavailable instead.
  if (service.incidentSourceStale) {
    return `${heading}
<div class="card"><p style="color:#8b949e;font-size:13px;padding:8px 0">Incident history unavailable &mdash; ${esc(service.name)}'s status source moved to a platform AIWatch can't currently reach, so recent incidents can't be retrieved.</p></div>`
  }

  if (recent.length === 0) {
    return `${heading}
<div class="card"><p style="color:#8b949e;font-size:13px;padding:8px 0">No incidents in the last 7 days</p></div>`
  }

  // Re-sort groupIncidents() output so ongoing/monitoring rows survive the
  // INCIDENT_ROW_CAP slice — see compareGroupedRows. Sort must run before
  // .slice() or a resolved-heavy window can truncate an active row.
  const rows = groupIncidents(recent, { timeZone: 'UTC' })
    .slice()
    .sort(compareGroupedRows)
    .slice(0, INCIDENT_ROW_CAP)
  const renderRow = (row: GroupRow | SingleRow): string =>
    row.kind === 'group' ? renderIncidentGroup(row) : renderIncidentSingle((row as SingleRow).incident)
  // Show the first INCIDENT_PREVIEW_ROWS rows; collapse the rest behind a CSS-only toggle that
  // stays anchored at the BOTTOM of the list (the overflow rows reveal ABOVE the toggle, matching
  // the dashboard ServiceDetails "show more" button). A checkbox-hack (no JS, CSP-clean) is used
  // instead of <details> because a <details> summary is pinned above its content, which left the
  // toggle awkwardly mid-list when expanded. Collapsed rows stay in the HTML so crawlers read them.
  const preview = rows.slice(0, INCIDENT_PREVIEW_ROWS).map(renderRow).join('\n')
  const rest = rows.slice(INCIDENT_PREVIEW_ROWS)
  // The fixed id="ih-more" assumes ONE incident list per page (renderIncidents is called once,
  // see the single call site) — revisit if a future page renders two service incident lists.
  const moreSection = rest.length > 0
    ? `<input type="checkbox" id="ih-more" class="ih-toggle" aria-label="Show ${rest.length} more incidents">
<div class="ih-rest">${rest.map(renderRow).join('\n')}</div>
<label for="ih-more" class="ih-more-label mono"><span class="ih-more-open">Show ${rest.length} more</span><span class="ih-more-close">Show less</span></label>`
    : ''
  return `${heading}
<div class="card">${preview}${moreSection}</div>`
}

function buildDataSummary(service: ServiceData | null, displayName: string): string {
  if (!service) return ''
  const incidents = Array.isArray(service.incidents) ? service.incidents : []
  const cutoff = Date.now() - 30 * 86_400_000
  const recent = incidents.filter((i) => new Date(i.startedAt).getTime() >= cutoff)
  const count = recent.length
  // #591 — don't surface a stale-source service's frozen uptime in the narrative either (mirrors the
  // same gate in buildMetaDescription; exposed by #654's "30-day uptime" → "Uptime" wording unification).
  const uptime = typeof service.uptime30d === 'number' && !Number.isNaN(service.uptime30d) && !service.incidentSourceStale
    ? `${service.uptime30d.toFixed(2)}%` : null

  if (count === 0) {
    // #654 — lead with uptime as its OWN sentence so the "last 30 days" frame (which scopes only the
    // incident count) doesn't make the source-window-varying uptime read as a 30-day figure.
    return uptime
      ? `${displayName}'s reported uptime is ${uptime}. Based on AIWatch data from the last 30 days, it has maintained a clean record with zero incidents.`
      : `Based on AIWatch data from the last 30 days, ${displayName} has maintained a clean record with zero incidents.`
  }

  // MTTR: only resolved incidents with parseable duration
  const resolved = recent.filter((i) => i.status === 'resolved' && i.duration)
  let mttrText = ''
  if (resolved.length > 0) {
    const totalMins = resolved.reduce((sum, i) => {
      const h = i.duration!.match(/(\d+)h/)
      const m = i.duration!.match(/(\d+)m/)
      return sum + (h ? parseInt(h[1]) * 60 : 0) + (m ? parseInt(m[1]) : 0)
    }, 0)
    const avg = Math.round(totalMins / resolved.length)
    if (avg > 0) {
      const mttrStr = avg >= 60 ? `${Math.floor(avg / 60)}h ${avg % 60}m` : `${avg} minutes`
      mttrText = ` with an average recovery time of ${mttrStr}`
    }
  }

  // #654 — uptime leads as its own sentence (see the count===0 branch); "last 30 days" scopes only
  // the incident count + MTTR, not the source-window-varying uptime.
  return uptime
    ? `${displayName}'s reported uptime is ${uptime}. Based on AIWatch data from the last 30 days, it experienced ${count} incident${count > 1 ? 's' : ''}${mttrText}.`
    : `Based on AIWatch data from the last 30 days, ${displayName} experienced ${count} incident${count > 1 ? 's' : ''}${mttrText}.`
}

function renderDescription(seo: ServiceSEO, service: ServiceData | null): string {
  const summary = buildDataSummary(service, seo.displayName)
  return `<h2>About ${esc(seo.displayName)}</h2>
<div class="card">
${summary ? `<p style="font-size:14px;margin-bottom:12px;padding:10px 14px;background:#161b22;border-left:3px solid #3fb950;border-radius:0 4px 4px 0"><strong>AIWatch Data:</strong> ${esc(summary)}</p>` : ''}
<p style="font-size:14px;margin-bottom:12px">${esc(seo.description)}</p>
${seo.insight ? `<p style="font-size:14px;margin-bottom:12px;padding:10px 14px;background:#161b22;border-left:3px solid #58a6ff;border-radius:0 4px 4px 0"><strong>AIWatch Insight:</strong> ${esc(seo.insight)}</p>` : ''}
<p style="font-size:14px;color:#8b949e">${esc(seo.whenDown)}</p>
<p style="font-size:13px;color:#484f58;margin-top:12px">This page provides real-time status, uptime history, and recent incident details &mdash; updated every 5 minutes by <a href="https://ai-watch.dev">AIWatch</a>.</p>
</div>`
}

function renderFAQ(seo: ServiceSEO, fallbacks: Fallback[]): string {
  if (seo.faqs.length === 0) return ''
  const items = seo.faqs.map(f => {
    const answer = enhanceFaqAnswer(f, fallbacks)
    return `<div class="faq-item">
<p class="faq-q">${esc(f.q)}</p>
<p class="faq-a">${linkifyFaqAnswer(answer)}</p>
</div>`
  }).join('\n')

  return `<h2>Frequently Asked Questions</h2>
<div class="card">${items}</div>`
}

function renderFallbacks(seo: ServiceSEO, fallbacks: Fallback[], fromId?: string): string {
  if (fallbacks.length === 0) return ''
  let anyOutbound = false
  const items = fallbacks.map(f => {
    const scoreText = f.score != null ? `Score: ${f.score}` : ''
    const color = statusColor(f.status)
    const label = statusLabel(f.status)
    const fbSlug = SERVICE_ID_TO_SLUG[f.id]
    const gaClick = fromId ? ` data-ga="fallback_click" data-ga-from="${esc(fromId)}" data-ga-to="${esc(f.id)}" data-ga-loc="is_down_page"` : ''
    const nameHtml = fbSlug ? `<a href="/is-${esc(fbSlug)}-down" style="color:#e6edf3"${gaClick}>${esc(f.name)}</a>` : esc(f.name)
    // #842 — prominent, disclosed OUTBOUND "Open" button so a panic visitor can act on the
    // (unpaid, Score-ranked) recommendation. `rel="nofollow"` = the accurate signal for an UNPAID
    // editorial link (matches the "not paid" disclosure); `sponsored` is deliberately NOT used — it's
    // Google's paid-placement marker and would contradict the disclosure. Add `sponsored` only if/when
    // a service becomes an actual paid sponsor. GA via the delegated [data-ga] listener (CSP-clean).
    const outUrl = outboundReferralUrl(f.id)
    if (outUrl) anyOutbound = true
    const tryBtn = outUrl
      ? `<a class="fallback-try" href="${esc(outUrl)}" target="_blank" rel="nofollow noopener noreferrer" data-ga="outbound_fallback_click" data-ga-from="${esc(fromId ?? '')}" data-ga-to="${esc(f.id)}" data-ga-loc="is_down_page" aria-label="Open ${esc(f.name)} (opens provider site)">Open &#8599;</a>`
      : ''
    return `<div class="fallback-item">
<span class="fallback-name">${nameHtml}</span>
<span class="fallback-right"><span class="fallback-score mono">${scoreText} &nbsp; <span style="color:${color}">${statusEmoji(f.status)} ${label}</span></span>${tryBtn}</span>
</div>`
  }).join('\n')

  return `<h2>Alternatives When ${esc(seo.displayName)} is Down</h2>
<div class="card">
${items}
${anyOutbound ? `<p class="mono fallback-disclosure">Open &#8599; goes to the provider site &middot; ranked by AIWatch Score, not paid.</p>` : ''}
<div class="links" style="margin-top:12px">
<a href="https://ai-watch.dev/#ranking" data-ga="click_ranking" data-ga-loc="is_down_page" data-ga-source="alternatives">Reliability rankings &rarr;</a>
<a href="/reports/" data-ga="click_reports" data-ga-loc="is_down_page" data-ga-source="alternatives">Monthly reports &rarr;</a>
</div>
</div>`
}

export function renderShareButtons(seo: ServiceSEO, service: ServiceData | null, canonical: string, ogImageUrl: string, aiInsight?: { summary: string; estimatedRecovery: string; affectedScope: string[] } | null): string {
  const status = service ? statusLabel(service.status) : 'Operational'
  const rawStatus = service?.status ?? 'operational'

  // Status-based share templates — randomly selected per render for variety
  // Include AI analysis when available
  const aiSuffix = aiInsight ? `\nAI Analysis: ${aiInsight.summary.slice(0, 100)}. Est. recovery: ${formatRecoveryDisplay(aiInsight.estimatedRecovery)}.` : ''
  const n = seo.displayName
  const downTexts = [
    `Is ${n} down? Current status: Down.`,
    `${n} is currently experiencing a major outage.`,
    `Heads up — ${n} appears to be down right now.`,
    `${n} outage detected. Check real-time status:`,
    `Wait, is ${n} down for everyone or just me?`,
    `Confirmed: ${n} is having issues. Reports from multiple users.`,
  ]
  const degradedTexts = [
    `Something feels off with ${n}...`,
    `${n} seems to be having issues right now.`,
    `Anyone else noticing ${n} is slow?`,
    `Seeing some lag on ${n}. Not a total outage, but definitely degraded.`,
  ]
  const operationalTexts = [
    `${n} is running fine for now. All green on AIWatch.`,
    `All clear — ${n} is fully operational right now via AIWatch.`,
    `${n} status: operational. No issues detected — tracked on AIWatch.`,
  ]
  const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]
  // Brand the down/degraded copy text too — the operational templates carry "AIWatch" inline but the
  // outage ones didn't, so a share posted DURING an incident (the highest-share moment) dropped the
  // attribution. A consistent branding tail keeps it on every status (and makes the branding e2e
  // deterministic instead of incident-state-dependent).
  const copyText = rawStatus === 'down'
    ? `${pick(downTexts)}${aiSuffix}\nTracked live on AIWatch:\n${canonical}`
    : rawStatus === 'degraded'
    ? `${pick(degradedTexts)}${aiSuffix}\nTracked live on AIWatch:\n${canonical}`
    : pick(operationalTexts)

  // X hashtag from display name (e.g. "Claude" → "#Claude", "GitHub Copilot" → "#GitHubCopilot")
  const tag = `#${n.replace(/[\s.]/g, '')}Down`
  const xDownTexts = [
    `Is ${n} down? \uD83D\uDEA8`,
    `\uD83D\uDEA8 ${n} major outage detected`,
    `Heads up — ${n} is down right now \uD83D\uDEA8`,
    `${n} outage in progress \u26A0\uFE0F`,
    `Is ${n} down for everyone or just me? \uD83D\uDEA8`,
  ]
  const xDegradedTexts = [
    `Something feels off with ${n}... \uD83D\uDC40`,
    `${n} seems slow right now \u26A0\uFE0F`,
    `Anyone else having issues with ${n}? \uD83D\uDC40`,
    `${n} is acting up again... \uD83D\uDC40`,
  ]
  const xOperationalTexts = [
    `${n} is running fine for now. All green on AIWatch. \u2705`,
    `All clear — ${n} is fully operational \u2705 via AIWatch`,
    `${n} status: all systems go \u2705 — tracked on AIWatch`,
  ]
  const xBase = rawStatus === 'down'
    ? pick(xDownTexts)
    : rawStatus === 'degraded'
    ? pick(xDegradedTexts)
    : pick(xOperationalTexts)
  const aiSnippet = aiSuffix ? ' AI: ' + aiInsight!.summary.slice(0, 60) : ''
  const xTag = rawStatus !== 'operational' ? ` ${tag} #AIWatch` : ''
  const xText = rawStatus === 'down'
    ? `${xBase}${aiSnippet}${xTag}`
    : rawStatus === 'degraded'
    ? `${xBase}${aiSnippet}${xTag}`
    : xBase
  const encodedText = encodeURIComponent(xText)
  const encodedUrl = rawStatus !== 'operational' ? encodeURIComponent(canonical) : ''
  const xUrlParam = encodedUrl ? `&amp;url=${encodedUrl}` : ''

  // Use JSON.stringify for safe JS string interpolation (prevents XSS via backslash/newline).
  // These are used inside `<script>` bodies (script content is CDATA-like, the inner `"` is correct).
  // #482: the share GA4 item_id moved to data-ga-item (read by the delegated [data-ga] listener), so
  // the attribute-safe `escJsForAttr` form is no longer needed.
  const jsDisplayName = JSON.stringify(seo.displayName)
  const jsCanonical = JSON.stringify(canonical)
  const jsOgImageUrl = JSON.stringify(ogImageUrl)
  const jsStatus = JSON.stringify(status)

  return `<div class="share-bar">
<a href="https://x.com/intent/tweet?text=${encodedText}${xUrlParam}" target="_blank" rel="noopener" class="share-btn share-x" data-ga="share" data-ga-method="x" data-ga-item="${esc(seo.displayName)}">
<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
Post
</a>
<a href="https://www.threads.net/intent/post?text=${encodedText}${encodedUrl ? '%20' + encodedUrl : ''}" target="_blank" rel="noopener" class="share-btn share-threads" data-ga="share" data-ga-method="threads" data-ga-item="${esc(seo.displayName)}">
<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12.186 24h-.007c-3.581-.024-6.334-1.205-8.184-3.509C2.35 18.44 1.5 15.586 1.472 12.01v-.017c.03-3.579.879-6.43 2.525-8.482C5.845 1.205 8.6.024 12.18 0h.014c2.746.02 5.043.725 6.826 2.098 1.677 1.29 2.858 3.13 3.509 5.467l-2.04.569c-1.104-3.96-3.898-5.984-8.304-6.015-2.91.022-5.11.936-6.54 2.717C4.307 6.504 3.616 8.914 3.59 12c.025 3.083.718 5.496 2.057 7.164 1.432 1.783 3.631 2.698 6.54 2.717 2.623-.02 4.358-.631 5.8-2.045 1.647-1.613 1.618-3.593 1.09-4.798-.346-.789-.96-1.42-1.757-1.846-.184 2.985-1.086 5.27-2.844 6.39-1.34.853-3.065 1.062-4.62.559-1.72-.557-3.09-1.843-3.37-3.583-.203-1.264.066-2.418.757-3.248.86-1.032 2.278-1.578 3.952-1.578 2.37 0 3.877 1.128 4.453 2.325.153-.915.177-1.937.073-3.065l2.023-.235c.203 2.153.015 4.027-.735 5.483a5.997 5.997 0 0 0 1.013.607c1.27.605 2.567.665 3.557-.12 1.258-1 1.554-2.79 1.168-4.34-.478-1.922-1.806-3.598-3.853-4.85C17.257 5.282 14.907 4.725 12.2 4.708h-.015c-3.34.024-5.886 1.348-7.357 3.832C3.622 10.52 3.088 12.947 3.088 12c0-.96.533-3.504 1.74-5.488 1.41-2.319 3.756-3.568 6.857-3.655h.02c2.467.02 4.57.527 6.25 1.508 1.735 1.012 3.032 2.488 3.558 4.282.65 2.214.23 4.685-1.496 6.055-1.497 1.187-3.366 1.065-4.868.348a7.89 7.89 0 0 1-.778-.42c-.66 1.345-1.68 2.276-3.063 2.788-.986.365-2.103.432-3.243.19-1.882-.401-3.466-1.576-4.156-3.216-.475-1.13-.53-2.394-.155-3.586.468-1.484 1.634-2.632 3.288-3.063 1.918-.5 3.728-.074 5.02 1.182.574.558 1.005 1.26 1.283 2.094.228-.76.382-1.581.455-2.46l-.005-.038z"/></svg>
Share
</a>
<button id="kakao-share" class="share-btn share-kakao" style="display:none" data-action="share-kakao">
<svg width="16" height="16" viewBox="0 0 24 24" fill="#191919"><path d="M12 3C6.477 3 2 6.463 2 10.691c0 2.754 1.862 5.18 4.67 6.532-.16.578-.583 2.096-.668 2.421-.104.397.146.392.306.285.126-.084 2.005-1.36 2.816-1.912.93.134 1.891.205 2.876.205 5.523 0 10-3.463 10-7.691S17.523 3 12 3z"/></svg>
KakaoTalk
</button>
<button class="share-btn share-copy" data-action="copy-link" data-url="${esc(canonical)}" data-text="${esc(copyText)}">
<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
Copy Link
</button>
</div>

<script>
var _copyOrig='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>Copy Link';
function copyLink(btn){
  var copyText=btn.dataset.text||btn.dataset.url;
  if(!navigator.clipboard){prompt('Copy this:',copyText);setTimeout(function(){btn.innerHTML=_copyOrig},500);return}
  navigator.clipboard.writeText(copyText).then(function(){
    btn.classList.add('copied');btn.innerHTML='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>Copied!';
    gtag('event','share',{method:'copy',content_type:'is_x_down',item_id:${jsDisplayName}});
    setTimeout(function(){btn.classList.remove('copied');btn.innerHTML=_copyOrig},2000)
  }).catch(function(){
    prompt('Copy this:',copyText);setTimeout(function(){btn.innerHTML=_copyOrig},500)
  })
}
function copyBadge(btn){
  var t=btn.dataset.text,o=btn.textContent;
  function done(){btn.textContent='Copied!';setTimeout(function(){btn.textContent=o},2000);typeof gtag==='function'&&gtag('event','copy_badge',{location:'is_down_page',service_id:btn.dataset.svc})}
  if(navigator.clipboard){navigator.clipboard.writeText(t).then(done).catch(function(){prompt('Copy this:',t)})}else{prompt('Copy this:',t)}
}
function shareKakao(){
  if(!window.Kakao||!Kakao.isInitialized())return;
  try{
    Kakao.Share.sendDefault({
      objectType:'feed',
      content:{
        title:'Is '+${jsDisplayName}+' Down?',
        description:'Current status: '+${jsStatus}+'. Real-time AI service monitoring by AIWatch.',
        imageUrl:${jsOgImageUrl},
        imageWidth:1200,
        imageHeight:630,
        link:{mobileWebUrl:${jsCanonical},webUrl:${jsCanonical}}
      },
      buttons:[
        {title:'Live Status',link:{mobileWebUrl:${jsCanonical},webUrl:${jsCanonical}}},
        {title:'Dashboard',link:{mobileWebUrl:"https://ai-watch.dev",webUrl:"https://ai-watch.dev"}}
      ]
    });
    gtag('event','share',{method:'kakao',content_type:'is_x_down',item_id:${jsDisplayName}});
  }catch(e){console.error('[AIWatch] Kakao share failed:',e)}
}
</script>
<script>
(function(){
  var s=document.createElement('script');s.src='https://t1.kakaocdn.net/kakao_js_sdk/2.7.4/kakao.min.js';
  s.onload=function(){
    try{Kakao.init('37903a9f5c2488dd6761866846073112');document.getElementById('kakao-share').style.display='inline-flex'}
    catch(e){console.error('[AIWatch] Kakao init failed:',e)}
  };
  s.onerror=function(){console.warn('[AIWatch] Kakao SDK failed to load')};
  document.head.appendChild(s);
})();
</script>`
}


// "Also check" footer cross-links are grouped by category (#424). Without
// grouping, the links render in `SLUG_TO_SERVICE` insertion order — which is
// the historical SEO-page rollout order, mixing services with no logic.
// Grouping gives the SEO internal-link block a coherent structure and lets a
// reader scan to the category they care about. #658: the taxonomy now mirrors
// the dashboard SERVICE_CATEGORIES (apps/llm/voice/inference/video/agents) so
// the is-down footer and the dashboard Overview group services identically.
export const FOOTER_CATEGORY_ORDER: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'llm', label: 'LLM APIs' },
  { key: 'agents', label: 'Coding Agents' },
  { key: 'voice', label: 'Voice' },
  { key: 'inference', label: 'Inference & Infra' },
  { key: 'observability', label: 'Observability' },
  { key: 'video', label: 'Video' },
  { key: 'image', label: 'Image' }, // #756
  { key: 'apps', label: 'AI Apps' },
]

// Exported for api/is-down/__tests__/html-template.test.ts — pins the
// category-grouped "Also check" structure (#424).
// #805 (Problem B) — surface the embeddable status badge on the high-traffic is-down page itself
// (not just the deep SPA detail route) so the right audience — developers checking if the service is
// down — can grab it. The markdown links back to THIS crawlable is-down page (the backlink authority
// that makes the badge an SEO asset; see src/utils/badge.js + #805 Problem A).
export function renderBadgeEmbed(slug: string, seo: ServiceSEO): string {
  const serviceId = SLUG_TO_SERVICE[slug]?.id ?? slug
  const badgeImg = `https://aiwatch-worker.p2c2kbf.workers.dev/badge/${serviceId}`
  const markdown = `[![${seo.displayName}](${badgeImg})](https://ai-watch.dev/is-${slug}-down)`
  return `<div style="margin:28px 0;padding:16px;background:#0d1117;border:1px solid rgba(255,255,255,0.08);border-radius:8px">
<h2 style="margin:0 0 4px">Embed this status badge</h2>
<p class="meta" style="margin:0 0 12px">Show your users ${esc(seo.displayName)}'s live status — drop this badge in your README, docs, or status page. It links back to this live page.</p>
<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
<img src="${esc(badgeImg)}" alt="${esc(seo.displayName)} status" height="20" loading="lazy">
<input type="text" readonly value="${esc(markdown)}" data-action="select" aria-label="Badge markdown" class="mono" style="flex:1;min-width:200px;font-size:11px;padding:6px 8px;background:#161b22;border:1px solid rgba(255,255,255,0.1);border-radius:4px;color:#adbac7;outline:none">
<button class="share-btn badge-copy" data-text="${esc(markdown)}" data-svc="${esc(serviceId)}" data-action="copy-badge" style="background:#161b22;color:#e6edf3;border-color:rgba(255,255,255,0.14)">Copy</button>
</div>
</div>`
}

export function renderFooter(slug: string): string {
  // Related services first (SEO cross-linking), then everything else grouped
  // by category.
  const related = (RELATED_SLUGS[slug] ?? []).filter(s => SLUG_TO_SERVICE[s])
  const allSlugs = Object.keys(SLUG_TO_SERVICE).filter(s => s !== slug)
  const remaining = allSlugs.filter(s => !related.includes(s))

  const seoEntry = SLUG_TO_SERVICE[slug]
  const relatedLinks = related
    .map(s => {
      const name = SLUG_TO_SERVICE[s]?.name ?? s.replace(/-/g, ' ')
      return `<a href="/is-${esc(s)}-down" style="font-weight:500">Is ${esc(name)} down?</a>`
    })
    .join(' &middot; ')

  // Group `remaining` by the fine `group` taxonomy (#658). Within each group the
  // existing deterministic SLUG_TO_SERVICE order is preserved. Empty groups emit
  // nothing — no stray sub-label. Every service falls into exactly one of
  // apps / llm / voice / inference / video / agents (every SLUG_TO_SERVICE
  // entry carries a `group`), so no service is dropped by the grouping.
  const otherGroups = FOOTER_CATEGORY_ORDER
    .map(({ key, label }) => {
      const links = remaining
        .filter(s => SLUG_TO_SERVICE[s]?.group === key)
        .map(s => `<a href="/is-${esc(s)}-down">Is ${esc(SLUG_TO_SERVICE[s]?.name ?? s.replace(/-/g, ' '))} down?</a>`)
      if (links.length === 0) return ''
      return `<span style="display:block;margin-top:4px"><strong style="color:#8b949e">${label}:</strong> ${links.join(' ')}</span>`
    })
    .filter(Boolean)
    .join('')

  return `<div class="footer">
<p style="margin-bottom:12px"><a href="https://ai-watch.dev" class="btn" data-ga="click_dashboard" data-ga-loc="is_down_page" data-ga-source="footer">View Full Dashboard</a></p>
<p><a href="https://ai-watch.dev/#${esc(seoEntry?.id ?? slug)}" data-ga="click_service_detail" data-ga-loc="is_down_page" data-ga-svc="${esc(seoEntry?.id ?? slug)}">Detailed service page</a> &middot; <a href="/reports/" data-ga="click_reports" data-ga-loc="is_down_page" data-ga-source="footer">Monthly reports</a> &middot; <a href="https://ai-watch.dev/#settings?focus=alerts" data-ga="click_cta_alerts" data-ga-loc="is_down_page" data-ga-source="footer">Set up alerts</a> &middot; <a href="https://ai-watch.dev/methodology#score" data-ga="click_methodology" data-ga-loc="is_down_page" data-ga-source="footer">How we measure this</a></p>
${relatedLinks ? `<p style="margin-top:12px;font-size:13px">Related: ${relatedLinks}</p>` : ''}
${otherGroups ? `<p style="margin-top:8px;font-size:12px">Also check:${otherGroups}</p>` : ''}
<p style="margin-top:12px">&copy; 2026 AIWatch. Real-time AI service status monitoring.</p>
</div>`
}
