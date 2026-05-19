// Cross-mirror sync test (#54). The RSS feed in worker/src/rss.ts hand-copies
// the service-ID ↔ is-down-slug mapping because the Worker bundle cannot import
// from api/ (Edge vs Worker compilation surfaces). This pins that copy to the
// canonical source — api/is-down/slug-map.ts — the same way api-tier-sync.test.ts
// and region-status-sync.test.ts pin their mirrors. slug-map.ts is pure data
// (no @vercel/edge imports) so a Vitest test can import it directly.

import { describe, it, expect } from 'vitest'
import { feedSlug, IS_DOWN_SLUG_OVERRIDE, NO_IS_DOWN_PAGE } from '../rss'
import { SERVICES } from '../services'
import { SERVICE_ID_TO_SLUG } from '../../../api/is-down/slug-map'

describe('feed slug ↔ api/is-down slug-map sync', () => {
  it('feedSlug() matches SERVICE_ID_TO_SLUG for every is-down service', () => {
    for (const [id, slug] of Object.entries(SERVICE_ID_TO_SLUG)) {
      expect(feedSlug(id), `feedSlug('${id}')`).toBe(slug)
    }
  })

  it('every IS_DOWN_SLUG_OVERRIDE entry matches the canonical reverse map', () => {
    for (const [id, slug] of Object.entries(IS_DOWN_SLUG_OVERRIDE)) {
      expect(SERVICE_ID_TO_SLUG[id], `override '${id}'`).toBe(slug)
    }
  })

  it('IS_DOWN_SLUG_OVERRIDE covers exactly the dash-dropped service IDs', () => {
    const dashDropped = Object.entries(SERVICE_ID_TO_SLUG)
      .filter(([id, slug]) => id !== slug)
      .map(([id]) => id)
      .sort()
    expect(Object.keys(IS_DOWN_SLUG_OVERRIDE).sort()).toEqual(dashDropped)
  })

  it('NO_IS_DOWN_PAGE is exactly the worker services absent from the slug map', () => {
    const absent = SERVICES.map((s) => s.id)
      .filter((id) => !(id in SERVICE_ID_TO_SLUG))
      .sort()
    expect([...NO_IS_DOWN_PAGE].sort()).toEqual(absent)
  })

  it('every slug-map service ID is a real worker service', () => {
    const workerIds = new Set(SERVICES.map((s) => s.id))
    for (const id of Object.keys(SERVICE_ID_TO_SLUG)) {
      expect(workerIds.has(id), `slug-map id '${id}'`).toBe(true)
    }
  })
})
