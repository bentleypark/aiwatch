// SSR HTML template for "Is X Down?" pages

import type { ServiceSEO } from './seo-content'
import { SERVICE_ID_TO_SLUG, SLUG_TO_SERVICE, RELATED_SLUGS } from './slug-map'

interface ServiceData {
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
  totalRanked?: number
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

function statusEmoji(status: string): string {
  if (status === 'operational') return '&#x1F7E2;'
  if (status === 'degraded') return '&#x1F7E1;'
  return '&#x1F534;'
}

function statusLabel(status: string): string {
  if (status === 'operational') return 'Operational'
  if (status === 'degraded') return 'Degraded Performance'
  return 'Down'
}

function statusColor(status: string): string {
  if (status === 'operational') return '#3fb950'
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

export function renderPage(
  slug: string,
  service: ServiceData | null,
  seo: ServiceSEO,
  fallbacks: Fallback[],
): string {
  const title = `Is ${seo.displayName} Down? Live Status | AIWatch`
  const desc = service
    ? `Check if ${seo.displayName} is down right now. Current status: ${statusLabel(service.status)}. ${typeof service.uptime30d === 'number' && !Number.isNaN(service.uptime30d) ? `30-day uptime: ${service.uptime30d.toFixed(2)}%.` : ''} Updated every 60 seconds.`
    : `Check if ${seo.displayName} is down right now. Real-time status monitoring by AIWatch.`
  const canonical = `https://ai-watch.dev/is-${slug}-down`

  // Dynamic OG image URL — cache busted per 10-min window
  const ogParams = new URLSearchParams({ service: seo.displayName, status: service?.status ?? 'operational' })
  if (service?.aiwatchScore != null && Number.isFinite(service.aiwatchScore)) ogParams.set('score', String(service.aiwatchScore))
  if (typeof service?.uptime30d === 'number' && !Number.isNaN(service.uptime30d)) ogParams.set('uptime', service.uptime30d.toFixed(2))
  ogParams.set('v', String(Math.floor(Date.now() / 600_000))) // 10-min cache bust
  const ogImageUrl = `https://aiwatch-worker.p2c2kbf.workers.dev/api/og?${ogParams.toString()}`

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(canonical)}">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">

<!-- Open Graph -->
<meta property="og:type" content="website">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(ogImageUrl)}">
<meta property="og:site_name" content="AIWatch">

<!-- Twitter -->
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(ogImageUrl)}">

<meta name="theme-color" content="#080c10">

