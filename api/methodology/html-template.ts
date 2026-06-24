// SSR HTML template for the /methodology page (#673).
//
// Public, indexable explainer of how AIWatch measures AI service reliability.
// Mirrors api/intro/html-template.ts conventions: inline <style> in <head>, inline
// KO/EN i18n + a client-side setLang() toggle, the shared Consent Mode v2 + cookie
// banner, dark theme + design tokens, mono headings.
//
// CSP-aware (#482): NO inline onclick=/onerror=/onmouseover= attributes anywhere.
// All interactivity (the KO/EN toggle + the GA4 link-click events) is wired via
// addEventListener inside the single inline <script> block using data-attributes +
// delegated listeners, so this page stays off the Phase-2 inline-handler refactor list.

import { CONSENT_INIT_COMMENT, CONSENT_INIT_SCRIPT } from '../_shared/consent-init'
import { COOKIE_BANNER_HTML } from '../_shared/cookie-banner'

export function renderMethodologyPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<title>How AIWatch Works — Methodology | AIWatch</title>
${CONSENT_INIT_COMMENT}
${CONSENT_INIT_SCRIPT}
<meta name="description" content="Transparent, independent measurement of AI service reliability. How AIWatch determines status, computes uptime and the AIWatch Score, and — explicitly — what we can't measure and why. 41 services, polled every 5 min, UTC.">
<meta name="robots" content="index, follow">
<meta property="og:type" content="website">
<meta property="og:url" content="https://ai-watch.dev/methodology">
<meta property="og:title" content="How AIWatch Works — Methodology | AIWatch">
<meta property="og:description" content="Transparent, independent measurement of AI service reliability. We publish what we can measure — and are explicit about what we can't.">
<meta property="og:image" content="https://ai-watch.dev/og-intro.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:locale" content="en_US">
<meta property="og:site_name" content="AIWatch">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="How AIWatch Works — Methodology | AIWatch">
<meta name="twitter:description" content="Transparent, independent measurement of AI service reliability. We publish what we can measure — and are explicit about what we can't.">
<meta name="twitter:image" content="https://ai-watch.dev/og-intro.png">
<link rel="canonical" href="https://ai-watch.dev/methodology">
<meta name="theme-color" content="#080c10">
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "TechArticle",
  "headline": "How AIWatch Works — Methodology",
  "description": "Transparent, independent measurement of AI service reliability: status determination, uptime, the AIWatch Score, latency probing, incident counting, and the limits of what is measurable.",
  "url": "https://ai-watch.dev/methodology",
  "author": { "@type": "Organization", "name": "AIWatch", "url": "https://ai-watch.dev" },
  "publisher": { "@type": "Organization", "name": "AIWatch", "url": "https://ai-watch.dev" },
  "mainEntityOfPage": "https://ai-watch.dev/methodology"
}
</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600&family=IBM+Plex+Sans:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg0: #080c10; --bg1: #0d1117; --bg2: #161b22; --bg3: #1c2128;
    --text0: #e6edf3; --text1: #adbac7; --text2: #8b949e;
    --green: #3fb950; --green-dim: #1a3d25;
    --blue: #58a6ff; --amber: #e86235; --yellow: #faa72a; --red: #f85149;
    --purple: #a78bfa; --teal: #39c5cf;
    --border: #30363d;
    --font-mono: 'IBM Plex Mono', monospace;
    --font-sans: 'IBM Plex Sans', sans-serif;
  }
  html { scroll-behavior: smooth; }
  body { background: var(--bg0); color: var(--text0); font-family: var(--font-sans); font-size: 15px; line-height: 1.7; -webkit-font-smoothing: antialiased; }
  .page-wrap { overflow-x: clip; max-width: 100vw; }
  a { color: inherit; text-decoration: none; }

  /* NAV */
  .topnav { position: sticky; top: 0; z-index: 100; background: rgba(8,12,16,0.85); backdrop-filter: blur(12px); border-bottom: 1px solid var(--border); padding: 0 24px; height: 56px; display: flex; align-items: center; justify-content: space-between; }
  .nav-logo { display: flex; align-items: center; gap: 10px; font-family: var(--font-mono); font-size: 15px; font-weight: 600; letter-spacing: -0.3px; color: var(--text0); }
  .nav-logo .nav-word { color: var(--text0); }
  .nav-logo .nav-green { color: var(--green); }
  .nav-logo img { border-radius: 4px; display: block; }
  .nav-right { display: flex; align-items: center; gap: 20px; }
  .nav-links { display: flex; align-items: center; gap: 20px; }
  .nav-links a { font-size: 13px; color: var(--text2); transition: color 0.2s; }
  .nav-links a:hover { color: var(--text0); }
  .lang-toggle { display: flex; background: var(--bg2); border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
  .lang-btn { font-family: var(--font-mono); font-size: 11px; padding: 5px 10px; cursor: pointer; border: none; background: transparent; color: var(--text2); transition: all 0.2s; }
  .lang-btn.active { background: var(--green); color: var(--bg0); font-weight: 500; }
  .nav-cta { background: var(--green); color: var(--bg0) !important; font-size: 13px !important; font-weight: 500; padding: 6px 16px; border-radius: 6px; transition: opacity 0.2s !important; white-space: nowrap; }
  .nav-cta:hover { opacity: 0.85; }

  /* DOC HEADER (compact — replaces the landing-style hero; this is a reference doc, not a marketing page) */
  .doc-header { border-bottom: 1px solid var(--border); }
  .doc-header-inner { max-width: 1080px; margin: 0 auto; padding: 40px 40px 30px; }
  .hero-badge { display: inline-flex; align-items: center; gap: 8px; background: var(--green-dim); border: 1px solid rgba(63,185,80,0.3); color: var(--green); font-family: var(--font-mono); font-size: 11px; padding: 4px 14px; border-radius: 20px; margin-bottom: 16px; letter-spacing: 0.06em; }
  .doc-header h1 { font-size: clamp(25px, 3.2vw, 34px); font-weight: 600; line-height: 1.2; margin-bottom: 12px; }
  .doc-header h1 em { font-style: normal; color: var(--green); }
  .doc-header .tagline { font-size: 15px; color: var(--text1); max-width: 700px; margin-bottom: 10px; }
  .doc-header .meta-line { font-family: var(--font-mono); font-size: 12px; color: var(--text2); margin-bottom: 10px; }
  .doc-header .principle { font-size: 13px; color: var(--text1); }
  .doc-header .principle strong { color: var(--green); font-weight: 500; }

  /* DOC LAYOUT — sticky sidebar "on this page" TOC + content column (Artificial-Analysis-style reference doc) */
  .doc-layout { max-width: 1080px; margin: 0 auto; display: grid; grid-template-columns: 224px minmax(0, 1fr); align-items: start; }
  .toc-side { position: sticky; top: 56px; align-self: start; max-height: calc(100vh - 56px); overflow-y: auto; padding: 34px 16px 34px 40px; }
  .toc-nav .toc-label { display: block; font-family: var(--font-mono); font-size: 10px; color: var(--green); letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 12px; padding-left: 10px; }
  .toc-nav ul { list-style: none; display: flex; flex-direction: column; gap: 1px; margin: 0; padding: 0; }
  .toc-nav li { padding: 0; }
  .toc-nav li::before { content: none; }
  .toc-nav a { display: block; font-family: var(--font-mono); font-size: 12px; line-height: 1.45; color: var(--text2); padding: 7px 10px; border-left: 2px solid transparent; transition: color 0.2s, border-color 0.2s, background 0.2s; }
  .toc-nav a:hover { color: var(--text0); }
  .toc-nav a.active { color: var(--green); border-left-color: var(--green); background: rgba(63,185,80,0.07); }
  .doc-content { min-width: 0; border-left: 1px solid var(--border); }
  .doc-content .section { max-width: 760px; margin: 0; padding: 48px 40px; }

  /* SECTIONS */
  .section { max-width: 880px; margin: 0 auto; padding: 56px 40px; border-bottom: 1px solid var(--border); scroll-margin-top: 72px; }
  .section-label { font-family: var(--font-mono); font-size: 11px; color: var(--green); letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 10px; }
  .section h2 { font-size: 26px; font-weight: 600; margin-bottom: 14px; overflow-wrap: break-word; }
  .section h3 { font-size: 16px; font-weight: 600; margin: 28px 0 10px; color: var(--text0); }
  .section p { font-size: 14px; color: var(--text1); margin-bottom: 14px; }
  .section p.lead { font-size: 15px; color: var(--text0); }
  .section ul { list-style: none; margin: 0 0 14px; padding: 0; }
  .section ul li { font-size: 14px; color: var(--text1); padding: 5px 0 5px 18px; position: relative; }
  .section ul li::before { content: '–'; position: absolute; left: 0; color: var(--green); }
  .section ul li strong { color: var(--text0); font-weight: 500; }
  .note { font-size: 13px; color: var(--text2); font-style: italic; margin-top: 6px; }
  .note a, .section p a { color: var(--blue); text-decoration: underline; text-underline-offset: 2px; font-style: normal; }
  .note a:hover, .section p a:hover { opacity: 0.8; }

  /* CHAINS (ordered priority steps) */
  .chain { display: flex; flex-direction: column; gap: 8px; margin: 18px 0; }
  .chain-step { background: var(--bg2); border: 1px solid var(--border); border-left: 3px solid var(--green); border-radius: 6px; padding: 12px 14px; }
  .chain-step .cs-num { font-family: var(--font-mono); font-size: 10px; color: var(--green); letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 4px; }
  .chain-step .cs-title { font-size: 14px; font-weight: 500; color: var(--text0); margin-bottom: 3px; }
  .chain-step .cs-body { font-size: 13px; color: var(--text2); line-height: 1.6; }

  /* FORMULA BLOCK */
  .formula { font-family: var(--font-mono); font-size: 13px; color: var(--text0); background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; margin: 12px 0; overflow-x: auto; }
  .formula .fl-sub { color: var(--text2); font-size: 12px; }

  /* SCORE COMPONENT CARDS */
  .score-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin: 18px 0 24px; }
  .score-card { background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 14px; text-align: center; }
  .score-card .sc-max { font-family: var(--font-mono); font-size: 22px; font-weight: 600; }
  .score-card .sc-label { font-family: var(--font-mono); font-size: 10px; color: var(--text2); text-transform: uppercase; letter-spacing: 0.04em; margin-top: 2px; }
  .sc-uptime .sc-max { color: var(--green); }
  .sc-inc .sc-max { color: var(--blue); }
  .sc-rec .sc-max { color: var(--teal); }
  .sc-resp .sc-max { color: var(--purple); }

  .subscore { background: var(--bg1); border: 1px solid var(--border); border-radius: 10px; padding: 18px 20px; margin: 16px 0; }
  .subscore h3 { margin-top: 0; }

  /* TABLES */
  .tbl-wrap { overflow-x: auto; margin: 14px 0; -webkit-overflow-scrolling: touch; }
  table.tbl { width: 100%; border-collapse: collapse; min-width: 360px; }
  table.tbl th { font-family: var(--font-mono); font-size: 11px; font-weight: 500; color: var(--text2); text-align: left; padding: 9px 14px; border-bottom: 1px solid var(--border); white-space: nowrap; }
  table.tbl td { font-size: 13px; padding: 9px 14px; border-bottom: 1px solid var(--border); color: var(--text1); vertical-align: top; }
  table.tbl td:first-child { color: var(--text0); }
  table.tbl tr:last-child td { border-bottom: none; }
  table.tbl.mono td, table.tbl.mono th { font-family: var(--font-mono); }
  .na { color: var(--amber); font-family: var(--font-mono); font-size: 12px; white-space: nowrap; }

  /* COVERAGE / LIMITS callout */
  .limits { background: rgba(232,98,53,0.07); border: 1px solid rgba(232,98,53,0.35); border-radius: 10px; padding: 16px 18px; margin: 20px 0; }
  .limits .limits-label { font-family: var(--font-mono); font-size: 10px; color: var(--amber); letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 8px; display: flex; align-items: center; gap: 6px; }
  .limits p, .limits li { color: var(--text1); }
  .limits ul li::before { content: '⚠'; color: var(--amber); font-size: 11px; }

  /* GRADES */
  .grades { display: flex; flex-direction: column; gap: 8px; margin: 14px 0; }
  .grade-row { display: flex; align-items: center; gap: 12px; }
  .grade-badge { width: 56px; text-align: center; font-family: var(--font-mono); font-size: 11px; font-weight: 500; border-radius: 4px; padding: 4px 0; color: var(--bg0); }
  .g-excellent { background: var(--green); }
  .g-good { background: #7ec699; color: var(--bg0); }
  .g-fair { background: var(--yellow); }
  .g-degrading { background: var(--amber); }
  .g-unstable { background: var(--red); }
  .grade-name { font-family: var(--font-mono); font-size: 13px; color: var(--text1); }

  /* INDEPENDENCE highlight */
  .indep { background: linear-gradient(180deg, var(--bg1), var(--bg0)); }
  .indep-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin: 18px 0; }
  .indep-card { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; padding: 18px; }
  .indep-card .ic-title { font-size: 14px; font-weight: 600; color: var(--text0); margin-bottom: 6px; display: flex; align-items: center; gap: 8px; }
  .indep-card .ic-body { font-size: 13px; color: var(--text2); line-height: 1.6; }
  .indep-card .ic-icon { font-size: 15px; }

  /* FOOTER */
  footer { border-top: 1px solid var(--border); padding: 24px; }
  .footer-inner { max-width: 880px; margin: 0 auto; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; }
  .footer-left { font-size: 13px; color: var(--text2); font-family: var(--font-mono); }
  .footer-links { display: flex; gap: 20px; flex-wrap: wrap; }
  .footer-links a { font-size: 13px; color: var(--text2); transition: color 0.2s; }
  .footer-links a:hover { color: var(--text0); }

  /* Below the sidebar breakpoint, collapse the TOC into a sticky horizontal jump-bar */
  @media (max-width: 860px) {
    .doc-layout { display: block; }
    .toc-side { position: sticky; top: 56px; z-index: 90; max-height: none; overflow-x: auto; overflow-y: hidden; padding: 0 20px; background: rgba(13,17,23,0.92); backdrop-filter: blur(8px); border-bottom: 1px solid var(--border); }
    .toc-nav .toc-label { display: none; }
    .toc-nav ul { flex-direction: row; gap: 2px; }
    .toc-nav a { white-space: nowrap; border-left: none; border-bottom: 2px solid transparent; padding: 11px 10px; }
    .toc-nav a.active { border-left: none; border-bottom-color: var(--green); background: transparent; }
    .doc-content { border-left: none; }
    .doc-content .section { max-width: none; scroll-margin-top: 108px; }
  }
  @media (max-width: 768px) {
    .nav-links { display: none; }
    .nav-right { gap: 10px; }
    .doc-header-inner { padding: 32px 20px 24px; }
    .doc-content .section { padding: 40px 20px; }
    .section h2 { font-size: 21px; }
    .score-grid { grid-template-columns: repeat(2, 1fr); }
    .indep-grid { grid-template-columns: 1fr; }
    .footer-inner { flex-direction: column; align-items: flex-start; gap: 16px; }
  }
