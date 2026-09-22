import { describe, expect, it, vi } from 'vitest'
import workerModule from '../index'
import {
  MISTRAL_FEED_OBSERVATION_INDEX,
  MISTRAL_FEED_OBSERVATION_SOURCE,
  parseMistralFeedObservation,
} from '../mistral-feed-observation'

describe('#1383 Mistral feed observations', () => {
  it('derives partial from the two measured counters and preserves the loss magnitude', () => {
    expect(parseMistralFeedObservation({
      delivery: 'stored', listed: 12, fetched: 8, available: 20, uptimeLostTooltips: 0,
    })).toEqual({
      delivery: 'stored', coverage: 'partial', listed: 12, fetched: 8, missing: 4, available: 20, uptimeLostTooltips: 0,
    })
  })

  it('keeps a pre-coverage failure distinct from a quiet, complete page', () => {
    expect(parseMistralFeedObservation({ delivery: 'not-posted' })).toEqual({
      delivery: 'not-posted', coverage: 'unavailable', listed: 0, fetched: 0, missing: 0, available: 0, uptimeLostTooltips: 0,
    })
  })

  it('rejects an impossible counter relation instead of laundering it into a complete run', () => {
    expect(parseMistralFeedObservation({ delivery: 'stored', listed: 8, fetched: 12, available: 12 })).toBeNull()
  })

  function env(writeDataPoint = vi.fn()) {
    return {
      STATUS_CACHE: { get: async () => null, put: async () => {}, delete: async () => {} },
      MISTRAL_FEED_TOKEN: 'test-token',
      ANALYTICS: { writeDataPoint },
    } as unknown as Parameters<typeof workerModule.fetch>[1]
  }

  it('records the real route as a bounded partial observation', async () => {
    const writeDataPoint = vi.fn()
    const res = await workerModule.fetch(new Request('https://ai-watch.dev/api/internal/mistral-feed-observation', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ delivery: 'stored', listed: 12, fetched: 8, available: 20, uptimeLostTooltips: 1 }),
    }), env(writeDataPoint), {} as ExecutionContext)

    expect(res.status).toBe(200)
    expect(writeDataPoint).toHaveBeenCalledWith({
      blobs: [MISTRAL_FEED_OBSERVATION_SOURCE, 'stored', 'partial'],
      doubles: [1, 12, 8, 4, 20, 1],
      indexes: [MISTRAL_FEED_OBSERVATION_INDEX],
    })
  })

  it('does not make the internal metric an unauthenticated write surface', async () => {
    const writeDataPoint = vi.fn()
    const res = await workerModule.fetch(new Request('https://ai-watch.dev/api/internal/mistral-feed-observation', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delivery: 'not-posted' }),
    }), env(writeDataPoint), {} as ExecutionContext)
    expect(res.status).toBe(401)
    expect(writeDataPoint).not.toHaveBeenCalled()
  })
})
