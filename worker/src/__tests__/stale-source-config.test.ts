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

  it('deepseekapp uses incidentSourceStale as its feed-absent fallback flag (#619)', () => {
    // #619 — the DeepSeek consumer app is feed-only (no apiUrl). When the Flashduty feed is fresh,
    // readFlashdutyStatus clears the flag; when absent it stays, so a feed outage can't rank an
    // empty/unknown app. Both DeepSeek services therefore carry the config flag.
    const app = SERVICES.find((s) => s.id === 'deepseekapp')
    expect(app).toBeDefined()
    expect(app!.incidentSourceStale).toBe(true)
  })

  it('the flag is opt-in — only the two DeepSeek (Flashduty) services are stale-flagged today', () => {
    const flagged = SERVICES.filter((s) => s.incidentSourceStale).map((s) => s.id)
    expect(flagged).toEqual(['deepseek', 'deepseekapp'])
  })
})
