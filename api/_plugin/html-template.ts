// SSR HTML for the /plugin page (#920) — the AIWatch Claude Code plugin landing/discovery surface.
//
// Self-contained Edge SSR (no data fetch), mirroring api/_methodology conventions: inline <style> in
// <head>, a single nonce'd <script> with a delegated [data-ga] listener (no inline handlers → CSP-clean),
// GA4 Consent Mode via the shared helper, cookie banner. English-only (the body is copy-paste command
// heavy) with a KO notice, like the statusline guide page. Indexable (real HTML on the edge runtime →
// zero Serverless-Function cost). The install CTA is gated (api/_shared/plugin-cta.ts) until the plugin
// clears the claude-community marketplace review.

import { CONSENT_INIT_COMMENT, consentInitScript } from '../_shared/consent-init'
import { cookieBannerHtml } from '../_shared/cookie-banner'
import { nonceAttr } from '../_shared/csp-nonce'
import { PLUGIN_MARKETPLACE_URL, renderPluginInstall } from '../_shared/plugin-cta'

export function renderPluginPage(nonce?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<title>AIWatch for Claude Code — outage plugin | AIWatch</title>
${CONSENT_INIT_COMMENT}
${consentInitScript(nonce)}
<meta name="description" content="A Claude Code plugin that tells you the moment an upstream AI service (Claude, OpenAI, Gemini, and more) goes down — a background outage monitor plus an /aiwatch status briefing, right in your terminal. Reads no code, collects no data.">
<meta name="robots" content="index, follow">
<meta property="og:type" content="website">
<meta property="og:url" content="https://ai-watch.dev/plugin">
<meta property="og:title" content="AIWatch for Claude Code — the outage plugin">
<meta property="og:description" content="Know the moment an AI service breaks, inside Claude Code. Background outage monitor + /aiwatch briefing. No code read, no data collected.">
<meta property="og:image" content="https://ai-watch.dev/og-intro.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:locale" content="en_US">
<meta property="og:site_name" content="AIWatch">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="AIWatch for Claude Code — the outage plugin">
<meta name="twitter:description" content="Know the moment an AI service breaks, inside Claude Code. Monitor + /aiwatch briefing. No code read.">
<meta name="twitter:image" content="https://ai-watch.dev/og-intro.png">
<link rel="canonical" href="https://ai-watch.dev/plugin">
<meta name="theme-color" content="#080c10">
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"SoftwareApplication","name":"AIWatch for Claude Code","applicationCategory":"DeveloperApplication","operatingSystem":"macOS, Linux, Windows","description":"Claude Code plugin: a background monitor that alerts when an upstream AI service goes down or recovers, plus an /aiwatch status briefing. Reads no code, collects no data.","offers":{"@type":"Offer","price":"0","priceCurrency":"USD"},"publisher":{"@type":"Organization","name":"AIWatch","url":"https://ai-watch.dev"},"url":"https://ai-watch.dev/plugin"}
</script>
<style>
:root{--bg0:#080c10;--bg1:#0d1117;--bg2:#131a22;--bg3:#1b2530;--border:#21262d;--border-hi:#30363d;--text0:#e6edf3;--text1:#adbac7;--text2:#768390;--green:#3fb950;--amber:#d29922;--red:#f85149;--blue:#58a6ff;--purple:#a371f7;--font-mono:ui-monospace,SFMono-Regular,Menlo,monospace;--font:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;}
*{box-sizing:border-box;margin:0;padding:0;}
body{background:var(--bg0);color:var(--text0);font-family:var(--font);line-height:1.6;-webkit-font-smoothing:antialiased;}
a{color:var(--blue);text-decoration:none;}a:hover{text-decoration:underline;}
.wrap{max-width:760px;margin:0 auto;padding:48px 20px 80px;}
.topbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:40px;}
.nav-logo{display:flex;align-items:center;gap:10px;font-family:var(--font-mono);font-size:15px;font-weight:600;letter-spacing:-0.3px;color:var(--text0);}
.nav-logo:hover{text-decoration:none;}
.nav-logo .nav-word{color:var(--text0);}
.nav-logo .nav-green{color:var(--green);}
.nav-logo img{border-radius:4px;display:block;}
.topbar-links{font-size:12px;}
.konote{border:1px solid var(--border);background:var(--bg2);border-radius:8px;padding:10px 14px;font-size:11px;color:var(--text2);margin-bottom:28px;line-height:1.6;}
h1{font-size:30px;line-height:1.2;letter-spacing:-0.02em;margin-bottom:14px;}
.lede{font-size:16px;color:var(--text1);margin-bottom:8px;}
.tag{display:inline-block;font-family:var(--font-mono);font-size:11px;color:var(--purple);border:1px solid var(--border-hi);border-radius:20px;padding:3px 11px;margin-bottom:20px;}
section{margin-top:40px;}
h2{font-size:19px;margin-bottom:14px;letter-spacing:-0.01em;}
h3{font-size:14px;color:var(--text0);margin-bottom:5px;}
p{color:var(--text1);margin-bottom:12px;}
.feat{border:1px solid var(--border);background:var(--bg1);border-radius:10px;padding:16px 18px;margin-bottom:12px;}
.feat p{color:var(--text2);font-size:13px;margin:0;}
code,.cmd{font-family:var(--font-mono);}
code{background:var(--bg2);border:1px solid var(--border);border-radius:4px;padding:1px 5px;font-size:12px;color:var(--text0);}
.cmd{display:block;background:var(--bg0);border:1px solid var(--border);border-radius:8px;padding:13px 15px;font-size:12.5px;color:var(--text0);white-space:pre;overflow-x:auto;line-height:1.7;}
.install{margin-top:8px;}
.install-note{color:var(--amber);font-size:13px;}
.mkt-link{display:inline-block;margin-top:10px;font-size:13px;}
.eg{border:1px solid var(--border);background:var(--bg0);border-radius:8px;padding:13px 15px;font-family:var(--font-mono);font-size:12px;color:var(--text1);white-space:pre-wrap;line-height:1.7;}
ul.caveats{list-style:disc;padding-left:20px;color:var(--text2);font-size:13px;line-height:1.8;}
.footer{margin-top:56px;padding-top:20px;border-top:1px solid var(--border);font-size:12px;color:var(--text2);}
</style>
</head>
<body>
<div class="wrap">
  <div class="topbar">
    <a href="https://ai-watch.dev" class="nav-logo"><img src="data:image/png;base64,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" alt="AIWatch" width="28" height="28"><span class="nav-word">AI<span class="nav-green">Watch</span></span></a>
    <div class="topbar-links"><a href="https://ai-watch.dev">Dashboard</a> · <a href="https://ai-watch.dev/#statusline">Statusline</a></div>
  </div>

  <div class="konote">이 페이지는 영문으로만 제공됩니다 — 설치 명령(<code>/plugin</code>) 위주라 영어로 유지했습니다. 플러그인 동작은 한국어 환경에서도 동일합니다.</div>

  <span class="tag">Claude Code plugin · Beta</span>
  <h1>Know the moment an AI service breaks — inside Claude Code</h1>
  <p class="lede">A background monitor that pings you when Claude, OpenAI, Gemini, or any monitored service goes <strong>down</strong> (and again when it <strong>recovers</strong>), plus an <code>/aiwatch</code> command that briefs the current incident. It answers <em>"is it me, or is the service down?"</em> without leaving your terminal.</p>
  <p style="font-size:13px;color:var(--text2)">The plugin reads <strong>no</strong> code and collects <strong>no</strong> data — it only polls <a href="https://ai-watch.dev">AIWatch</a>'s public status feed.</p>

  <section>
    <h2>What you get</h2>
    <div class="feat">
      <h3>🔔 Outage monitor (background)</h3>
      <p>Runs quietly and notifies Claude when a service changes state — <span style="color:var(--text0)">🔴 Claude API is down</span>, then <span style="color:var(--text0)">✅ Claude API has recovered</span> — naming each service. It checks AIWatch every <strong>60 seconds</strong> by default (set <code>AIWATCH_POLL_SECONDS</code> to change it) and only speaks up on a real transition, so it never spams. You find out an outage is upstream <em>before</em> you burn time debugging your own code.</p>
    </div>
    <div class="feat">
      <h3>⌨️ <code>/aiwatch</code> command</h3>
      <p>On demand, briefs which services are degraded/down right now — each with its active incident, an AI summary, a fallback suggestion, and a link to the status page. Or a one-liner when all is clear.</p>
    </div>
  </section>

  <section>
    <h2>Install</h2>
    ${renderPluginInstall(PLUGIN_MARKETPLACE_URL)}
    <p style="font-size:12px;color:var(--text2);margin-top:12px">Requires Claude Code v2.1.105+ (the background monitor is an interactive-session feature). Prefer a status bar instead? See the <a href="https://ai-watch.dev/#statusline">statusline guide</a>.</p>
  </section>

  <section>
    <h2>What a briefing looks like</h2>
    <div class="eg">🔴 Claude API (down) — "Elevated error rates on the Messages API" · major impact
   AI: Likely a capacity issue; ~30–60 min historical recovery.
   Try instead: OpenAI, Gemini
   ↳ https://ai-watch.dev/p/claude</div>
  </section>

  <section>
    <h2>Privacy</h2>
    <ul class="caveats">
      <li>No page or code content is read — the plugin only sends a <code>GET</code> to AIWatch's public, unauthenticated status endpoint.</li>
      <li>No identifier is collected. AIWatch measures only anonymous, aggregate poll volume.</li>
    </ul>
    <p style="font-size:13px;margin-top:8px"><a href="/plugin-privacy">Full privacy policy →</a></p>
  </section>

  <div class="footer">
    AIWatch is open-source under AGPL-3.0 · <a href="https://github.com/bentleypark/aiwatch" target="_blank" rel="noopener" data-ga="plugin_github">GitHub</a> · <a href="https://ai-watch.dev">Dashboard</a>
  </div>
</div>

<script${nonceAttr(nonce)}>
(function(){
  // Delegated GA4 click tracking — CSP-clean (no inline handlers). Fires only after consent
  // (gtag is a no-op until the cookie banner grants analytics_storage).
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-ga]') : null;
    if (!el || typeof gtag !== 'function') return;
    gtag('event', el.getAttribute('data-ga'), { page: 'plugin' });
  });
})();
</script>
${cookieBannerHtml(nonce)}
</body>
</html>`
}
