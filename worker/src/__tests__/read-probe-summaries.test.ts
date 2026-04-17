import { describe, it, expect, vi } from 'vitest'
import { readProbeSummaries } from '../index'
import type { ProbeSummary } from '../types'

// Locks the catch-and-translate behavior of readProbeSummaries.
// This is the load-bearing layer that converts KV-degraded throws (HIGH-3 in #132) into `undefined`,
// which downstream classifyProbe maps to 'unavailable' — preventing silent 5%-penalty across all probed services.

describe('readProbeSummaries', () => {
  it('returns the Map on successful KV read', async () => {
    const summary: ProbeSummary = { p50: 200, p95: 400, cvCombined: 0.5, validDays: 7 }
    const cached = JSON.stringify([['claude', summary]])
    const kv = { get: vi.fn(async () => cached) } as unknown as KVNamespace

    const result = await readProbeSummaries(kv, 'test')
    expect(result).toBeInstanceOf(Map)
    expect(result!.get('claude')).toEqual(summary)
  })

  it('returns undefined when getCachedProbeSummaries throws (KV degraded)', async () => {
    // Locks the .catch — a refactor that drops it would propagate the throw to /api/status handlers.
    // Without this catch, every probed service would be silently misclassified as 'insufficient' (-5%).
    const kv = {
      get: vi.fn(async () => { throw new Error('KV unavailable') }),
    } as unknown as KVNamespace

    const result = await readProbeSummaries(kv, 'test')
    expect(result).toBeUndefined()
  })

  it('returns empty Map (not undefined) when cache is genuinely empty', async () => {
    // Distinct from the throw case: KV is healthy but no summary cached yet (cold start, fresh deploy).
    // Empty Map → classifyProbe maps to 'insufficient' (5% penalty) — the *correct* semantic.
    const kv = {
      get: vi.fn(async (key: string) => {
        if (key === 'probe:summaries') return null
        return null // no daily archives either
      }),
    } as unknown as KVNamespace

    const result = await readProbeSummaries(kv, 'test')
    expect(result).toBeInstanceOf(Map)
    expect(result!.size).toBe(0)
  })
})
