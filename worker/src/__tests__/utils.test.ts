import { describe, it, expect, vi } from 'vitest'
import { formatDuration, trackFetchFailure, resetFetchFailure, type KVLike } from '../utils'

function mockKV(store: Record<string, string> = {}): KVLike {
  return {
    get: vi.fn(async (key: string) => store[key] ?? null),
    put: vi.fn(async (key: string, value: string) => { store[key] = value }),
    delete: vi.fn(async (key: string) => { delete store[key] }),
  }
}

describe('formatDuration', () => {
  it('returns 1m for durations under 60 seconds (ceil to 1m)', () => {
    const start = new Date('2026-03-23T10:00:00Z')
    const end = new Date('2026-03-23T10:00:30Z') // 30s
    expect(formatDuration(start, end)).toBe('1m')
  })

  it('returns 1m for 0 second duration', () => {
    const d = new Date('2026-03-23T10:00:00Z')
    expect(formatDuration(d, d)).toBe('1m')
  })

  it('returns 1m for exactly 60 seconds', () => {
    const start = new Date('2026-03-23T10:00:00Z')
    const end = new Date('2026-03-23T10:01:00Z')
    expect(formatDuration(start, end)).toBe('1m')
  })

  it('returns minutes for sub-hour durations', () => {
    const start = new Date('2026-03-23T10:00:00Z')
    const end = new Date('2026-03-23T10:45:00Z')
    expect(formatDuration(start, end)).toBe('45m')
  })

  it('returns hours and minutes for longer durations', () => {
    const start = new Date('2026-03-23T10:00:00Z')
    const end = new Date('2026-03-23T12:30:00Z')
    expect(formatDuration(start, end)).toBe('2h 30m')
  })

  it('returns Xh 0m when minutes are exactly zero', () => {
    const start = new Date('2026-03-23T10:00:00Z')
    const end = new Date('2026-03-23T13:00:00Z')
    expect(formatDuration(start, end)).toBe('3h 0m')
  })
})

describe('trackFetchFailure', () => {
  it('returns false on first failure (count=1, threshold=3)', async () => {
    const kv = mockKV()
    expect(await trackFetchFailure(kv, 'azure')).toBe(false)
    expect(kv.put).toHaveBeenCalledWith('fetch-fail:azure', '1', { expirationTtl: 1800 })
  })

  it('returns false on second failure (count=2, threshold=3)', async () => {
    const kv = mockKV({ 'fetch-fail:azure': '1' })
    expect(await trackFetchFailure(kv, 'azure')).toBe(false)
  })

  it('returns true on third failure (count=3, threshold=3)', async () => {
    const kv = mockKV({ 'fetch-fail:azure': '2' })
    expect(await trackFetchFailure(kv, 'azure')).toBe(true)
  })

  it('returns true when already above threshold and skips write', async () => {
    const kv = mockKV({ 'fetch-fail:azure': '5' })
    expect(await trackFetchFailure(kv, 'azure')).toBe(true)
    expect(kv.put).not.toHaveBeenCalled() // already above, skip write
  })

  it('handles corrupted (non-numeric) KV value gracefully', async () => {
    const kv = mockKV({ 'fetch-fail:azure': 'NaN' })
    expect(await trackFetchFailure(kv, 'azure')).toBe(false) // treats as 0+1=1 < 3
  })

  it('returns false when kv is undefined', async () => {
    expect(await trackFetchFailure(undefined, 'azure')).toBe(false)
  })

  it('supports custom threshold', async () => {
    const kv = mockKV({ 'fetch-fail:azure': '3' })
    expect(await trackFetchFailure(kv, 'azure', 5)).toBe(false) // 3+1=4 < 5
    const kv2 = mockKV({ 'fetch-fail:azure': '4' })
    expect(await trackFetchFailure(kv2, 'azure', 5)).toBe(true) // 4+1=5 >= 5
  })
})

describe('resetFetchFailure', () => {
  it('deletes the fail counter key when it exists', async () => {
    const store: Record<string, string> = { 'fetch-fail:azure': '3' }
    const kv = mockKV(store)
    await resetFetchFailure(kv, 'azure')
    expect(store['fetch-fail:azure']).toBeUndefined()
    expect(kv.delete).toHaveBeenCalled()
  })

  it('skips delete when key does not exist (saves KV write)', async () => {
    const kv = mockKV()
    await resetFetchFailure(kv, 'azure')
    expect(kv.delete).not.toHaveBeenCalled()
  })

  it('does nothing when kv is undefined', async () => {
    await resetFetchFailure(undefined, 'azure') // no throw
  })
})
