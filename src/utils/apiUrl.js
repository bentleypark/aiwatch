// Worker API URL resolution — extracted so the default is unit-testable (#953).
//
// The default port MUST match `npm run dev:worker` / `dev:all` (8788). A worktree
// that didn't receive `.env` / `.env.local` (VITE_API_URL unset) previously fell to
// a stale 8787 default → a dead port → silent MOCK_SERVICES fallback, which made
// local verification misrepresent mock data as real. Keeping this in lockstep with
// dev:worker means a missing env var self-heals to the running local worker.
export const DEFAULT_API_URL = 'http://localhost:8788/api/status'

// Resolve the status API URL from the (optional) VITE_API_URL env override.
export function resolveApiUrl(envUrl) {
  return envUrl || DEFAULT_API_URL
}

// Derive the KV-only cached endpoint from a resolved status URL.
export function cachedUrlFor(apiUrl) {
  return apiUrl.endsWith('/api/status') ? apiUrl + '/cached' : apiUrl
}