<!-- Google Analytics -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-D4ZWVHQ7JK"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-D4ZWVHQ7JK');</script>
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
.faq-item{margin:16px 0}
.faq-q{font-weight:600;font-size:15px;margin-bottom:6px}
.faq-a{font-size:14px;color:#8b949e}
.fallback-item{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:#161b22;border-radius:6px;margin:8px 0}
.fallback-name{font-weight:500;font-size:14px}
.fallback-score{font-size:12px;color:#8b949e}
.footer{text-align:center;padding:32px 0;font-size:13px;color:#484f58;border-top:1px solid rgba(255,255,255,0.07);margin-top:40px}
.btn{display:inline-block;padding:8px 20px;background:#161b22;border:1px solid rgba(255,255,255,0.14);border-radius:6px;color:#e6edf3;font-size:13px;font-weight:500;transition:background 0.2s}
.btn:hover{background:#1c2230;text-decoration:none}
.btn-primary{background:#1a3d22;border-color:#3fb950;color:#3fb950}
.btn-primary:hover{background:#224a2a}
.cta{background:#0d1117;border:1px solid rgba(255,255,255,0.07);border-radius:8px;padding:16px 20px;text-align:center;margin:16px 0}
.cta-title{font-size:14px;font-weight:600;margin-bottom:10px}
.cta-buttons{display:flex;gap:8px;justify-content:center;flex-wrap:wrap}
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
@media(max-width:600px){h1{font-size:22px}.container{padding:16px 12px}}
</style>
</head>
<body>
<div class="container">

${renderStatusHeader(service, seo)}
${renderCTA(seo, service?.status ?? 'operational')}
${renderIncidents(service)}
${renderDescription(seo, service)}
${renderFAQ(seo, fallbacks)}
${renderFallbacks(seo, fallbacks, service?.id)}
${renderShareButtons(seo, service, canonical, ogImageUrl)}
${renderFooter(slug)}

</div>
</body>
</html>`
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

function renderStatusHeader(service: ServiceData | null, seo: ServiceSEO): string {
  if (!service) {
    return `<div class="header">
<h1>Is ${esc(seo.displayName)} Down?</h1>
<p class="meta">Status data is temporarily unavailable. Please check back shortly.</p>
<p class="meta" style="margin-top:12px"><a href="https://ai-watch.dev" class="btn">View AIWatch Dashboard</a></p>
</div>`
  }

  const color = statusColor(service.status)
  const uptimeStr = typeof service.uptime30d === 'number' && !Number.isNaN(service.uptime30d) ? `${service.uptime30d.toFixed(2)}%` : 'N/A'
  const scoreStr = service.aiwatchScore != null ? `${service.aiwatchScore}` : 'N/A'
  const gradeStr = service.scoreGrade ? ` (${service.scoreGrade.charAt(0).toUpperCase() + service.scoreGrade.slice(1)})` : ''
  const incidents = Array.isArray(service.incidents) ? service.incidents : []
  const lastIncident = incidents.length > 0 ? incidents[0] : null

  return `<div class="header">
<h1>${statusEmoji(service.status)} Is ${esc(seo.displayName)} Down?</h1>
<p style="font-size:20px;font-weight:600;color:${color};margin:12px 0">${statusLabel(service.status)}</p>
<p class="meta mono">Last checked: ${esc(timeAgo(service.lastChecked))} &middot; Uptime (30d): ${uptimeStr} &middot; AIWatch Score: ${scoreStr}${esc(gradeStr)}</p>
${lastIncident ? `<p class="meta">Last incident: ${esc(formatDate(lastIncident.startedAt))} &mdash; ${esc(lastIncident.title)}${lastIncident.duration ? ` (${esc(lastIncident.duration)})` : ' (ongoing)'}</p>` : '<p class="meta">No recent incidents</p>'}
${service.rank ? `<p class="meta">${esc(seo.displayName)} is ranked <strong>#${service.rank}</strong> of ${service.totalRanked} AI services by <a href="https://ai-watch.dev/#ranking">AIWatch reliability score</a></p>` : ''}
</div>`
}

function renderCTA(seo: ServiceSEO, status: string): string {
  const isDown = status === 'down' || status === 'degraded'
  const message = isDown
    ? `${seo.displayName} is currently experiencing issues \u2014 get notified when it recovers`
    : `Get notified when ${seo.displayName} goes down`
  return `<div class="cta">
<p class="cta-title">${esc(message)}</p>
<div class="cta-buttons">
<a href="https://ai-watch.dev/#settings" class="btn btn-primary">Set Up Alerts &rarr;</a>
</div>
</div>`
}

function renderIncidents(service: ServiceData | null): string {
  const incidents = Array.isArray(service?.incidents) ? service.incidents : []
  if (!service || incidents.length === 0) return ''

  const items = incidents.slice(0, 5).map(inc => {
    const impactCls = inc.impact === 'major' || inc.impact === 'critical' ? 'impact-major' : inc.impact === 'minor' ? 'impact-minor' : ''
    const statusText = inc.status === 'resolved' ? 'Resolved' : inc.status === 'monitoring' ? 'Monitoring' : 'Investigating'
    return `<div class="incident-item">
<div class="incident-title">${esc(inc.title)}</div>
<div class="incident-meta mono">${esc(formatDate(inc.startedAt))} &middot; ${statusText}${inc.duration ? ` &middot; ${esc(inc.duration)}` : ''}${impactCls ? ` &middot; <span class="${impactCls}">${esc(inc.impact ?? '')}</span>` : ''}</div>
</div>`
  }).join('\n')

  return `<h2>Recent Incidents</h2>
<div class="card">${items}</div>`
}

function buildDataSummary(service: ServiceData | null, displayName: string): string {
  if (!service) return ''
  const incidents = Array.isArray(service.incidents) ? service.incidents : []
  const cutoff = Date.now() - 30 * 86_400_000
  const recent = incidents.filter((i) => new Date(i.startedAt).getTime() >= cutoff)
  const count = recent.length
  const uptime = typeof service.uptime30d === 'number' && !Number.isNaN(service.uptime30d)
    ? `${service.uptime30d.toFixed(2)}%` : null

  if (count === 0) {
    return uptime
      ? `Based on AIWatch data from the last 30 days, ${displayName} has maintained a clean record with zero incidents. 30-day uptime: ${uptime}.`
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

  return uptime
    ? `Based on AIWatch data from the last 30 days, ${displayName} experienced ${count} incident${count > 1 ? 's' : ''}${mttrText}. 30-day uptime: ${uptime}.`
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
<p style="font-size:13px;color:#484f58;margin-top:12px">This page provides real-time status, 30-day uptime history, and recent incident details &mdash; updated every 60 seconds by <a href="https://ai-watch.dev">AIWatch</a>.</p>
</div>`
}

function renderFAQ(seo: ServiceSEO, fallbacks: Fallback[]): string {
  if (seo.faqs.length === 0) return ''
  const items = seo.faqs.map(f => {
    const answer = enhanceFaqAnswer(f, fallbacks)
    return `<div class="faq-item">
<p class="faq-q">${esc(f.q)}</p>
<p class="faq-a">${esc(answer)}</p>
</div>`
  }).join('\n')

  return `<h2>Frequently Asked Questions</h2>
<div class="card">${items}</div>`
}

function renderFallbacks(seo: ServiceSEO, fallbacks: Fallback[], fromId?: string): string {
  if (fallbacks.length === 0) return ''
  const items = fallbacks.map(f => {
    const scoreText = f.score != null ? `Score: ${f.score}` : ''
    const color = statusColor(f.status)
    const label = statusLabel(f.status)
    const fbSlug = SERVICE_ID_TO_SLUG[f.id]
    const gaClick = fromId ? ` onclick="typeof gtag==='function'&&gtag('event','fallback_click',{from_service:'${esc(fromId)}',to_service:'${esc(f.id)}',location:'is_down_page'})"` : ''
    const nameHtml = fbSlug ? `<a href="/is-${esc(fbSlug)}-down" style="color:#e6edf3"${gaClick}>${esc(f.name)}</a>` : esc(f.name)
    return `<div class="fallback-item">
<span class="fallback-name">${nameHtml}</span>
<span class="fallback-score mono">${scoreText} &nbsp; <span style="color:${color}">${statusEmoji(f.status)} ${label}</span></span>
</div>`
  }).join('\n')

  return `<h2>Alternatives When ${esc(seo.displayName)} is Down</h2>
<div class="card">
${items}
<div class="links" style="margin-top:12px">
<a href="https://ai-watch.dev/#ranking">Reliability rankings &rarr;</a>
<a href="https://reports.ai-watch.dev/">Monthly reports &rarr;</a>
</div>
</div>`
}

function renderShareButtons(seo: ServiceSEO, service: ServiceData | null, canonical: string, ogImageUrl: string): string {
  const status = service ? statusLabel(service.status) : 'Operational'
  const rawStatus = service?.status ?? 'operational'

  // Status-based share templates — viral optimized for Reddit/X/community
  // Down: question-style to drive search + urgency
  // Degraded: uncertainty + "official vs AIWatch" contrast
  // Operational: brand mention only, no link (account trust building)
  const copyText = rawStatus === 'down'
    ? `Is ${seo.displayName} down? Current status: Major Outage. Check live reports: ${canonical}`
    : rawStatus === 'degraded'
    ? `Something feels off with ${seo.displayName}... Official says green, but AIWatch sees a spike: ${canonical}`
    : `${seo.displayName} is running fine for now. All green on AIWatch.`

  const xText = rawStatus === 'down'
    ? `Is ${seo.displayName} down? \u26A0\uFE0F Current status: Major Outage. Check live reports:`
    : rawStatus === 'degraded'
    ? `Something feels off with ${seo.displayName}... \uD83D\uDC40 Official says green, but AIWatch sees a spike:`
    : `${seo.displayName} is running fine for now. All green on AIWatch. \u2705`
  const encodedText = encodeURIComponent(xText)
  const encodedUrl = rawStatus !== 'operational' ? encodeURIComponent(canonical) : ''
  const xUrlParam = encodedUrl ? `&amp;url=${encodedUrl}` : ''

  // Use JSON.stringify for safe JS string interpolation (prevents XSS via backslash/newline)
  const jsDisplayName = JSON.stringify(seo.displayName)
  const jsCanonical = JSON.stringify(canonical)
  const jsOgImageUrl = JSON.stringify(ogImageUrl)
  const jsStatus = JSON.stringify(status)

  return `<div class="share-bar">
<a href="https://x.com/intent/tweet?text=${encodedText}${xUrlParam}" target="_blank" rel="noopener" class="share-btn share-x" onclick="gtag('event','share',{method:'x',content_type:'is_x_down',item_id:${jsDisplayName}})">
<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
Post
</a>
<a href="https://www.threads.net/intent/post?text=${encodedText}${encodedUrl ? '%20' + encodedUrl : ''}" target="_blank" rel="noopener" class="share-btn share-threads" onclick="gtag('event','share',{method:'threads',content_type:'is_x_down',item_id:${jsDisplayName}})">
<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12.186 24h-.007c-3.581-.024-6.334-1.205-8.184-3.509C2.35 18.44 1.5 15.586 1.472 12.01v-.017c.03-3.579.879-6.43 2.525-8.482C5.845 1.205 8.6.024 12.18 0h.014c2.746.02 5.043.725 6.826 2.098 1.677 1.29 2.858 3.13 3.509 5.467l-2.04.569c-1.104-3.96-3.898-5.984-8.304-6.015-2.91.022-5.11.936-6.54 2.717C4.307 6.504 3.616 8.914 3.59 12c.025 3.083.718 5.496 2.057 7.164 1.432 1.783 3.631 2.698 6.54 2.717 2.623-.02 4.358-.631 5.8-2.045 1.647-1.613 1.618-3.593 1.09-4.798-.346-.789-.96-1.42-1.757-1.846-.184 2.985-1.086 5.27-2.844 6.39-1.34.853-3.065 1.062-4.62.559-1.72-.557-3.09-1.843-3.37-3.583-.203-1.264.066-2.418.757-3.248.86-1.032 2.278-1.578 3.952-1.578 2.37 0 3.877 1.128 4.453 2.325.153-.915.177-1.937.073-3.065l2.023-.235c.203 2.153.015 4.027-.735 5.483a5.997 5.997 0 0 0 1.013.607c1.27.605 2.567.665 3.557-.12 1.258-1 1.554-2.79 1.168-4.34-.478-1.922-1.806-3.598-3.853-4.85C17.257 5.282 14.907 4.725 12.2 4.708h-.015c-3.34.024-5.886 1.348-7.357 3.832C3.622 10.52 3.088 12.947 3.088 12c0-.96.533-3.504 1.74-5.488 1.41-2.319 3.756-3.568 6.857-3.655h.02c2.467.02 4.57.527 6.25 1.508 1.735 1.012 3.032 2.488 3.558 4.282.65 2.214.23 4.685-1.496 6.055-1.497 1.187-3.366 1.065-4.868.348a7.89 7.89 0 0 1-.778-.42c-.66 1.345-1.68 2.276-3.063 2.788-.986.365-2.103.432-3.243.19-1.882-.401-3.466-1.576-4.156-3.216-.475-1.13-.53-2.394-.155-3.586.468-1.484 1.634-2.632 3.288-3.063 1.918-.5 3.728-.074 5.02 1.182.574.558 1.005 1.26 1.283 2.094.228-.76.382-1.581.455-2.46l-.005-.038z"/></svg>
Share
</a>
<button id="kakao-share" class="share-btn share-kakao" style="display:none" onclick="shareKakao()">
<svg width="16" height="16" viewBox="0 0 24 24" fill="#191919"><path d="M12 3C6.477 3 2 6.463 2 10.691c0 2.754 1.862 5.18 4.67 6.532-.16.578-.583 2.096-.668 2.421-.104.397.146.392.306.285.126-.084 2.005-1.36 2.816-1.912.93.134 1.891.205 2.876.205 5.523 0 10-3.463 10-7.691S17.523 3 12 3z"/></svg>
KakaoTalk
</button>
<button class="share-btn share-copy" onclick="copyLink(this)" data-url="${esc(canonical)}" data-text="${esc(copyText)}">
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

function renderFooter(slug: string): string {
  // Related services first (SEO cross-linking), then remaining
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
  const otherLinks = remaining
    .map(s => `<a href="/is-${esc(s)}-down">Is ${esc(SLUG_TO_SERVICE[s]?.name ?? s.replace(/-/g, ' '))} down?</a>`)
    .join(' ')

  return `<div class="footer">
<p style="margin-bottom:12px"><a href="https://ai-watch.dev" class="btn">View Full Dashboard</a></p>
<p><a href="https://ai-watch.dev/#${esc(seoEntry?.id ?? slug)}">Detailed service page</a> &middot; <a href="https://reports.ai-watch.dev/">Monthly reports</a> &middot; <a href="https://ai-watch.dev/#settings">Set up alerts</a></p>
${relatedLinks ? `<p style="margin-top:12px;font-size:13px">Related: ${relatedLinks}</p>` : ''}
${otherLinks ? `<p style="margin-top:8px;font-size:12px">Also check: ${otherLinks}</p>` : ''}
<p style="margin-top:12px">&copy; 2026 AIWatch. Real-time AI service status monitoring.</p>
</div>`
}
