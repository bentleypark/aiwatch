// Vercel Edge Function — Dynamic OG image for Is X Down pages
// Isolated in api/og/ to prevent bundling conflict with api/is-down

import { ImageResponse } from '@vercel/og'

export const config = { runtime: 'edge' }

const FALLBACK_OG = 'https://ai-watch.dev/og-image.png'

const STATUS_STYLE: Record<string, { label: string; color: string; bg: string }> = {
  operational: { label: 'Operational', color: '#3fb950', bg: '#1a3d22' },
  degraded:    { label: 'Degraded',    color: '#e86235', bg: '#3d2a1a' },
  down:        { label: 'Down',        color: '#f85149', bg: '#3d1a1a' },
}

export default async function handler(req: Request) {
  const url = new URL(req.url)
  const service = (url.searchParams.get('service') || 'Unknown').slice(0, 50)
  const status = url.searchParams.get('status') || 'operational'
  const score = (url.searchParams.get('score') || '').slice(0, 5)
  const uptime = (url.searchParams.get('uptime') || '').slice(0, 6)

  const s = STATUS_STYLE[status] ?? STATUS_STYLE.operational

  try {
    return new ImageResponse(
      (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', background: '#080c10', padding: '40px' }}>
          <div style={{ display: 'flex', position: 'absolute', top: 0, left: 0, right: 0, height: '4px', background: s.color }} />
          <div style={{ display: 'flex', fontSize: '24px', color: '#8b949e', marginBottom: '32px', letterSpacing: '0.05em' }}>AIWatch</div>
          <div style={{ display: 'flex', fontSize: '52px', fontWeight: 700, color: '#e6edf3', marginBottom: '28px' }}>{`Is ${service} Down?`}</div>
          <div style={{ display: 'flex', alignItems: 'center', padding: '14px 36px', borderRadius: '12px', background: s.bg, border: `2px solid ${s.color}` }}>
            <div style={{ display: 'flex', width: '16px', height: '16px', borderRadius: '50%', background: s.color, marginRight: '14px' }} />
            <div style={{ display: 'flex', fontSize: '34px', fontWeight: 600, color: s.color }}>{s.label}</div>
          </div>
          {(score || uptime) ? (
            <div style={{ display: 'flex', marginTop: '28px', fontSize: '20px', color: '#8b949e' }}>
              {score ? <div style={{ display: 'flex', marginRight: '40px' }}>{`Score: `}<span style={{ color: '#e6edf3', fontWeight: 600, marginLeft: '6px' }}>{score}</span></div> : null}
              {uptime ? <div style={{ display: 'flex' }}>{`Uptime: `}<span style={{ color: '#e6edf3', fontWeight: 600, marginLeft: '6px' }}>{`${uptime}%`}</span></div> : null}
            </div>
          ) : null}
          <div style={{ display: 'flex', position: 'absolute', bottom: '24px', fontSize: '18px', color: '#484f58' }}>ai-watch.dev</div>
        </div>
      ),
      {
        width: 1200,
        height: 630,
        headers: { 'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=1200' },
      },
    )
  } catch (err) {
    console.error('[og] Image generation failed:', err instanceof Error ? err.message : err)
    return Response.redirect(FALLBACK_OG, 302)
  }
}
