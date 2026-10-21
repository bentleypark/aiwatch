import { describe, expect, it, vi } from 'vitest'
import workerModule from '../index'
import {
  MISTRAL_FEED_OBSERVATION_INDEX,
  MISTRAL_FEED_OBSERVATION_SOURCE,
  MISTRAL_PAGE_CONTRACT_ALERT_KEY,
  MISTRAL_PAGE_CONTRACT_CONSECUTIVE_KEY,
  observeMistralPageContract,
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
      blobs: [MISTRAL_FEED_OBSERVATION_SOURCE, 'stored', 'partial', 'none'],
      doubles: [1, 12, 8, 4, 20, 1],
      indexes: [MISTRAL_FEED_OBSERVATION_INDEX],
    })
  })

  it('alerts on the second consecutive confirmed contract change, then suppresses reminders for seven days', async () => {
    const store: Record<string, string> = {}
    const kv = {
      get: vi.fn(async (key: string) => store[key] ?? null),
      put: vi.fn(async (key: string, value: string) => { store[key] = value }),
      delete: vi.fn(async (key: string) => { delete store[key] }),
    }
    const observation = parseMistralFeedObservation({ delivery: 'not-posted', failure: 'page-contract' })!
    const send = vi.fn(async () => true)
    await expect(observeMistralPageContract(kv, observation, send)).resolves.toEqual({ consecutive: 1, alerted: false })
    await expect(observeMistralPageContract(kv, observation, send)).resolves.toEqual({ consecutive: 2, alerted: true })
    await expect(observeMistralPageContract(kv, observation, send)).resolves.toEqual({ consecutive: 3, alerted: false })
    expect(send).toHaveBeenCalledTimes(1)
    expect(store[MISTRAL_PAGE_CONTRACT_ALERT_KEY]).toBe('1')
    expect(store[MISTRAL_PAGE_CONTRACT_CONSECUTIVE_KEY]).toContain('3')
  })

  it('clears the contract-change streak after any other terminal observation', async () => {
    const store: Record<string, string> = { [MISTRAL_PAGE_CONTRACT_CONSECUTIVE_KEY]: JSON.stringify({ count: 1 }) }
    const kv = { get: async (key: string) => store[key] ?? null, put: async () => {}, delete: async (key: string) => { delete store[key] } }
    const clean = parseMistralFeedObservation({ delivery: 'not-posted' })!
    await observeMistralPageContract(kv, clean, async () => true)
    expect(store[MISTRAL_PAGE_CONTRACT_CONSECUTIVE_KEY]).toBeUndefined()
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
