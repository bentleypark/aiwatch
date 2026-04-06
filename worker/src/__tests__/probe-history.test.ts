import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readProbeHistory } from '../index'

/** Helper: YYYY-MM-DD for N days ago */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().split('T')[0]
}

function mockKV(store: Record<string, string> = {}) {
  return {
    get: vi.fn(async (key: string) => store[key] ?? null),
    put: vi.fn(),
  } as unknown as KVNamespace
}

describe('readProbeHistory', () => {
  it('reads probe:daily keys for the requested number of days', async () => {
    const today = daysAgo(0)
    const yesterday = daysAgo(1)
    const store: Record<string, string> = {
      [`probe:daily:${today}`]: JSON.stringify({ claude: { p50: 25, p75: 30, p95: 45, min: 20, max: 50, count: 288, spikes: 0 } }),
      [`probe:daily:${yesterday}`]: JSON.stringify({ claude: { p50: 28, p75: 32, p95: 48, min: 22, max: 55, count: 280, spikes: 1 } }),
    }
    const kv = mockKV(store)
    const history = await readProbeHistory(kv, 3)

    // Should have called get for 3 days (today + 2 past)
    expect(kv.get).toHaveBeenCalledTimes(3)
    // Should contain the 2 days that have data
    const dates = Object.keys(history)
    expect(dates).toContain(today)
    expect(dates).toContain(yesterday)
    expect(history[today].claude.p75).toBe(30)
    expect(history[yesterday].claude.spikes).toBe(1)
  })

  it('returns empty object when no probe data exists', async () => {
    const kv = mockKV({})
    const history = await readProbeHistory(kv, 7)
    expect(history).toEqual({})
    expect(kv.get).toHaveBeenCalledTimes(7)
  })

  it('works with the maximum day count of 90', async () => {
    const kv = mockKV({})
    const history = await readProbeHistory(kv, 90)
    expect(history).toEqual({})
    expect(kv.get).toHaveBeenCalledTimes(90)
  })

  it('skips entries with invalid JSON gracefully', async () => {
    const today = daysAgo(0)
    const yesterday = daysAgo(1)
    const store: Record<string, string> = {
      [`probe:daily:${today}`]: '{ invalid json',
      [`probe:daily:${yesterday}`]: JSON.stringify({ openai: { p50: 100, p75: 150, p95: 200, min: 80, max: 300, count: 288, spikes: 2 } }),
    }
    const kv = mockKV(store)
    const history = await readProbeHistory(kv, 3)

    // Invalid JSON day should be skipped
    expect(history[today]).toBeUndefined()
    expect(history[yesterday].openai.p75).toBe(150)
  })

  it('handles KV get failures gracefully', async () => {
    const today = daysAgo(0)
    const kv = {
      get: vi.fn(async (key: string) => {
        if (key.includes(today)) throw new Error('KV error')
        return null
      }),
      put: vi.fn(),
    } as unknown as KVNamespace

    const history = await readProbeHistory(kv, 3)
    expect(history).toEqual({})
  })
})
