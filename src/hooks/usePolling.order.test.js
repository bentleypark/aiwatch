// #796 — MOCK_SERVICES order invariant.
// Bug: the mock fallback array listed the 4 AI apps FIRST (apps → apis → agents). mergeWithMock
// preserves array order and the Incidents service-filter dropdown renders `services` unsorted, so
// the dropdown showed AI apps before the APIs — diverging from the live /api/status order.
// This pins the canonical category order so a re-introduction fails the build.
import { describe, it, expect } from 'vitest'
import { MOCK_SERVICES } from './usePolling'

describe('MOCK_SERVICES order (#796)', () => {
  const cats = MOCK_SERVICES.map((s) => s.category)

  it('has the full 44-service roster', () => {
    expect(MOCK_SERVICES.length).toBe(44)
  })

  it('is grouped in the canonical api → app → agent order (matches worker SERVICES + live API)', () => {
    // Collapse to category runs and assert exactly [api, app, agent] — no app before any api.
    const runs = cats.filter((c, i) => c !== cats[i - 1])
    expect(runs).toEqual(['api', 'app', 'agent'])
  })

  it('places every app after every api (the exact dropdown-ordering regression)', () => {
    const lastApi = cats.lastIndexOf('api')
    const firstApp = cats.indexOf('app')
    expect(firstApp).toBeGreaterThan(lastApi)
  })

  it('leads with the major LLM APIs, not an app', () => {
    expect(MOCK_SERVICES[0].id).toBe('claude')
    expect(MOCK_SERVICES[0].category).toBe('api')
  })
})
