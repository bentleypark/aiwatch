// #777 — pin TWEET_SEARCH_TERMS (alerts.ts) scope so it can't silently drift from the agreed
// Claude/OpenAI family + Gemini. Same intent as tweet-draft-slug-sync.test.ts: the operator "find tweets
// to reply to" search links must cover exactly the surfaces that spawn viral outage tweets, and every
// keyed id must be a real worker service.
import { describe, it, expect } from 'vitest'
import { TWEET_SEARCH_TERMS, TWEET_DRAFT_SERVICES } from '../alerts'
import { SERVICES } from '../services'
import { SERVICE_ID_TO_SLUG } from '../../../api/is-down/slug-map'

describe('TWEET_SEARCH_TERMS scope', () => {
  it('covers exactly the Claude/OpenAI family + Gemini (7 services)', () => {
    expect(Object.keys(TWEET_SEARCH_TERMS).sort()).toEqual(
      ['chatgpt', 'claude', 'claudeai', 'claudecode', 'codex', 'gemini', 'openai'],
    )
  })

  it('is a superset of the tweet-draft scope (every draftable service is also searchable)', () => {
    for (const id of Object.keys(TWEET_DRAFT_SERVICES)) {
      expect(TWEET_SEARCH_TERMS[id], `TWEET_SEARCH_TERMS['${id}']`).toBeTruthy()
    }
  })

  it('every search id is a real worker service', () => {
    const workerIds = new Set(SERVICES.map((s) => s.id))
    for (const id of Object.keys(TWEET_SEARCH_TERMS)) {
      expect(workerIds.has(id), `tweet-search id '${id}'`).toBe(true)
    }
  })

  it('every search id has an is-down slug (else buildReplyDraft silently drops the reply)', () => {
    // buildReplyDraft returns null when SERVICE_ID_TO_SLUG[id] is missing — pin that every scoped id
    // has a slug so a future addition (e.g. a slug-map-excluded service) can't drop the reply unnoticed.
    for (const id of Object.keys(TWEET_SEARCH_TERMS)) {
      expect(SERVICE_ID_TO_SLUG[id], `no is-down slug for tweet-search id '${id}'`).toBeTruthy()
    }
  })

  it('every term is a plain "down" phrase with no advanced operators (the 0-result footgun)', () => {
    for (const [id, term] of Object.entries(TWEET_SEARCH_TERMS)) {
      expect(term, `TWEET_SEARCH_TERMS['${id}']`).toContain('down')
      expect(term, `TWEET_SEARCH_TERMS['${id}'] must not over-filter`).not.toMatch(/min_faves|filter:/)
    }
  })
})