</style>
</head>
<body>
<div class="page-wrap">
<nav class="topnav">
  <div class="nav-logo">
    <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRAAIAAwAEN2eGb4AAAAHdElNRQfqAx4GGx+s3nLlAAAAJXRFWHRkYXRlOmNyZWF0ZQAyMDI2LTAzLTMwVDA2OjI2OjIxKzAwOjAwn2T7zQAAACV0RVh0ZGF0ZTptb2RpZnkAMjAyNi0wMy0zMFQwNjoyNjoyMSswMDowMO45Q3EAAAAodEVYdGRhdGU6dGltZXN0YW1wADIwMjYtMDMtMzBUMDY6Mjc6MzErMDA6MDCaRAkOAAAHl0lEQVRYw12XS28kVxXHf+fcW9Vlu9tu29OMx5OZJEwyKGIUKURBCg8lQiJkxSKKFCGBEAvEN8g6iD0rWMCOj8AOsSEhC4QiGEVkEoiTeWQm9sx4/Br3u6vuYXFvVbfT8m1X9a265/0//yOAAYgI4hziHM5nqCqiiojinAOB9IWZET+GBWt+MwuEELBQYWaEECBY3AsVWAAzmtcB3whPAtU5xDtEFBFBVTFAEEQEY+FtAzQpFuJTqkJAMQuICXiBKgCKBYCAYKQ/fGOYCGgUKoB4iQekfc0doQxYMCyE2n5MDFGNXrGontXKSVoaL8QEQ9Je1EAb10oSpoIBoYzuDKHCCPiWJ4SKUFXR1RYaBUwNy4UgRvoVJCljjUqYfkVWDIEkTeODIYTkkOhyDNSMwdFpil8KghiSK8WFFpdeeIL9Wwec7JxgI5vH2axOGxqfawqXCWAoyWkWYhLF60CoorUhBKqqoqrKdB+XWcC80bu2wa/feZuX3/gWrIJp8kE6q1Z6njo2D42kJASJXrEoXESwxgPWZL3VlklMaDEox4FJ6ONMIBBXk+bSuB9Ne5zd8ulkLClhZvFhAatCjJfMXWi1K0UwCxRZi5EbsXFuHcmVOscaIcx1WNQHifIUW3goRCusAqoUbzW0q7ieh9ZiAhmmsNpd5Yv9L1ldX6XVzqPyCr6Vod7NjzeLsQ/WeMnM6ipY0LC2VmKRSkd45Scv89O33yS/kINL2ayCOOhudvjvxzeZllPaG8uYi+/7Ise3snkZisT/TlmUqWcE6/y6LiVdclz55mWuPX8Vv+zrN+JrmbK+2eXOjV2OH56w2dtIZwjjwZDZdIqopsqTxu3zJBS0AY16LYKHF1qdFlIIB9NDOmvtCFBOwAnZckZ3bY1Hd47Y/+KQre0eZCCFol2HtBUySWFJSJryJ9pnqNTAkGInTpBM0cKhy561XofR6ZhbO/fobW9GF6sgXlhaLUCM470Tdu/cp9tbxS07fNfz+i9e5eqrV9CVeJa0HGSKOE2JHS31tcXiFMkd0lKkUKSlaMvxtac2ebh3wMlRn/NP9LjR3sEmARDavTbD6YjR4zGP9o4ovpuTd3La60u88uOXaP+zzc0bd6kGFTYJhAnY1JCpgAkWLJWhAzLQFcF3M4rzLbavbjE4HXDx2R67O/sc7B3znR++yMUXz7O5sc5H73/K5laXweMhs0FJX/soyupWm6effYLPv7zD+laHyy9v4cnY/WSP0YMx1cAIw4QnFXhZFtyap9hu0Xl6mc6lFS480+OXr/2K67c/4PPPbrK794Bxf0K+5nn9Z99nq9vj5s0vOLe1wePDU0KomE6M/mDAxee3+Pqzl7n+wcdcvNzjzZ+/xgsXXuKPf/0Dd3f2GDwc0r87ZHBnxOzhFG8joyxLhiNjcr/k+D9DDrb6/PbG7zncP+bRzhGTwynkQjWouPrS09zb26W9tkJnrc3n129jQ6MsKx7dP+S5b18hG3s+fe82Hw0/5cPn/se72x/w2Yc36e8NKfszqn5JNahgbHiCwQxCvyKMjNnRjPGDCYc3jiNEVwnaMvjw75+wu/eA7SsX2H7qPJ3NFY4OTyBAGAf2vzzgjWs/4m9/+QeP750STkpu7Y647e9iE8OmFVYaTANUBpXV3VCafmAlkUAkCLaaKwS48d4Oel35wVvf48krFymKFv3jIZJ6wP7dAwb3h+xcv0U4LaEWSoL1KqFgsLpPoUaCR4ubiY7MgQNBVBAUKRVGwsN7B1x66gIWYDYt0cyj6ji+85jf/eZPfPb+LRgnhLO4BJ2joWpCx1j5Dd9rQAIB0YYjivORpnmHqOPw6DEbG12mZUmlguQe8Z5qaOz9+yGTg1nEa5PEsKRhRV/9eGmIXaJgNUhIJKSignjFVNDcoYUykZJWllHmhq7k6JIRLHa2EP2NiTWNq+aR4lKjq/3fMKKmMwjqHUtrHcaD0RygMkWyqIC0FF12rBYbdM8fkm/kWD9QmiXKBYGFzpf6mgWL3daIIQgViOCjNgsdwmA2niIa8V6yJDRTdMmjKw7D8+d/vcvAleTn2oRBdGJ1OiUyC4MyzJOtMgSJ1PwrLdmJ8A4i0VKnSOYwB9JySOHQFYfv5Li1nOxcQXGxTfsbm+iT61x65hrTdklVTqPpTtBMwUWFTQxxLiWczV2/QFS1KUOJFtedCydIHhWKzUlxSx4tXBTgMgpX4IocWc6QwqNFnazJGOfimWdy72wiCoLFwcSBj1mvPlnR8lEJr2gr3uuyR1c8fiMn2yioDqeUR1NmJxOqQUkYlVTjGZSBkMJgZcDKCqoQ8SCEhhEJYKKCiMbBxLkmHHjF5T5VQSQg4iKVlUzQwmNTQ02pxhU2DYRpSZhVUBlhVsYhJgSsViYJrxVYIKUBCYJJqEkcmFEFi8ooMNE4cEgsKfUakROw0uKwEwyrosU2i/Q9ol9I9Dwk8mNnearU7Fc00agIHnFmXOB0CwUjmkisJfiuS7wK0dIqzGeCNElJomA1c58rsPgl8yWyeE8DLo0CyRoL9fBhZxlwzYvN5oPtwnwrZ2/r8xOCpUF1TqFqyfWzcsaa5mIhxgunNdPZ4uf/xYAMxFaxEJwAAAAASUVORK5CYII=" alt="AIWatch" width="28" height="28">
    <span class="nav-word">AI<span class="nav-green">Watch</span></span>
  </div>
  <div class="nav-right">
    <div class="nav-links">
      <a href="/reports/" data-i18n="nav.report">월간 리포트</a>
      <a href="https://github.com/bentleypark/aiwatch" data-i18n="nav.github" data-ga="click_github" data-ga-loc="methodology_nav">GitHub</a>
    </div>
    <div class="lang-toggle">
      <button type="button" class="lang-btn" data-lang="ko">KO</button>
      <button type="button" class="lang-btn active" data-lang="en">EN</button>
    </div>
    <a href="https://ai-watch.dev" class="nav-cta" data-i18n="nav.cta" data-ga="click_dashboard" data-ga-loc="methodology_nav">대시보드 열기 →</a>
  </div>
