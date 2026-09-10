// Service-worker caching decisions, extracted as pure functions (#1386).
//
// These live apart from the event handlers for one reason: `src/main.jsx` registers the SW in
// PRODUCTION ONLY (#432), so no dev-server e2e can ever exercise this code. Keeping the decisions
// pure is what makes them reachable from `test:src`.

export const BYPASS = 'bypass'
export const NETWORK_FIRST = 'network-first'
export const STALE_WHILE_REVALIDATE = 'stale-while-revalidate'

// Real-time / server-rendered paths the SW must never answer from cache. Substring match on the
// full URL, carried over verbatim from the pre-#1386 handler. Deliberately over-broad: a built chunk
// named `/assets/reports-<hash>.js` also matches and is handed straight to the network. That costs a
// cache entry, never correctness — the mismatch direction is always MORE bypass, never a cache write
// that should not have happened — so it is pinned as intended behaviour rather than narrowed here.
const NEVER_CACHE = ['/is-', '/api/', '/reports']

// Which strategy a request gets. `request` needs only { method, url, mode }.
export function routeFor(request, swOrigin) {
  if (request.method !== 'GET') return BYPASS

  const url = request.url
  if (NEVER_CACHE.some((p) => url.includes(p))) return BYPASS

  let origin
  try {
    origin = new URL(url).origin
  } catch {
    return BYPASS
  }
  if (origin !== swOrigin) return BYPASS

  // The document is what tells the browser which asset hashes to load, so a stale one names assets
  // from a build that is gone and the page renders blank. Cache is the OFFLINE fallback here, never
  // a fast path: a timeout race would reopen the stale-document path on a slow network, which is the
  // path this rule exists to close.
  if (request.mode === 'navigate') return NETWORK_FIRST

  return STALE_WHILE_REVALIDATE
}

const isJsMime = (ct) => /^(text|application)\/(x-)?(java|ecma)script$/.test(ct)
const isCssMime = (ct) => ct === 'text/css'
const isHtmlMime = (ct) => ct === 'text/html' || ct === 'application/xhtml+xml'

// What a response must declare to be stored under a request of this destination. `worker` and
// `serviceworker` sit in the JS group because browsers apply the same strict MIME check to them.
// `document` is here for a different reason: nothing rejects a mistyped document, but a document is
// never the right body for the asset URLs this guard protects, so the constraint still holds.
const EXPECTED_BY_DESTINATION = {
  script: isJsMime,
  worker: isJsMime,
  serviceworker: isJsMime,
  sharedworker: isJsMime,
  style: isCssMime,
  document: isHtmlMime,
}

// The same question asked of the URL, because `request.destination` is the one input this guard
// cannot verify: an unrecognised value (a context that spells it differently, a Request built
// without one) would otherwise take the unconstrained path and restore the pre-#1386 status-only
// rule silently, per browser. A built asset's extension is not subject to that — it is in the URL
// the SW was handed.
const EXPECTED_BY_EXTENSION = [
  [/\.m?js$/, isJsMime],
  [/\.css$/, isCssMime],
]

function expectedFor(request) {
  const byDestination = EXPECTED_BY_DESTINATION[request.destination]
  if (byDestination) return byDestination
  let path = ''
  try {
    path = new URL(request.url).pathname.toLowerCase()
  } catch {
    return null
  }
  const match = EXPECTED_BY_EXTENSION.find(([re]) => re.test(path))
  return match ? match[1] : null
}

// Whether a network response may be written to the cache under this request.
//
// The status alone is not enough. Before #1386 the SPA catch-all answered a deleted build asset with
// index.html at HTTP 200, so `response.ok` was true for a body that can never run as the script it
// was requested as — and storing it is what let a bad load survive into later ones. That source is
// fixed in `vercel.json`, but the guard stays: the SW must not be the thing that persists a bad
// response, whatever produced it.
export function mayCache(request, response) {
  if (!response || !response.ok) return false
  if (response.type === 'opaque' || response.type === 'opaqueredirect') return false

  const expected = expectedFor(request)
  if (!expected) return true

  const raw = response.headers.get('content-type') || ''
  const ct = raw.split(';')[0].trim().toLowerCase()
  // No declared type where one is required: refuse rather than guess.
  if (!ct) return false
  return expected(ct)
}
