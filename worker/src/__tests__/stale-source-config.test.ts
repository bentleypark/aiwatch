import { describe, it, expect } from 'vitest'
import { SERVICES } from '../services'

// #591 — the stale-source ranking exclusion keys off ServiceConfig.incidentSourceStale. This guards
// against the flag being silently dropped (which would re-inflate the affected service's Score and
// let its frozen feed rank again — DeepSeek was #4 with score 88 from an empty 30-day window).
describe('stale-source config (#591)', () => {
  it('deepseek is flagged incidentSourceStale (its Flashduty mirror is frozen, #507)', () => {
    const deepseek = SERVICES.find((s) => s.id === 'deepseek')
    expect(deepseek).toBeDefined()
    expect(deepseek!.incidentSourceStale).toBe(true)
  })

  it('the flag is opt-in — no OTHER service is stale-flagged today', () => {
    const flagged = SERVICES.filter((s) => s.incidentSourceStale).map((s) => s.id)
    expect(flagged).toEqual(['deepseek'])
  })
})