</nav>

<!-- DOC HEADER (compact) -->
<header class="doc-header">
  <div class="doc-header-inner">
    <div class="hero-badge"><span data-i18n="hero.badge">METHODOLOGY</span></div>
    <h1 data-i18n="hero.title">AIWatch는 <em>어떻게</em> 동작하는가 — 측정 방법론</h1>
    <p class="tagline" data-i18n="hero.tagline">AI 서비스 신뢰도를 독립적이고 투명하게 측정합니다 — 계정도, 개인정보도 필요 없습니다.</p>
    <p class="meta-line" data-i18n="hero.meta">41개 서비스 · 5분 간격 폴링 · UTC 기준</p>
    <p class="principle" data-i18n="hero.principle"><strong>측정할 수 있는 것은 공개하고, 측정할 수 없는 것은 분명히 밝힙니다.</strong></p>
  </div>
</header>

<!-- DOC LAYOUT: sticky sidebar "on this page" TOC + content column -->
<div class="doc-layout">
<aside class="toc-side">
  <nav class="toc-nav" aria-label="On this page">
    <span class="toc-label" data-i18n="toc.onthispage">// 목차</span>
    <ul>
      <li><a href="#sources" data-i18n="toc.sources">측정 대상</a></li>
      <li><a href="#status" data-i18n="toc.status">상태 결정</a></li>
      <li><a href="#uptime" data-i18n="toc.uptime">Uptime</a></li>
      <li><a href="#latency" data-i18n="toc.latency">레이턴시</a></li>
      <li><a href="#incidents" data-i18n="toc.incidents">인시던트 · MTTR · 탐지</a></li>
      <li><a href="#score" data-i18n="toc.score">AIWatch Score</a></li>
      <li><a href="#independence" data-i18n="toc.independence">독립성 · 프라이버시</a></li>
    </ul>
  </nav>
</aside>
<main class="doc-content">

<!-- §1 WHAT WE MEASURE -->
<section class="section" id="sources">
  <p class="section-label">// 01</p>
  <h2 data-i18n="s1.title">측정 대상</h2>
  <p class="lead" data-i18n="s1.lead">AIWatch는 LLM API 15개, 코딩 에이전트 6개, 음성 3개, 추론·인프라 6개, 관측 3개, 영상 2개, 이미지 2개, AI 앱 4개 — 총 41개 AI 서비스를 최대 5분 간격으로 폴링합니다. 모든 시각은 UTC 기준입니다.</p>
  <h3 data-i18n="s1.sourcesTitle">데이터 출처</h3>
  <p data-i18n="s1.sourcesDesc">상태·인시던트·uptime 데이터는 각 서비스의 공식 상태 페이지에서 수집됩니다. 제공사가 공개한 데이터가 1차 출처이며, 없는 값을 자체 추정으로 채우지 않습니다 — 공식 uptime이 없는 경우의 처리는 아래 <a href="#uptime">Uptime 섹션</a>에서 다룹니다.</p>
  <ul>
    <li><strong>Atlassian Statuspage</strong> <span data-i18n="s1.src.atlassian">— 다수의 주요 제공사</span></li>
    <li><strong>incident.io</strong> <span data-i18n="s1.src.incidentio">— 컴포넌트 단위 인시던트 + 영향도</span></li>
    <li><strong>Google Cloud Status · AI Studio Status</strong> <span data-i18n="s1.src.gcloud">— Gemini API (Google Cloud 상태 + AI Studio 컴포넌트 인시던트 병합)</span></li>
    <li><strong>Better Stack</strong>, <strong>Instatus</strong>, <strong>OnlineOrNot</strong> <span data-i18n="s1.src.others">— 그 외 상태 페이지 플랫폼 (인시던트 RSS + 가동률 JSON)</span></li>
    <li><strong>Flashduty</strong> <span data-i18n="s1.src.flashduty">— DeepSeek 상태 피드 정규화 (status.deepseek.com)</span></li>
    <li><strong>AWS Health Dashboard</strong> <span data-i18n="s1.src.awshealth">— Amazon Bedrock — 공개 이벤트 JSON API(인시던트 start/end), 가동률 API 없음</span></li>
    <li><strong>RSS incident feeds</strong> <span data-i18n="s1.src.rss">— Azure Status(Azure OpenAI) · xAI(status.x.ai) — 가동률 API 없이 인시던트 RSS만 수집</span></li>
    <li><strong>Direct RTT probes</strong> <span data-i18n="s1.src.probe">— 28개 AI 서비스의 API 엔드포인트 직접 측정</span></li>
  </ul>
  <h3 data-i18n="s1.secTitle">보안 이슈 모니터링</h3>
  <p data-i18n="s1.secDesc">상태·신뢰도 측정과는 별개로, AI 스택에 영향을 주는 보안 이슈도 함께 추적해 <strong>월간 리포트</strong>에 집계합니다. 이 데이터는 AIWatch Score나 인시던트 집계에는 반영되지 않습니다.</p>
  <ul>
    <li><strong>OSV.dev</strong> <span data-i18n="s1.sec.osv">— SDK 취약점 (PyPI · npm 24개 추적 패키지), GitHub Advisories로 상세 보강</span></li>
    <li><strong>Hacker News</strong> <span data-i18n="s1.sec.hn">— AI 서비스 관련 보안 뉴스 (Algolia 검색 API)</span></li>
  </ul>
</section>

<!-- §2 STATUS DETERMINATION -->
<section class="section" id="status">
  <p class="section-label">// 02</p>
  <h2 data-i18n="s2.title">상태 결정</h2>
  <p class="lead" data-i18n="s2.lead">서비스별 상태는 계층화된 우선순위 체인으로 결정되며, 화면에는 <strong>Operational · Partial · Degraded · Down</strong> 로 표기됩니다. 규칙은 위에서부터 순서대로 확인하며, 처음 일치하는 규칙에서 상태가 결정됩니다.</p>
  <div class="chain">
    <div class="chain-step">
      <div class="cs-num">1 · <span data-i18n="s2.1.tag">worst-of</span></div>
      <div class="cs-title" data-i18n="s2.1.title">멀티 컴포넌트 worst-of</div>
      <div class="cs-body" data-i18n="s2.1.body">하나의 서비스가 여러 컴포넌트로 구성된 경우(예: Cursor의 IDE + Cloud Agents + CLI), 그중 가장 심각한 상태를 서비스 배지에 표시합니다 (Down &gt; Degraded &gt; Operational).</div>
    </div>
    <div class="chain-step">
      <div class="cs-num">2 · <span data-i18n="s2.2.tag">component match</span></div>
      <div class="cs-title" data-i18n="s2.2.title">컴포넌트 매칭</div>
      <div class="cs-body" data-i18n="s2.2.body">해당 서비스의 주요 컴포넌트가 지정되어 있으면 그 컴포넌트의 상태를 사용합니다.</div>
    </div>
    <div class="chain-step">
      <div class="cs-num">3 · <span data-i18n="s2.3.tag">overall indicator</span></div>
      <div class="cs-title" data-i18n="s2.3.title">전체 인디케이터 폴백</div>
      <div class="cs-body" data-i18n="s2.3.body">컴포넌트를 찾지 못하면 상태 페이지의 전체 인디케이터로 폴백합니다. 단, 필터링 후 관련된 미해결 인시던트가 없으면 정상으로 간주해, 공유 상태 페이지에서 다른 서비스의 인시던트가 섞이는 것을 막습니다(예: ChatGPT 인시던트가 OpenAI API 상태에 영향을 주지 않도록).</div>
    </div>
    <div class="chain-step">
      <div class="cs-num">4 · <span data-i18n="s2.4.tag">incidentExclude bypass</span></div>
      <div class="cs-title" data-i18n="s2.4.title">incidentExclude 컴포넌트 우회</div>
      <div class="cs-body" data-i18n="s2.4.body">제목 기반 제외 패턴에 걸리더라도, 인시던트의 컴포넌트 태그가 해당 서비스의 주요 컴포넌트로 시작하면 포함합니다. 제목 문자열 매칭보다 컴포넌트 태그를 더 우선하기 때문입니다.</div>
    </div>
    <div class="chain-step">
      <div class="cs-num">5 · <span data-i18n="s2.5.tag">component-status filter</span></div>
      <div class="cs-title" data-i18n="s2.5.title">컴포넌트 상태 인시던트 필터</div>
      <div class="cs-body" data-i18n="s2.5.body">컴포넌트는 정상인데 제공사가 모든 컴포넌트에 인시던트를 일괄로 연결한 경우, 미해결 인시던트를 제거합니다(해결됨·모니터링은 유지). 이렇게 하면 무관한 인시던트가 정상 컴포넌트에 잘못 표시되지 않습니다.</div>
    </div>
    <div class="chain-step">
      <div class="cs-num">6 · <span data-i18n="s2.6.tag">fetch-failure cross-validation</span></div>
      <div class="cs-title" data-i18n="s2.6.title">수집 실패 보정</div>
      <div class="cs-body" data-i18n="s2.6.body">상태 페이지를 못 읽어 저하로 잡혔더라도 probe RTT가 정상이면 다시 정상으로 되돌립니다. 같은 플랫폼의 70% 이상이 동시에 실패하면 플랫폼 자체 장애로 판단해 모두 정상으로 처리합니다. 확실한 근거가 있을 때만 보수적으로 덮어씁니다.</div>
    </div>
  </div>
  <p class="note" data-i18n="s2.partial"><strong>Partial</strong>은 다중 컴포넌트 서비스(Better Stack 기반 — Together · Fireworks · HuggingFace · Modal · Luma)에서 전체 서비스는 정상이지만 일부 컴포넌트(예: 특정 모델)만 영향받은 중간 상태입니다. 서비스 전체를 'degraded'로 격상시키지는 않되, 영향받은 컴포넌트의 실제 장애는 uptime · 인시던트 집계를 통해 AIWatch Score · 랭킹에 그대로 반영됩니다.</p>
  <p class="note" data-i18n="s2.note">규칙의 전체 순서와 각 규칙의 근거는 오픈소스 저장소의 <a href="https://github.com/bentleypark/aiwatch/blob/main/docs/reference/status-determination.md" target="_blank" rel="noopener">status-determination 문서</a>에 공개되어 있습니다.</p>
