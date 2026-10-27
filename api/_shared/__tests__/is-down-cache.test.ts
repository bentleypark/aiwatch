import { describe, it, expect } from 'vitest'
import { isDownCacheControl, STALE_IF_ERROR_S } from '../is-down-cache'

describe('isDownCacheControl (#1531 Part 6)', () => {
  it('lets the CDN serve a good render in place of a later error', () => {
    expect(isDownCacheControl(false)).toBe(`public, s-maxage=60, stale-while-revalidate=300, stale-if-error=${STALE_IF_ERROR_S}`)
    expect(STALE_IF_ERROR_S).toBe(600)
  })

  it('keeps a fallback render out of every cache (#378)', () => {
    const header = isDownCacheControl(true)
    expect(header).toBe('no-store, max-age=0, must-revalidate')
    expect(header).not.toContain('stale-if-error')
  })
})
