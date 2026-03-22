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
