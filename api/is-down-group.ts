// #1164 — Vercel Edge Function for the provider-family group pages that now live at
// /is-claude-down and /is-openai-down (the single-service content that used to be there moved to
// /is-claude-api-down and /is-openai-api-down, api/is-down.ts). Someone searching the bare product
// name ("is claude down") is more likely asking about the product broadly than one specific surface
// — this page worst-of's the family's live status and links out to each member's own page.
//
// Deliberately LIGHT still: no FAQ/Alternatives/embed-badge/region-status sections — those stay
// individual-page-only. But the page carries real content beyond the live status snapshot: recent
// incidents (7d, across every member) with their AI analysis when one exists, a share affordance, and
// cross-links to sibling family pages — real-review feedback that a bare status list read as too
// empty, especially on the (common) all-operational day.

import { FAMILY_GROUPS, SERVICE_ID_TO_SLUG, SLUG_TO_SERVICE } from './_is-down/slug-map'
import { cspForHtml } from './_shared/csp-hash'
import { EXTENSION_STORE_URL, renderExtInstallCta } from './_shared/extension-cta'
import { CONSENT_INIT_COMMENT, consentInitScript } from './_shared/consent-init'
import { cookieBannerHtml } from './_shared/cookie-banner'

export const config = { runtime: 'edge' }

const WORKER_API = 'https://aiwatch-worker.p2c2kbf.workers.dev'

interface MemberStatus {
  id: string
  name: string
  slug: string
  status: 'operational' | 'degraded' | 'down' | 'unknown'
}

interface FamilyIncident {
  /** #1164 — a shared multi-surface incident (one incident id across e.g. Claude API + claude.ai, the
   *  same model the worker's alert/tweet-draft svcIds resolution already relies on) carries every
   *  affected member here instead of being split into one row per member. Almost always length 1. */
  members: Array<{ name: string; slug: string }>
  title: string
  status: 'investigating' | 'identified' | 'monitoring' | 'resolved'
  startedAt: string
  resolvedAt?: string | null
  duration: string | null
  /** AI-generated summary for this SPECIFIC incident, when the worker's analysis pipeline has one
   *  (matched by incidentId — the worker can hold analyses for other, unrelated incidents on the
   *  same member). Absent is normal (no incident, or not yet analyzed), not an error. */
  aiSummary?: string
  aiEstimatedRecovery?: string
}

// Recent-incidents window + cap — mirrors the single-service page's "Last 7 days" framing, capped to
// a handful so a busy family doesn't turn the group page into a full incident log (that's what each
// member's own is-down page is for).
const RECENT_INCIDENTS_DAYS = 7
const RECENT_INCIDENTS_MAX = 5
// A resolved incident's analysis is only shown for a short window after recovery — the reply-tweet
// use case ("is X down [was]?") happens shortly after the fact, not days later. Past this window the
// row still renders (with the plain "resolved after X" meta line), just without the analysis card.
//
// 2h, not a guess: matches worker/src/recovery-mark.ts's RESOLVED_TTL_S (7200s) — the single constant
// that already governs how long BOTH the `recovered:{svcId}:{incId}` marker and the resolved
// `ai:analysis:*` value live in KV. Past that TTL, `/api/status/cached`'s aiAnalysis simply stops
// carrying the entry at all (worker/src/index.ts's recoveryCutoff there is a 3h READ-side query margin
// for clock/cron skew, not the actual data lifetime — the KV key itself is gone by 2h regardless), so
// this local gate is redundant with the upstream cutoff today. Kept anyway as defense-in-depth (same
// posture as STATUS_RANK's unknown-outranks-operational gate above) rather than trusting the upstream
// contract to never change or lag — hand-copied, not imported, since worker/ and api/ are different
// deploy targets (no established import path in that direction yet, unlike slug-map.ts → worker).
const RESOLVED_ANALYSIS_WINDOW_MS = 2 * 60 * 60 * 1000

