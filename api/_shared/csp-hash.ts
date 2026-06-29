// Hash-based CSP for the high-traffic /is-down Edge pages (#482 option C).
//
// Unlike a per-response nonce (which is incompatible with caching — a cached page reuses one nonce
// for every visitor, defeating it), a SHA-256 hash is DERIVED FROM the script content, so it stays
// valid when the page is edge-cached (the cached header's hashes match the cached body's scripts).
// That lets /is-down keep its `s-maxage=60` edge cache (it's the busiest, outage-viral SEO surface)
// AND get a real enforcing CSP. The handler renders the HTML, extracts its inline scripts, hashes
// each, and emits a `script-src ... 'sha256-…' …` header — recomputed per response, so per-request
// script data (e.g. the share item_id) is covered automatically.
//
// crypto.subtle is available on the Vercel Edge (Cloudflare Workers) runtime — same API the worker
// uses for #486 AES-GCM. Inline EVENT HANDLERS are NOT covered by hashes (that needs 'unsafe-hashes'
// + per-handler hashes, brittle) — they must be refactored to delegated listeners instead.

/** Extract the bodies of EXECUTABLE inline `<script>` blocks (skips `src=` loaders and
 *  `application/ld+json` data blocks — neither needs a hash). */
export function extractInlineScripts(html: string): string[] {
  const out: string[] = []
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1]
    if (/\bsrc\s*=/.test(attrs)) continue // external loader — covered by an allowlisted origin
    if (/type\s*=\s*["']application\/ld\+json/.test(attrs)) continue // JSON-LD data, not executable
    out.push(m[2])
  }
  return out
}

/** SHA-256 of `s` (UTF-8), base64 — the form CSP's `'sha256-…'` source expects. */
export async function sha256Base64(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

/**
 * Build the CSP header (key + value) whose `script-src` allows exactly the given script hashes.
 * Mirrors the vercel.json / csp-nonce policy (keep in sync) but with `'sha256-…'` tokens instead of
 * a nonce. `enforce` picks Report-Only (Phase 2) vs enforcing `Content-Security-Policy` (Phase 3).
 */
export function buildCspWithHashes(hashes: string[], opts: { enforce?: boolean } = {}): { key: string; value: string } {
  const scriptHashes = hashes.map((h) => `'sha256-${h}'`).join(' ')
  const value = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    `script-src 'self' ${scriptHashes} https://www.googletagmanager.com https://t1.kakaocdn.net`,
    "connect-src 'self' https://aiwatch-worker.p2c2kbf.workers.dev https://www.google-analytics.com https://region1.google-analytics.com https://www.googletagmanager.com",
    "img-src 'self' data: https://ai-watch.dev https://aiwatch-worker.p2c2kbf.workers.dev",
    "style-src 'self' https://fonts.googleapis.com 'unsafe-inline'",
    "font-src 'self' https://fonts.gstatic.com",
    'report-uri /api/csp-report',
    'report-to csp',
  ].join('; ')
  return { key: opts.enforce ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only', value }
}

/** Render-then-hash convenience: extract inline scripts from `html`, hash them, build the header. */
export async function cspForHtml(html: string, opts: { enforce?: boolean } = {}): Promise<{ key: string; value: string }> {
  const scripts = extractInlineScripts(html)
  const hashes = await Promise.all(scripts.map(sha256Base64))
  // de-dupe identical scripts (e.g. repeated blocks) so the header stays compact
  return buildCspWithHashes([...new Set(hashes)], opts)
}
