// Fetches /api/report?month=YYYY-MM for the months covered by an extended period filter (#375).
// Process-wide cache: archive responses are *almost* immutable — the operator can rebuild a
// month via POST /api/admin/rebuild-archive (CLAUDE.md), but that's a rare path and a full
// page reload clears this cache. Caching the promise across re-renders avoids re-fetching
// when the user toggles between 7d/30d/90d. Cache key is the YYYY-MM string.

import { useEffect, useState } from 'react'

// Derive the API origin from VITE_API_URL (which points at /api/status). Strip the
// trailing path so we can build sibling endpoints like /api/report. Mirrors usePolling.
const API_BASE = (() => {
  const raw = import.meta.env.VITE_API_URL || 'https://aiwatch-worker.p2c2kbf.workers.dev/api/status'
  return raw.replace(/\/api\/status\/?(?:cached\/?)?$/, '')
})()

const promiseCache = new Map() // 'YYYY-MM' → Promise<archive | null>

// Visible for tests in src/hooks/__tests__/useMonthlyArchives.test.js — React-renderHook
// would require @testing-library/react which isn't in dev deps; exporting the fetcher
// keeps the load-bearing fetch contract under test without that dep.
export function _resetArchiveCacheForTests() { promiseCache.clear() }
export function fetchArchive(month) {
  const cached = promiseCache.get(month)
  if (cached) return cached
  const promise = fetch(`${API_BASE}/api/report?month=${month}`)
    .then(r => {
      // 404 is a real signal — that month was never archived (deploy started later).
      // Treat it as "no data" rather than throwing, so other months still resolve.
      if (r.status === 404) return null
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return r.json()
    })
    .catch(err => {
      // Surface in operator console without breaking the UI — 90d view degrades to
      // live-only data, which matches pre-#375 behavior. Don't cache the rejection
      // so a retry on the next selection actually re-attempts.
      console.warn(`[useMonthlyArchives] ${month}: ${err.message}`)
      promiseCache.delete(month)
      return null
    })
  promiseCache.set(month, promise)
  return promise
}

/**
 * @param {string[]} months  e.g. ['2026-02', '2026-03', '2026-04']
 * @returns {{archives: Record<string, object>, loading: boolean}}
 */
export function useMonthlyArchives(months) {
  const [archives, setArchives] = useState({})
  const [loading, setLoading] = useState(false)
  // Identity-stable key for the dependency — months array is recomputed on every render
  // by the consumer's useMemo, so a length+content fingerprint avoids spurious effect runs.
  const key = months.join(',')

  useEffect(() => {
    if (!months.length) {
      setArchives({})
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    Promise.all(months.map(m => fetchArchive(m).then(a => [m, a])))
      .then(pairs => {
        if (cancelled) return
        const obj = {}
        for (const [m, a] of pairs) {
          if (a) obj[m] = a
        }
        setArchives(obj)
        setLoading(false)
      })
    return () => { cancelled = true }
  // months.join already encodes the array; React doesn't need to inspect months itself.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return { archives, loading }
}
