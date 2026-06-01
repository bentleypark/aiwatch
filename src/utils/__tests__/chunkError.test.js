import { describe, it, expect } from 'vitest'
import { isChunkLoadError } from '../chunkError'

describe('isChunkLoadError', () => {
  it('matches Chrome dynamic import failure', () => {
    expect(isChunkLoadError(new Error('Failed to fetch dynamically imported module: https://example.com/assets/Latency-abc123.js'))).toBe(true)
  })

  it('matches Firefox dynamic import failure', () => {
    expect(isChunkLoadError(new Error('error loading dynamically imported module: https://example.com/assets/Incidents-def456.js'))).toBe(true)
  })

  it('matches Safari dynamic import failure', () => {
    expect(isChunkLoadError(new Error('Importing a module script failed.'))).toBe(true)
  })

  it('matches Vite legacy chunk failure pattern', () => {
    expect(isChunkLoadError(new Error('Loading chunk 5 failed.'))).toBe(true)
  })

  it('returns false for non-chunk errors', () => {
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false)
    expect(isChunkLoadError(new Error('NetworkError when attempting to fetch resource'))).toBe(false)
    expect(isChunkLoadError(new Error('Script error.'))).toBe(false)
  })

  it('returns false for null/undefined error', () => {
    expect(isChunkLoadError(null)).toBe(false)
    expect(isChunkLoadError(undefined)).toBe(false)
  })

  it('returns false for error with no message', () => {
    expect(isChunkLoadError({})).toBe(false)
    expect(isChunkLoadError(new Error(''))).toBe(false)
  })
})
