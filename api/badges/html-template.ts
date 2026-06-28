// Vercel Edge Function template — /badges gallery page (#805 Problem B)
//
// One canonical, indexable destination for AIWatch's embeddable status badges (shields.io-style):
// every monitored service's live badge + copy-paste markdown that links to the crawlable
// /is-{slug}-down page (the SEO-backlink target, #805 Problem A). Self-contained SSR (no data
// fetch) — the badge <img>s render live from the Worker /badge/:id endpoint. Mirrors
// api/methodology/html-template.ts chrome (tokens, nav, footer).

import { SLUG_TO_SERVICE } from '../is-down/slug-map'
import { CONSENT_INIT_COMMENT, CONSENT_INIT_SCRIPT } from '../_shared/consent-init'
import { COOKIE_BANNER_HTML } from '../_shared/cookie-banner'

const WORKER = 'https://aiwatch-worker.p2c2kbf.workers.dev'

// Display grouping/order for the gallery — mirrors FOOTER_CATEGORY_ORDER in api/is-down/html-template.ts
// (defined locally so this Edge page doesn't import the heavy is-down template; the `group` taxonomy
// lives on each SLUG_TO_SERVICE entry). Pinned against the is-down order by the badges unit test.
const GROUP_ORDER: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'llm', label: 'LLM APIs' },
  { key: 'agents', label: 'Coding Agents' },
  { key: 'voice', label: 'Voice' },
  { key: 'inference', label: 'Inference & Infra' },
  { key: 'observability', label: 'Observability' },
  { key: 'video', label: 'Video' },
  { key: 'image', label: 'Image' },
  { key: 'apps', label: 'AI Apps' },
]

function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Copy-paste markdown for a service's badge, linking to its crawlable is-down page (#805). */
export function badgeMarkdownFor(slug: string): string {
  const svc = SLUG_TO_SERVICE[slug]
  const id = svc?.id ?? slug
  const name = svc?.name ?? slug
  return `[![${name}](${WORKER}/badge/${id})](https://ai-watch.dev/is-${slug}-down)`
}

function renderCard(slug: string): string {
  const svc = SLUG_TO_SERVICE[slug]
  const id = svc?.id ?? slug
  const name = svc?.name ?? slug
  const markdown = badgeMarkdownFor(slug)
  return `<div class="badge-card">
  <a href="/is-${esc(slug)}-down" class="badge-preview"><img src="${esc(WORKER)}/badge/${esc(id)}" alt="${esc(name)} status" height="20" loading="lazy"></a>
  <div class="badge-copy-row">
    <input type="text" readonly value="${esc(markdown)}" onclick="this.select()" aria-label="${esc(name)} badge markdown" class="mono badge-input">
    <button class="badge-copy" data-text="${esc(markdown)}" data-svc="${esc(id)}" onclick="copyBadge(this)">Copy</button>
  </div>
</div>`
}

function renderGroups(): string {
  const allSlugs = Object.keys(SLUG_TO_SERVICE)
  return GROUP_ORDER
    .map(({ key, label }) => {
      const slugs = allSlugs.filter((s) => SLUG_TO_SERVICE[s]?.group === key)
      if (slugs.length === 0) return ''
      return `<section class="badge-group">
  <h2>${esc(label)} <span class="count">${slugs.length}</span></h2>
  <div class="badge-grid">${slugs.map(renderCard).join('')}</div>
</section>`
    })
    .filter(Boolean)
    .join('\n')
}

