// Vercel Edge Function — proxy /reports/* to the aiwatch-reports Jekyll/GH Pages
// origin (#264). Originally pointed at reports.ai-watch.dev; switched to fetch
// GH Pages directly via bentleypark.github.io/aiwatch-reports/* so that a
// Cloudflare Page Rule can 301 the public reports.ai-watch.dev hostname to
// ai-watch.dev/reports/ without trapping the proxy in a redirect loop. With
// the prior origin, a Page Rule on the public hostname would 301 the proxy's
// own fetch back to ai-watch.dev/reports/ (= itself).
//
// vercel.json needs four rewrite sources for this to cover every Jekyll URL
// shape — path-to-regexp's `:rest*` does not match requests with a trailing
// slash in Vercel's router, so trailing-slash variants are listed explicitly:
//   /reports, /reports/, /reports/:rest*, /reports/:rest*/
//
// URL mapping:
//   /reports           → bentleypark.github.io/aiwatch-reports/
//   /reports/          → bentleypark.github.io/aiwatch-reports/
//   /reports/2026-03/  → bentleypark.github.io/aiwatch-reports/2026-03/
//   /reports/assets/x  → bentleypark.github.io/aiwatch-reports/assets/x

export const config = { runtime: 'edge' }

// Direct GH Pages URL — bypasses the public reports.ai-watch.dev hostname so
// that Cloudflare's 301 Page Rule on that hostname can't trap the proxy in
// a redirect loop. Requires the aiwatch-reports repo to NOT have a CNAME
// file pointing at reports.ai-watch.dev (else GH Pages 301s every request
// from this URL back to the public hostname, defeating the bypass).
//
// During the deploy gap between this proxy change landing and the
// aiwatch-reports CNAME removal, GH Pages still 301s from this URL back to
// reports.ai-watch.dev — the fetch's `redirect: 'follow'` (below) is what
// keeps the proxy working in that interim. Don't change it to 'manual' or
// 'error' without first verifying the CNAME has been removed.
const UPSTREAM_ORIGIN = 'https://bentleypark.github.io/aiwatch-reports'

// Strip /reports prefix and normalize: missing trailing slash on home becomes '/'.
// Exported for unit testing; not imported anywhere in production code.
export function toUpstreamPath(pathname: string): string {
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
      `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Reports unavailable</title></head><body style="background:#080c10;color:#e6edf3;font-family:sans-serif;text-align:center;padding:60px"><h1>Monthly reports temporarily unavailable</h1><p>The reports origin is unreachable. Please try again shortly, or return to the <a href="https://ai-watch.dev" style="color:#58a6ff">dashboard</a>.</p></body></html>`,
      { status: 502, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' } },
    )
  }
}
