import { describe, it, expect } from 'vitest'
import { DEFAULT_API_URL, resolveApiUrl, cachedUrlFor } from './apiUrl'

describe('apiUrl (#953)', () => {
  it('default API URL targets port 8788 (matches npm run dev:worker)', () => {
    // Regression guard: the old 8787 default did not match dev:worker (8788), so a
    // worktree with no VITE_API_URL hit a dead port → silent MOCK_SERVICES fallback.
    expect(DEFAULT_API_URL).toBe('http://localhost:8788/api/status')
  })

  it('resolveApiUrl falls back to the 8788 default when env is unset', () => {
    expect(resolveApiUrl(undefined)).toBe('http://localhost:8788/api/status')
    expect(resolveApiUrl('')).toBe('http://localhost:8788/api/status')
    expect(resolveApiUrl(null)).toBe('http://localhost:8788/api/status')
  })

  it('resolveApiUrl honors an explicit VITE_API_URL override', () => {
    expect(resolveApiUrl('https://aiwatch-worker.example.dev/api/status'))
      .toBe('https://aiwatch-worker.example.dev/api/status')
  })

  it('cachedUrlFor appends /cached only to a /api/status URL', () => {
    expect(cachedUrlFor('http://localhost:8788/api/status')).toBe('http://localhost:8788/api/status/cached')
    expect(cachedUrlFor('https://x.dev/api/status')).toBe('https://x.dev/api/status/cached')
    // A non-/api/status override is passed through unchanged (incl. an already-/cached URL).
    expect(cachedUrlFor('https://x.dev/custom')).toBe('https://x.dev/custom')
    expect(cachedUrlFor('https://x.dev/api/status/cached')).toBe('https://x.dev/api/status/cached')
  })

  it('the default composition (unset env) yields the 8788 cached endpoint usePolling uses', () => {
    expect(cachedUrlFor(resolveApiUrl(undefined))).toBe('http://localhost:8788/api/status/cached')
  })
})
