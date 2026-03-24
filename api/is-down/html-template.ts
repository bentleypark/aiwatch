// SSR HTML template for "Is X Down?" pages

import type { ServiceSEO } from './seo-content'
import { SERVICE_ID_TO_SLUG } from './slug-map'

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
<meta property="og:image" content="https://ai-watch.dev/og-image.png">
<meta property="og:site_name" content="AIWatch">

<!-- Twitter -->
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="https://ai-watch.dev/og-image.png">

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
<a href="https://bentleypark.github.io/aiwatch-reports/">Monthly reports &rarr;</a>
</div>
</div>`
}

function renderFooter(slug: string): string {
  const otherSlugs = Object.keys(SERVICE_ID_TO_SLUG)
    .map(id => SERVICE_ID_TO_SLUG[id])
    .filter(s => s !== slug)
  const otherLinks = otherSlugs
    .map(s => `<a href="/is-${esc(s)}-down">Is ${esc(s.replace(/-/g, ' '))} down?</a>`)
    .join(' ')

  return `<div class="footer">
<p style="margin-bottom:12px"><a href="https://ai-watch.dev" class="btn">View Full Dashboard</a></p>
<p><a href="https://ai-watch.dev/#${esc(slug)}">Detailed service page</a> &middot; <a href="https://bentleypark.github.io/aiwatch-reports/">Monthly reports</a> &middot; <a href="https://ai-watch.dev/#settings">Set up alerts</a></p>
${otherLinks ? `<p style="margin-top:12px;font-size:12px">Also check: ${otherLinks}</p>` : ''}
<p style="margin-top:12px">&copy; 2026 AIWatch. Real-time AI service status monitoring.</p>
</div>`
}
