// #348 — pin TWEET_DRAFT_SERVICES (alerts.ts) to the canonical is-down slug map. alerts.ts
// hand-lists the 6 Claude/OpenAI-family service IDs and their is-down slugs so the tweet draft can
// build the right https://ai-watch.dev/is-{slug}-down link; this guards against drift if a slug is
// ever renamed. Same pattern as feed-slug-sync.test.ts. slug-map.ts is pure data (no @vercel/edge
// imports) so a Vitest test can import it directly.

import { describe, it, expect } from 'vitest'
import { TWEET_DRAFT_SERVICES } from '../alerts'
import { SERVICE_ID_TO_SLUG } from '../../../api/_is-down/slug-map'
import { SERVICES } from '../services'

describe('TWEET_DRAFT_SERVICES ↔ api/is-down slug-map sync', () => {
  it('every tweet-draft slug matches the canonical SERVICE_ID_TO_SLUG', () => {
    for (const [id, slug] of Object.entries(TWEET_DRAFT_SERVICES)) {
      expect(SERVICE_ID_TO_SLUG[id], `TWEET_DRAFT_SERVICES['${id}']`).toBe(slug)
    }
  })

  it('every tweet-draft service ID is a real worker service', () => {
    const workerIds = new Set(SERVICES.map((s) => s.id))
    for (const id of Object.keys(TWEET_DRAFT_SERVICES)) {
      expect(workerIds.has(id), `tweet-draft id '${id}'`).toBe(true)
    }
  })

  it('covers exactly the agreed Claude/OpenAI family (6 services)', () => {
    expect(Object.keys(TWEET_DRAFT_SERVICES).sort()).toEqual(
      ['chatgpt', 'claude', 'claudeai', 'claudecode', 'codex', 'openai'],
    )
  })
})