</section>

<!-- §3 UPTIME -->
<section class="section" id="uptime">
  <p class="section-label">// 03</p>
  <h2 data-i18n="s3.title">Uptime</h2>
  <p class="lead" data-i18n="s3.lead">Uptime%는 출처에 따라 두 가지 방식으로 나뉩니다.</p>
  <ul>
    <li><strong data-i18n="s3.official">Official</strong> <span data-i18n="s3.officialDesc">— 상태 페이지가 공개한 %를 그대로 읽습니다(페이지마다 집계 기간이 다름).</span></li>
    <li><strong data-i18n="s3.platform">Platform</strong> <span data-i18n="s3.platformDesc">— 상태 페이지 플랫폼(Better Stack)이 자체 모니터로 측정한 가동률 (Together · Fireworks · HuggingFace · Modal · Luma). 제공사 공식 SLA가 아닌 플랫폼 측정치입니다.</span></li>
  </ul>
  <p data-i18n="s3.weighted"><strong>Atlassian 가중 영향 일수:</strong> 다운타임은 단순 인시던트 건수가 아니라, 각 날짜를 그날의 가장 심각한 영향도로 가중한 "영향 일수"로 집계합니다 — critical · major = 1.0, minor = 0.3, 정보성/null = 제외. uptime과 score 모두 같은 가중 방식을 씁니다.</p>

  <div class="limits">
    <div class="limits-label">⚠ <span data-i18n="s3.limits.label">측정 한계와 그 이유</span></div>
    <p data-i18n="s3.limits.intro">아래 서비스는 공식 상태 페이지에 비교 가능한 30일 롤링 uptime%가 없습니다. 임의로 추측해 채우는 대신 "— Not provided"로 명확히 표시합니다.</p>
    <div class="tbl-wrap">
      <table class="tbl">
        <thead><tr><th data-i18n="s3.limits.col1">서비스</th><th data-i18n="s3.limits.col2">측정 불가 사유</th></tr></thead>
        <tbody>
          <tr><td>Amazon Bedrock · Azure OpenAI</td><td data-i18n="s3.limits.estimate">공식 롤링 uptime% 미공개 — 인시던트 피드만 존재</td></tr>
          <tr><td>Gemini · OpenRouter · Deepgram</td><td data-i18n="s3.limits.norolling">상태 페이지가 비교 가능한 롤링 30일 % 미노출</td></tr>
          <tr><td>xAI</td><td data-i18n="s3.limits.xai">재시작 이후 엔드포인트별 성공률만 노출 — 30일 수치와 비교 불가</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</section>

<!-- §4 LATENCY -->
<section class="section" id="latency">
  <p class="section-label">// 04</p>
  <h2 data-i18n="s5.title">레이턴시 (Probe RTT)</h2>
  <p class="lead" data-i18n="s5.lead">28개 AI 서비스의 API 엔드포인트를 Cloudflare Workers 엣지에서 5분 간격으로 직접 측정합니다. p50 / p75 / p95 분위수를 산출합니다.</p>
  <div class="limits">
    <div class="limits-label">⚠ <span data-i18n="s5.limit.label">핵심 한계 — 네트워크 RTT ≠ 추론 레이턴시</span></div>
    <p data-i18n="s5.limit.body">Probe RTT는 <strong>네트워크 왕복 시간</strong>을 측정합니다. 모델의 추론(토큰 생성) 레이턴시가 아닙니다. "이 서비스가 얼마나 빨리 토큰을 만드나"가 아니라 "엔드포인트가 네트워크 계층에서 얼마나 빨리 응답하나"를 나타냅니다.</p>
    <p data-i18n="s5.limit.probe"><strong>Probe 미적용:</strong> 레이턴시 랭킹은 직접 probe하는 28개 AI 서비스만 대상입니다 — 앱·코딩 에이전트, 그리고 probe하지 않는 나머지 3개 AI 서비스는 제외됩니다.</p>
  </div>
</section>

<!-- §5 INCIDENTS -->
<section class="section" id="incidents">
  <p class="section-label">// 05</p>
  <h2 data-i18n="s6.title">인시던트 · MTTR · 탐지</h2>

  <h3 data-i18n="s6.counting.title">인시던트 집계</h3>
  <p data-i18n="s6.counting.body">인시던트 수는 서비스별 영향 컴포넌트를 모두 반영합니다. 제공사마다 인시던트를 세분화하는 정도가 다릅니다 — Anthropic은 모델별(Opus/Sonnet/Haiku)로 따로 보고해, 서비스 단위로 묶어 보고하는 곳보다 건수가 부풀려집니다. 따라서 건수가 많다고 신뢰도가 낮은 것은 아니며, 제공사끼리 비교할 때는 이 세분화 차이를 감안해야 합니다.</p>

  <h3 data-i18n="s6.mttr.title">복구 시간 (MTTR)</h3>
  <p data-i18n="s6.mttr.body">Score의 Recovery 항목은 30일 중앙값을 사용합니다. 반면 ServiceDetails의 "Recovery" 카드는 7일 중앙값 + 최악값("일반 15분 · 최악 29시간34분")을 보여줍니다. 두 값은 같은 중앙값 방식을 쓰지만 관측 기간(7일 vs 30일)이 달라 서로 다를 수 있으며, 이는 정상입니다.</p>

  <h3 data-i18n="s6.detection.title">탐지 (Detection)</h3>
  <p data-i18n="s6.detection.body">탐지 지표는 두 가지입니다 — MTTD(평균 탐지 시간, AIWatch가 인시던트를 감지하기까지 걸린 시간)와 RTT 저하 탐지(probe RTT 급증으로 잡는 조기 신호). 상태 페이지 폴링은 공식 발표보다 늦을 수밖에 없으므로, AIWatch는 <strong>"공식 상태 페이지보다 빠르다"고 절대 주장하지 않고</strong> 이 두 지표로만 정직하게 표현합니다. 이 지표는 월간 리포트에 집계되며, AIWatch Score나 대시보드 숫자에는 반영되지 않습니다.</p>

  <div class="limits">
    <div class="limits-label">⚠ <span data-i18n="s6.limit.label">한계</span></div>
    <p data-i18n="s6.limit.body">최근 항목만 짧게 노출되는 출처(Azure·Bedrock)는 잠깐 발생했다 사라지는 인시던트를 놓칠 수 있습니다.</p>
  </div>
</section>

