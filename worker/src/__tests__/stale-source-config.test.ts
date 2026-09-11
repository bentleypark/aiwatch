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

  it('mistral does NOT carry the flag — its source is readable again (#1381)', () => {
    // It DID, while the Instatus→Rootly migration left no readable source at all. #1381 restored one
    // (a browser scrape pushed to KV), and the flag's own copy then becomes a lie: `/is-mistral-down`
    // renders "AIWatch can't currently read Mistral API's status source" beneath a badge derived
    // from that feed. Asserted here rather than left to the roster test below so a revert says why.
    //
    // What the flag would have been standing in for — "this read may be lossy" — is expressed
    // PER CYCLE instead: the KV gate refuses a feed it cannot fully read, and the response for that
    // cycle carries `incidentSourceStale` from `withUnreadFeedFlag`. A config flag cannot stop being
    // true; a response can. Precedent: junie/langsmith/fireworks each migrated sources, none took it.
    const mistral = SERVICES.find((s) => s.id === 'mistral')
    expect(mistral).toBeDefined()
    expect(mistral!.incidentSourceStale).toBeUndefined()
  })

  it('the flag is opt-in — exactly the services whose source we cannot read carry it', () => {
    const flagged = SERVICES.filter((s) => s.incidentSourceStale).map((s) => s.id)
    expect(flagged).toEqual(['deepseek', 'deepseekapp'])
  })
})
