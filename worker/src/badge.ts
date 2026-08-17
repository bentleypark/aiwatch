import type { ServiceStatus } from './types'

/** #1233 — the badge's status color, extracted from the inline ternary chain in `index.ts` so it can be
 *  unit-tested. It was a chain whose final `else` was RED, so `unknown` would have rendered a red
 *  "down" badge for a source AIWatch could not read — a hole the new union member opens, not a bug that
 *  already shipped (the worker did not publish this value before #1233). Worth closing at the source
 *  because a badge is the most durable thing AIWatch publishes: it is copied into READMEs and
 *  third-party status pages, so a false red there outlives any dashboard view and is seen by people who
 *  never visit the site.
 *
 *  Grey `#8b949e` is the neutral already used for `unknown` in the OG card palette (`og.ts`). */
export function badgeStatusColor(status: ServiceStatus['status']): string {
  switch (status) {
    case 'operational': return '#3fb950'
    case 'degraded': return '#d29922'
    case 'unknown': return '#8b949e'
    case 'down': return '#f85149'
    default: {
      // A new union member fails `typecheck:worker` here; an unrecognised value from an older cached
      // payload falls to the neutral grey rather than to red.
      const exhaustive: never = status
      console.warn('[badge] unrecognised status, painting neutral:', exhaustive)
      return '#8b949e'
    }
  }
}

// SVG Badge Generator (shields.io style)

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function generateBadgeSvg(label: string, status: string, color: string, style: string): string {
  const labelWidth = Math.round(label.length * 6.5 + 12)
  const statusWidth = Math.round(status.length * 6.5 + 12)
  const totalWidth = labelWidth + statusWidth
  const radius = style === 'flat-square' ? '0' : '3'
  const safeLabel = escapeXml(label)
  const safeStatus = escapeXml(status)
  const safeColor = /^#[0-9a-fA-F]{3,8}$/.test(color) ? color : '#9e9e9e'

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20" role="img" aria-label="${safeLabel}: ${safeStatus}">
  <title>${safeLabel}: ${safeStatus}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="${totalWidth}" height="20" rx="${radius}" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="20" fill="#555"/>
    <rect x="${labelWidth}" width="${statusWidth}" height="20" fill="${safeColor}"/>
    <rect width="${totalWidth}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="11">
    <text x="${labelWidth / 2}" y="14">${safeLabel}</text>
    <text x="${labelWidth + statusWidth / 2}" y="14">${safeStatus}</text>
  </g>
</svg>`
}
