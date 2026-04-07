// SSR HTML template for Product Hunt landing page

interface LandingOptions {
  showPHBanner: boolean
}

export function renderLandingPage(opts: LandingOptions): string {
  const phDisplay = opts.showPHBanner ? 'block' : 'none'
  const reportUrl = 'https://reports.ai-watch.dev/'
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<title>AIWatch — Real-time AI Service Monitoring</title>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-D4ZWVHQ7JK"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-D4ZWVHQ7JK');</script>
<meta name="description" content="Track Claude, OpenAI, Gemini, Cursor and more. AI analyzes incidents and recommends fallback options instantly. Free.">
<meta property="og:type" content="website">
<meta property="og:url" content="https://ai-watch.dev/intro">
<meta property="og:title" content="AIWatch — Real-time AI Service Monitoring">
<meta property="og:description" content="Track Claude, OpenAI, Gemini, Cursor and more. AI analyzes incidents and recommends fallback options instantly. Free.">
<meta property="og:image" content="https://ai-watch.dev/og-intro.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:locale" content="en_US">
<meta property="og:site_name" content="AIWatch">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="AIWatch — Real-time AI Service Monitoring">
<meta name="twitter:description" content="Track Claude, OpenAI, Gemini, Cursor and more. AI analyzes incidents and recommends fallback options instantly. Free.">
<meta name="twitter:image" content="https://ai-watch.dev/og-intro.png">
<link rel="canonical" href="https://ai-watch.dev/intro">
<meta name="theme-color" content="#080c10">
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "WebApplication",
  "name": "AIWatch",
  "url": "https://ai-watch.dev",
  "description": "Real-time status monitoring for 30 AI services including Claude, ChatGPT, Gemini, and Cursor. AI-powered incident analysis with fallback recommendations.",
  "applicationCategory": "DeveloperApplication",
  "operatingSystem": "Web",
  "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
  "screenshot": "https://ai-watch.dev/og-intro.png"
}
</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&family=Pretendard:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg0: #080c10; --bg1: #0d1117; --bg2: #161b22; --bg3: #1c2128;
    --text0: #e6edf3; --text1: #adbac7; --text2: #8b949e;
    --green: #3fb950; --green-dim: #1a3d25;
    --blue: #58a6ff; --amber: #e86235; --yellow: #faa72a; --red: #f85149;
    --border: #30363d; /* opaque equivalent for SSR — production uses rgba(255,255,255,0.07) */
    --font-mono: 'JetBrains Mono', monospace;
    --font-sans: 'Pretendard', -apple-system, sans-serif;
  }
  html { scroll-behavior: smooth; }
  body { background: var(--bg0); color: var(--text0); font-family: var(--font-sans); font-size: 15px; line-height: 1.7; -webkit-font-smoothing: antialiased; }
  .page-wrap { overflow-x: clip; max-width: 100vw; }
  a { color: inherit; text-decoration: none; }

  /* NAV */
  nav { position: sticky; top: 0; z-index: 100; background: rgba(8,12,16,0.85); backdrop-filter: blur(12px); border-bottom: 1px solid var(--border); padding: 0 24px; height: 56px; display: flex; align-items: center; justify-content: space-between; }
  .nav-logo { display: flex; align-items: center; gap: 10px; font-family: var(--font-mono); font-size: 15px; font-weight: 500; }
  .nav-logo span { color: var(--green); }
  .logo-icon { width: 28px; height: 28px; background: var(--bg0); border-radius: 6px; display: flex; align-items: center; justify-content: center; border: 1px solid var(--border); }
  .nav-right { display: flex; align-items: center; gap: 20px; }
  .nav-links { display: flex; align-items: center; gap: 20px; }
  .nav-links a { font-size: 13px; color: var(--text2); transition: color 0.2s; }
  .nav-links a:hover { color: var(--text0); }

  /* LANG TOGGLE */
  .lang-toggle { display: flex; background: var(--bg2); border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
  .lang-btn { font-family: var(--font-mono); font-size: 11px; padding: 5px 10px; cursor: pointer; border: none; background: transparent; color: var(--text2); transition: all 0.2s; }
  .lang-btn.active { background: var(--green); color: var(--bg0); font-weight: 500; }

  .nav-cta { background: var(--green); color: var(--bg0) !important; font-size: 13px !important; font-weight: 500; padding: 6px 16px; border-radius: 6px; transition: opacity 0.2s !important; white-space: nowrap; }
  .nav-cta:hover { opacity: 0.85; }

  /* HERO */

  /* HERO 2-COLUMN */
  .hero-outer { border-bottom: 1px solid var(--border); }
  .hero-2col { max-width: 1100px; margin: 0 auto; padding: 80px 40px 60px; display: grid; grid-template-columns: 1fr 420px; gap: 60px; align-items: center; }
  .hero-left { text-align: left; }
  .hero-left h1 { font-size: clamp(28px, 4vw, 44px); font-weight: 600; line-height: 1.2; margin-bottom: 20px; animation: fadeInUp 0.6s ease 0.1s both; }
  .hero-left h1 em { font-style: normal; color: var(--green); }
  .hero-left p { font-size: 15px; color: var(--text1); max-width: 480px; margin: 0 0 28px; animation: fadeInUp 0.6s ease 0.2s both; line-height: 1.7; }
  .hero-left .hero-ctas { justify-content: flex-start; animation: fadeInUp 0.6s ease 0.3s both; }
  .hero-left .hero-trust { text-align: left; margin-top: 14px; font-size: 12px; color: var(--text2); font-family: var(--font-mono); animation: fadeInUp 0.6s ease 0.4s both; }
  .hero-left .hero-inline-stats { justify-content: flex-start; margin-top: 16px; animation: fadeInUp 0.6s ease 0.5s both; }

  /* FLOW WIDGET */
  .hero-right { animation: fadeInUp 0.6s ease 0.3s both; }
  .flow-wrap { background: #0d1117; border: 1px solid var(--border); border-radius: 12px; padding: 20px; font-family: var(--font-mono); }
  .flow-step { opacity: 0.01; transform: translateY(8px); will-change: opacity, transform; -webkit-backface-visibility: hidden; }
  /* Cycling animation: staggered fade-in, hold, fade-out, repeat */
  @keyframes fc1 { 0%{opacity:0.01;transform:translateY(8px)} 5%{opacity:1;transform:translateY(0)} 80%{opacity:1;transform:translateY(0)} 90%{opacity:0.01;transform:translateY(8px)} 100%{opacity:0.01;transform:translateY(8px)} }
  @keyframes fc2 { 0%,13%{opacity:0.01;transform:translateY(8px)} 18%{opacity:1;transform:translateY(0)} 80%{opacity:1;transform:translateY(0)} 90%{opacity:0.01;transform:translateY(8px)} 100%{opacity:0.01;transform:translateY(8px)} }
  @keyframes fc3 { 0%,27%{opacity:0.01;transform:translateY(8px)} 32%{opacity:1;transform:translateY(0)} 80%{opacity:1;transform:translateY(0)} 90%{opacity:0.01;transform:translateY(8px)} 100%{opacity:0.01;transform:translateY(8px)} }
  @keyframes fc4 { 0%,40%{opacity:0.01;transform:translateY(8px)} 45%{opacity:1;transform:translateY(0)} 80%{opacity:1;transform:translateY(0)} 90%{opacity:0.01;transform:translateY(8px)} 100%{opacity:0.01;transform:translateY(8px)} }
  #fw1.show { animation: fc1 6s ease infinite; }
  #fw2.show { animation: fc2 6s ease infinite; }
  #fw3.show { animation: fc3 6s ease infinite; }
  #fw4.show { animation: fc4 6s ease infinite; }
  @media (prefers-reduced-motion: reduce) {
    .flow-step { opacity: 1; transform: none; }
    .flow-step.show { animation: none; }
    .fade-up { opacity: 1; transform: none; transition: none; }
  }
  .flow-card { border-radius: 8px; padding: 12px 14px; margin-bottom: 4px; }
  .flow-connector { display: flex; align-items: center; padding: 3px 16px; gap: 6px; }
  .flow-conn-line { width: 1px; height: 16px; background: #30363d; }
  .flow-conn-label { font-size: 10px; color: #444; letter-spacing: 0.06em; }
  .fc-detect { background: #1a0d0d; border: 1px solid #f85149; border-left: 3px solid #f85149; border-radius: 0; }
  .fc-ai { background: #0f0d1a; border: 1px solid #7c3aed; border-left: 3px solid #7c3aed; border-radius: 0; }
  .fc-alert { background: #0d1a0f; border: 1px solid #3fb950; border-left: 3px solid #3fb950; border-radius: 0; }
  .fc-fallback { background: #0d1519; border: 1px solid #1d9bd1; border-left: 3px solid #1d9bd1; border-radius: 0; }
  .flow-card-header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .flow-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
  .fd-red { background: #f85149; animation: fd-blink 1.2s infinite; }
  .fd-purple { background: #a78bfa; animation: fd-pulse 2s infinite; }
  .fd-green { background: #3fb950; }
  .fd-blue { background: #1d9bd1; }
  @keyframes fd-blink { 0%,100%{opacity:1} 50%{opacity:0.3} }
  @keyframes fd-pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }
  .flow-tag { font-size: 10px; letter-spacing: 0.06em; padding: 2px 7px; border-radius: 3px; font-weight: 500; }
  .ft-red { background: rgba(248,81,73,0.15); color: #f85149; }
  .ft-purple { background: rgba(124,58,237,0.15); color: #a78bfa; }
  .ft-green { background: rgba(63,185,80,0.15); color: #3fb950; }
  .ft-blue { background: rgba(29,155,209,0.15); color: #1d9bd1; }
  .flow-title { font-size: 12px; font-weight: 500; flex: 1; }
  .flow-body { font-size: 11px; color: #8b949e; line-height: 1.6; }
  .flow-body strong { color: #e6edf3; font-weight: 500; }
  .flow-mono { font-size: 10px; color: #adbac7; }
  .flow-bars { display: flex; align-items: center; gap: 5px; margin-top: 5px; }
  .flow-bar { height: 3px; border-radius: 2px; background: #7c3aed; animation: fbar 1.5s ease infinite; }
  .flow-bar:nth-child(2) { animation-delay: 0.2s; }
  .flow-bar:nth-child(3) { animation-delay: 0.4s; }
  @keyframes fbar { 0%,100%{opacity:0.3;width:16px} 50%{opacity:1;width:36px} }
  .flow-fallback-row { display: flex; align-items: center; gap: 8px; margin-top: 5px; }
  .flow-score { font-size: 10px; padding: 2px 7px; border-radius: 10px; background: rgba(63,185,80,0.12); color: #3fb950; font-weight: 500; }

  @media (max-width: 900px) {
    .hero-2col { grid-template-columns: 1fr; padding: 48px 24px 40px; gap: 32px; }
    .hero-left { text-align: center; }
    .hero-left .hero-ctas { justify-content: center; }
    .hero-left .hero-trust { text-align: center; }
    .hero-left .hero-inline-stats { justify-content: center; }
    .hero-left p { margin: 0 auto 28px; }
    .hero-left .hero-badge { display: inline-flex; }
    .hero-right { animation: none; opacity: 1; transform: none; }
  }



  .hero-badge { display: inline-flex; align-items: center; gap: 8px; background: var(--green-dim); border: 1px solid rgba(63,185,80,0.3); color: var(--green); font-family: var(--font-mono); font-size: 11px; padding: 4px 14px; border-radius: 20px; margin-bottom: 24px; }
  .hero-badge-dot { position: relative; width: 8px; height: 8px; flex-shrink: 0; }
  .hero-badge-dot::before { content: ''; position: absolute; inset: 0; background: var(--green); border-radius: 50%; animation: live-core 2s ease-in-out infinite; }
  .hero-badge-dot::after { content: ''; position: absolute; inset: -4px; background: rgba(63,185,80,0.35); border-radius: 50%; animation: live-ripple 2s ease-out infinite; }
  @keyframes live-core { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:0.7;transform:scale(0.85)} }
  @keyframes live-ripple { 0%{opacity:0.6;transform:scale(0.5)} 100%{opacity:0;transform:scale(2)} }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
  @keyframes fadeInUp { from{opacity:0;transform:translateY(16px)} to{opacity:1;transform:translateY(0)} }
  .hero h1 { font-size: clamp(28px, 5vw, 48px); font-weight: 600; line-height: 1.2; margin-bottom: 20px; animation: fadeInUp 0.6s ease 0.1s both; }
  .hero h1 em { font-style: normal; color: var(--green); }
  .hero p { font-size: 16px; color: var(--text1); max-width: 560px; margin: 0 auto 32px; animation: fadeInUp 0.6s ease 0.2s both; }
  .hero-ctas { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; animation: fadeInUp 0.6s ease 0.3s both; }

  /* BUTTONS */
  .btn-primary { background: var(--green); color: var(--bg0); font-weight: 500; font-size: 14px; padding: 10px 24px; border-radius: 8px; transition: opacity 0.2s, transform 0.2s; display: inline-flex; align-items: center; gap: 6px; }
  .btn-primary:hover { background: #52d168; transform: translateY(-1px); }
  .btn-secondary { background: transparent; color: var(--text1); font-size: 14px; padding: 10px 24px; border-radius: 8px; border: 1px solid var(--border); transition: border-color 0.2s, color 0.2s; display: inline-flex; align-items: center; gap: 6px; }
  .btn-secondary:hover { border-color: var(--text2); color: var(--text0); }

  /* STATS */

  /* SECTIONS */
  .demo-section, .how-section, .cta-section { padding: 64px 24px; }
  .demo-section { border-top: 1px solid var(--border); }
  .demo-inner { max-width: 900px; margin: 0 auto; }
  .how-section { border-top: 1px solid var(--border); }
  .how-section > * { max-width: 900px; margin-left: auto; margin-right: auto; }
  .cta-section { border-top: 1px solid var(--border); padding-top: 48px !important; padding-bottom: 48px !important; }
  .cta-section > * { max-width: 900px; margin-left: auto; margin-right: auto; }
  .features-section { border-top: 1px solid var(--border); padding: 64px 24px; }
  .features-inner { max-width: 900px; margin: 0 auto; }
  .section-label { font-family: var(--font-mono); font-size: 11px; color: var(--green); letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 8px; }
  .section-title { font-size: 24px; font-weight: 600; margin-bottom: 8px; overflow-wrap: break-word; }
  .section-sub { font-size: 14px; color: var(--text2); margin-bottom: 36px; overflow-wrap: break-word; }

  /* DASHBOARD MOCK */
  .dashboard-mock { background: var(--bg1); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; max-width: 100%; }
  .mock-nav { background: var(--bg1); border-bottom: 1px solid var(--border); padding: 10px 20px; display: flex; align-items: center; justify-content: space-between; }
  .mock-logo-row { display: flex; align-items: center; gap: 8px; font-family: var(--font-mono); font-size: 15px; font-weight: 600; letter-spacing: -0.3px; }
  .mock-logo-green { color: var(--green); }
  .mock-nav-center { font-family: var(--font-mono); font-size: 10px; color: var(--text2); display: flex; align-items: center; gap: 4px; }
  .mock-live-dot { display: inline-block; width: 5px; height: 5px; background: var(--green); border-radius: 50%; animation: mock-pulse 2s ease-in-out infinite; }
  @keyframes mock-pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
  .mock-nav-right { display: flex; align-items: center; gap: 8px; }
  .mock-analyze-mobile { display: none; }
  .mock-analyze-desktop { display: inline-flex; }
  .mock-nav-btn { font-family: var(--font-mono); font-size: 10px; color: var(--text2); background: var(--bg2); border: 1px solid var(--border); border-radius: 6px; padding: 4px 10px; display: flex; align-items: center; gap: 4px; }
  .mock-analyze-btn { background: #4c1d95; border-color: #7c3aed; color: #c4b5fd; }
  .mock-analyze-btn .mock-beta { font-size: 8px; background: rgba(124,58,237,0.3); padding: 1px 4px; border-radius: 2px; }
  .mock-analyze-btn .mock-count { color: #a78bfa; }
  .mock-body { padding: 16px 20px; }
  .mock-stats-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 16px; }
  .mock-stat-card { background: var(--bg1); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; position: relative; overflow: hidden; }
  .mock-stat-card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 1px; }
  .mock-stat-card.stat-green::before { background: var(--green); }
  .mock-stat-card.stat-amber::before { background: var(--amber); }
  .mock-stat-card.stat-red::before { background: var(--red); }
  .mock-stat-card.stat-blue::before { background: var(--blue); }
  .mock-stat-label { font-size: 9px; color: var(--text2); font-family: var(--font-mono); text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 6px; }
  .mock-stat-value { font-size: 26px; font-weight: 600; font-family: var(--font-mono); }
  .mock-stat-sub { font-size: 10px; color: var(--text2); font-family: var(--font-mono); margin-top: 2px; }
  .mock-section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
  .mock-section-title { font-family: var(--font-mono); font-size: 10px; color: var(--text2); text-transform: uppercase; letter-spacing: 0.1em; display: flex; align-items: center; gap: 6px; }
  .mock-section-title .green-slash { color: var(--green); font-weight: 600; }
  .mock-filter-tabs { display: flex; background: var(--bg2); border: 1px solid var(--border); border-radius: 6px; padding: 2px; gap: 1px; }
  .mock-filter-tab { font-family: var(--font-mono); font-size: 10px; padding: 4px 10px; border-radius: 4px; color: var(--text2); white-space: nowrap; }
  .mock-filter-tab.active { background: var(--bg3); color: var(--text0); }
  .mock-filter-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--amber); margin-left: 4px; vertical-align: middle; }
  .mock-cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .mock-card { background: var(--bg1); border: 1px solid var(--border); border-radius: 8px; padding: 14px; }
  .mock-card.degraded { border-left: 3px solid var(--amber); }
  .mock-card.ok { border-left: 3px solid var(--green); }
  .mock-card-header { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 8px; }
  .mock-card-name { font-size: 13px; font-weight: 500; color: var(--text0); }
  .mock-card-provider { font-size: 10px; color: var(--text2); font-family: var(--font-mono); margin-top: 1px; }
  .mock-card-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-bottom: 8px; }
  .mock-card-metric-val { font-size: 13px; font-weight: 500; font-family: var(--font-mono); }
  .mock-card-metric-label { font-size: 9px; color: var(--text2); font-family: var(--font-mono); letter-spacing: 0.04em; margin-top: 1px; }
  .mock-card-score { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .mock-card-score-label { font-size: 9px; color: var(--text2); font-family: var(--font-mono); }
  .mock-card-score-bar { flex: 1; height: 4px; background: var(--bg3); border-radius: 9999px; overflow: hidden; }
  .mock-card-score-fill { height: 100%; border-radius: 9999px; }
  .mock-card-score-badge { font-size: 10px; font-weight: 500; font-family: var(--font-mono); padding: 2px 6px; border-radius: 4px; }
  .mock-history { display: flex; gap: 2px; align-items: flex-end; height: 18px; }
  .mock-history span { flex: 1; border-radius: 4px; display: block; }
  .mock-badge { font-family: var(--font-mono); font-size: 10px; padding: 3px 8px; border-radius: 4px; white-space: nowrap; }
  .badge-ok { background: rgba(63,185,80,0.15); color: var(--green); }
  .badge-warn { background: rgba(210,153,34,0.15); color: var(--amber); }
  .mock-panel { background: var(--bg1); border: 1px solid var(--border); border-radius: 8px; margin-top: 12px; }
  .mock-panel-header { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid var(--border); }
  .mock-panel-title { font-family: var(--font-mono); font-size: 10px; color: var(--text1); text-transform: uppercase; letter-spacing: 0.05em; display: flex; align-items: center; gap: 6px; }
  .mock-panel-title .dot { width: 5px; height: 5px; border-radius: 50%; display: inline-block; }
  .mock-panel-sub { font-family: var(--font-mono); font-size: 9px; color: var(--text2); }
  .mock-panel-body { padding: 14px; }
  .mock-incident-row { display: flex; align-items: center; justify-content: space-between; padding: 6px 0; }
  .mock-incident-name { font-size: 12px; font-weight: 500; color: var(--text0); }
  .mock-incident-desc { font-size: 10px; color: var(--text2); font-family: var(--font-mono); }
  .mock-incident-status { font-size: 9px; font-family: var(--font-mono); color: var(--amber); }

  /* FEATURES */
  .feature-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; }
  .feature-card { background: var(--bg2); border: 1px solid var(--border); border-radius: 12px; padding: 24px; transition: border-color 0.2s; }
  .feature-card:hover { border-color: var(--text2); }
  .feature-icon { width: 36px; height: 36px; background: var(--green-dim); border-radius: 8px; display: flex; align-items: center; justify-content: center; margin-bottom: 14px; font-size: 16px; }
  .feature-title { font-size: 15px; font-weight: 500; margin-bottom: 6px; }
  .feature-desc { font-size: 13px; color: var(--text2); line-height: 1.7; }
  .feature-tag { display: inline-block; background: var(--green-dim); color: var(--green); font-size: 10px; font-family: var(--font-mono); padding: 2px 8px; border-radius: 4px; margin-bottom: 10px; }

  /* HOW */
  .how-grid { display: flex; align-items: flex-start; gap: 0; }
  .how-item { flex: 1; display: flex; flex-direction: column; align-items: center; text-align: center; position: relative; }
  .how-arrow { display: flex; align-items: center; padding-top: 28px; color: var(--border); font-size: 20px; flex-shrink: 0; }
  .how-icon-wrap { width: 64px; height: 64px; border-radius: 16px; background: var(--bg2); border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; margin-bottom: 16px; }
  .how-num { display: none; }
  .how-title { font-size: 14px; font-weight: 500; margin-bottom: 6px; }
  .how-desc { font-size: 12px; color: var(--text2); line-height: 1.6; max-width: 160px; }
  .how-badge { font-family: var(--font-mono); font-size: 10px; color: var(--green); background: var(--green-dim); border-radius: 4px; padding: 2px 8px; margin-bottom: 12px; }

  /* STACK */
  .stack-section { border-top: 1px solid var(--border); padding: 48px 24px; }
  .stack-inner { max-width: 900px; margin: 0 auto; display: flex; align-items: center; gap: 32px; flex-wrap: wrap; }
  .stack-label { font-family: var(--font-mono); font-size: 11px; color: var(--green); white-space: nowrap; letter-spacing: 0.1em; text-transform: uppercase; }
  .stack-pills { display: flex; flex-wrap: wrap; gap: 8px; }
  .stack-pill { background: var(--bg2); border: 1px solid var(--border); color: var(--text1); font-family: var(--font-mono); font-size: 12px; padding: 5px 12px; border-radius: 6px; display: inline-flex; align-items: center; gap: 6px; }
  .stack-pill svg { flex-shrink: 0; }

  /* CTA */
  .cta-box { background: var(--bg1); border: 1px solid var(--border); border-radius: 16px; padding: 36px; text-align: center; position: relative; overflow: hidden; }
  .cta-box::before { content: ''; position: absolute; top: 0; left: 50%; transform: translateX(-50%); width: 200px; height: 1px; background: linear-gradient(90deg, transparent, var(--green), transparent); }
  .cta-box h2 { font-size: 24px; font-weight: 600; margin-bottom: 10px; }
  .cta-box p { font-size: 14px; color: var(--text2); margin-bottom: 28px; }
  .cta-btns { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }

  /* FOOTER */
  footer { border-top: 1px solid var(--border); padding: 24px; }
  .footer-inner { max-width: 900px; margin: 0 auto; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; }
  .footer-left { font-size: 13px; color: var(--text2); font-family: var(--font-mono); }
  .footer-links { display: flex; gap: 20px; }
  .footer-links a { font-size: 13px; color: var(--text2); transition: color 0.2s; }
  .footer-links a:hover { color: var(--text0); }

  /* MOBILE */

  /* ALERT SECTION */
  .alert-section { border-top: 1px solid var(--border); padding: 64px 24px; }
  .alert-inner { max-width: 900px; margin: 0 auto; }
  .alert-grid { display: grid; grid-template-columns: 1fr; gap: 20px; margin-top: 36px; max-width: 560px; }
  .discord-wrap { background: #313338; border-radius: 10px; padding: 16px; }
  .slack-wrap { background: #1a1d21; border-radius: 10px; padding: 16px; }
  .app-header { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; padding-bottom: 10px; border-bottom: 1px solid rgba(255,255,255,0.06); }
  .app-header-icon { width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; }
  .app-channel { font-size: 12px; font-family: var(--font-mono); }
  .bot-msg { display: flex; gap: 10px; margin-bottom: 12px; }
  .bot-avatar { width: 36px; height: 36px; border-radius: 50%; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
  .slack-avatar-sq { border-radius: 6px !important; }
  .bot-body { flex: 1; min-width: 0; }
  .bot-name { font-size: 13px; font-weight: 500; margin-bottom: 1px; }
  .bot-time { font-size: 11px; font-weight: 400; margin-left: 6px; }
  .d-embed { border-radius: 0 4px 4px 0; padding: 10px 12px; margin-top: 4px; }
  .d-embed-title { font-size: 13px; font-weight: 600; margin-bottom: 6px; }
  .d-embed-text { font-size: 12px; line-height: 1.5; margin-bottom: 6px; }
  .d-embed-divider { height: 1px; margin: 8px 0; }
  .d-embed-key { font-size: 10px; font-family: var(--font-mono); text-transform: uppercase; margin-bottom: 3px; }
  .d-embed-val { font-size: 12px; font-family: var(--font-mono); }
  .d-embed-footer { font-size: 11px; margin-top: 6px; }
  .d-embed-link { font-size: 12px; text-decoration: none; }

  /* REPORT + AI ANALYSIS SECTIONS */
  .report-section { padding: 64px 24px; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
  .report-inner { max-width: 900px; margin: 0 auto; }
  .ai-section { border-top: 1px solid var(--border); padding: 64px 24px; }
  .ai-inner { max-width: 900px; margin: 0 auto; }
  .report-chart { background: var(--bg1); border: 1px solid var(--border); border-radius: 12px; padding: 24px; margin: 28px auto 0; overflow-x: auto; max-width: 560px; }
  .report-chart svg { display: block; width: 100%; height: auto; }
  .report-link { display: inline-flex; align-items: center; gap: 6px; color: var(--green); font-size: 14px; font-weight: 500; border-bottom: 1px solid rgba(63,185,80,0.3); padding-bottom: 2px; transition: border-color 0.2s; }
  .report-link:hover { border-color: var(--green); }
  .ai-card { background: var(--bg2); border: 1px solid var(--border); border-radius: 12px; padding: 24px; }
  .ai-analysis-mock { background: #0d1117; border: 1px solid #30363d; border-radius: 8px; padding: 16px; margin-top: 20px; border-left: 3px solid #7c3aed; }
  .ai-mock-title { font-size: 13px; font-weight: 500; color: #e6edf3; margin-bottom: 10px; }
  .ai-mock-body { font-size: 12px; color: #adbac7; line-height: 1.7; margin-bottom: 10px; }
  .ai-mock-meta { display: flex; gap: 16px; flex-wrap: wrap; }
  .ai-mock-chip { background: #1a1d21; border: 1px solid #30363d; border-radius: 4px; padding: 4px 10px; font-size: 11px; font-family: var(--font-mono); color: #adbac7; }
  .ai-mock-chip span { color: #3fb950; }
  @media (max-width: 768px) {
    .report-section { padding: 40px 20px; }
    .report-chart { padding: 12px 8px; border-radius: 8px; margin: 20px -8px; }
    .ai-section { padding: 40px 20px; }
  }


  /* COMPARISON */
  .compare-section { border-top: 1px solid var(--border); padding: 64px 24px; }
  .compare-inner { max-width: 900px; margin: 0 auto; }
  .compare-table { width: 100%; border-collapse: collapse; margin-top: 28px; }
  .compare-table th { font-size: 12px; font-family: var(--font-mono); font-weight: 500; padding: 10px 16px; text-align: left; border-bottom: 1px solid var(--border); }
  .compare-table th:first-child { color: var(--text2); }
  .compare-table th.col-old { color: var(--text2); }
  .compare-table th.col-new { color: var(--green); }
  .compare-table td { font-size: 13px; padding: 12px 16px; border-bottom: 1px solid var(--border); color: var(--text1); vertical-align: middle; }
  .compare-table td:first-child { color: var(--text2); font-size: 12px; }
  .compare-table tr:last-child td { border-bottom: none; }
  .compare-table .no { color: var(--text2); font-family: var(--font-mono); }
  .compare-table .yes { color: var(--green); font-family: var(--font-mono); font-weight: 500; }
  .compare-table .val-old { color: var(--text2); }
  .compare-table .val-new { color: var(--green); font-weight: 500; }
  @media (max-width: 768px) {
    .compare-section { padding: 40px 20px; }
    .compare-table td, .compare-table th { padding: 10px 10px; font-size: 12px; }
  }


  /* SCROLL ANIMATION */
  .fade-up { opacity: 0; transform: translateY(24px); transition: opacity 0.6s ease, transform 0.6s ease; will-change: opacity, transform; -webkit-backface-visibility: hidden; }
  .fade-up.visible { opacity: 1; transform: translateY(0); }
  .fade-up.delay-1 { transition-delay: 0.1s; }
  .fade-up.delay-2 { transition-delay: 0.2s; }
  .fade-up.delay-3 { transition-delay: 0.3s; }
  .fade-up.delay-4 { transition-delay: 0.4s; }


  /* STATS PILLS */
  .hero-pills { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; justify-content: flex-start; }
  .stats-pills { border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); padding: 20px 32px; display: flex; align-items: center; justify-content: center; gap: 8px; flex-wrap: wrap; background: var(--bg1); }
  .stat-pill { display: inline-flex; align-items: center; gap: 6px; padding: 8px 16px; border: 1px solid var(--border); border-radius: 6px; font-family: var(--font-mono); font-size: 12px; color: var(--text2); background: var(--bg2); transition: border-color 0.2s, background 0.2s; }
  .stat-pill:hover { border-color: var(--green); background: rgba(63,185,80,0.05); }
  .stat-pill-num { color: var(--green); font-size: 15px; font-weight: 700; }
  .stat-pill-sep { color: var(--border); font-size: 16px; }
  @media (max-width: 768px) {
    .hero-pills { justify-content: center; }
  .stats-pills { padding: 16px 20px; gap: 6px; }
    .stat-pill { padding: 6px 12px; font-size: 11px; }
  }
  @media (min-width: 901px) {
    .hero-sub-line { display: inline; }
  }
  @media (max-width: 900px) {
    .hero-sub-line { display: block; }
  }

  @media (max-width: 768px) {
    /* Nav */
    .nav-links { display: none; }
    .nav-right { gap: 10px; }
    .nav-cta { padding: 6px 12px; font-size: 12px !important; }

    /* Hero */
    .hero-ctas { flex-direction: column; align-items: center; }
    .btn-primary, .btn-secondary { width: 100%; max-width: 280px; justify-content: center; }

    /* Dashboard mock mobile */
    .demo-section, .how-section, .cta-section { padding: 40px 20px; }
    .demo-section { padding: 32px 16px; }
    .dashboard-mock { overflow-x: hidden; border-radius: 8px; }
    .mock-nav { padding: 8px 12px; }
    .mock-nav-center { font-size: 9px; }
    .mock-nav-btn span { display: none; }
    .mock-nav-btn { padding: 0; border: none; background: none !important; }
    .mock-analyze-mobile { display: inline-block; }
    .mock-analyze-desktop { display: none !important; }
    .mock-body { padding: 12px; }
    .mock-stats-row { grid-template-columns: repeat(2, 1fr); }
    .mock-stat-card { padding: 8px 10px; }
    .mock-stat-value { font-size: 16px; }
    .mock-stat-label { font-size: 9px; }
    .mock-cards { grid-template-columns: 1fr; }
    .mock-card { padding: 10px 12px; }
    .mock-card-header { margin-bottom: 4px; }
    .mock-card-name { font-size: 12px; }
    .mock-card-grid { display: none; }
    .mock-card-score { display: none; }
    .mock-card-compact { display: flex !important; }
    .mock-history { height: 10px; transform: scaleY(0.55); transform-origin: bottom; }
    .mock-badge { font-size: 9px; padding: 2px 6px; }
    .mock-filter-tabs { display: none; }
    .mock-panel { display: none; }

    /* Features */
    .features-section { padding: 40px 20px; }
    .feature-grid { grid-template-columns: 1fr; }

    /* How */
    .how-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; }
    .how-arrow { display: none; }
    .how-item { padding: 16px; background: var(--bg2); border: 1px solid var(--border); border-radius: 12px; }
    .how-icon-wrap { width: 48px; height: 48px; margin-bottom: 10px; }
    .how-desc { max-width: 100%; }

    /* Stack */
    .stack-section { padding: 32px 20px; }
    .stack-inner { flex-direction: column; align-items: flex-start; gap: 16px; }

    /* CTA */
    .cta-box { padding: 32px 20px; }
    .cta-btns { flex-direction: column; align-items: center; }

    /* Footer */
    .footer-inner { flex-direction: column; align-items: flex-start; gap: 16px; }
    .footer-links { flex-wrap: wrap; gap: 12px; }
  }
</style>
</head>
<body>
<div class="page-wrap">

<!-- PH BANNER -->
<div id="ph-banner" style="display:${phDisplay};background:var(--green-dim);border-bottom:1px solid rgba(63,185,80,0.3);padding:10px 24px;text-align:center;">
  <a href="https://www.producthunt.com/posts/ai-watch" target="_blank" rel="noopener" onclick="typeof gtag==='function'&&gtag('event','click_ph_upvote',{location:'landing_banner'})" style="font-size:13px;color:var(--green);font-family:var(--font-mono);text-decoration:none;">
    👋 Welcome, Product Hunters! &nbsp;·&nbsp; If AIWatch is useful, <strong style="text-decoration:underline;text-underline-offset:3px;">an upvote means the world to us</strong> 🙏
  </a>
</div>

<nav>
  <div class="nav-logo">
    <div class="logo-icon">
      <img src="/favicon.png" alt="AIWatch logo" width="24" height="24" style="border-radius:4px;">
    </div>
    AI<span>Watch</span>
  </div>
  <div class="nav-right">
    <div class="nav-links">
      <a href="#how" data-i18n="nav.how">동작 방식</a>
      <a href="#features" data-i18n="nav.features">기능</a>
      <a href="https://reports.ai-watch.dev" data-i18n="nav.report">월간 리포트</a>
      <a href="https://github.com/bentleypark/aiwatch">GitHub</a>
    </div>
    <div class="lang-toggle">
      <button class="lang-btn active" onclick="setLang('ko')">KO</button>
      <button class="lang-btn" onclick="setLang('en')">EN</button>
    </div>
    <a href="https://ai-watch.dev" class="nav-cta" data-i18n="nav.cta" onclick="gtag('event','click_dashboard',{location:'landing_nav',source:'intro'})">대시보드 열기 →</a>
  </div>
</nav>

<section class="hero-outer">
<div class="hero-2col">
  <div class="hero-left">
    <div class="hero-badge"><span class="hero-badge-dot"></span><span data-i18n="hero.badge">LIVE MONITORING</span></div>
    <h1 data-i18n="hero.title">지금 <em>Claude</em>가<br>나만 안 되는 건가요?</h1>
    <p data-i18n="hero.sub">Claude, OpenAI, Gemini, Cursor 등 주요 AI 서비스<span class="hero-sub-line"> 상태를 한눈에 확인하세요.</span> 장애 발생 시 AI가 원인을 분석하고 대안을 즉시 추천합니다.</p>
    <div class="hero-ctas">
      <a href="https://ai-watch.dev" class="btn-primary" data-i18n="hero.cta1" onclick="gtag('event','click_dashboard',{location:'landing_hero',source:'intro'})">지금 장애 확인하기 →</a>
      <a href="https://github.com/bentleypark/aiwatch" target="_blank" rel="noopener noreferrer" class="btn-secondary" data-i18n="hero.cta2" onclick="gtag('event','click_github_header',{location:'landing_hero',source:'intro'})">GitHub에서 보기</a>
    </div>
    <p class="hero-trust" data-i18n="hero.trust">로그인 없음 · 10초 만에 확인 · 완전 무료 오픈소스</p>
    <div class="hero-pills">
      <div class="stat-pill"><span class="stat-pill-num">30</span> <span data-i18n="hero.pill1">AI 서비스</span></div>
      <div class="stat-pill"><span class="stat-pill-num" data-i18n="hero.pill2v">실시간</span> <span data-i18n="hero.pill2">알림</span></div>
      <div class="stat-pill"><span class="stat-pill-num">AGPL</span> <span data-i18n="hero.pill3">오픈소스</span></div>
    </div>
  </div>
  <div class="hero-right">
  <div class="flow-wrap">
    <div class="flow-step" id="fw1">
      <div class="flow-card fc-detect">
        <div class="flow-card-header">
          <span class="flow-dot fd-red"></span>
          <span class="flow-title" style="color:#f85149;" data-i18n="flow.1.title">장애 감지</span>
          <span class="flow-tag ft-red">INCIDENT</span>
        </div>
        <div class="flow-body">
          <strong>Claude API</strong> — Elevated error rates on Opus 4.6<br>
          <span class="flow-mono">status: degraded · detected at 14:23 UTC</span>
        </div>
      </div>
    </div>
    <div class="flow-step" id="fw2">
      <div class="flow-connector"><div class="flow-conn-line"></div><span class="flow-conn-label" data-i18n="flow.2.conn">AI 분석 시작</span></div>
      <div class="flow-card fc-ai">
        <div class="flow-card-header">
          <span class="flow-dot fd-purple"></span>
          <span class="flow-title" style="color:#a78bfa;">AI Analysis</span>
          <span class="flow-tag ft-purple">BETA</span>
        </div>
        <div class="flow-body">
          Model-specific outage · 3 similar incidents in 30 days
          <div class="flow-bars">
            <div class="flow-bar"></div>
            <div class="flow-bar"></div>
            <div class="flow-bar"></div>
            <span style="font-size:10px;color:#555;" data-i18n="flow.2.bar">패턴 분석 중</span>
          </div>
          <span class="flow-mono">⏱ Est. recovery: 30–90 min</span>
        </div>
      </div>
    </div>
    <div class="flow-step" id="fw3">
      <div class="flow-connector"><div class="flow-conn-line"></div><span class="flow-conn-label" data-i18n="flow.3.conn">Discord · Slack 발송</span></div>
      <div class="flow-card fc-alert">
        <div class="flow-card-header">
          <span class="flow-dot fd-green"></span>
          <span class="flow-title" style="color:#3fb950;" data-i18n="flow.3.title">알림 발송</span>
          <span class="flow-tag ft-green">SENT</span>
        </div>
        <div class="flow-body">
          <span data-i18n="flow.3.body">Discord · Slack 알림 전송 완료</span><br>
          <span class="flow-mono">AIWatch Worker · 14:23 UTC</span>
        </div>
      </div>
    </div>
    <div class="flow-step" id="fw4">
      <div class="flow-connector"><div class="flow-conn-line"></div><span class="flow-conn-label" data-i18n="flow.4.conn">대안 추천</span></div>
      <div class="flow-card fc-fallback">
        <div class="flow-card-header">
          <span class="flow-dot fd-blue"></span>
          <span class="flow-title" style="color:#1d9bd1;" data-i18n="flow.4.title">Fallback 추천</span>
          <span class="flow-tag ft-blue">SUGGESTED</span>
        </div>
        <div class="flow-body">
          <div class="flow-fallback-row"><strong>OpenAI API</strong><span class="flow-score">Score 88</span></div>
          <div class="flow-fallback-row"><strong>Gemini API</strong><span class="flow-score">Score 78</span></div>
        </div>
      </div>
    </div>
  </div>
</div>
</div>
</section>

<section class="demo-section">
  <div class="demo-inner">
  <p class="section-label">// dashboard preview</p>
  <h2 class="section-title" data-i18n="demo.title">장애 파악부터 대안 선택까지</h2>
  <p class="section-sub" data-i18n="demo.sub">지금 어떤 서비스가 안정적인지, 장애 중이라면 대안은 무엇인지 한 화면에서 파악합니다</p>
  <div class="dashboard-mock">
    <!-- Topbar -->
    <div class="mock-nav">
      <div class="mock-logo-row">
        <img src="/favicon.png" alt="AIWatch logo" width="26" height="26" style="border-radius:4px;">
        <span>AI<span class="mock-logo-green">Watch</span></span>
      </div>
      <div class="mock-nav-center">
        <span class="mock-live-dot"></span>
        <span>LIVE · 14:45</span>
      </div>
      <div class="mock-nav-right">
        <!-- GitHub -->
        <span class="mock-nav-btn" style="gap:4px;">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="var(--text2)"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
          <span style="font-size:10px;">GitHub</span>
        </span>
        <!-- Refresh -->
        <span class="mock-nav-btn" style="gap:4px;">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M14 8A6 6 0 114.5 3.5" stroke="var(--text2)" stroke-width="1.4" stroke-linecap="round"/><path d="M4.5 0.5v3h3" stroke="var(--text2)" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span style="font-size:10px;">Refresh</span>
        </span>
        <!-- Analyze — mobile: icon + green dot, desktop: btn-topbar -->
        <span class="mock-analyze-mobile" style="position:relative;font-size:14px;cursor:pointer;">🤖<span style="position:absolute;top:-2px;right:-2px;width:6px;height:6px;background:var(--green);border-radius:50%;"></span></span>
        <span class="mock-analyze-desktop mock-nav-btn" style="border-color:var(--border);background:transparent;">🤖 Analyze <span style="font-size:8px;color:#a78bfa;background:rgba(124,58,237,0.15);padding:1px 4px;border-radius:3px;vertical-align:middle;position:relative;top:-1px;">Beta</span></span>
        <!-- Settings -->
        <span class="mock-nav-btn" style="padding:5px 8px;">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M6.5 1.5h3l.4 1.7a5.5 5.5 0 011.3.7l1.6-.6 1.5 2.6-1.2 1.1a5.5 5.5 0 010 1.5l1.2 1.1-1.5 2.6-1.6-.6a5.5 5.5 0 01-1.3.7l-.4 1.7h-3l-.4-1.7a5.5 5.5 0 01-1.3-.7l-1.6.6-1.5-2.6 1.2-1.1a5.5 5.5 0 010-1.5L2.7 5.9l1.5-2.6 1.6.6a5.5 5.5 0 011.3-.7z" stroke="var(--text2)" stroke-width="1.2" stroke-linejoin="round"/><circle cx="8" cy="8" r="2" stroke="var(--text2)" stroke-width="1.2"/></svg>
          <span style="font-size:10px;">Settings</span>
        </span>
      </div>
    </div>
    <div class="mock-body">
      <!-- Stats Cards -->
      <div class="mock-stats-row">
        <div class="mock-stat-card stat-green"><div class="mock-stat-value" style="color:var(--green);">29</div><div class="mock-stat-sub">services running</div></div>
        <div class="mock-stat-card stat-amber"><div class="mock-stat-value" style="color:var(--amber);">1</div><div class="mock-stat-sub">partially affected</div></div>
        <div class="mock-stat-card stat-red"><div class="mock-stat-value" style="color:var(--red);">0</div><div class="mock-stat-sub">—</div></div>
        <div class="mock-stat-card stat-blue"><div class="mock-stat-value" style="color:var(--blue);">99.6%</div><div class="mock-stat-sub">Overall average</div></div>
      </div>
      <!-- Action Banner -->
      <div style="background:var(--bg1);border:1px solid var(--border);border-left:3px solid var(--amber);border-radius:8px;padding:10px 14px;margin-bottom:16px;line-height:1.5;">
        <div style="font-size:13px;font-weight:500;color:var(--text0);">⚠️ Degraded <span style="color:var(--amber);">(1)</span>: Claude API</div>
        <div style="font-size:11px;font-family:var(--font-mono);margin-top:3px;">
          👉 <span style="color:var(--blue);cursor:pointer;">View incident details</span>
        </div>
        <div style="font-size:11px;color:var(--text2);font-family:var(--font-mono);margin-top:4px;">
          Suggested fallback: <span style="color:var(--text2);">API → </span><span style="color:var(--green);">OpenAI API (88)</span>, <span style="color:var(--green);">Gemini API (78)</span>
        </div>
      </div>
      <!-- Section Header + Filter -->
      <div class="mock-section-header">
        <div class="mock-section-title"><span class="green-slash">//</span> Services</div>
        <div class="mock-filter-tabs">
          <span class="mock-filter-tab active">All 30</span>
          <span class="mock-filter-tab">Operational 29</span>
          <span class="mock-filter-tab">Issues 1<span class="mock-filter-dot"></span></span>
        </div>
      </div>
      <!-- Service Cards -->
      <div class="mock-cards">
        <!-- Claude API — degraded -->
        <div class="mock-card degraded">
          <div class="mock-card-header">
            <div><div class="mock-card-name">Claude API</div><div class="mock-card-provider">Anthropic</div></div>
            <span class="mock-badge badge-warn">PARTIAL OUTAGE</span>
          </div>
          <div class="mock-card-grid">
            <div><div class="mock-card-metric-val" style="color:var(--green);">145ms</div><div class="mock-card-metric-label">status page</div></div>
            <div><div class="mock-card-metric-val" style="color:var(--amber);">99.34%</div><div class="mock-card-metric-label">uptime</div></div>
            <div><div class="mock-card-metric-val" style="color:var(--text0);">1</div><div class="mock-card-metric-label">incidents</div></div>
          </div>
          <div class="mock-card-score">
            <span class="mock-card-score-label">Score</span>
            <div class="mock-card-score-bar"><div class="mock-card-score-fill" style="width:62%;background:var(--yellow);"></div></div>
            <span class="mock-card-score-badge" style="background:var(--yellow);color:var(--bg0);">62 fair</span>
          </div>
          <div class="mock-history">
            <span style="height:15px;background:var(--green);opacity:0.6;"></span><span style="height:18px;background:var(--green);opacity:0.6;"></span>
            <span style="height:13px;background:var(--green);opacity:0.6;"></span><span style="height:16px;background:var(--green);opacity:0.6;"></span>
            <span style="height:12px;background:var(--green);opacity:0.6;"></span><span style="height:17px;background:var(--green);opacity:0.6;"></span>
            <span style="height:14px;background:var(--green);opacity:0.6;"></span><span style="height:7px;background:var(--amber);opacity:0.8;"></span>
            <span style="height:4px;background:var(--amber);opacity:0.8;"></span><span style="height:16px;background:var(--green);opacity:0.6;"></span>
            <span style="height:18px;background:var(--green);opacity:0.6;"></span><span style="height:14px;background:var(--green);opacity:0.6;"></span>
            <span style="height:15px;background:var(--green);opacity:0.6;"></span><span style="height:12px;background:var(--green);opacity:0.6;"></span>
            <span style="height:17px;background:var(--green);opacity:0.6;"></span><span style="height:13px;background:var(--green);opacity:0.6;"></span>
            <span style="height:16px;background:var(--green);opacity:0.6;"></span><span style="height:18px;background:var(--green);opacity:0.6;"></span>
            <span style="height:5px;background:var(--amber);opacity:0.8;"></span><span style="height:15px;background:var(--green);opacity:0.6;"></span>
            <span style="height:14px;background:var(--green);opacity:0.6;"></span><span style="height:17px;background:var(--green);opacity:0.6;"></span>
            <span style="height:12px;background:var(--green);opacity:0.6;"></span><span style="height:18px;background:var(--green);opacity:0.6;"></span>
            <span style="height:16px;background:var(--green);opacity:0.6;"></span><span style="height:13px;background:var(--green);opacity:0.6;"></span>
            <span style="height:15px;background:var(--green);opacity:0.6;"></span><span style="height:6px;background:var(--amber);opacity:0.8;"></span>
            <span style="height:17px;background:var(--green);opacity:0.6;"></span><span style="height:14px;background:var(--green);opacity:0.6;"></span>
          </div>
          <!-- Mobile compact -->
          <div class="mock-card-compact" style="display:none;align-items:center;justify-content:space-between;font-family:var(--font-mono);font-size:10px;color:var(--text2);">
            <span>99.34% · 1 inc · 62 fair</span>
          </div>
        </div>
        <!-- OpenAI API — operational -->
        <div class="mock-card ok">
          <div class="mock-card-header">
            <div><div class="mock-card-name">OpenAI API</div><div class="mock-card-provider">OpenAI</div></div>
            <span class="mock-badge badge-ok">OPERATIONAL</span>
          </div>
          <div class="mock-card-grid">
            <div><div class="mock-card-metric-val" style="color:var(--green);">89ms</div><div class="mock-card-metric-label">status page</div></div>
            <div><div class="mock-card-metric-val" style="color:var(--green);">99.99%</div><div class="mock-card-metric-label">uptime</div></div>
            <div><div class="mock-card-metric-val" style="color:var(--text0);">0</div><div class="mock-card-metric-label">incidents</div></div>
          </div>
          <div class="mock-card-score">
            <span class="mock-card-score-label">Score</span>
            <div class="mock-card-score-bar"><div class="mock-card-score-fill" style="width:86%;background:var(--green);"></div></div>
            <span class="mock-card-score-badge" style="background:var(--green);color:var(--bg0);">86 excellent</span>
          </div>
          <div class="mock-history">
            <span style="height:17px;background:var(--green);opacity:0.6;"></span><span style="height:13px;background:var(--green);opacity:0.6;"></span>
            <span style="height:18px;background:var(--green);opacity:0.6;"></span><span style="height:15px;background:var(--green);opacity:0.6;"></span>
            <span style="height:12px;background:var(--green);opacity:0.6;"></span><span style="height:16px;background:var(--green);opacity:0.6;"></span>
            <span style="height:18px;background:var(--green);opacity:0.6;"></span><span style="height:14px;background:var(--green);opacity:0.6;"></span>
            <span style="height:17px;background:var(--green);opacity:0.6;"></span><span style="height:15px;background:var(--green);opacity:0.6;"></span>
            <span style="height:13px;background:var(--green);opacity:0.6;"></span><span style="height:18px;background:var(--green);opacity:0.6;"></span>
            <span style="height:16px;background:var(--green);opacity:0.6;"></span><span style="height:12px;background:var(--green);opacity:0.6;"></span>
            <span style="height:14px;background:var(--green);opacity:0.6;"></span><span style="height:18px;background:var(--green);opacity:0.6;"></span>
            <span style="height:17px;background:var(--green);opacity:0.6;"></span><span style="height:15px;background:var(--green);opacity:0.6;"></span>
            <span style="height:13px;background:var(--green);opacity:0.6;"></span><span style="height:16px;background:var(--green);opacity:0.6;"></span>
            <span style="height:18px;background:var(--green);opacity:0.6;"></span><span style="height:14px;background:var(--green);opacity:0.6;"></span>
            <span style="height:12px;background:var(--green);opacity:0.6;"></span><span style="height:17px;background:var(--green);opacity:0.6;"></span>
            <span style="height:15px;background:var(--green);opacity:0.6;"></span><span style="height:18px;background:var(--green);opacity:0.6;"></span>
            <span style="height:16px;background:var(--green);opacity:0.6;"></span><span style="height:13px;background:var(--green);opacity:0.6;"></span>
            <span style="height:14px;background:var(--green);opacity:0.6;"></span><span style="height:18px;background:var(--green);opacity:0.6;"></span>
          </div>
          <div class="mock-card-compact" style="display:none;align-items:center;justify-content:space-between;font-family:var(--font-mono);font-size:10px;color:var(--text2);">
            <span>99.99% · 0 inc · 86 excellent</span>
          </div>
        </div>
        <!-- Gemini API — operational -->
        <div class="mock-card ok">
          <div class="mock-card-header">
            <div><div class="mock-card-name">Gemini API</div><div class="mock-card-provider">Google</div></div>
            <span class="mock-badge badge-ok">OPERATIONAL</span>
          </div>
          <div class="mock-card-grid">
            <div><div class="mock-card-metric-val" style="color:var(--green);">112ms</div><div class="mock-card-metric-label">status page</div></div>
            <div><div class="mock-card-metric-val" style="color:var(--green);">99.97%</div><div class="mock-card-metric-label">uptime</div></div>
            <div><div class="mock-card-metric-val" style="color:var(--text0);">0</div><div class="mock-card-metric-label">incidents</div></div>
          </div>
          <div class="mock-card-score">
            <span class="mock-card-score-label">Score</span>
            <div class="mock-card-score-bar"><div class="mock-card-score-fill" style="width:78%;background:var(--green);"></div></div>
            <span class="mock-card-score-badge" style="background:var(--green);color:var(--bg0);">78 good</span>
          </div>
          <div class="mock-history">
            <span style="height:16px;background:var(--green);opacity:0.6;"></span><span style="height:13px;background:var(--green);opacity:0.6;"></span>
            <span style="height:18px;background:var(--green);opacity:0.6;"></span><span style="height:15px;background:var(--green);opacity:0.6;"></span>
            <span style="height:12px;background:var(--green);opacity:0.6;"></span><span style="height:17px;background:var(--green);opacity:0.6;"></span>
            <span style="height:14px;background:var(--green);opacity:0.6;"></span><span style="height:18px;background:var(--green);opacity:0.6;"></span>
            <span style="height:16px;background:var(--green);opacity:0.6;"></span><span style="height:13px;background:var(--green);opacity:0.6;"></span>
            <span style="height:15px;background:var(--green);opacity:0.6;"></span><span style="height:18px;background:var(--green);opacity:0.6;"></span>
            <span style="height:5px;background:var(--amber);opacity:0.8;"></span><span style="height:17px;background:var(--green);opacity:0.6;"></span>
            <span style="height:14px;background:var(--green);opacity:0.6;"></span><span style="height:12px;background:var(--green);opacity:0.6;"></span>
            <span style="height:16px;background:var(--green);opacity:0.6;"></span><span style="height:18px;background:var(--green);opacity:0.6;"></span>
            <span style="height:15px;background:var(--green);opacity:0.6;"></span><span style="height:13px;background:var(--green);opacity:0.6;"></span>
            <span style="height:17px;background:var(--green);opacity:0.6;"></span><span style="height:14px;background:var(--green);opacity:0.6;"></span>
            <span style="height:18px;background:var(--green);opacity:0.6;"></span><span style="height:16px;background:var(--green);opacity:0.6;"></span>
            <span style="height:12px;background:var(--green);opacity:0.6;"></span><span style="height:15px;background:var(--green);opacity:0.6;"></span>
            <span style="height:18px;background:var(--green);opacity:0.6;"></span><span style="height:17px;background:var(--green);opacity:0.6;"></span>
            <span style="height:13px;background:var(--green);opacity:0.6;"></span><span style="height:14px;background:var(--green);opacity:0.6;"></span>
          </div>
          <div class="mock-card-compact" style="display:none;align-items:center;justify-content:space-between;font-family:var(--font-mono);font-size:10px;color:var(--text2);">
            <span>99.97% · 0 inc · 78 good</span>
          </div>
        </div>
        <!-- More services -->
        <div class="mock-card ok" style="opacity:0.4;padding:10px 14px;grid-column:1/-1;">
          <div style="font-size:12px;color:var(--text2);text-align:center;" data-i18n="demo.more">+ 27개 서비스 더 보기...</div>
        </div>
      </div>
      <!-- Recent Incidents Panel -->
      <div class="mock-panel">
        <div class="mock-panel-header">
          <div class="mock-panel-title"><span class="dot" style="background:var(--red);"></span> RECENT INCIDENTS <span style="font-family:var(--font-mono);font-size:9px;color:var(--text2);margin-left:4px;">· Last 7 days</span></div>
        </div>
        <div class="mock-panel-body">
          <div class="mock-incident-row">
            <div>
              <div class="mock-incident-name">Claude API</div>
              <div class="mock-incident-desc">Elevated error rates on Opus 4.6 Fast Mode</div>
            </div>
            <div class="mock-incident-status">In Progress</div>
          </div>
        </div>
      </div>
    </div>
  </div>
  </div>
</section>

<section class="how-section" id="how">
  <p class="section-label">// how it works</p>
  <h2 class="section-title" data-i18n="how.title">이렇게 동작합니다</h2>
  <p class="section-sub" data-i18n="how.sub">각 서비스의 공식 상태 페이지 데이터를 기반으로 동작합니다</p>
  <div class="how-grid">

    <div class="how-item fade-up">
      <div class="how-badge">자동</div>
      <div class="how-icon-wrap">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#3fb950" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <path d="M12 6v6l4 2"/>
        </svg>
      </div>
      <div class="how-title" data-i18n="how.1.title">수집</div>
      <div class="how-desc" data-i18n="how.1.desc">공식 상태 페이지를 최대 5분 간격으로 자동 갱신</div>
    </div>

    <div class="how-arrow fade-up delay-1">→</div>

    <div class="how-item fade-up delay-1">
      <div class="how-badge">장애 감지 시</div>
      <div class="how-icon-wrap">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#3fb950" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3"/>
          <path d="M12 2v3M12 19v3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M2 12h3M19 12h3M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12"/>
        </svg>
      </div>
      <div class="how-title" data-i18n="how.2.title">분석</div>
      <div class="how-desc" data-i18n="how.2.desc">Claude Sonnet이 패턴 · 복구 시간 · 영향 범위 분석</div>
    </div>

    <div class="how-arrow fade-up delay-2">→</div>

    <div class="how-item fade-up delay-2">
      <div class="how-badge">즉시</div>
      <div class="how-icon-wrap">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#3fb950" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
          <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
        </svg>
      </div>
      <div class="how-title" data-i18n="how.3.title">알림</div>
      <div class="how-desc" data-i18n="how.3.desc">Discord · Slack 즉시 발송 + Fallback 추천 포함</div>
    </div>

    <div class="how-arrow fade-up delay-3">→</div>

    <div class="how-item fade-up delay-3">
      <div class="how-badge">매월</div>
      <div class="how-icon-wrap">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#3fb950" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="20" x2="18" y2="10"/>
          <line x1="12" y1="20" x2="12" y2="4"/>
          <line x1="6" y1="20" x2="6" y2="14"/>
        </svg>
      </div>
      <div class="how-title" data-i18n="how.4.title">리포트</div>
      <div class="how-desc" data-i18n="how.4.desc">월간 신뢰도 랭킹 · Score · 인시던트 통계 공개</div>
    </div>

  </div>
</section>

<section class="features-section" id="features">
  <div class="features-inner">
    <p class="section-label">// features</p>
    <h2 class="section-title" data-i18n="feat.title">단순 상태 표시를 넘어</h2>
    <p class="section-sub" data-i18n="feat.sub">의사결정까지 도와주는 AI 모니터링 대시보드</p>
    <div class="feature-grid">
      <div class="feature-card fade-up">
        <div class="feature-tag">SCORE</div>
        <div class="feature-icon">📊</div>
        <div class="feature-title" data-i18n="feat.1.title">AIWatch Score</div>
        <div class="feature-desc" data-i18n="feat.1.desc">Uptime(40) + 인시던트 영향 일수(25) + 복구 시간(15) + 응답성(20)을 종합한 0~100점 신뢰도 지표입니다. 서비스마다 흩어진 공식 데이터를 통합해 한눈에 비교할 수 있게 합니다. 데이터 미제공 서비스는 업계 평균 + 10% 패널티가 적용됩니다.</div>
      </div>
      <div class="feature-card fade-up delay-1">
        <div class="feature-tag">AI ANALYSIS BETA</div>
        <div class="feature-icon">🤖</div>
        <div class="feature-title" data-i18n="feat.2.title">AI 장애 분석</div>
        <div class="feature-desc" data-i18n="feat.2.desc">장애 발생 시 Claude Sonnet이 패턴을 분석해 예상 복구 시간과 영향 범위를 알려줍니다. "언제쯤 복구될까?"에 빠르게 답합니다.</div>
      </div>
      <div class="feature-card fade-up delay-2">
        <div class="feature-tag">FALLBACK</div>
        <div class="feature-icon">🔄</div>
        <div class="feature-title" data-i18n="feat.3.title">Fallback 추천</div>
        <div class="feature-desc" data-i18n="feat.3.desc">장애 중인 서비스의 대안을 같은 카테고리 Score 상위 순으로 즉시 제안합니다. 같은 제공사 서비스는 자동 제외됩니다.</div>
      </div>
      <div class="feature-card fade-up delay-3">
        <div class="feature-tag">SEO PAGE</div>
        <div class="feature-icon">🔍</div>
        <div class="feature-title" data-i18n="feat.4.title">"Is X Down?" 전용 페이지</div>
        <div class="feature-desc" data-i18n="feat.4.desc">ai-watch.dev/is-claude-down 같은 전용 페이지에서 실시간 상태, AI 분석, 대안 추천을 한 번에 확인합니다.</div>
      </div>
    </div>
  </div>
</section>

<section class="alert-section">
  <div class="alert-inner">
    <p class="section-label">// real-time alerts</p>
    <h2 class="section-title" data-i18n="alert.title">Discord · Slack 실시간 알림</h2>
    <p class="section-sub" data-i18n="alert.sub">장애 발생 즉시 알림 + AI 분석 + Fallback 추천까지 한 번에. 무료입니다.</p>
    <div class="alert-grid">
      <div>
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px;">
          <div style="display:flex;align-items:center;gap:5px;">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="#5865F2"><path d="M20.317 4.37a19.791 19.791 0 00-4.885-1.515.074.074 0 00-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 00-5.487 0 12.64 12.64 0 00-.617-1.25.077.077 0 00-.079-.037A19.736 19.736 0 003.677 4.37a.07.07 0 00-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 00.031.057 19.9 19.9 0 005.993 3.03.078.078 0 00.084-.028 14.09 14.09 0 001.226-1.994.076.076 0 00-.041-.106 13.107 13.107 0 01-1.872-.892.077.077 0 01-.008-.128 10.2 10.2 0 00.372-.292.074.074 0 01.077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 01.078.01c.12.098.246.198.373.292a.077.077 0 01-.006.127 12.299 12.299 0 01-1.873.892.077.077 0 00-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 00.084.028 19.839 19.839 0 006.002-3.03.077.077 0 00.032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 00-.031-.03z"/></svg>
            <span style="font-size:11px;font-weight:500;color:#5865F2;font-family:var(--font-mono);">Discord</span>
          </div>
          <span style="font-size:11px;color:#444;font-family:var(--font-mono);">·</span>
          <div style="display:flex;align-items:center;gap:5px;">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="#E01E5A"><path d="M5.042 15.165a2.528 2.528 0 01-2.52 2.523A2.528 2.528 0 010 15.165a2.527 2.527 0 012.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 012.521-2.52 2.527 2.527 0 012.521 2.52v6.313A2.528 2.528 0 018.834 24a2.528 2.528 0 01-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 01-2.521-2.52A2.528 2.528 0 018.834 0a2.528 2.528 0 012.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 012.521 2.521 2.528 2.528 0 01-2.521 2.521H2.522A2.528 2.528 0 010 8.834a2.528 2.528 0 012.522-2.521h6.312zm10.122 2.521a2.528 2.528 0 012.522-2.521A2.528 2.528 0 0124 8.834a2.528 2.528 0 01-2.522 2.521h-2.522V8.834zm-1.268 0a2.528 2.528 0 01-2.523 2.521 2.527 2.527 0 01-2.52-2.521V2.522A2.527 2.527 0 0115.165 0a2.528 2.528 0 012.523 2.522v6.312zm-2.523 10.122a2.528 2.528 0 012.523 2.522A2.528 2.528 0 0115.165 24a2.527 2.527 0 01-2.52-2.522v-2.522h2.52zm0-1.268a2.527 2.527 0 01-2.52-2.523 2.526 2.526 0 012.52-2.52h6.313A2.527 2.527 0 0124 15.165a2.528 2.528 0 01-2.522 2.523h-6.313z"/></svg>
            <span style="font-size:11px;font-weight:500;color:#E01E5A;font-family:var(--font-mono);">Slack</span>
          </div>
        </div>
        <div class="discord-wrap">
          <!-- incident + AI Analysis 통합 -->
          <div class="bot-msg">
            <div class="bot-avatar" style="background:#1a3d25;">
              <img src="/favicon.png" alt="" width="22" height="22" style="border-radius:4px;">
            </div>
            <div class="bot-body">
              <div class="bot-name" style="color:#dbdee1;">AIWatch Worker <span class="bot-time" style="color:#949ba4;">오후 2:48</span></div>
              <div class="d-embed" style="border-left:4px solid #f85149;background:#2b2d31;">
                <div class="d-embed-title" style="color:#dbdee1;">🔴 Together AI — New Incident</div>
                <div class="d-embed-text" style="color:#b5bac1;margin-bottom:6px;">Qwen3 Coder 480B A35B Instruct FP8 — down</div>
                <div class="d-embed-text" style="color:#949ba4;font-family:var(--font-mono);font-size:11px;margin-bottom:6px;">┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈</div>
                <div class="d-embed-text" style="color:#dbdee1;font-weight:500;margin-bottom:4px;">🤖 AI ANALYSIS [Beta]</div>
                <div class="d-embed-text" style="color:#b5bac1;margin-bottom:4px;">Qwen model-specific outage affecting the 480B variant. 4 similar incidents detected in the past 30 days.</div>
                <div class="d-embed-text" style="color:#b5bac1;margin-bottom:2px;">⏱ Est. recovery: 13–54 min</div>
                <div class="d-embed-text" style="color:#b5bac1;margin-bottom:6px;">📡 Scope: Qwen3 Coder 480B, Code generation</div>
                <div class="d-embed-text" style="color:#949ba4;font-family:var(--font-mono);font-size:11px;margin-bottom:6px;">┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈</div>
                <div class="d-embed-text" style="color:#dbdee1;font-weight:500;margin-bottom:4px;">👉 SUGGESTED FALLBACK</div>
                <div class="d-embed-text" style="color:#3fb950;margin-bottom:6px;">• Cohere API (Score 100) · DeepSeek API (Score 100)</div>
                <div class="d-embed-text" style="color:#949ba4;font-family:var(--font-mono);font-size:11px;margin-bottom:6px;">┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈</div>
                <a href="https://ai-watch.dev" class="d-embed-link" style="color:#00a8fc;">View on AIWatch</a>
                <div class="d-embed-footer" style="color:#949ba4;margin-top:4px;">AIWatch Worker · 오늘 오후 2:48</div>
              </div>
            </div>
          </div>
          <!-- resolved -->
          <div class="bot-msg">
            <div class="bot-avatar" style="background:#0d2818;">
              <img src="/favicon.png" alt="" width="22" height="22" style="border-radius:4px;">
            </div>
            <div class="bot-body">
              <div class="bot-name" style="color:#dbdee1;">AIWatch Worker <span class="bot-time" style="color:#949ba4;">오후 3:35</span></div>
              <div class="d-embed" style="border-left:4px solid #3fb950;background:#2b2d31;">
                <div class="d-embed-title" style="color:#dbdee1;">🟢 Together AI — Service Recovered (47m)</div>
                <div class="d-embed-text" style="color:#b5bac1;"><strong style="color:#dbdee1;">Together AI</strong> is back to operational</div>
                <div class="d-embed-divider" style="background:#3d3f45;"></div>
                <a href="https://ai-watch.dev" class="d-embed-link" style="color:#00a8fc;">View on AIWatch</a>
                <div class="d-embed-footer" style="color:#949ba4;margin-top:4px;">AIWatch Worker · 오늘 오후 3:35</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</section>

<section class="ai-section" id="ai-analysis">
  <div class="ai-inner">
    <p class="section-label">// ai analysis beta</p>
    <h2 class="section-title" data-i18n="ai.title">장애가 나면 AI가 분석합니다</h2>
    <p class="section-sub" data-i18n="ai.sub">단순 상태 표시에서 한 발 더 — 장애 패턴, 예상 복구 시간, 영향 범위를 Claude Sonnet이 즉시 분석합니다.</p>
    <!-- AI Analysis 모달 목업 — 실제 UI 기반 -->
    <div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-top:20px;">
      <!-- 모달 헤더 -->
      <div style="background:var(--bg1);border-bottom:1px solid var(--border);padding:14px 20px;display:flex;align-items:center;justify-content:space-between;">
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="font-size:16px;">🤖</span>
          <span style="font-family:var(--font-mono);font-size:14px;font-weight:500;color:var(--text0);">AI Analysis</span>
          <span style="background:#4c1d95;color:#c4b5fd;font-size:10px;font-family:var(--font-mono);padding:2px 8px;border-radius:4px;">Beta</span>
          <span style="color:var(--text2);font-size:12px;font-family:var(--font-mono);">(1)</span>
        </div>
      </div>
      <!-- 분석 카드 -->
      <div style="padding:16px;">
        <div style="background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:20px;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
            <span style="width:8px;height:8px;background:var(--green);border-radius:50%;display:inline-block;flex-shrink:0;"></span>
            <span style="font-size:15px;font-weight:600;color:var(--text0);">Claude API</span>
          </div>
          <p style="font-size:13px;color:var(--text1);line-height:1.7;margin-bottom:14px;">Connection reset errors specific to Cowork environment, indicating a network/infrastructure issue rather than the model-level errors seen in recent incidents. This represents a new failure pattern compared to the recent Opus 4.6 model errors.</p>
          <div style="font-family:var(--font-mono);font-size:12px;color:var(--text1);margin-bottom:10px;">⏱ 15 minutes - 3 hours</div>
          <div style="font-family:var(--font-mono);font-size:12px;color:var(--text1);margin-bottom:14px;">📡 Cowork integration, Claude API connectivity, Real-time collaboration features</div>
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="width:8px;height:8px;background:var(--text2);border-radius:50%;display:inline-block;"></span>
            <span style="font-size:12px;color:var(--text2);font-family:var(--font-mono);">5시간 전</span>
          </div>
        </div>
      </div>
      <!-- 푸터 경고 -->
      <div style="background:var(--bg1);border-top:1px solid var(--border);padding:10px 20px;">
        <p style="font-size:11px;color:var(--text2);font-family:var(--font-mono);line-height:1.6;">⚠ AI-generated estimation based on historical data. Actual recovery time may vary. This analysis is provided for informational purposes only.</p>
      </div>
    </div>
  </div>
</section>

<section class="compare-section">
  <div class="compare-inner">
    <p class="section-label">// why aiwatch</p>
    <h2 class="section-title" data-i18n="compare.title">공식 상태 페이지와 비교</h2>
    <p class="section-sub" data-i18n="compare.sub">기존 도구로는 부족했던 이유</p>
    <table class="compare-table">
      <thead>
        <tr>
          <th></th>
          <th class="col-old" data-i18n="compare.col1">공식 상태 페이지</th>
          <th class="col-new">AIWatch</th>
        </tr>
      </thead>
      <tbody>
        
        <tr>
          <td data-i18n="compare.r2">장애 알림</td>
          <td class="no" data-i18n="compare.r2a">직접 확인 필요</td>
          <td class="yes" data-i18n="compare.r2b">Discord · Slack 즉시 발송</td>
        </tr>
        <tr>
          <td data-i18n="compare.r3">AIWatch Score</td>
          <td class="no" data-i18n="compare.r3a">업타임 % 뿐</td>
          <td class="yes" data-i18n="compare.r3b">AIWatch Score — Uptime + 영향 일수 + 복구 시간</td>
        </tr>
        <tr>
          <td data-i18n="compare.r4">장애 분석</td>
          <td class="no">—</td>
          <td class="yes" data-i18n="compare.r4b">AI가 원인 · 복구 시간 분석</td>
        </tr>
        <tr>
          <td data-i18n="compare.r5">대안 추천</td>
          <td class="no">—</td>
          <td class="yes" data-i18n="compare.r5b">Fallback 서비스 즉시 제안</td>
        </tr>
        <tr>
          <td data-i18n="compare.r6">월간 리포트</td>
          <td class="no">—</td>
          <td class="yes" data-i18n="compare.r6b">매월 신뢰도 랭킹 공개</td>
        </tr>
        <tr>
          <td data-i18n="compare.r7">비용</td>
          <td class="val-old" data-i18n="compare.r7a">무료</td>
          <td class="yes" data-i18n="compare.r7b">완전 무료 · 오픈소스</td>
        </tr>
      </tbody>
    </table>
  </div>
</section>

<section class="report-section" id="report">
  <div class="report-inner">
  <p class="section-label">// monthly report</p>
  <h2 class="section-title" data-i18n="report.title">월간 AI 서비스 신뢰도 리포트</h2>
  <p class="section-sub" data-i18n="report.hook" style="color:var(--amber);font-size:15px;font-weight:500;margin-bottom:8px;">가장 안정적인 AI 서비스는? 답은 의외일 수 있습니다.</p>
  <p class="section-sub" data-i18n="report.sub">매월 30개 서비스의 AIWatch Score 순위, 인시던트 요약, 공식 업타임, 주요 장애 분석, 프로바이더 추천까지 한 리포트로 공개합니다.</p>
  <div class="report-chart">
    <svg viewBox="0 0 320 356" xmlns="http://www.w3.org/2000/svg" style="width:100%;font-family:'JetBrains Mono',monospace;">
  <rect width="320" height="356" fill="#0d1117" rx="8"/>
  <text x="16" y="22" fill="#58a6ff" font-size="10" font-weight="600">TOP 5</text>
  <text x="78" y="46" text-anchor="end" fill="#768390" font-size="11">Cohere</text>
  <rect x="86" y="33" width="190" height="16" rx="3" fill="#22c55e"/>
  <text x="282" y="46" fill="#adbac7" font-size="11">100</text>
  <text x="78" y="74" text-anchor="end" fill="#768390" font-size="11">HuggingFace</text>
  <rect x="86" y="61" width="190" height="16" rx="3" fill="#22c55e"/>
  <text x="282" y="74" fill="#adbac7" font-size="11">100</text>
  <text x="78" y="102" text-anchor="end" fill="#768390" font-size="11">OpenRouter</text>
  <rect x="86" y="89" width="188" height="16" rx="3" fill="#22c55e"/>
  <text x="280" y="102" fill="#adbac7" font-size="11">99</text>
  <text x="78" y="130" text-anchor="end" fill="#768390" font-size="11">Groq</text>
  <rect x="86" y="117" width="177" height="16" rx="3" fill="#22c55e"/>
  <text x="269" y="130" fill="#adbac7" font-size="11">93</text>
  <text x="78" y="158" text-anchor="end" fill="#768390" font-size="11">DeepSeek</text>
  <rect x="86" y="145" width="175" height="16" rx="3" fill="#22c55e"/>
  <text x="267" y="158" fill="#adbac7" font-size="11">92</text>
  <line x1="16" y1="176" x2="304" y2="176" stroke="#30363d" stroke-width="1" stroke-dasharray="4,4"/>
  <text x="16" y="196" fill="#f0883e" font-size="10" font-weight="600">BOTTOM 5</text>
  <text x="78" y="220" text-anchor="end" fill="#768390" font-size="11">Claude Code</text>
  <rect x="86" y="207" width="116" height="16" rx="3" fill="#eab308"/>
  <text x="208" y="220" fill="#adbac7" font-size="11">61</text>
  <text x="78" y="248" text-anchor="end" fill="#768390" font-size="11">Claude API</text>
  <rect x="86" y="235" width="112" height="16" rx="3" fill="#eab308"/>
  <text x="204" y="248" fill="#adbac7" font-size="11">59</text>
  <text x="78" y="276" text-anchor="end" fill="#768390" font-size="11">Replicate</text>
  <rect x="86" y="263" width="108" height="16" rx="3" fill="#eab308"/>
  <text x="200" y="276" fill="#adbac7" font-size="11">57</text>
  <text x="78" y="304" text-anchor="end" fill="#768390" font-size="11">claude.ai</text>
  <rect x="86" y="291" width="106" height="16" rx="3" fill="#eab308"/>
  <text x="198" y="304" fill="#adbac7" font-size="11">56</text>
  <text x="78" y="332" text-anchor="end" fill="#768390" font-size="11">ElevenLabs</text>
  <rect x="86" y="319" width="89" height="16" rx="3" fill="#ef4444"/>
  <text x="181" y="332" fill="#adbac7" font-size="11">47</text>
  <text x="160" y="350" text-anchor="middle" fill="#484f58" font-size="8" data-i18n="report.chart.note">* Lower scores may reflect reporting granularity, not actual instability</text>
</svg>
  </div>
  <a href="${reportUrl}" class="report-link" target="_blank" rel="noopener noreferrer" onclick="gtag('event','click_reports',{location:'landing_report',source:'intro'})">
    <span data-i18n="report.link">전체 리포트 보기 →</span>
  </a>
  </div>
</section>

<div class="stack-section">
  <div class="stack-inner">
    <div style="display:flex;align-items:center;justify-content:space-between;width:100%;flex-wrap:wrap;gap:12px;"><div class="stack-label">// tech stack</div><a href="https://github.com/bentleypark/aiwatch" style="display:inline-flex;align-items:center;gap:6px;background:#21262d;border:1px solid #30363d;color:#e6edf3;font-size:12px;font-family:var(--font-mono);padding:5px 12px;border-radius:6px;text-decoration:none;transition:border-color 0.2s;" onmouseover="this.style.borderColor='#58a6ff'" onmouseout="this.style.borderColor='#30363d'" onclick="gtag('event','click_github_header',{location:'landing_stack',source:'intro'})"><svg width="14" height="14" viewBox="0 0 16 16" fill="#e6edf3"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>Star on GitHub</a></div>
    <div class="stack-pills">
      <span class="stack-pill"><svg width="14" height="14" viewBox="0 0 128 128"><path d="M64.1 115.8L2.3 68.4l22-15.5L64.1 81l39.8-28.1 22 15.5z" fill="#f6821f"/><path d="M102.8 41.3l-7.1-2.4-.4 1.3c-3.1 10.7-11.6 14.8-22.4 12l-8.2-2.1c-3.5-.9-5.3 1.6-5.7 3.2l-4.7 17.4 47.7 12.9 4.6-17c.9-3.3.5-6-1.1-8.1-1.3-1.8-3.5-3.1-6.2-3.8l3.5-13.4z" fill="#fbad41"/><path d="M87.5 38.5c3-11.2-3.3-22.8-14.1-25.9L62.6 9.8c-10.8-2.9-22 3.7-25 14.9l-3.5 13.4 6.2 1.7.4-1.3c3.1-10.7 11.6-14.8 22.4-12l8.2 2.1c3.5.9 5.3-1.6 5.7-3.2l.4-1.3 6.2 1.7z" fill="#fff"/></svg>Cloudflare Workers</span>
      <span class="stack-pill"><svg width="14" height="14" viewBox="0 0 128 128"><path d="M64.1 115.8L2.3 68.4l22-15.5L64.1 81l39.8-28.1 22 15.5z" fill="#f6821f"/><path d="M64 12L2.3 59.4l22 15.5L64 47l39.8 28 22-15.5z" fill="#fbad41"/></svg>Cloudflare KV</span>
      <span class="stack-pill"><svg width="14" height="14" viewBox="0 0 116 100"><path fill="#e6edf3" d="M57.5 0L115 100H0z"/></svg>Vercel Edge SSR</span>
      <span class="stack-pill"><svg width="14" height="14" viewBox="0 0 128 128"><circle cx="64" cy="64" r="11.4" fill="#61dafb"/><path d="M107.3 45.2c-2.6-.8-5.3-1.5-8.1-2.1 .5-2.2.9-4.4 1.1-6.5 1.2-10.6-.2-18.1-4.4-20.5-4-2.3-10.8.4-17.9 6.7-1.7 1.5-3.4 3.2-5.1 5.1-1.6-1.7-3.2-3.2-4.8-4.6C60.8 17 54.2 14.4 50.3 16.6c-4 2.3-5.3 9.5-4.2 19.7.3 2.3.7 4.6 1.3 7-3 .7-5.8 1.4-8.5 2.3C28.3 49.5 22 55.3 22 60.3s6.3 11 17 15c2.5.9 5.2 1.7 8 2.4-.5 2.3-.9 4.5-1.2 6.7-1.2 10.5.1 18.2 4.1 20.5 4.1 2.4 11.2-.3 18.5-6.9 1.6-1.4 3.2-3 4.8-4.7 1.8 1.9 3.5 3.6 5.3 5.1 6.9 6.2 13.5 8.7 17.4 6.5 4-2.3 5.5-10.1 4.2-21-.3-2.1-.7-4.3-1.2-6.5 2.5-.7 4.8-1.4 7-2.2C117 71 123 65.3 123 60.3c0-4.9-5.8-10.4-15.7-14.1z" fill="none" stroke="#61dafb" stroke-width="8.4"/></svg>React 19</span>
      <span class="stack-pill"><svg width="14" height="14" viewBox="0 0 128 128"><path d="M64 0L121 36.2V91.8L64 128 7 91.8V36.2z" fill="none" stroke="#646cff" stroke-width="6"/><path d="M64 16L108 45.8V86.2L64 116 20 86.2V45.8z" fill="#646cff" fill-opacity="0.15"/><path d="M49 94L63.5 34 78 94" fill="none" stroke="#646cff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>Vite 6</span>
      <span class="stack-pill"><svg width="14" height="14" viewBox="0 0 128 128"><path d="M13.227 56.074l-3.528 10.608 10.063.192c-2.852 5.476-4.327 11.836-4.327 18.239 0 5.57 1.31 10.382 3.881 14.333.096.147.193.29.292.432L.218 112.108l9.26 14.678 18.963-12.075c3.3 2.562 7.215 4.332 11.756 5.25l-2.97 17.883L53.24 128l2.965-17.86c1.394.092 2.813.14 4.258.14l.043-.002.043.002c1.446 0 2.864-.048 4.258-.14L67.772 128l16.014-10.156-2.97-17.883c4.54-.918 8.455-2.688 11.756-5.25l18.963 12.075 9.26-14.678-19.39-12.23c.099-.142.197-.286.293-.432 2.57-3.951 3.88-8.763 3.88-14.333 0-6.403-1.474-12.763-4.326-18.239l10.063-.192-3.528-10.608-10.47.2A42.96 42.96 0 0088.857 45.5l7.782-6.794-7.753-12.33-8.088 7.062c-3.08-2.522-6.632-4.27-10.665-5.198l2.63-10.556L56.749 7.527l-2.628 10.547c-.4-.03-.803-.052-1.208-.068L55.47 7.54l-16.025-.002L42 18.006c-.406.016-.809.038-1.21.068l-2.627-10.547-16.013 10.157 2.63 10.556c-4.033.929-7.584 2.676-10.664 5.198l-8.088-7.062-7.753 12.33 7.782 6.794a42.963 42.963 0 00-8.461 10.774z" fill="#38bdf8"/></svg>TailwindCSS v4</span>
      <span class="stack-pill"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8b949e" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>AGPL-3.0</span>
    </div>
  </div>
</div>

<section class="cta-section">
  <div class="cta-box">
    <h2 data-i18n="cta.title">지금 바로 확인하세요</h2>
    <p data-i18n="cta.sub">완전 무료 · 설치 불필요 · Discord/Slack 알림 무료</p>
    <div class="cta-btns">
      <a href="https://ai-watch.dev" class="btn-primary" style="font-size:16px;padding:14px 32px;" data-i18n="cta.btn1" onclick="gtag('event','click_dashboard',{location:'landing_cta',source:'intro'})">대시보드 열기 →</a>
      <a href="https://ai-watch.dev/#settings" class="btn-secondary" style="font-size:14px;padding:12px 24px;" data-i18n="cta.btn2" onclick="gtag('event','click_cta_alerts',{location:'landing_cta',source:'intro'})">알림 설정하기</a>
    </div>
  </div>
</section>

<footer>
  <div class="footer-inner">
    <div class="footer-left">© 2026 AIWatch · AGPL-3.0</div>
    <div class="footer-links">
      <a href="https://github.com/bentleypark/aiwatch">GitHub</a>
      <a href="https://reports.ai-watch.dev" data-i18n="footer.report">월간 리포트</a>
      <a href="https://ai-watch.dev/#settings" data-i18n="footer.alert">알림 설정</a>
      <a href="https://ai-watch.dev/is-claude-down">Is Claude Down?</a>
    </div>
  </div>
</footer>
</div><!-- .page-wrap -->

<script>
const i18n = {
  ko: {
    'nav.features': '기능', 'nav.how': '동작 방식', 'nav.report': '월간 리포트', 'nav.cta': '장애 확인하기 →',
    'hero.badge': 'LIVE MONITORING',
    'hero.title': '지금 <em>Claude</em>가<br>나만 안 되는 건가요?',
    'hero.sub': 'Claude, OpenAI, Gemini, Cursor 등 주요 AI 서비스<span class="hero-sub-line"> 상태를 한눈에 확인하세요.</span> 장애 발생 시 AI가 원인을 분석하고 대안을 즉시 추천합니다.',
    'hero.cta1': '지금 장애 확인하기 →', 'hero.trust': '로그인 없음 · 10초 만에 확인 · 완전 무료 오픈소스', 'hero.cta2': 'GitHub에서 보기',
    'hero.pill1': 'AI 서비스', 'hero.pill2v': '실시간', 'hero.pill2': '알림', 'hero.pill3': '오픈소스',
    'flow.1.title': '장애 감지', 'flow.2.conn': 'AI 분석 시작', 'flow.2.bar': '패턴 분석 중', 'flow.3.conn': 'Discord · Slack 발송', 'flow.3.title': '알림 발송', 'flow.3.body': 'Discord · Slack 알림 전송 완료', 'flow.4.conn': '대안 추천', 'flow.4.title': 'Fallback 추천',
    'stats.services': '모니터링 서비스', 'stats.interval': '자동 수집', 'stats.free': 'Discord/Slack 알림 포함', 'stats.oss': '오픈소스',
    'demo.title': '장애 파악부터 대안 선택까지', 'demo.sub': '지금 어떤 서비스가 안정적인지, 장애 중이라면 대안은 무엇인지 한 화면에서 파악합니다', 'demo.more': '+ 27개 서비스 더 보기...',
    'feat.title': '단순 상태 표시를 넘어', 'feat.sub': '의사결정까지 도와주는 AI 모니터링 대시보드',
    'feat.1.title': 'AIWatch Score', 'feat.1.desc': 'Uptime(40) + 인시던트 영향 일수(25) + 복구 시간(15) + 응답성(20)을 종합한 0~100점 신뢰도 지표입니다. 서비스마다 흩어진 공식 데이터를 통합해 한눈에 비교할 수 있게 합니다. 데이터 미제공 서비스는 업계 평균 + 10% 패널티가 적용됩니다.',
    'feat.2.title': 'AI 장애 분석', 'feat.2.desc': '장애 발생 시 Claude Sonnet이 패턴을 분석해 예상 복구 시간과 영향 범위를 알려줍니다. "언제쯤 복구될까?"에 빠르게 답합니다.',
    'feat.3.title': 'Fallback 추천', 'feat.3.desc': '장애 중인 서비스의 대안을 같은 카테고리 Score 상위 순으로 즉시 제안합니다. 같은 제공사 서비스는 자동 제외됩니다.',
    'feat.4.title': '"Is X Down?" 전용 페이지', 'feat.4.desc': 'ai-watch.dev/is-claude-down 같은 전용 페이지에서 실시간 상태, AI 분석, 대안 추천을 한 번에 확인합니다.',
    'how.title': '이렇게 동작합니다', 'how.sub': '각 서비스의 공식 상태 페이지 데이터를 기반으로 동작합니다',
    'compare.title': '공식 상태 페이지와 무엇이 다른가요?', 'compare.sub': '공식 페이지 데이터를 기반으로, 30개를 한 화면에서 통합합니다', 'compare.col1': '공식 상태 페이지', 'compare.r2': '장애 알림', 'compare.r2a': '직접 확인 필요', 'compare.r2b': 'Discord · Slack 즉시 발송', 'compare.r3': 'AIWatch Score', 'compare.r3a': '서비스별 개별 확인', 'compare.r3b': 'AIWatch Score — Uptime + 영향 일수 + 복구 시간 + 응답성', 'compare.r4': '장애 분석', 'compare.r4b': 'AI가 원인 · 복구 시간 분석', 'compare.r5': '대안 추천', 'compare.r5b': 'Fallback 서비스 즉시 제안', 'compare.r6': '월간 리포트', 'compare.r6b': '매월 리포트 공개', 'compare.r7': '비용', 'compare.r7a': '무료', 'compare.r7b': '완전 무료 · 오픈소스',
    'how.1.title': '수집', 'how.1.desc': '공식 상태 페이지를 최대 5분 간격으로 자동 갱신',
    'how.2.title': '분석', 'how.2.desc': 'Claude Sonnet이 패턴 · 복구 시간 · 영향 범위 분석',
    'how.3.title': '알림', 'how.3.desc': 'Discord · Slack 즉시 발송 + Fallback 추천 포함',
    'how.4.title': '리포트', 'how.4.desc': '월간 업타임 추이 · 인시던트 통계 리포트 공개',
    'cta.title': '지금 바로 확인하세요', 'cta.sub': '완전 무료 · 설치 불필요 · Discord/Slack 알림 무료', 'cta.btn1': '지금 장애 확인하기 →', 'cta.btn2': '알림 설정하기',
    'alert.title': 'Discord · Slack 실시간 알림', 'alert.sub': '장애 발생 즉시 알림 + AI 분석 + Fallback 추천까지 한 번에. 무료입니다.',
    'report.title': '월간 AI 서비스 신뢰도 리포트', 'report.hook': '가장 안정적인 AI 서비스는? 답은 의외일 수 있습니다.', 'report.link': '전체 리포트 보기 →', 'report.sub': '매월 30개 서비스의 AIWatch Score 순위, 인시던트 요약, 공식 업타임, 주요 장애 분석, 프로바이더 추천까지 한 리포트로 공개합니다.', 'report.chart.note': '* 하위 점수는 리포팅 방식 차이일 수 있으며, 실제 불안정성을 의미하지 않습니다', 'ai.title': '장애가 나면 AI가 분석합니다', 'ai.sub': '단순 상태 표시에서 한 발 더 — 장애 패턴, 예상 복구 시간, 영향 범위를 Claude Sonnet이 즉시 분석합니다.',
    'footer.report': '월간 리포트', 'footer.alert': '알림 설정'
  },
  en: {
    'nav.features': 'Features', 'nav.how': 'How it works', 'nav.report': 'Monthly Report', 'nav.cta': 'Check for Outages →',
    'hero.badge': 'LIVE MONITORING',
    'hero.title': 'Is <em>Claude</em> down —<br>or is it just you?',
    'hero.sub': 'Track Claude, OpenAI, Gemini, Cursor and more —<span class="hero-sub-line"> all in one dashboard.</span> AI analyzes incidents and recommends fallback options instantly.',
    'hero.cta1': 'Check for Outages Now →', 'hero.trust': 'No signup · See results in 10 seconds · Free & open source', 'hero.cta2': 'View on GitHub',
    'hero.pill1': 'AI Services', 'hero.pill2v': 'Real-time', 'hero.pill2': 'Alerts', 'hero.pill3': 'Open Source',
    'flow.1.title': 'Outage Detected', 'flow.2.conn': 'AI analysis started', 'flow.2.bar': 'Analyzing patterns', 'flow.3.conn': 'Discord · Slack sent', 'flow.3.title': 'Alert Sent', 'flow.3.body': 'Discord · Slack alert delivered', 'flow.4.conn': 'Alternatives suggested', 'flow.4.title': 'Fallback Suggested',
    'stats.services': 'Services monitored', 'stats.interval': 'Auto-collected', 'stats.free': 'Discord/Slack alerts included', 'stats.oss': 'Open source',
    'demo.title': 'From outage detection to fallback — in one view', 'demo.sub': 'See which services are stable right now — and what to use instead when they\\\'re not', 'demo.more': '+ 27 more services...',
    'feat.title': 'Beyond status monitoring', 'feat.sub': 'An AI monitoring dashboard that helps you make decisions',
    'feat.1.title': 'AIWatch Score', 'feat.1.desc': 'A 0–100 reliability score combining Uptime (40) + Impact days (25) + Recovery time (15) + Responsiveness (20). Services without official data use industry averages with a 10% penalty.',
    'feat.2.title': 'AI Incident Analysis', 'feat.2.desc': 'When an outage hits, Claude Sonnet analyzes the pattern and tells you the estimated recovery time and impact scope. No more guessing.',
    'feat.3.title': 'Fallback Recommendations', 'feat.3.desc': 'Get instant alternative suggestions ranked by Score within the same category. Same-provider services are automatically excluded.',
    'feat.4.title': '"Is X Down?" Dedicated Pages', 'feat.4.desc': 'Pages like ai-watch.dev/is-claude-down show real-time status, AI analysis, and fallback recommendations — all in one place.',
    'how.title': 'How it works', 'how.sub': 'Powered by official status page data from each provider',
    'compare.title': 'How is AIWatch different?', 'compare.sub': 'Built on official status data — aggregated across 30 services in one place', 'compare.col1': 'Official Status Page', 'compare.r2': 'Alerts', 'compare.r2a': 'Manual check required', 'compare.r2b': 'Instant Discord · Slack', 'compare.r3': 'AIWatch Score', 'compare.r3a': 'Per-service, separate pages', 'compare.r3b': 'AIWatch Score — Uptime + Impact days + Recovery + Responsiveness', 'compare.r4': 'Incident analysis', 'compare.r4b': 'AI analyzes cause & recovery', 'compare.r5': 'Fallback', 'compare.r5b': 'Alternative services suggested', 'compare.r6': 'Monthly report', 'compare.r6b': 'Monthly report published', 'compare.r7': 'Cost', 'compare.r7a': 'Free', 'compare.r7b': 'Free & open source',
    'how.1.title': 'Collect', 'how.1.desc': 'Official status pages auto-refreshed up to every 5 min',
    'how.2.title': 'Analyze', 'how.2.desc': 'Claude Sonnet analyzes pattern, recovery time & scope',
    'how.3.title': 'Alert', 'how.3.desc': 'Discord · Slack instant alert + fallback recommendations',
    'how.4.title': 'Report', 'how.4.desc': 'Monthly uptime trends · incident statistics report',
    'cta.title': 'Check it out now', 'cta.sub': 'Completely free · No installation · Discord/Slack alerts included', 'cta.btn1': 'Check for Outages Now →', 'cta.btn2': 'Set Up Alerts',
    'alert.title': 'Discord & Slack alerts', 'alert.sub': 'Instant incident alerts with AI analysis and fallback recommendations. Free.',
    'report.title': 'Monthly AI Reliability Report', 'report.hook': 'Which AI service is most reliable? The answer may surprise you.', 'report.link': 'View All Reports →', 'report.sub': 'AIWatch Score rankings, incident summaries, official uptime, notable outage analysis, and provider recommendations — all in one monthly report for 30 services.', 'report.chart.note': '* Lower scores may reflect reporting granularity, not actual instability', 'ai.title': 'AI analyzes every incident', 'ai.sub': 'One step beyond status monitoring — Claude Sonnet instantly analyzes incident patterns, estimated recovery time, and impact scope.',
    'footer.report': 'Monthly Report', 'footer.alert': 'Alert Settings'
  }
};

const browserLang = (navigator.language || '').startsWith('ko') ? 'ko' : 'en';
let currentLang = browserLang;


function setLang(lang) {
  currentLang = lang;
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.classList.toggle('active', btn.textContent.trim() === lang.toUpperCase());
  });
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (key in i18n[lang]) el.innerHTML = i18n[lang][key];
  });
  document.documentElement.lang = lang;
}
try {
  setLang(currentLang);

  // Flow widget: IO detects visibility → add .show to all → CSS transition-delay handles sequencing
  var _fwStarted = false;
  var _flowEl = document.querySelector('.flow-wrap');
  if (_flowEl && 'IntersectionObserver' in window) {
    new IntersectionObserver(function(entries) {
      var visible = entries.some(function(e) { return e.isIntersecting; });
      if (visible && !_fwStarted) {
        _fwStarted = true;
        ['fw1','fw2','fw3','fw4'].forEach(function(id) {
          var el = document.getElementById(id);
          if (el) el.classList.add('show');
        });
      }
    }, { threshold: 0.15 }).observe(_flowEl);
  } else {
    ['fw1','fw2','fw3','fw4'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.classList.add('show');
    });
  }

  // Fade-up scroll animations (double rAF for iOS)
  const _fadeEls = document.querySelectorAll('.fade-up');
  if ('IntersectionObserver' in window) {
    const _observer = new IntersectionObserver((entries) => {
      entries.forEach(e => {
        if (e.isIntersecting) {
          requestAnimationFrame(() => { requestAnimationFrame(() => { e.target.classList.add('visible'); }); });
          _observer.unobserve(e.target);
        }
      });
    }, { threshold: 0.12 });
    _fadeEls.forEach(el => _observer.observe(el));
  } else {
    _fadeEls.forEach(el => el.classList.add('visible'));
  }
} catch (e) { console.error('[intro] Client init failed:', e); }

</script>
</body>
</html>
`
}
