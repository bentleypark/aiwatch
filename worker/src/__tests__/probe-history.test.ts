import { describe, it, expect, vi } from 'vitest'
import { readProbeHistory } from '../index'

function mockKV(store: Record<string, string> = {}) {
  return {
    get: vi.fn(async (key: string) => store[key] ?? null),
    put: vi.fn(),
  } as unknown as KVNamespace
}

describe('readProbeHistory', () => {
  it('reads probe:daily keys for the requested number of days', async () => {
    const store: Record<string, string> = {
      'probe:daily:2026-04-02': JSON.stringify({ claude: { p50: 25, p75: 30, p95: 45, min: 20, max: 50, count: 288, spikes: 0 } }),
      'probe:daily:2026-04-01': JSON.stringify({ claude: { p50: 28, p75: 32, p95: 48, min: 22, max: 55, count: 280, spikes: 1 } }),
    }
    const kv = mockKV(store)
    const history = await readProbeHistory(kv, 3)

    // Should have called get for 3 days (today + 2 past)
    expect(kv.get).toHaveBeenCalledTimes(3)
    // Should contain the 2 days that have data
    const dates = Object.keys(history)
    expect(dates).toContain('2026-04-02')
    expect(dates).toContain('2026-04-01')
    expect(history['2026-04-02'].claude.p75).toBe(30)
    expect(history['2026-04-01'].claude.spikes).toBe(1)
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
    const store: Record<string, string> = {
      'probe:daily:2026-04-02': '{ invalid json',
      'probe:daily:2026-04-01': JSON.stringify({ openai: { p50: 100, p75: 150, p95: 200, min: 80, max: 300, count: 288, spikes: 2 } }),
    }
    const kv = mockKV(store)
    const history = await readProbeHistory(kv, 3)

    // Invalid JSON day should be skipped
    expect(history['2026-04-02']).toBeUndefined()
    expect(history['2026-04-01'].openai.p75).toBe(150)
  })

  it('handles KV get failures gracefully', async () => {
    const kv = {
      get: vi.fn(async (key: string) => {
        if (key.includes('04-02')) throw new Error('KV error')
        return null
      }),
      put: vi.fn(),
    } as unknown as KVNamespace

    const history = await readProbeHistory(kv, 3)
    expect(history).toEqual({})
  })
})