export function renderBadgesPage(): string {
  const total = Object.keys(SLUG_TO_SERVICE).length
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<title>AI Status Badges — Embed Live AI Service Status | AIWatch</title>
${CONSENT_INIT_COMMENT}
${CONSENT_INIT_SCRIPT}
<meta name="description" content="Embed a live, real-time status badge for any of ${total} AI services (Claude, OpenAI, Gemini, and more) in your README, docs, or status page. Free, auto-updating, links to the live AIWatch status page.">
<meta name="robots" content="index, follow">
<meta property="og:type" content="website">
<meta property="og:url" content="https://ai-watch.dev/badges">
<meta property="og:title" content="AI Status Badges — Embed Live AI Service Status | AIWatch">
<meta property="og:description" content="Free, auto-updating status badges for ${total} AI services. Drop one in your README, docs, or status page.">
<meta property="og:image" content="https://ai-watch.dev/og-intro.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:site_name" content="AIWatch">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="AI Status Badges | AIWatch">
<meta name="twitter:description" content="Free, auto-updating status badges for ${total} AI services.">
<meta name="twitter:image" content="https://ai-watch.dev/og-intro.png">
<link rel="canonical" href="https://ai-watch.dev/badges">
<meta name="theme-color" content="#080c10">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg0: #080c10; --bg1: #0d1117; --bg2: #161b22; --bg3: #1c2128;
    --text0: #e6edf3; --text1: #adbac7; --text2: #8b949e;
    --green: #3fb950; --green-dim: #1a3d25; --blue: #58a6ff;
    --border: #30363d;
    --font-mono: 'IBM Plex Mono', monospace; --font-sans: 'IBM Plex Sans', sans-serif;
  }
  body { background: var(--bg0); color: var(--text0); font-family: var(--font-sans); font-size: 15px; line-height: 1.7; -webkit-font-smoothing: antialiased; }
  a { color: inherit; text-decoration: none; }
  .mono { font-family: var(--font-mono); }
  .topnav { position: sticky; top: 0; z-index: 100; background: rgba(8,12,16,0.85); backdrop-filter: blur(12px); border-bottom: 1px solid var(--border); padding: 0 24px; height: 56px; display: flex; align-items: center; justify-content: space-between; }
  .nav-logo { display: flex; align-items: center; gap: 10px; font-family: var(--font-mono); font-size: 15px; font-weight: 600; letter-spacing: -0.3px; }
  .nav-logo .nav-green { color: var(--green); }
  .nav-cta { background: var(--green); color: var(--bg0); font-size: 13px; font-weight: 500; padding: 6px 16px; border-radius: 6px; }
  .nav-cta:hover { opacity: 0.85; }
  .wrap { max-width: 980px; margin: 0 auto; padding: 40px 24px 64px; }
  .doc-head { border-bottom: 1px solid var(--border); padding-bottom: 24px; margin-bottom: 8px; }
  .doc-head h1 { font-size: clamp(24px, 3.2vw, 32px); font-weight: 600; margin-bottom: 12px; }
  .doc-head p { font-size: 15px; color: var(--text1); max-width: 720px; }
  .doc-head code { font-family: var(--font-mono); font-size: 12px; background: var(--bg2); border: 1px solid var(--border); border-radius: 4px; padding: 1px 6px; color: var(--text0); }
  .badge-group { margin-top: 36px; }
  .badge-group h2 { font-size: 15px; font-weight: 600; color: var(--text0); margin-bottom: 14px; display: flex; align-items: center; gap: 8px; }
  .badge-group h2 .count { font-family: var(--font-mono); font-size: 11px; color: var(--text2); font-weight: 400; }
  .badge-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 12px; }
  .badge-card { background: var(--bg1); border: 1px solid var(--border); border-radius: 8px; padding: 12px; }
  .badge-preview { display: inline-block; margin-bottom: 8px; }
  .badge-copy-row { display: flex; gap: 6px; align-items: center; }
  .badge-input { flex: 1; min-width: 0; font-size: 10px; padding: 6px 8px; background: var(--bg2); border: 1px solid var(--border); border-radius: 4px; color: var(--text1); outline: none; }
  .badge-copy { flex-shrink: 0; font-family: var(--font-mono); font-size: 11px; padding: 6px 12px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.14); background: var(--bg3); color: var(--text0); cursor: pointer; }
  .badge-copy.copied { background: var(--green); color: var(--bg0); }
  .params { margin-top: 44px; border-top: 1px solid var(--border); padding-top: 28px; }
  .params h2 { font-size: 16px; font-weight: 600; margin-bottom: 12px; }
  .params table { border-collapse: collapse; font-size: 13px; }
  .params td { border: 1px solid var(--border); padding: 6px 12px; }
  .params td:first-child { font-family: var(--font-mono); color: var(--blue); }
  footer { border-top: 1px solid var(--border); padding: 24px; text-align: center; font-size: 12px; color: var(--text2); }
  footer a { color: var(--text1); text-decoration: underline; text-underline-offset: 2px; }
  @media (max-width: 600px) { .badge-grid { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<nav class="topnav">
  <a class="nav-logo" href="https://ai-watch.dev"><span>AI</span><span class="nav-green">Watch</span></a>
  <a href="https://ai-watch.dev" class="nav-cta">Open Dashboard →</a>
</nav>
<div class="wrap">
  <div class="doc-head">
    <h1>AI Status Badges</h1>
    <p>Embed a live, auto-updating status badge for any of ${total} AI services in your README, docs, or status page. Each badge links to that service's live AIWatch status page. Add <code>?uptime=true</code>, <code>?style=flat-square</code>, or <code>?label=My+API</code> to customize.</p>
  </div>
  ${renderGroups()}
  <div class="params">
    <h2>Parameters</h2>
    <table>
      <tr><td>uptime</td><td>Show uptime % — <code>/badge/claude?uptime=true</code></td></tr>
      <tr><td>style</td><td><code>flat</code> or <code>flat-square</code> — <code>/badge/claude?style=flat-square</code></td></tr>
      <tr><td>label</td><td>Custom label — <code>/badge/claude?label=My+API</code></td></tr>
    </table>
  </div>
</div>
<footer>
  © 2026 AIWatch · AGPL-3.0 · <a href="https://ai-watch.dev">Dashboard</a> · <a href="https://ai-watch.dev/methodology">Methodology</a> · <a href="https://github.com/bentleypark/aiwatch">GitHub</a>
</footer>
<script>
function copyBadge(btn){
  var t=btn.dataset.text,o=btn.textContent;
  function done(){btn.classList.add('copied');btn.textContent='Copied!';setTimeout(function(){btn.classList.remove('copied');btn.textContent=o},2000);typeof gtag==='function'&&gtag('event','copy_badge',{location:'badges_page',service_id:btn.dataset.svc})}
  if(navigator.clipboard){navigator.clipboard.writeText(t).then(done).catch(function(){prompt('Copy this:',t)})}else{prompt('Copy this:',t)}
}
</script>
${COOKIE_BANNER_HTML}
</body>
</html>`
}
