import { describe, it, expect } from 'vitest'
import { toUpstreamPath } from '../reports'

// Pure-function unit test for the path-stripping logic that maps Vercel
// request paths onto the GH Pages upstream. A regex regression here would
// silently break asset URLs / nested report paths in production, so the
// four documented mappings (#264) are pinned by tests.
describe('toUpstreamPath (#264)', () => {
  it('maps the bare /reports root to /', () => {
    expect(toUpstreamPath('/reports')).toBe('/')
  })

  it('maps /reports/ (trailing slash) to /', () => {
    expect(toUpstreamPath('/reports/')).toBe('/')
  })

  it('strips the /reports prefix from a monthly report path', () => {
    expect(toUpstreamPath('/reports/2026-03/')).toBe('/2026-03/')
  })

  it('strips the prefix from asset paths', () => {
    expect(toUpstreamPath('/reports/assets/main.css')).toBe('/assets/main.css')
  })

  it('handles paths with explicit index.html', () => {
    expect(toUpstreamPath('/reports/2026-03/index.html')).toBe('/2026-03/index.html')
  })

  it('handles deeply nested paths', () => {
    expect(toUpstreamPath('/reports/2026-03/assets/charts/uptime.svg')).toBe(
      '/2026-03/assets/charts/uptime.svg',
    )
  })

  it('preserves a leading slash on the stripped result', () => {
    // Defends against a regex that would strip /reports without preserving the
    // path separator and produce something like 'assets/main.css' (no leading /).
    expect(toUpstreamPath('/reports/anything')).toMatch(/^\//)
  })
})
