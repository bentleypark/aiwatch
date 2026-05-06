// CORS helpers for the AIWatch Worker.
//
// The allowlist is a comma-separated env var (`ALLOWED_ORIGIN`) of literal
// origins plus optional `*suffix` patterns. Suffix patterns exist to cover
// Vercel Preview deployments, which rotate per branch+commit and are not a
// pure subdomain hierarchy — Vercel concatenates project + branch slug +
// deploy hash + team slug with hyphens into a *single* subdomain
// (`aiwatch-dev-git-{branch}-{hash}-{team}.vercel.app`), so a `*.suffix`
// dot-anchor doesn't fit. We use literal-end-with matching, with the
// operator responsible for choosing a suffix unique enough to be safe.
//
// For AIWatch the safe suffix is `-bentleys-projects-5f6a1a8c.vercel.app`
// (team-scoped — Vercel won't issue this team slug to anyone else). A bare
// `*.vercel.app` would let any Vercel user call the API and is never used.
//
// Match semantics:
//   - `'*'`               → permissive, returns the wildcard origin literal
//   - `'*-suffix'` /      → matches any origin whose host ends with the suffix.
//     `'*.suffix'`          The character right after the `*` must be `-` or
//                           `.` so a typo missing the separator (e.g.
//                           `*bentleys-projects-...`) doesn't silently widen
//                           the allowlist. Suffix matching is literal end-with
//                           on the entire origin string; operator picks a
//                           suffix unique enough to be unforgeable.
//   - `'https://x.com'`   → exact match
//
// Returns `{}` (no headers) when origin doesn't match — the browser will then
// block the request, which is the correct fail-closed behavior.

/**
 * Pure origin-matching helper, exported for unit testing.
 *
 * @param origin - The Origin header from the incoming request.
 * @param allowedOrigin - Comma-separated allowlist (env var). May be `'*'`,
 *   exact origins, or `*suffix` patterns.
 * @returns The string to send back as `Access-Control-Allow-Origin`, or `''`
 *   when the origin is not allowed.
 */
export function matchOrigin(origin: string, allowedOrigin: string | undefined): string {
  if (!allowedOrigin) return ''
  if (allowedOrigin === '*') return '*'
  if (!origin) return ''
  for (const raw of allowedOrigin.split(',')) {
    const pattern = raw.trim()
    if (!pattern) continue
    if (pattern === origin) return origin
    if (pattern.startsWith('*') && pattern.length > 1) {
      const suffix = pattern.slice(1)
      // Require a leading separator (`-` or `.`) on the suffix. This rejects
      // typo'd patterns like `*bentleys-projects-…vercel.app` (missing `-`)
      // that would otherwise match `evilbentleys-projects-…vercel.app` — the
      // separator anchors the suffix to a real boundary in the origin string.
      if (suffix[0] !== '-' && suffix[0] !== '.') continue
      if (origin.endsWith(suffix)) return origin
    }
  }
  return ''
}

/**
 * CORS response headers for the matched origin, or `{}` when not allowed.
 * `Vary: Origin` ensures CDN/proxy caches don't serve a response targeted
 * at one origin to a different one.
 */
export function corsHeaders(origin: string, allowedOrigin: string | undefined): HeadersInit {
  const allowOrigin = matchOrigin(origin, allowedOrigin)
  if (!allowOrigin) return {}

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  }
}