<!-- §6 AIWATCH SCORE -->
<section class="section" id="score">
  <p class="section-label">// 06</p>
  <h2 data-i18n="s4.title">AIWatch Score</h2>
  <p class="lead" data-i18n="s4.intro">AIWatch Score는 uptime, 인시던트 영향 일수, 복구 시간, (probe 대상 API 서비스의 경우) 응답성을 종합한 0~100점 신뢰도 지표입니다. 30일 데이터를 기준으로 합니다.</p>
  <div class="formula" data-i18n="s4.formulaStr">AIWatch Score = Uptime + Incidents + Recovery + Responsiveness</div>
  <div class="score-grid">
    <div class="score-card sc-uptime"><div class="sc-max">40</div><div class="sc-label">Uptime</div></div>
    <div class="score-card sc-inc"><div class="sc-max">25</div><div class="sc-label">Incidents</div></div>
    <div class="score-card sc-rec"><div class="sc-max">15</div><div class="sc-label">Recovery</div></div>
    <div class="score-card sc-resp"><div class="sc-max">20</div><div class="sc-label">Responsiveness</div></div>
  </div>

  <!-- Uptime sub -->
  <div class="subscore">
    <h3 data-i18n="s4.uptime.title">Uptime Score (0~40)</h3>
    <div class="formula">(uptime% − 95%) / 5% × 40</div>
    <div class="tbl-wrap">
      <table class="tbl mono">
        <thead><tr><th data-i18n="s4.input">입력</th><th data-i18n="s4.points">점수</th></tr></thead>
        <tbody>
          <tr><td>100%</td><td>40</td></tr>
          <tr><td>99.5%</td><td>36</td></tr>
          <tr><td>99.0%</td><td>32</td></tr>
          <tr><td>97.0%</td><td>16</td></tr>
          <tr><td>95% <span data-i18n="s4.below">이하</span></td><td>0</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <!-- Incidents sub -->
  <div class="subscore">
    <h3 data-i18n="s4.inc.title">Incident Score (0~25)</h3>
    <div class="formula">25 × exp(−weighted_days / 10)</div>
    <div class="tbl-wrap">
      <table class="tbl mono">
        <thead><tr><th data-i18n="s4.input">입력</th><th data-i18n="s4.points">점수</th></tr></thead>
        <tbody>
          <tr><td>0 <span data-i18n="s4.days">일</span></td><td>25.0</td></tr>
          <tr><td>5 <span data-i18n="s4.days">일</span></td><td>15.2</td></tr>
          <tr><td>10 <span data-i18n="s4.days">일</span></td><td>9.2</td></tr>
          <tr><td>18 <span data-i18n="s4.days">일</span></td><td>4.1</td></tr>
          <tr><td>30 <span data-i18n="s4.days">일</span></td><td>1.2</td></tr>
        </tbody>
      </table>
    </div>
    <p class="note" data-i18n="s4.inc.note">표의 값은 critical/major 영향(가중치 1.0)을 기준으로 합니다. minor만 발생한 날은 가중치 0.3입니다 — 예: minor 5일 ≈ 가중 1.5일 ≈ 21.5점.</p>
    <p data-i18n="s4.inc.why"><strong>영향 일수를 쓰는 이유:</strong> 일부 서비스(Anthropic 등)는 모델별(Opus/Sonnet/Haiku)로 인시던트를 따로 보고해 같은 장애가 여러 건으로 집계됩니다. 그래서 건수가 아닌 영향 일수를 쓰고, 각 날짜를 그날의 가장 심각한 영향도로 가중합니다 — critical/major = 1.0, minor = 0.3, 정보성/null = 제외.</p>
  </div>

  <!-- Recovery sub -->
  <div class="subscore">
    <h3 data-i18n="s4.rec.title">Recovery Score (0~15)</h3>
    <div class="formula">15 × exp(−MTTR_hours / 4)</div>
    <div class="tbl-wrap">
      <table class="tbl mono">
        <thead><tr><th data-i18n="s4.input">입력</th><th data-i18n="s4.points">점수</th></tr></thead>
        <tbody>
          <tr><td>30 <span data-i18n="s4.min">분</span></td><td>13.2</td></tr>
          <tr><td>1 <span data-i18n="s4.hour">시간</span></td><td>11.7</td></tr>
          <tr><td>2 <span data-i18n="s4.hour">시간</span></td><td>9.1</td></tr>
          <tr><td>4 <span data-i18n="s4.hour">시간</span></td><td>5.5</td></tr>
          <tr><td>10 <span data-i18n="s4.hour">시간</span></td><td>1.2</td></tr>
        </tbody>
      </table>
    </div>
    <p class="note" data-i18n="s4.rec.note">MTTR은 해결된 인시던트 지속 시간의 30일 중앙값입니다(3건 미만이면 평균으로 폴백).</p>
  </div>

  <!-- Responsiveness sub -->
  <div class="subscore">
    <h3 data-i18n="s4.resp.title">Responsiveness Score (0~20)</h3>
    <p data-i18n="s4.resp.desc">5분 간격 health-check probe로 실제 API 엔드포인트의 응답 속도와 안정성을 측정합니다(28개 AI 서비스). 응답 속도와 일관성을 함께 반영합니다.</p>
    <div class="formula"><span class="fl-sub" data-i18n="s4.resp.speed">Speed (0~10) — p50 RTT 지수 감쇠</span><br>10 × exp(−max(p50, 50ms) / 400ms)</div>
    <div class="formula"><span class="fl-sub" data-i18n="s4.resp.stability">Stability (0~10) — 결합 변동계수 지수 감쇠</span><br>10 × exp(−CV_combined / 0.5)</div>
    <p data-i18n="s4.resp.na1">앱과 코딩 에이전트는 측정할 API 엔드포인트가 없어 probe 대상이 아니며, probe 세트(28개)에 들지 않은 나머지 3개 AI 서비스(Bedrock · Azure OpenAI · Modal)도 probe하지 않습니다.</p>
    <p data-i18n="s4.resp.na2">이 경우 80점 만점을 100점으로 환산합니다(가용 컴포넌트만으로 산정).</p>
    <div class="formula">Score = (Uptime + Incidents + Recovery) / 80 × 100<br><span class="fl-sub" data-i18n="s4.resp.naFormula">probe-less: base 80 → 100 환산</span></div>
    <p class="note" data-i18n="s4.resp.insufficient">새로 추가된 probe 대상 서비스는 7일치 데이터가 쌓이기 전까지 5% 페널티를 적용합니다.</p>
  </div>

  <!-- No uptime data -->
  <div class="subscore">
    <h3 data-i18n="s4.noUptime.title">Uptime 미제공 서비스</h3>
    <p data-i18n="s4.noUptime.desc">일부 서비스(Gemini·xAI·Bedrock 등)는 공식 uptime 수치가 없습니다. 가정값을 넣지 않고 uptime 컴포넌트(40점)를 제외한 뒤 나머지 가용 컴포넌트만으로 100점 환산합니다. probe가 있는 서비스(Gemini·xAI·OpenRouter 등)는 인시던트·복구·응답성으로 점수를 산정해 랭킹에 포함합니다. probe도 없는 서비스(Bedrock·Azure)는 측정 신호가 인시던트·복구뿐이라 신뢰할 점수를 낼 수 없어, 점수를 산출·표시하지 않고 인시던트 추적만 제공합니다.</p>
    <div class="formula">Score = (가용 컴포넌트 점수 합) / (가용 컴포넌트 max 합) × 100 <span class="fl-sub">— uptime 40점 제외</span></div>
  </div>

  <!-- Grades -->
  <h3 data-i18n="s4.grades.title">등급 기준</h3>
  <div class="grades">
    <div class="grade-row"><span class="grade-badge g-excellent">90+</span><span class="grade-name">Excellent</span></div>
    <div class="grade-row"><span class="grade-badge g-good">75+</span><span class="grade-name">Good</span></div>
    <div class="grade-row"><span class="grade-badge g-fair">55+</span><span class="grade-name">Fair</span></div>
    <div class="grade-row"><span class="grade-badge g-degrading">40+</span><span class="grade-name">Degrading</span></div>
    <div class="grade-row"><span class="grade-badge g-unstable">&lt;40</span><span class="grade-name">Unstable</span></div>
  </div>
</section>

<!-- §7 INDEPENDENCE -->
<section class="section indep" id="independence">
  <p class="section-label">// 07</p>
  <h2 data-i18n="s7.title">독립성 · 프라이버시</h2>
  <p class="lead" data-i18n="s7.lead">AIWatch는 AI 서비스 신뢰도를 중립적으로 측정합니다. 그 결과를 데이터로 보여주고, 누구의 영향도 받지 않고 공개합니다.</p>
  <div class="indep-grid">
    <div class="indep-card">
      <div class="ic-title"><span class="ic-icon">🆓</span> <span data-i18n="s7.free.title">무료 · 무가입</span></div>
      <div class="ic-body" data-i18n="s7.free.body">공개 대시보드는 완전 무료이며, 계정이나 로그인 없이 누구나 이용할 수 있습니다. 개인정보(PII)는 수집하지 않습니다.</div>
    </div>
    <div class="indep-card">
      <div class="ic-title"><span class="ic-icon">🔍</span> <span data-i18n="s7.open.title">오픈소스</span></div>
      <div class="ic-body" data-i18n="s7.open.body">상태 결정, 점수 산정, 수집 로직 전부가 AGPL-3.0으로 공개되어 있습니다. 방법론을 직접 검증할 수 있습니다.</div>
    </div>
    <div class="indep-card">
      <div class="ic-title"><span class="ic-icon">⚖️</span> <span data-i18n="s7.merit.title">성과 기반</span></div>
      <div class="ic-body" data-i18n="s7.merit.body">Score와 Fallback 추천은 객관적으로 측정된 신뢰도에만 근거합니다. 순위나 추천은 비용으로 살 수 없습니다.</div>
    </div>
    <div class="indep-card">
      <div class="ic-title"><span class="ic-icon">🔒</span> <span data-i18n="s7.privacy.title">프라이버시</span></div>
      <div class="ic-body" data-i18n="s7.privacy.body">익명 사용 통계(GA4)만, 동의 시에만 수집합니다. 동의 없이는 분석·광고 쿠키가 저장되지 않습니다.</div>
    </div>
  </div>
  <p data-i18n="s7.close">이 중립성이 AIWatch 데이터를 의사결정에 쓸 수 있게 하는 핵심입니다 — AIWatch는 측정한 것만 말하고, 측정할 수 없는 것은 분명히 밝힙니다.</p>
</section>

</main>
</div>

<footer>
  <div class="footer-inner">
    <div class="footer-left">© 2026 AIWatch · AGPL-3.0</div>
    <div class="footer-links">
      <a href="https://ai-watch.dev" data-i18n="footer.dashboard" data-ga="click_dashboard" data-ga-loc="methodology_footer">라이브 대시보드</a>
      <a href="/reports/" data-i18n="footer.reports">월간 리포트</a>
      <a href="https://github.com/bentleypark/aiwatch" data-i18n="footer.github" data-ga="click_github" data-ga-loc="methodology_footer">GitHub (오픈소스)</a>
      <a href="https://ai-watch.dev/feed.xml" data-i18n="footer.rss">RSS</a>
    </div>
  </div>
</footer>
</div>