// #1164 review — 'unknown' MUST outrank 'operational': it means AIWatch couldn't confirm that
// member's status (missing from the Worker response, or the whole fetch failed), not that it's
// healthy. Ranking it alongside 'operational' (both 0) let a family where every member is unknown
// render a false "🟢 Operational" headline — the worst failure mode for a status page. 'unknown'
// still loses to a CONFIRMED 'degraded'/'down', since an actual known problem is worse than an
// unconfirmed one.
const STATUS_RANK: Record<MemberStatus['status'], number> = { operational: 0, unknown: 1, degraded: 2, down: 3 }
const STATUS_EMOJI: Record<MemberStatus['status'], string> = { operational: '🟢', degraded: '🟡', down: '🔴', unknown: '⚪' }
const STATUS_LABEL: Record<MemberStatus['status'], string> = {
  operational: 'Operational', degraded: 'Degraded Performance', down: 'Down', unknown: 'Unknown',
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Narrows an arbitrary Worker status string to the 4 values this page renders — anything else
 *  (a typo, a future status value the Worker adds) collapses to 'unknown' rather than being trusted. */
function normalizeStatus(raw: string | undefined): MemberStatus['status'] {
  return raw === 'operational' || raw === 'degraded' || raw === 'down' ? raw : 'unknown'
}

/** Worst-of across a set of statuses: down > degraded > unknown > operational — an unconfirmed member
 *  must never be silently masked by a confirmed-operational one (see STATUS_RANK). Empty input →
 *  'unknown' as defense-in-depth; in practice `members` always has `family.members.length` entries
 *  (never fabricate a status when the fetch failed — same posture as is-down.ts's fallback). Takes just
 *  `{ status }` (not the full MemberStatus) so it also serves the other-family alternative-recommendation
 *  check below, which has no per-member name/slug to construct. */
function worstStatus(members: Array<{ status: MemberStatus['status'] }>): MemberStatus['status'] {
  if (members.length === 0) return 'unknown'
  return members.reduce((worst, m) => (STATUS_RANK[m.status] > STATUS_RANK[worst] ? m.status : worst), 'operational' as MemberStatus['status'])
}

/** Formats an incident row's date, resolved-duration text (if applicable). Pure/side-effect-free. */
function incidentMeta(inc: FamilyIncident): string {
  const started = new Date(inc.startedAt)
  const dateStr = Number.isNaN(started.getTime()) ? '' : started.toISOString().slice(0, 10)
  if (inc.status === 'resolved') return inc.duration ? `${dateStr} · resolved after ${inc.duration}` : `${dateStr} · resolved`
  return `${dateStr} · ongoing`
}

function renderGroupPage(family: { slug: string; name: string }, members: MemberStatus[], incidents: FamilyIncident[], otherFamilies: Array<{ slug: string; name: string; status: MemberStatus['status'] }>): string {
  const headline = worstStatus(members)
  const title = `Is ${family.name} Down? ${STATUS_LABEL[headline]} | AIWatch`
  const desc = headline === 'operational'
    ? `No — every ${family.name} service AIWatch monitors is currently operational.`
    : `${STATUS_LABEL[headline]} — see which ${family.name} service is affected and its live status.`
  const canonical = `https://ai-watch.dev/is-${family.slug}-down`
  // #1164 follow-up — the group page originally used the static site-wide og-intro.png, unlike every
  // individual is-down page (which draws a live status card via the worker's /api/og). Reuses that
  // SAME endpoint: `service`/`status` alone render a full card (STATUS_STYLE covers 'unknown' too —
  // worker/src/og.ts), `score`/`uptime` are optional and simply omitted since there's no
  // family-level analog for either.
  //
  // #1103 (diagnosed on the individual pages, applies identically here) — og:url ("canonical" below)
  // never changes for this page (no `?e=`/`?i=` pin like a per-incident share), so a static og:image
  // query string lets a social platform's crawler cache the URL indefinitely against a card that can
  // go stale OR — #1103's actual observed failure — unfurl with NO image at all once the crawler
  // decides the (unchanged) URL doesn't need a re-fetch. `v`, a 10-min bucket, forces periodic
  // re-fetch on the LIVE page the same way the individual pages' unpinned share does.
  const ogImage = `https://aiwatch-worker.p2c2kbf.workers.dev/api/og?${new URLSearchParams({ service: family.name, status: headline, v: String(Math.floor(Date.now() / 600_000)) }).toString()}`

  const rows = members.map((m) => `
    <li class="member-row">
      <a href="/is-${esc(m.slug)}-down">
        <span class="member-emoji">${STATUS_EMOJI[m.status]}</span>
        <span class="member-name">${esc(m.name)}</span>
        <span class="member-status">${STATUS_LABEL[m.status]}</span>
      </a>
    </li>`).join('')

  // #1164 review — a lightweight alternative-service nudge for an ONGOING incident's AI card: not the
  // individual is-down page's tiered fallback engine (~150 lines, worker/src/fallback.ts-synced, keyed
  // per-service capability/tier) — deliberately not duplicated a third time here, and out of scope for
  // a "worst-of across N surfaces of ONE provider" page anyway. A group page only has sibling FAMILIES
  // to recommend, so the question is simply "is the other whole provider healthy right now?". Never
  // recommends a family that's itself degraded/down/unknown — that isn't an alternative.
  const healthyOtherFamily = otherFamilies.find((f) => f.status === 'operational')
  const altRecommendation = healthyOtherFamily
    ? `<p class="incident-ai-alt">🔄 Alternative: <a href="/is-${esc(healthyOtherFamily.slug)}-down">${esc(healthyOtherFamily.name)}</a> is operational right now.</p>`
    : ''

  // #1164 review — recent incidents give the "everything's operational" case actual content instead
  // of reading as empty (a clean status still has a history worth showing), and give a currently-bad
  // headline supporting evidence beyond the bare status word.
  const incidentSection = incidents.length > 0
    ? `<h2>Recent Incidents <span class="incidents-window">(last ${RECENT_INCIDENTS_DAYS} days)</span></h2>
<ul class="incident-list">${incidents.map((inc) => `
    <li class="incident-row">
      <div class="incident-header">
        <span class="incident-service">${inc.members.map((m) => `<a href="/is-${esc(m.slug)}-down">${esc(m.name)}</a>`).join(', ')}</span>
        <span class="incident-title">${esc(inc.title)}</span>
        <span class="incident-meta">${esc(incidentMeta(inc))}</span>
      </div>${inc.aiSummary ? `
      <div class="incident-ai">
        <span class="incident-ai-badge">${inc.status === 'resolved' ? '🤖 Post-Incident Analysis' : '🤖 AI Analysis'}</span>
        <p>${esc(inc.aiSummary)}</p>
        ${inc.status === 'resolved'
          ? '' /* #1164 review — a live "Estimated recovery" figure is stale once resolved (incidentMeta
                 above already states "resolved after {duration}"); the summary text alone is what an
                 operator needs for a post-hoc reply tweet explaining WHAT happened. An alternative is
                 also moot post-recovery, so altRecommendation is withheld here too, not just the ETA. */
          : `${inc.aiEstimatedRecovery ? `<p class="incident-ai-eta">Estimated recovery: ${esc(inc.aiEstimatedRecovery)}</p>` : ''}${altRecommendation}`}
      </div>` : ''}
    </li>`).join('')}</ul>`
    : `<h2>Recent Incidents <span class="incidents-window">(last ${RECENT_INCIDENTS_DAYS} days)</span></h2>
<p class="no-incidents">No incidents reported for any ${esc(family.name)} service in the last ${RECENT_INCIDENTS_DAYS} days.</p>`

  // #1164 review — same "set up alerts" entry point the individual pages' secondary CTA links to
  // (https://ai-watch.dev/#settings?focus=alerts). No per-family feed exists (RSS/Slack subscribe is
  // per-service, /feed/{slug}), so this points at the central settings screen rather than inventing
  // one — the user can enable alerts for any/all of this family's members there.
  const alertSection = `<p class="alert-cta"><a href="https://ai-watch.dev/#settings?focus=alerts" data-ga="click_cta_alerts" data-ga-loc="is_down_group_page">🔔 Get notified when ${esc(family.name)} status changes</a></p>`

  // #1164 review — a share affordance, matching the individual is-down pages (X + copy link). Kept
  // deliberately simple (no Threads/Kakao) for the v1 group page.
  const shareText = `${STATUS_EMOJI[headline]} Is ${family.name} down? ${STATUS_LABEL[headline]}. Live status → ${canonical}`
  const shareSection = `<div class="share-row">
  <a class="share-btn share-x" href="https://x.com/intent/tweet?text=${encodeURIComponent(shareText)}" target="_blank" rel="noopener"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg> Post</a>
  <button class="share-btn share-copy" data-url="${esc(canonical)}" data-action="copy-link">🔗 Copy link</button>
</div>`

  // #1164 review — cross-links to the OTHER provider-family pages. Someone checking one provider is
  // plausibly curious about the other too (both are common AI-stack dependencies), and this doubles
  // as internal linking between the two highest-value SEO pages on the site. Shares one footer line
  // with the dashboard home link (below) rather than its own stacked paragraph — two one-line "here's
  // somewhere else to go" links didn't need two separate rows.
  const otherFamiliesLinks = otherFamilies.length > 0
    ? `Also check: ${otherFamilies.map((f) => `<a href="/is-${esc(f.slug)}-down">${esc(f.name)}</a>`).join(' · ')} · `
    : ''
  const otherFamiliesSection = `<p class="also-check">${otherFamiliesLinks}<a class="home" href="/">All AI services on AIWatch</a></p>`

  // #837/#888 — the Chrome extension is Claude-ONLY, so it's gated to the Anthropic family page only
  // (an install CTA on /is-openai-down would be a mismatch — mirrors isClaudeSurface's gate on the
  // individual is-down pages). Empty EXTENSION_STORE_URL → renderExtInstallCta returns '' (pre-CWS-
  // approval), same fail-closed default as the individual pages.
  const extCtaSection = family.slug === 'claude'
    ? renderExtInstallCta(EXTENSION_STORE_URL, { loc: 'is_down_group_page', variant: 'is-down' })
    : ''

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: title,
    url: canonical,
    description: desc,
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="website">
<meta property="og:url" content="${canonical}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(ogImage)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(ogImage)}">
<link rel="icon" type="image/png" href="/favicon.png">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
${CONSENT_INIT_COMMENT}
${consentInitScript()}
<style>
  body { background:#080c10; color:#e6edf3; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; max-width:640px; margin:0 auto; padding:32px 20px; }
  h1 { font-size:1.5rem; text-align:center; }
  h2 { font-size:1.05rem; margin:28px 0 12px; }
  .incidents-window { color:#9ca3af; font-weight:400; font-size:0.85rem; }
  .headline { font-size:1.1rem; margin-bottom:24px; }
  ul.member-list, ul.incident-list { list-style:none; padding:0; margin:0; }
  .member-row a { display:flex; align-items:center; gap:10px; padding:14px 16px; border:1px solid #1f2937; border-radius:8px; margin-bottom:8px; text-decoration:none; color:inherit; }
  .member-name { flex:1; font-weight:600; }
  .member-status { color:#9ca3af; font-size:0.9rem; }
  .incident-row { border:1px solid #1f2937; border-radius:8px; margin-bottom:8px; overflow:hidden; }
  .incident-header { display:flex; flex-wrap:wrap; align-items:center; gap:10px; padding:14px 16px; }
  .incident-service { font-weight:600; }
  .incident-service a { color:#58a6ff; text-decoration:none; }
  .incident-service a:hover { text-decoration:underline; }
  .incident-title { flex:1; }
  .incident-meta { color:#9ca3af; font-size:0.85rem; width:100%; }
  .no-incidents { color:#9ca3af; }
  .incident-ai { padding:12px 16px; border-top:1px solid #1f2937; background:#0d1420; }
  .incident-ai-badge { font-size:0.8rem; color:#9ca3af; }
  .incident-ai p { margin:6px 0 0; font-size:0.9rem; }
  .incident-ai-eta { color:#9ca3af; font-size:0.85rem; }
  .incident-ai-alt { color:#9ca3af; font-size:0.85rem; }
  .incident-ai-alt a { color:#58a6ff; text-decoration:none; }
  .incident-ai-alt a:hover { text-decoration:underline; }
  .also-check { margin-top:16px; color:#9ca3af; }
  .also-check a { color:#58a6ff; }
  .alert-cta { margin-top:20px; padding:12px 16px; border:1px solid #1f2937; border-radius:8px; background:#161b22; text-align:center; }
  .alert-cta a { color:#58a6ff; text-decoration:none; }
  .ext-strip { margin:20px 0 0; padding:9px 14px; border:1px solid #21262d; border-radius:8px; background:#0d1117; text-align:center; font-size:13px; line-height:1.45; }
  .ext-strip a { color:#8b949e; text-decoration:none; }
  .ext-strip a:hover { color:#c9d1d9; }
  .ext-strip strong { color:#58a6ff; font-weight:600; }
  .share-row { display:flex; gap:10px; margin-top:24px; }
  .share-btn { flex:1; display:inline-flex; align-items:center; justify-content:center; gap:6px; padding:10px; border:1px solid #1f2937; border-radius:8px; background:#161b22; color:#e6edf3; text-decoration:none; cursor:pointer; font-size:0.9rem; }
  .share-x { background:#000; color:#fff; border-color:#333; }
  a.home { color:#58a6ff; }
</style>
</head>
<body>
<h1>${STATUS_EMOJI[headline]} Is ${esc(family.name)} Down?</h1>
<p class="headline">${esc(desc)}</p>
<ul class="member-list">${rows}</ul>
${alertSection}
${extCtaSection}
${incidentSection}
${shareSection}
${otherFamiliesSection}
<script>
document.querySelector('[data-action="copy-link"]')?.addEventListener('click', function(e){
  navigator.clipboard.writeText(e.currentTarget.dataset.url).then(function(){
    e.currentTarget.textContent = '✓ Copied'
    setTimeout(function(){ e.currentTarget.textContent = '🔗 Copy link' }, 2000)
  })
})
// #482-style delegated GA4 hook — CSP-clean (no inline handlers). Mirrors the individual is-down
// pages' [data-ga] listener, minimal subset (location only) — every CTA on this page (alerts,
// extension install, share, cross-links) already carries data-ga/data-ga-loc attributes from the
// section builders above, so this listener now actually fires once gtag exists (below).
document.addEventListener('click', function(e){
  var g = e.target.closest('[data-ga]')
  if (g && typeof gtag === 'function') gtag('event', g.dataset.ga, { location: g.dataset.gaLoc })
})
</script>
${cookieBannerHtml()}
</body>
</html>`
}

export default async function handler(req: Request) {
  try {
    const url = new URL(req.url)
    const familyKey = url.searchParams.get('family') ?? ''
    const family = FAMILY_GROUPS[familyKey]
    if (!family) return new Response('Not Found', { status: 404 })
    // #1164 review — cross-links to every OTHER family (currently just the one sibling, but this
    // scales automatically if a third family is ever added to FAMILY_GROUPS). Starts 'unknown' like
    // `members` below — the fetch-success block overwrites with a real worst-of status, used both for
    // the "Also check" cross-link and the ongoing-incident "🔄 Alternative" recommendation (which must
    // never recommend a sibling family whose own status couldn't be confirmed).
    let otherFamilies: Array<{ slug: string; name: string; status: MemberStatus['status'] }> =
      Object.values(FAMILY_GROUPS)
        .filter((f) => f.slug !== family.slug)
        .map((f) => ({ slug: f.slug, name: f.name, status: 'unknown' as const }))

    // #1164 review — every member starts 'unknown' (name/slug BOTH resolved from the canonical
    // SLUG_TO_SERVICE/SERVICE_ID_TO_SLUG maps, so the row reads with a real display name — "claude.ai",
    // not the raw id "claudeai" — and its is-down link works even when nothing is confirmed). A
    // successful fetch OVERWRITES this per member below; on total fetch failure it's what actually
    // renders — so the fallback page keeps every member's real name + outbound link instead of an
    // empty list of raw ids.
    const resolvedName = (id: string, slug: string) => SLUG_TO_SERVICE[slug]?.name ?? id
    let members: MemberStatus[] = family.members.map((id) => {
      const slug = SERVICE_ID_TO_SLUG[id] ?? id
      return { id, name: resolvedName(id, slug), slug, status: 'unknown' as const }
    })
    let incidents: FamilyIncident[] = []
    let isFallback = true
    try {
      const res = await fetch(`${WORKER_API}/api/status/cached`, { signal: AbortSignal.timeout(5000) })
      if (res.ok) {
        const data = await res.json() as {
          services: Array<{
            id: string; name: string; status: string
            incidents?: Array<{
              id: string; title: string; status: 'investigating' | 'identified' | 'monitoring' | 'resolved'
              startedAt: string; resolvedAt?: string | null; duration: string | null
            }>
          }>
          // #926 — one entry per active incident, keyed by service id (same shape is-down.ts reads).
          aiAnalysis?: Record<string, Array<{ incidentId: string; summary: string; estimatedRecovery: string }>>
        }
        const byId = new Map(data.services.map((s) => [s.id, s]))
        members = family.members.map((id) => {
          const s = byId.get(id)
          const slug = SERVICE_ID_TO_SLUG[id] ?? id
          if (!s) return { id, name: resolvedName(id, slug), slug, status: 'unknown' as const }
          return { id, name: s.name, slug, status: normalizeStatus(s.status) }
        })
        // #1164 review — same /api/status/cached payload already carries EVERY monitored service (not
        // just this family's), so the sibling family's worst-of status is derived from the same `byId`
        // map with zero extra fetches — see the "🔄 Alternative" recommendation in renderGroupPage.
        otherFamilies = otherFamilies.map((f) => ({
          ...f,
          status: worstStatus(FAMILY_GROUPS[f.slug].members.map((id) => ({ status: normalizeStatus(byId.get(id)?.status) }))),
        }))
        // #1164 review — recent incidents across every family member, newest first, capped. Gives the
        // page real content even in the common "everything's operational right now" case, and backs
        // up a bad headline with the actual incident, not just the bare status word. Each incident is
        // cross-matched to the worker's AI analysis (by incidentId, NOT just service id — a service can
        // hold an analysis for a different, unrelated incident) when one exists.
        //
        // A same-family incident that hits multiple surfaces at once (e.g. Claude API + claude.ai) is
        // carried under the SAME incident id on each affected member's own `incidents` array — the same
        // sharing the worker's alert/tweet-draft svcIds resolution already relies on (worker/src/alerts.ts
        // FAMILY_OF_SERVICE / buildGroupTweetDraft). Group by id across members here so it renders as ONE
        // row listing every affected member, not one duplicate row per member.
        //
        // #1164 round-3 review (code-reviewer + silent-failure-hunter, independently) — the Worker
        // stores an incident's analysis under exactly ONE service key (the alert's primary surface),
        // not every affected member's, and the cross-member sibling-copy in worker/src/ai-analysis.ts
        // only runs for ACTIVE incidents on a later cron cycle (never backfills a resolved one). A
        // per-member-scoped lookup during the merge loop below would only ever check whichever member
        // happens to be iterated first for a given incident id — silently dropping a real analysis
        // filed under a different member. Build one incidentId → analysis map across EVERY member's
        // bucket up front instead, so the lookup is independent of which member is "first".
        const analysisByIncidentId = new Map<string, { summary: string; estimatedRecovery: string }>()
        for (const id of family.members) {
          for (const a of data.aiAnalysis?.[id] ?? []) {
            if (!analysisByIncidentId.has(a.incidentId)) analysisByIncidentId.set(a.incidentId, a)
          }
        }
        const cutoff = Date.now() - RECENT_INCIDENTS_DAYS * 86_400_000
        const byIncidentId = new Map<string, FamilyIncident>()
        for (const id of family.members) {
          const s = byId.get(id)
          const slug = SERVICE_ID_TO_SLUG[id] ?? id
          const memberName = s ? s.name : resolvedName(id, slug)
          for (const inc of s?.incidents ?? []) {
            // #1164 round-3 review (silent-failure-hunter) — `new Date(inc.startedAt).getTime()` is
            // NaN for a missing/malformed date, and `NaN < cutoff` is always false — the old bare
            // inequality let a garbage-dated incident fail OPEN (never filtered, kept forever) instead
            // of failing safe. Reject NaN explicitly, same posture as the resolved-analysis window below.
            const startedMs = new Date(inc.startedAt).getTime()
            if (Number.isNaN(startedMs) || startedMs < cutoff) continue
            const existing = byIncidentId.get(inc.id)
            if (existing) {
              existing.members.push({ name: memberName, slug })
              continue
            }
            // #1164 review — a RESOLVED incident's analysis is shown too (mirrors the individual is-down
            // page's "Post-Incident Analysis" card, html-template.ts renderAIInsight): an operator
            // replying to an "is X down" tweet shortly after recovery needs the same root-cause
            // explanation, not just a bare "resolved after 1h 30m". But NOT unconditionally — past
            // RESOLVED_ANALYSIS_WINDOW_MS since resolvedAt, the analysis is stale/no-longer-actionable
            // and is dropped (row still renders, just without the card). Never shown for a resolved
            // incident with no resolvedAt (can't establish recency, so fail closed).
            const recoveredRecently = inc.status === 'resolved'
              ? !!inc.resolvedAt && Date.now() - new Date(inc.resolvedAt).getTime() <= RESOLVED_ANALYSIS_WINDOW_MS
              : true
            const analysis = recoveredRecently ? analysisByIncidentId.get(inc.id) : undefined
            byIncidentId.set(inc.id, {
              members: [{ name: memberName, slug }], title: inc.title, status: inc.status,
              startedAt: inc.startedAt, resolvedAt: inc.resolvedAt, duration: inc.duration,
              aiSummary: analysis?.summary, aiEstimatedRecovery: analysis?.estimatedRecovery,
            })
          }
        }
        // Ongoing incidents (any non-'resolved' status) always rank above resolved ones, regardless of
        // startedAt — a currently-active incident is the thing a visitor most needs to see, even if a
        // shorter incident on another member resolved more recently. Newest-first within each group.
        incidents = Array.from(byIncidentId.values())
          .sort((a, b) => {
            const aOngoing = a.status === 'resolved' ? 0 : 1
            const bOngoing = b.status === 'resolved' ? 0 : 1
            if (aOngoing !== bOngoing) return bOngoing - aOngoing
            return new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
          })
          .slice(0, RECENT_INCIDENTS_MAX)
        isFallback = false
      }
    } catch (err) {
      console.warn(`[is-down-group/${familyKey}] status fetch failed:`, err instanceof Error ? err.message : err)
    }

    const html = renderGroupPage(family, members, incidents, otherFamilies)
    const csp = await cspForHtml(html, { enforce: true })
    // Mirrors is-down.ts's fallback semantics: a fetch failure renders "unknown" for every member
    // (never a fabricated status), and the 503 + no-store tells caches/crawlers not to trust or cache
    // that render, exactly like the single-service page.
    return new Response(html, {
      status: isFallback ? 503 : 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': isFallback
          ? 'no-store, max-age=0, must-revalidate'
          : 'public, s-maxage=60, stale-while-revalidate=300',
        [csp.key]: csp.value,
      },
    })
  } catch (err) {
    console.error('[is-down-group] Unhandled error:', err instanceof Error ? err.stack : err)
    return new Response(
      '<!DOCTYPE html><html><head><title>AIWatch - Temporarily Unavailable</title></head><body style="background:#080c10;color:#e6edf3;font-family:sans-serif;text-align:center;padding:60px"><h1>Something went wrong</h1><p>Please try again or visit <a href="https://ai-watch.dev" style="color:#58a6ff">AIWatch</a>.</p></body></html>',
      { status: 500, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' } },
    )
  }
}
