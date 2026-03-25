// OG Image Generator — generates 1200×630 PNG for social share previews
// Uses SVG template + resvg-wasm for PNG conversion in Cloudflare Workers

import { escapeXml } from './badge'

const STATUS_STYLE: Record<string, { label: string; color: string; bg: string }> = {
  operational: { label: 'Operational', color: '#3fb950', bg: '#1a3d22' },
  degraded:    { label: 'Degraded',    color: '#e86235', bg: '#3d2a1a' },
  down:        { label: 'Down',        color: '#f85149', bg: '#3d1a1a' },
}

export function generateOgSvg(service: string, status: string, score: string, uptime: string): string {
  const s = STATUS_STYLE[status]
  if (!s) console.warn(`[og] Unrecognized status "${status}", defaulting to operational`)
  const style = s ?? STATUS_STYLE.operational
  const safeName = escapeXml(service.slice(0, 50))
  const safeScore = escapeXml(score.slice(0, 5))
  const safeUptime = escapeXml(uptime.slice(0, 6))

  const metricsY = 420
  let metrics = ''
  if (safeScore || safeUptime) {
    const parts: string[] = []
    if (safeScore) parts.push(`Score: <tspan fill="#e6edf3" font-weight="600">${safeScore}</tspan>`)
    if (safeUptime) parts.push(`Uptime: <tspan fill="#e6edf3" font-weight="600">${safeUptime}%</tspan>`)
    metrics = `<text x="600" y="${metricsY}" text-anchor="middle" fill="#8b949e" font-size="20" font-family="Inter, sans-serif">${parts.join('    ')}</text>`
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#080c10"/>
  <rect width="1200" height="4" fill="${style.color}"/>
  <text x="600" y="200" text-anchor="middle" fill="#8b949e" font-size="24" font-family="Inter, sans-serif" letter-spacing="1">AIWatch</text>
  <text x="600" y="275" text-anchor="middle" fill="#e6edf3" font-size="48" font-weight="700" font-family="Inter, sans-serif">Is ${safeName} Down?</text>
  <rect x="${600 - 120}" y="310" width="240" height="56" rx="12" fill="${style.bg}" stroke="${style.color}" stroke-width="2"/>
  <circle cx="${600 - 80}" cy="338" r="8" fill="${style.color}"/>
  <text x="${600 + 10}" y="348" text-anchor="middle" fill="${style.color}" font-size="30" font-weight="600" font-family="Inter, sans-serif">${escapeXml(style.label)}</text>
  ${metrics}
  <text x="600" y="605" text-anchor="middle" fill="#484f58" font-size="18" font-family="Inter, sans-serif">ai-watch.dev</text>
</svg>`
}