<script>
const i18n = {
  ko: {
    'nav.report': '월간 리포트', 'nav.github': 'GitHub', 'nav.cta': '대시보드 열기 →',
    'toc.onthispage': '// 목차',
    'toc.sources': '측정 대상', 'toc.status': '상태 결정', 'toc.uptime': 'Uptime', 'toc.score': 'AIWatch Score', 'toc.latency': '레이턴시', 'toc.incidents': '인시던트 · MTTR · 탐지', 'toc.independence': '독립성 · 프라이버시',
    'hero.badge': 'METHODOLOGY',
    'hero.title': 'AIWatch는 <em>어떻게</em> 동작하는가 — 측정 방법론',
    'hero.tagline': 'AI 서비스 신뢰도를 독립적이고 투명하게 측정합니다 — 계정도, 개인정보도 필요 없습니다.',
    'hero.meta': '41개 서비스 · 5분 간격 폴링 · UTC 기준',
    'hero.principle': '<strong>측정할 수 있는 것은 공개하고, 측정할 수 없는 것은 분명히 밝힙니다.</strong>',
    's1.title': '측정 대상',
    's1.lead': 'AIWatch는 LLM API 15개, 코딩 에이전트 6개, 음성 3개, 추론·인프라 6개, 관측 3개, 영상 2개, 이미지 2개, AI 앱 4개 — 총 41개 AI 서비스를 최대 5분 간격으로 폴링합니다. 모든 시각은 UTC 기준입니다.',
    's1.sourcesTitle': '데이터 출처',
    's1.sourcesDesc': '상태·인시던트·uptime 데이터는 각 서비스의 공식 상태 페이지에서 수집됩니다. 제공사가 공개한 데이터가 1차 출처이며, 없는 값을 자체 추정으로 채우지 않습니다 — 공식 uptime이 없는 경우의 처리는 아래 <a href="#uptime">Uptime 섹션</a>에서 다룹니다.',
    's1.src.atlassian': '— 다수의 주요 제공사', 's1.src.incidentio': '— 컴포넌트 단위 인시던트 + 영향도', 's1.src.gcloud': '— Gemini API (Google Cloud 상태 + AI Studio 컴포넌트 인시던트 병합)', 's1.src.others': '— 그 외 상태 페이지 플랫폼 (인시던트 RSS + 가동률 JSON)', 's1.src.flashduty': '— DeepSeek 상태 피드 정규화 (status.deepseek.com)', 's1.src.awshealth': '— Amazon Bedrock — 공개 이벤트 JSON API(인시던트 start/end), 가동률 API 없음', 's1.src.rss': '— Azure Status(Azure OpenAI) · xAI(status.x.ai) — 가동률 API 없이 인시던트 RSS만 수집', 's1.src.probe': '— 28개 AI 서비스의 API 엔드포인트 직접 측정',
    's1.secTitle': '보안 이슈 모니터링',
    's1.secDesc': '상태·신뢰도 측정과는 별개로, AI 스택에 영향을 주는 보안 이슈도 함께 추적해 <strong>월간 리포트</strong>에 집계합니다. 이 데이터는 AIWatch Score나 인시던트 집계에는 반영되지 않습니다.',
    's1.sec.osv': '— SDK 취약점 (PyPI · npm 24개 추적 패키지), GitHub Advisories로 상세 보강', 's1.sec.hn': '— AI 서비스 관련 보안 뉴스 (Algolia 검색 API)',
    's2.title': '상태 결정',
    's2.lead': '서비스별 상태는 계층화된 우선순위 체인으로 결정되며, 화면에는 <strong>Operational · Partial · Degraded · Down</strong> 로 표기됩니다. 규칙은 위에서부터 순서대로 확인하며, 처음 일치하는 규칙에서 상태가 결정됩니다.',
    's2.1.tag': 'worst-of', 's2.1.title': '멀티 컴포넌트 worst-of', 's2.1.body': '하나의 서비스가 여러 컴포넌트로 구성된 경우(예: Cursor의 IDE + Cloud Agents + CLI), 그중 가장 심각한 상태를 서비스 배지에 표시합니다 (Down > Degraded > Operational).',
    's2.2.tag': 'component match', 's2.2.title': '컴포넌트 매칭', 's2.2.body': '해당 서비스의 주요 컴포넌트가 지정되어 있으면 그 컴포넌트의 상태를 사용합니다.',
    's2.3.tag': 'overall indicator', 's2.3.title': '전체 인디케이터 폴백', 's2.3.body': '컴포넌트를 찾지 못하면 상태 페이지의 전체 인디케이터로 폴백합니다. 단, 필터링 후 관련된 미해결 인시던트가 없으면 정상으로 간주해, 공유 상태 페이지에서 다른 서비스의 인시던트가 섞이는 것을 막습니다(예: ChatGPT 인시던트가 OpenAI API 상태에 영향을 주지 않도록).',
    's2.4.tag': 'incidentExclude bypass', 's2.4.title': 'incidentExclude 컴포넌트 우회', 's2.4.body': '제목 기반 제외 패턴에 걸리더라도, 인시던트의 컴포넌트 태그가 해당 서비스의 주요 컴포넌트로 시작하면 포함합니다. 제목 문자열 매칭보다 컴포넌트 태그를 더 우선하기 때문입니다.',
    's2.5.tag': 'component-status filter', 's2.5.title': '컴포넌트 상태 인시던트 필터', 's2.5.body': '컴포넌트는 정상인데 제공사가 모든 컴포넌트에 인시던트를 일괄로 연결한 경우, 미해결 인시던트를 제거합니다(해결됨·모니터링은 유지). 이렇게 하면 무관한 인시던트가 정상 컴포넌트에 잘못 표시되지 않습니다.',
    's2.6.tag': 'fetch-failure cross-validation', 's2.6.title': '수집 실패 보정', 's2.6.body': '상태 페이지를 못 읽어 저하로 잡혔더라도 probe RTT가 정상이면 다시 정상으로 되돌립니다. 같은 플랫폼의 70% 이상이 동시에 실패하면 플랫폼 자체 장애로 판단해 모두 정상으로 처리합니다. 확실한 근거가 있을 때만 보수적으로 덮어씁니다.',
    's2.partial': '<strong>Partial</strong>은 다중 컴포넌트 서비스(Better Stack 기반 — Together · Fireworks · HuggingFace · Modal · Luma)에서 전체 서비스는 정상이지만 일부 컴포넌트(예: 특정 모델)만 영향받은 중간 상태입니다. 서비스 전체를 \\'degraded\\'로 격상시키지는 않되, 영향받은 컴포넌트의 실제 장애는 uptime · 인시던트 집계를 통해 AIWatch Score · 랭킹에 그대로 반영됩니다.',
    's2.note': '규칙의 전체 순서와 각 규칙의 근거는 오픈소스 저장소의 <a href="https://github.com/bentleypark/aiwatch/blob/main/docs/reference/status-determination.md" target="_blank" rel="noopener">status-determination 문서</a>에 공개되어 있습니다.',
    's3.title': 'Uptime',
    's3.lead': 'Uptime%는 출처에 따라 두 가지 방식으로 나뉩니다.',
    's3.official': 'Official', 's3.officialDesc': '— 상태 페이지가 공개한 %를 그대로 읽습니다(페이지마다 집계 기간이 다름).',
    's3.platform': 'Platform', 's3.platformDesc': '— 상태 페이지 플랫폼(Better Stack)이 자체 모니터로 측정한 가동률 (Together · Fireworks · HuggingFace · Modal · Luma). 제공사 공식 SLA가 아닌 플랫폼 측정치입니다.',
    's3.weighted': '<strong>Atlassian 가중 영향 일수:</strong> 다운타임은 단순 인시던트 건수가 아니라, 각 날짜를 그날의 가장 심각한 영향도로 가중한 "영향 일수"로 집계합니다 — critical · major = 1.0, minor = 0.3, 정보성/null = 제외. uptime과 score 모두 같은 가중 방식을 씁니다.',
    's3.limits.label': '측정 한계와 그 이유',
    's3.limits.intro': '아래 서비스는 공식 상태 페이지에 비교 가능한 30일 롤링 uptime%가 없습니다. 임의로 추측해 채우는 대신 "— Not provided"로 명확히 표시합니다.',
    's3.limits.col1': '서비스', 's3.limits.col2': '측정 불가 사유',
    's3.limits.estimate': '공식 롤링 uptime% 미공개 — 인시던트 피드만 존재',
    's3.limits.norolling': '상태 페이지가 비교 가능한 롤링 30일 % 미노출',
    's3.limits.xai': '재시작 이후 엔드포인트별 성공률만 노출 — 30일 수치와 비교 불가',
    's4.title': 'AIWatch Score',
    's4.intro': 'AIWatch Score는 uptime, 인시던트 영향 일수, 복구 시간, (probe 대상 API 서비스의 경우) 응답성을 종합한 0~100점 신뢰도 지표입니다. 30일 데이터를 기준으로 합니다.',
    's4.formulaStr': 'AIWatch Score = Uptime + Incidents + Recovery + Responsiveness',
    's4.input': '입력', 's4.points': '점수', 's4.below': '이하', 's4.days': '일', 's4.min': '분', 's4.hour': '시간',
    's4.uptime.title': 'Uptime Score (0~40)',
    's4.inc.title': 'Incident Score (0~25)',
    's4.inc.note': '표의 값은 critical/major 영향(가중치 1.0)을 기준으로 합니다. minor만 발생한 날은 가중치 0.3입니다 — 예: minor 5일 ≈ 가중 1.5일 ≈ 21.5점.',
    's4.inc.why': '<strong>영향 일수를 쓰는 이유:</strong> 일부 서비스(Anthropic 등)는 모델별(Opus/Sonnet/Haiku)로 인시던트를 따로 보고해 같은 장애가 여러 건으로 집계됩니다. 그래서 건수가 아닌 영향 일수를 쓰고, 각 날짜를 그날의 가장 심각한 영향도로 가중합니다 — critical/major = 1.0, minor = 0.3, 정보성/null = 제외.',
    's4.rec.title': 'Recovery Score (0~15)',
    's4.rec.note': 'MTTR은 해결된 인시던트 지속 시간의 30일 중앙값입니다(3건 미만이면 평균으로 폴백).',
    's4.resp.title': 'Responsiveness Score (0~20)',
    's4.resp.desc': '5분 간격 health-check probe로 실제 API 엔드포인트의 응답 속도와 안정성을 측정합니다(28개 AI 서비스). 응답 속도와 일관성을 함께 반영합니다.',
    's4.resp.speed': 'Speed (0~10) — p50 RTT 지수 감쇠',
    's4.resp.stability': 'Stability (0~10) — 결합 변동계수 지수 감쇠',
    's4.resp.na1': '앱과 코딩 에이전트는 측정할 API 엔드포인트가 없어 probe 대상이 아니며, probe 세트(28개)에 들지 않은 나머지 3개 AI 서비스(Bedrock · Azure OpenAI · Modal)도 probe하지 않습니다.',
    's4.resp.na2': '이 경우 80점 만점을 100점으로 환산합니다(가용 컴포넌트만으로 산정).',
    's4.resp.naFormula': 'probe-less: base 80 → 100 환산',
    's4.resp.insufficient': '새로 추가된 probe 대상 서비스는 7일치 데이터가 쌓이기 전까지 5% 페널티를 적용합니다.',
    's4.noUptime.title': 'Uptime 미제공 서비스',
    's4.noUptime.desc': '일부 서비스(Gemini·xAI·Bedrock 등)는 공식 uptime 수치가 없습니다. 가정값을 넣지 않고 uptime 컴포넌트(40점)를 제외한 뒤 나머지 가용 컴포넌트만으로 100점 환산합니다. probe가 있는 서비스(Gemini·xAI·OpenRouter 등)는 인시던트·복구·응답성으로 점수를 산정해 랭킹에 포함합니다. probe도 없는 서비스(Bedrock·Azure)는 측정 신호가 인시던트·복구뿐이라 신뢰할 점수를 낼 수 없어, 점수를 산출·표시하지 않고 인시던트 추적만 제공합니다.',
    's4.grades.title': '등급 기준',
    's5.title': '레이턴시 (Probe RTT)',
    's5.lead': '28개 AI 서비스의 API 엔드포인트를 Cloudflare Workers 엣지에서 5분 간격으로 직접 측정합니다. p50 / p75 / p95 분위수를 산출합니다.',
    's5.limit.label': '핵심 한계 — 네트워크 RTT ≠ 추론 레이턴시',
    's5.limit.body': 'Probe RTT는 <strong>네트워크 왕복 시간</strong>을 측정합니다. 모델의 추론(토큰 생성) 레이턴시가 아닙니다. "이 서비스가 얼마나 빨리 토큰을 만드나"가 아니라 "엔드포인트가 네트워크 계층에서 얼마나 빨리 응답하나"를 나타냅니다.',
    's5.limit.probe': '<strong>Probe 미적용:</strong> 레이턴시 랭킹은 직접 probe하는 28개 AI 서비스만 대상입니다 — 앱·코딩 에이전트, 그리고 probe하지 않는 나머지 3개 AI 서비스는 제외됩니다.',
    's6.title': '인시던트 · MTTR · 탐지',
    's6.counting.title': '인시던트 집계',
    's6.counting.body': '인시던트 수는 서비스별 영향 컴포넌트를 모두 반영합니다. 제공사마다 인시던트를 세분화하는 정도가 다릅니다 — Anthropic은 모델별(Opus/Sonnet/Haiku)로 따로 보고해, 서비스 단위로 묶어 보고하는 곳보다 건수가 부풀려집니다. 따라서 건수가 많다고 신뢰도가 낮은 것은 아니며, 제공사끼리 비교할 때는 이 세분화 차이를 감안해야 합니다.',
    's6.mttr.title': '복구 시간 (MTTR)',
    's6.mttr.body': 'Score의 Recovery 항목은 30일 중앙값을 사용합니다. 반면 ServiceDetails의 "Recovery" 카드는 7일 중앙값 + 최악값("일반 15분 · 최악 29시간34분")을 보여줍니다. 두 값은 같은 중앙값 방식을 쓰지만 관측 기간(7일 vs 30일)이 달라 서로 다를 수 있으며, 이는 정상입니다.',
    's6.detection.title': '탐지 (Detection)',
    's6.detection.body': '탐지 지표는 두 가지입니다 — MTTD(평균 탐지 시간, AIWatch가 인시던트를 감지하기까지 걸린 시간)와 RTT 저하 탐지(probe RTT 급증으로 잡는 조기 신호). 상태 페이지 폴링은 공식 발표보다 늦을 수밖에 없으므로, AIWatch는 <strong>"공식 상태 페이지보다 빠르다"고 절대 주장하지 않고</strong> 이 두 지표로만 정직하게 표현합니다. 이 지표는 월간 리포트에 집계되며, AIWatch Score나 대시보드 숫자에는 반영되지 않습니다.',
    's6.limit.label': '한계',
    's6.limit.body': '최근 항목만 짧게 노출되는 출처(Azure·Bedrock)는 잠깐 발생했다 사라지는 인시던트를 놓칠 수 있습니다.',
    's7.title': '독립성 · 프라이버시',
    's7.lead': 'AIWatch는 AI 서비스 신뢰도를 중립적으로 측정합니다. 그 결과를 데이터로 보여주고, 누구의 영향도 받지 않고 공개합니다.',
    's7.free.title': '무료 · 무가입', 's7.free.body': '공개 대시보드는 완전 무료이며, 계정이나 로그인 없이 누구나 이용할 수 있습니다. 개인정보(PII)는 수집하지 않습니다.',
    's7.open.title': '오픈소스', 's7.open.body': '상태 결정, 점수 산정, 수집 로직 전부가 AGPL-3.0으로 공개되어 있습니다. 방법론을 직접 검증할 수 있습니다.',
    's7.merit.title': '성과 기반', 's7.merit.body': 'Score와 Fallback 추천은 객관적으로 측정된 신뢰도에만 근거합니다. 순위나 추천은 비용으로 살 수 없습니다.',
    's7.privacy.title': '프라이버시', 's7.privacy.body': '익명 사용 통계(GA4)만, 동의 시에만 수집합니다. 동의 없이는 분석·광고 쿠키가 저장되지 않습니다.',
    's7.close': '이 중립성이 AIWatch 데이터를 의사결정에 쓸 수 있게 하는 핵심입니다 — AIWatch는 측정한 것만 말하고, 측정할 수 없는 것은 분명히 밝힙니다.',
    'footer.dashboard': '라이브 대시보드', 'footer.reports': '월간 리포트', 'footer.github': 'GitHub (오픈소스)', 'footer.rss': 'RSS'
  },
  en: {
    'nav.report': 'Monthly Report', 'nav.github': 'GitHub', 'nav.cta': 'Dashboard →',
    'toc.onthispage': '// on this page',
    'toc.sources': 'What we measure', 'toc.status': 'Status', 'toc.uptime': 'Uptime', 'toc.score': 'AIWatch Score', 'toc.latency': 'Latency', 'toc.incidents': 'Incidents · MTTR · Detection', 'toc.independence': 'Independence · Privacy',
    'hero.badge': 'METHODOLOGY',
    'hero.title': 'How AIWatch <em>Works</em> — Methodology',
    'hero.tagline': 'Independent, transparent measurement of AI service reliability — no account, no PII.',
    'hero.meta': '41 services · polled every 5 min · UTC',
    'hero.principle': '<strong>We publish what we can measure — and are explicit about what we can\\\'t.</strong>',
    's1.title': 'What we measure',
    's1.lead': 'AIWatch polls 41 AI services — 15 LLM APIs, 6 coding agents, 3 voice, 6 inference & infra, 3 observability, 2 video, 2 image, and 4 AI apps — up to every 5 minutes. All timestamps are in UTC.',
    's1.sourcesTitle': 'Data sources',
    's1.sourcesDesc': 'Status, incident, and uptime data are all collected from each service\\\'s official status page. The provider\\\'s published data is the primary source, and we never fill a missing value with our own estimate — how a missing official uptime is handled is covered in the <a href="#uptime">Uptime section</a> below.',
    's1.src.atlassian': '— many major providers', 's1.src.incidentio': '— per-component incidents + impact', 's1.src.gcloud': '— Gemini API (Google Cloud status + AI Studio component incidents, merged)', 's1.src.others': '— additional status-page platforms (incident RSS + uptime JSON)', 's1.src.flashduty': '— normalized DeepSeek status feed (status.deepseek.com)', 's1.src.awshealth': '— Amazon Bedrock — public events JSON API (incident start/end), no uptime API', 's1.src.rss': '— Azure Status (Azure OpenAI) · xAI (status.x.ai) — incident RSS only, no uptime API', 's1.src.probe': '— direct measurement of 28 AI services\\\' API endpoints',
    's1.secTitle': 'Security-issue monitoring',
    's1.secDesc': 'On a track separate from status & reliability, we also track security issues affecting the AI stack, aggregated into the <strong>monthly report</strong>. This data does not feed the AIWatch Score or incident counts.',
    's1.sec.osv': '— SDK vulnerabilities (24 tracked PyPI · npm packages), enriched via GitHub Advisories', 's1.sec.hn': '— security news about AI services (Algolia search API)',
    's2.title': 'Status determination',
    's2.lead': 'Per-service status is resolved by a layered priority chain and shown as <strong>Operational · Partial · Degraded · Down</strong>. Rules apply top-to-bottom and stop at the first match.',
    's2.1.tag': 'worst-of', 's2.1.title': 'Multi-component worst-of', 's2.1.body': 'When a user-facing surface spans multiple components (e.g. Cursor IDE + Cloud Agents + CLI), the worst of their statuses becomes the badge (Down > Degraded > Operational).',
    's2.2.tag': 'component match', 's2.2.title': 'Component match', 's2.2.body': 'If the service has a designated primary component, use that component\\\'s status.',
    's2.3.tag': 'overall indicator', 's2.3.title': 'Overall-indicator fallback', 's2.3.body': 'If no component is found, fall back to the page\\\'s overall indicator — but if no relevant unresolved incidents remain after filtering, treat as operational. This prevents cross-contamination on shared status pages (e.g. a ChatGPT incident shouldn\\\'t affect OpenAI API status).',
    's2.4.tag': 'incidentExclude bypass', 's2.4.title': 'incidentExclude component bypass', 's2.4.body': 'Even when a title-based exclude pattern matches, the incident is kept if its component tag starts with the service\\\'s primary component. Component tagging is more authoritative than title substring matching.',
    's2.5.tag': 'component-status filter', 's2.5.title': 'Component-status incident filter', 's2.5.body': 'If a component is operational but the provider bulk-linked an incident to all components, unresolved incidents are removed (resolved/monitoring kept). This prevents an unrelated incident from showing on a healthy component.',
    's2.6.tag': 'fetch-failure cross-validation', 's2.6.title': 'Fetch-failure cross-validation', 's2.6.body': 'If a degraded status came from a fetch failure but probe RTT is normal, revert to operational. If 70%+ of services on the same platform fail at once, treat it as a platform outage and revert all to operational. We only override when the evidence is strong.',
    's2.partial': '<strong>Partial</strong> is an intermediate state for multi-component services (Better Stack — Together · Fireworks · HuggingFace · Modal · Luma) where the overall service is operational but some components (e.g. a specific model) report issues. It does not escalate the whole service to \\'degraded\\', but the affected component\\'s real outage is still reflected in the AIWatch Score &amp; ranking through the uptime &amp; incident aggregation.',
    's2.note': 'The full ordered rules and the rationale for each are published in the open-source <a href="https://github.com/bentleypark/aiwatch/blob/main/docs/reference/status-determination.md" target="_blank" rel="noopener">status-determination reference</a>.',
    's3.title': 'Uptime',
    's3.lead': 'Uptime% comes from one of two source types.',
    's3.official': 'Official', 's3.officialDesc': '— read directly from the % the status page publishes (window varies by page).',
    's3.platform': 'Platform', 's3.platformDesc': '— uptime measured by the status-page platform\\\'s own monitors (Better Stack) — a platform measurement, not the provider\\\'s official SLA (Together · Fireworks · HuggingFace · Modal · Luma).',
    's3.weighted': '<strong>Atlassian-weighted affected days:</strong> downtime is counted not as raw incident count but as "affected days," where each day is weighted by its worst impact — critical · major = 1.0, minor = 0.3, informational/null = excluded. Uptime and the Score share the same weighting.',
    's3.limits.label': 'Coverage & limits — what we can\\\'t measure and why',
    's3.limits.intro': 'These services\\\' status pages do not expose a comparable rolling 30-day uptime %. We never fill it with a guess — they show "— Not provided".',
    's3.limits.col1': 'Service', 's3.limits.col2': 'Reason',
    's3.limits.estimate': 'No official rolling uptime — incident feed only',
    's3.limits.norolling': 'Status page exposes no comparable rolling-30d %',
    's3.limits.xai': 'Exposes a since-restart per-endpoint success rate — not comparable to a 30-day figure',
    's4.title': 'AIWatch Score',
    's4.intro': 'AIWatch Score is a composite 0–100 reliability metric combining uptime, incident affected days, recovery time, and (for probed API services) responsiveness. It is based on 30-day data.',
    's4.formulaStr': 'AIWatch Score = Uptime + Incidents + Recovery + Responsiveness',
    's4.input': 'Input', 's4.points': 'Points', 's4.below': 'or below', 's4.days': 'days', 's4.min': 'min', 's4.hour': 'h',
    's4.uptime.title': 'Uptime Score (0–40)',
    's4.inc.title': 'Incident Score (0–25)',
    's4.inc.note': 'Table values assume critical/major impact days (weight 1.0). Minor-only days are weighted 0.3 — e.g. 5 minor days ≈ 1.5 weighted days ≈ 21.5 points.',
    's4.inc.why': '<strong>Why affected days:</strong> some services (e.g. Anthropic) report incidents per model (Opus/Sonnet/Haiku), so one outage gets counted multiple times. We use affected days instead of raw count, each day weighted by its worst impact — critical/major = 1.0, minor = 0.3, informational/null = excluded.',
    's4.rec.title': 'Recovery Score (0–15)',
    's4.rec.note': 'MTTR is the 30-day median of resolved-incident durations (mean fallback for fewer than 3 incidents).',
    's4.resp.title': 'Responsiveness Score (0–20)',
    's4.resp.desc': 'Measures actual API endpoint speed and stability via 5-minute health-check probes (28 AI services). Combines response speed and consistency.',
    's4.resp.speed': 'Speed (0–10) — exp decay on p50 RTT',
    's4.resp.stability': 'Stability (0–10) — exp decay on combined coefficient of variation',
    's4.resp.na1': 'Apps and coding agents have no API endpoint to measure; and 3 other AI services outside the 28-service probe set (Bedrock, Azure OpenAI, Modal) are not probed either.',
    's4.resp.na2': 'Their score is rescaled from the 80-point base to 100 (computed on the available components).',
    's4.resp.naFormula': 'probe-less: rescale base 80 → 100',
    's4.resp.insufficient': 'Newly added probed services receive a 5% penalty until 7 days of probe data accumulate.',
    's4.noUptime.title': 'Services without uptime data',
    's4.noUptime.desc': 'Some services (Gemini, xAI, Bedrock, etc.) publish no official uptime. We assume no value — the 40-point uptime component is dropped and the score is rescaled over the remaining available components. Services that ARE probed (Gemini, xAI, OpenRouter, etc.) are scored on incidents + recovery + responsiveness and included in the ranking. Services with no probe either (Bedrock, Azure OpenAI) have only incidents + recovery left as signals — too thin for a trustworthy score, so we publish no score for them and provide incident tracking only.',
    's4.grades.title': 'Grade thresholds',
    's5.title': 'Latency (Probe RTT)',
    's5.lead': 'We measure the API endpoints of 28 AI services directly from the Cloudflare Workers edge every 5 minutes, producing p50 / p75 / p95 percentiles.',
    's5.limit.label': 'Key limit — network RTT ≠ inference latency',
    's5.limit.body': 'Probe RTT measures <strong>network round-trip time</strong>, NOT a model\\\'s inference (token-generation) latency. It reflects how fast the endpoint responds at the network layer, not how fast the service generates tokens.',
    's5.limit.probe': '<strong>No probe:</strong> The latency ranking covers only the 28 directly-probed AI services — apps, coding agents, and 3 other non-probed AI services are excluded.',
    's6.title': 'Incidents · MTTR · Detection',
    's6.counting.title': 'Incident counting',
    's6.counting.body': 'Incident counts reflect all affected components per service. Providers differ in reporting granularity — Anthropic reports per-model (Opus/Sonnet/Haiku counted separately), inflating its totals versus service-level reporters. A higher count does not mean lower reliability; adjust for granularity before comparing across providers.',
    's6.mttr.title': 'Recovery time (MTTR)',
    's6.mttr.body': 'The Score\\\'s Recovery component uses a 30-day median. The ServiceDetails "Recovery" card is a separate display — a 7-day median + worst ("typical 15m · worst 29h34m"). The two windows differ, so the figures can legitimately differ — same lower-median convention, different observation window.',
    's6.detection.title': 'Detection',
    's6.detection.body': 'Detection is measured two ways — MTTD (mean time to detect: how long AIWatch took to spot the incident) and RTT degradation detection (an early signal from probe RTT spikes). Because status-page polling is necessarily later than an official publish, AIWatch <strong>never claims to be "faster than the official status page"</strong> and reports only these two honest metrics. This is surfaced in the monthly report and does not feed the AIWatch Score or any dashboard number.',
    's6.limit.label': 'Limit',
    's6.limit.body': 'Sources that only retain recent items (Azure · Bedrock) can miss short-lived incidents that appear and disappear quickly.',
    's7.title': 'Independence · Privacy',
    's7.lead': 'AIWatch measures AI service reliability — neutrally. It shows the results as data and publishes them free of anyone\\\'s influence.',
    's7.free.title': 'Free · No signup', 's7.free.body': 'The public dashboard is completely free and open to anyone — no account, no login. We collect no personally identifiable information (PII).',
    's7.open.title': 'Open source', 's7.open.body': 'Status determination, scoring, and collection logic are all published under AGPL-3.0. You can verify the methodology yourself.',
    's7.merit.title': 'Merit-based', 's7.merit.body': 'The Score and Fallback recommendations are based only on measured reliability. Rank and recommendations cannot be bought.',
    's7.privacy.title': 'Privacy', 's7.privacy.body': 'Only anonymous usage statistics (GA4), and only with consent. Without consent, no analytics or ad cookies are stored.',
    's7.close': 'This neutrality is what makes AIWatch data usable for decisions — we say only what we measure, and are explicit about what we can\\\'t.',
    'footer.dashboard': 'Live dashboard', 'footer.reports': 'Monthly reports', 'footer.github': 'GitHub (open source)', 'footer.rss': 'RSS'
  }
};

