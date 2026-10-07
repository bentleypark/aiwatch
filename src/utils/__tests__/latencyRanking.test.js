import { describe, it, expect } from 'vitest'
import { rankedByLatency } from '../latencyRanking'

const svc = (id, category, latency) => ({ id, category, latency })

describe('rankedByLatency (#1633)', () => {
  it('ranks only probed, non-app services, fastest first', () => {
    const services = [
      svc('openai', 'api', 300),
      svc('claude', 'api', 180),
      svc('bedrock', 'api', 304),       // carries a value but is not in the probe snapshot
      svc('characterai', 'app', 90),    // probed, but an app
      svc('cursor', 'agent', 250),
      svc('chatgpt', 'app', null),
    ]
    const ids = ['openai', 'claude', 'characterai', 'cursor']
    expect(rankedByLatency(services, ids).map((s) => s.id)).toEqual(['claude', 'cursor', 'openai'])
  })

  it('a probed service whose probe failed (latency null) is left out', () => {
    expect(rankedByLatency([svc('claude', 'api', null)], ['claude'])).toEqual([])
  })

  it('no probe snapshot (mock/dev) → every non-app service with a value', () => {
    const services = [svc('claude', 'api', 180), svc('characterai', 'app', 90), svc('groq', 'api', 95)]
    expect(rankedByLatency(services, []).map((s) => s.id)).toEqual(['groq', 'claude'])
  })
})
