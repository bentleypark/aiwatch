// Vercel Edge Function — proxy /reports/* to the aiwatch-reports Jekyll/GH Pages
// origin at reports.ai-watch.dev (#264). Replaces the prior external-URL rewrite
// which fell through to the SPA catch-all in production (Vercel rewrites expect
// internal destinations; external URLs are not reliably proxied).
//
// vercel.json needs four rewrite sources for this to cover every Jekyll URL
// shape — path-to-regexp's `:rest*` does not match requests with a trailing
// slash in Vercel's router, so trailing-slash variants are listed explicitly:
//   /reports, /reports/, /reports/:rest*, /reports/:rest*/
//
// URL mapping:
//   /reports           → reports.ai-watch.dev/
//   /reports/          → reports.ai-watch.dev/
//   /reports/2026-03/  → reports.ai-watch.dev/2026-03/
//   /reports/assets/x  → reports.ai-watch.dev/assets/x

export const config = { runtime: 'edge' }

const UPSTREAM_ORIGIN = 'https://reports.ai-watch.dev'

// Strip /reports prefix and normalize: missing trailing slash on home becomes '/'.
function toUpstreamPath(pathname: string): string {
  const stripped = pathname.replace(/^\/reports/, '') || '/'
  return stripped.startsWith('/') ? stripped : `/${stripped}`
}

// Forwarded response headers — drop the ones that identify the upstream origin
// or break Vercel's own caching / transport layer. Whitelist approach is tempting
// but risks dropping useful meta (e.g., canonical cookie hints), so use denylist.
const DENYLIST_HEADERS = new Set([
  'server',
  'x-github-request-id',
  'x-served-by',
  'x-cache',
  'x-cache-hits',
  'x-timer',
  'via',
  'connection',
  'transfer-encoding',
  'content-encoding',  // Vercel re-encodes; passing upstream encoding causes double-decompress
  'content-length',    // stripping content-encoding may change body length; let Vercel recompute
])

// Jekyll emits root-relative paths (href="/assets/main.css") so the browser would
// request them from the proxy host (ai-watch.dev/assets/...), miss this Edge Function,
// and fall through to the SPA. Rewrite the HTML so site-root links resolve under
// /reports/ instead. Applied only to HTML responses, not CSS/JS/images (those are
// served by the proxy at their final /reports/assets/* path and don't need rewriting).
//
// Tag-context constraint — the leading `(<[^<>]*\s)` group requires the attribute
// be inside an HTML opening tag (no intervening `<` or `>`). This keeps the rewrite
// from touching literal strings inside <script>/<style> blocks (JSON-LD, inline JS).
const PATH_REWRITE_PATTERNS: [RegExp, string][] = [
  // <tag ... href="/assets/..." → prefixed with /reports/ (covers href=, src=)
  [/(<[^<>]*\s)(href|src)="\/(assets|feed\.xml|sitemap\.xml|robots\.txt)/g, '$1$2="/reports/$3'],
  // <a href="/"> home link in nav — rewrite only the exact home attribute
  [/(<[^<>]*\s)href="\/"/g, '$1href="/reports/"'],
]

function rewriteHtmlPaths(html: string): string {
  let out = html
  for (const [pattern, replacement] of PATH_REWRITE_PATTERNS) {
    out = out.replace(pattern, replacement)
  }
  return out
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } })
  }
  try {
    const url = new URL(req.url)
    const upstreamUrl = `${UPSTREAM_ORIGIN}${toUpstreamPath(url.pathname)}${url.search}`

    // Forward user-agent + accept so upstream content negotiation works. Drop
    // the Host header (fetch rewrites it) and cookies (aiwatch-reports has no
    // session state; cookies would pollute CDN cache keys).
    const forwardedHeaders = new Headers()
    const ua = req.headers.get('user-agent')
    if (ua) forwardedHeaders.set('user-agent', ua)
    const accept = req.headers.get('accept')
    if (accept) forwardedHeaders.set('accept', accept)

    const upstreamRes = await fetch(upstreamUrl, {
      method: req.method,
      headers: forwardedHeaders,
      redirect: 'follow',  // GH Pages may 301 a trailing-slash variant
      signal: AbortSignal.timeout(10_000),
    })

    const responseHeaders = new Headers()
    for (const [k, v] of upstreamRes.headers) {
      if (!DENYLIST_HEADERS.has(k.toLowerCase())) responseHeaders.set(k, v)
    }
    // Cache policy: bound error caching so transient 5xx from GH Pages doesn't
    // propagate into a 10-minute edge-wide outage, and a 404 for a not-yet-published
    // month doesn't linger after Jekyll publishes it. Success responses either keep
    // upstream's cache-control or fall back to 10min + 1h SWR.
    if (upstreamRes.status >= 500) {
      responseHeaders.set('cache-control', 'no-cache')
    } else if (upstreamRes.status >= 400) {
      responseHeaders.set('cache-control', 's-maxage=60')
    } else if (!responseHeaders.has('cache-control')) {
      responseHeaders.set('cache-control', 's-maxage=600, stale-while-revalidate=3600')
    }

    // HTML-only: rewrite absolute paths so they resolve under /reports/. For
    // non-HTML (CSS, JS, images, feeds) stream the body through unchanged.
    const contentType = upstreamRes.headers.get('content-type') || ''
    if (contentType.includes('text/html') || contentType.includes('application/xhtml+xml')) {
      const html = await upstreamRes.text()
      return new Response(rewriteHtmlPaths(html), {
        status: upstreamRes.status,
        headers: responseHeaders,
      })
    }
    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      headers: responseHeaders,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('[api/reports] proxy failed:', message)
    // Don't mask failure with the dashboard SPA — return an honest error page
    // so operators can tell the difference between "report not found" and
    // "proxy is broken". Status 502 is semantically correct for upstream fail.
    return new Response(
      `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Reports unavailable</title></head><body style="background:#080c10;color:#e6edf3;font-family:sans-serif;text-align:center;padding:60px"><h1>Monthly reports temporarily unavailable</h1><p>The aiwatch-reports origin is unreachable. Try <a href="https://reports.ai-watch.dev" style="color:#58a6ff">reports.ai-watch.dev</a> directly, or return to the <a href="https://ai-watch.dev" style="color:#58a6ff">dashboard</a>.</p></body></html>`,
      { status: 502, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' } },
    )
  }
}