// Methodology defaults to English — the page is <html lang="en"> and English-indexed for SEO.
// The KO/EN toggle still lets visitors switch; we no longer auto-detect to KO.
let currentLang = 'en';

function setLang(lang) {
  currentLang = lang;
  document.querySelectorAll('.lang-btn').forEach(function (btn) {
    btn.classList.toggle('active', btn.getAttribute('data-lang') === lang);
  });
  document.querySelectorAll('[data-i18n]').forEach(function (el) {
    var key = el.getAttribute('data-i18n');
    if (i18n[lang] && key in i18n[lang]) el.innerHTML = i18n[lang][key];
  });
  document.documentElement.lang = lang;
}

try {
  setLang(currentLang);

  // CSP-safe (#482): all interactivity via addEventListener — no inline handlers.
  // Lang toggle (delegated on each button).
  document.querySelectorAll('.lang-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var l = btn.getAttribute('data-lang');
      if (l) setLang(l);
    });
  });

  // GA4 link-click events — wired from data-ga / data-ga-loc attributes.
  document.querySelectorAll('[data-ga]').forEach(function (el) {
    el.addEventListener('click', function () {
      if (typeof gtag === 'function') {
        gtag('event', el.getAttribute('data-ga'), {
          location: el.getAttribute('data-ga-loc') || 'methodology',
          source: 'methodology'
        });
      }
    });
  });

  // Scroll-spy: the active section is the LAST one whose top has scrolled above a line just below
  // the sticky nav. Pure geometry (rAF-throttled scroll) — robust vs IntersectionObserver, whose
  // band catches BOTH adjacent sections at a boundary (the off-by-one highlight after jumping up).
  var tocLinks = Array.prototype.slice.call(document.querySelectorAll('.toc-nav a[href^="#"]'));
  var spySections = tocLinks
    .map(function (a) { return document.getElementById(a.getAttribute('href').slice(1)); })
    .filter(Boolean);
  if (spySections.length) {
    var currentId = null;
    var setActive = function (id) {
      if (id === currentId) return;   // skip redundant re-toggles + scrollIntoView
      currentId = id;
      tocLinks.forEach(function (a) {
        var on = a.getAttribute('href') === '#' + id;
        a.classList.toggle('active', on);
        // Keep the active chip visible in the collapsed horizontal bar (mobile).
        if (on) a.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      });
    };
    var pick = function () {
      // A section becomes active once its top crosses an imaginary line below the sticky chrome.
      // These offsets are empirically tuned to sit just under the sticky nav (56px) and above each
      // section's scroll-margin-top (72px desktop / 108px mobile) — they are NOT the sum of those
      // values; the line deliberately sits higher so a section activates as its heading approaches.
      // Mobile (<=860px) needs a larger offset because the horizontal TOC bar also stacks on top.
      var navLine = window.innerWidth <= 860 ? 120 : 90;
      // Near the page bottom the last section can't scroll up to the line (not enough content
      // below it) — force it active once the page bottom is within view.
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 120) {
        setActive(spySections[spySections.length - 1].id);
        return;
      }
      var id = spySections[0].id;
      for (var i = 0; i < spySections.length; i++) {
        if (spySections[i].getBoundingClientRect().top <= navLine) id = spySections[i].id;
        else break;
      }
      setActive(id);
    };
    var ticking = false;
    window.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () { pick(); ticking = false; });
    }, { passive: true });
    pick();
  }
} catch (e) { console.error('[methodology] Client init failed:', e); }
</script>
${COOKIE_BANNER_HTML}
</body>
</html>
`
}
