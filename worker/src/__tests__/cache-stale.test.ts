import { describe, it, expect } from 'vitest'
import { isCacheStale } from '../utils'

const THRESHOLD = 10 * 60 * 1000 // 10 minutes
const NOW = 1712400000000 // fixed timestamp

describe('isCacheStale', () => {
  it('returns stale when raw is null', () => {
    const result = isCacheStale(null, THRESHOLD, NOW)
    expect(result.stale).toBe(true)
    expect(result.services).toEqual([])
  })

  it('returns stale when raw is invalid JSON', () => {
    const result = isCacheStale('not-json{{{', THRESHOLD, NOW)
    expect(result.stale).toBe(true)
    expect(result.services).toEqual([])
  })

  it('returns stale when services array is empty', () => {
    const raw = JSON.stringify({ services: [], cachedAt: new Date(NOW).toISOString() })
    const result = isCacheStale(raw, THRESHOLD, NOW)
    expect(result.stale).toBe(true)
    expect(result.services).toEqual([])
  })

  it('returns stale when cachedAt is missing', () => {
    const raw = JSON.stringify({ services: [{ id: 'test' }] })
    const result = isCacheStale(raw, THRESHOLD, NOW)
    expect(result.stale).toBe(true)
    expect(result.services).toHaveLength(1)
  })

  it('returns stale when cachedAt is older than threshold', () => {
    const staleTime = new Date(NOW - THRESHOLD - 1000).toISOString() // 11 min ago
    const raw = JSON.stringify({ services: [{ id: 'test' }], cachedAt: staleTime })
    const result = isCacheStale(raw, THRESHOLD, NOW)
    expect(result.stale).toBe(true)
    expect(result.services).toHaveLength(1)
  })

  it('returns not stale when cachedAt is within threshold', () => {
    const freshTime = new Date(NOW - 5 * 60 * 1000).toISOString() // 5 min ago
    const raw = JSON.stringify({ services: [{ id: 'test' }], cachedAt: freshTime })
    const result = isCacheStale(raw, THRESHOLD, NOW)
    expect(result.stale).toBe(false)
    expect(result.services).toHaveLength(1)
  })

  it('returns not stale at exact threshold boundary', () => {
    const boundaryTime = new Date(NOW - THRESHOLD).toISOString() // exactly 10 min ago
    const raw = JSON.stringify({ services: [{ id: 'test' }], cachedAt: boundaryTime })
    const result = isCacheStale(raw, THRESHOLD, NOW)
    expect(result.stale).toBe(false) // not stale at exact boundary
  })

  it('handles legacy format (plain array without wrapper)', () => {
    // Old format was just an array, not { services, cachedAt }
    const raw = JSON.stringify([{ id: 'test' }])
    const result = isCacheStale(raw, THRESHOLD, NOW)
    expect(result.stale).toBe(true) // no cachedAt → stale
    expect(result.services).toHaveLength(1)
  })
})
