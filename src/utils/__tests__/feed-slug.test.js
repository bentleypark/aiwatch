// Cross-mirror sync (#432). The per-service RSS feed URL in src/utils/constants.js
// (feedUrlOf) hand-mirrors the service-ID ↔ is-down-slug mapping because the SPA
// bundle does not import from api/. This pins that mirror to the canonical
// source — api/_is-down/slug-map.ts — the same way worker/src/__tests__/
// feed-slug-sync.test.ts pins the worker copy.
import { describe, it, expect } from 'vitest'
import { SERVICE_ID_TO_SLUG } from '../../../api/_is-down/slug-map'
import { feedUrlOf, NO_FEED_SERVICES, ALL_SERVICE_IDS } from '../constants'

describe('feedUrlOf ↔ api/is-down slug-map sync (#432)', () => {
  it('feedUrlOf() matches SERVICE_ID_TO_SLUG for every is-down service', () => {
    for (const [id, slug] of Object.entries(SERVICE_ID_TO_SLUG)) {
      expect(feedUrlOf(id), `feedUrlOf('${id}')`).toBe(`https://ai-watch.dev/feed/${slug}`)
    }
  })

  it('every monitored service either has a feed or is in NO_FEED_SERVICES', () => {
    for (const id of ALL_SERVICE_IDS) {
      const hasFeed = id in SERVICE_ID_TO_SLUG
      expect(hasFeed || NO_FEED_SERVICES.includes(id), `service '${id}'`).toBe(true)
    }
  })

  it('NO_FEED_SERVICES are exactly the monitored services absent from the slug map', () => {
    const absent = ALL_SERVICE_IDS.filter((id) => !(id in SERVICE_ID_TO_SLUG)).sort()
    expect([...NO_FEED_SERVICES].sort()).toEqual(absent)
  })

  it('feedUrlOf() returns null for feedless services and falsy input', () => {
    for (const id of NO_FEED_SERVICES) expect(feedUrlOf(id)).toBeNull()
    expect(feedUrlOf('')).toBeNull()
    expect(feedUrlOf(undefined)).toBeNull()
  })
})
