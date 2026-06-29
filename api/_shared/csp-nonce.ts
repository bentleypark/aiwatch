// Per-response CSP nonce + header for the Edge SSR pages (#482 Phase 2/3).
//
// Why per-response nonce (not a static hash in vercel.json): the is-down share <script>
// interpolates per-request data (displayName/status/canonical/ogImageUrl), so a static
// SHA-256 hash of the inline script body is unstable across renders. A nonce sidesteps that,
// but a nonce can't live in the static vercel.json header → each Edge Function mints one here
// and sets its OWN `Content-Security-Policy(-Report-Only)` header. The SPA keeps the
// vercel.json header. crypto.getRandomValues is available on the Vercel Edge (Cloudflare
// Workers) runtime — same API the worker uses for #486 AES-GCM webhook encryption.
//
// The policy MIRRORS vercel.json's (keep the two in sync) but ADDS `'nonce-<n>'` to script-src;
// `'unsafe-inline'` stays OUT of script-src (a nonce makes browsers ignore it anyway) and stays
// ON style-src (the templates use inline style="..." attributes, which are not the #482 target).

/** A fresh base64 nonce (128 bits) for one response. */
export function generateNonce(): string {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  let s = ''
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i])
  return btoa(s)
}

/**
 * Build the CSP header (key + value) carrying `nonce`. `enforce` picks the header name:
 * Report-Only (Phase 2 — reports, never blocks) vs enforcing `Content-Security-Policy` (Phase 3).
 */
export function buildCsp(nonce: string, opts: { enforce?: boolean } = {}): { key: string; value: string } {
  const value = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    `script-src 'self' 'nonce-${nonce}' https://www.googletagmanager.com https://t1.kakaocdn.net`,
    "connect-src 'self' https://aiwatch-worker.p2c2kbf.workers.dev https://www.google-analytics.com https://region1.google-analytics.com https://www.googletagmanager.com",
    "img-src 'self' data: https://ai-watch.dev https://aiwatch-worker.p2c2kbf.workers.dev",
    "style-src 'self' https://fonts.googleapis.com 'unsafe-inline'",
    "font-src 'self' https://fonts.gstatic.com",
    'report-uri /api/csp-report',
    'report-to csp',
  ].join('; ')
  return { key: opts.enforce ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only', value }
}

/** ` nonce="<n>"` attribute fragment for an inline `<script>` (empty when no nonce — keeps
 *  pre-#482 callers/tests rendering without a stray attribute). */
export function nonceAttr(nonce?: string): string {
  return nonce ? ` nonce="${nonce}"` : ''
}
