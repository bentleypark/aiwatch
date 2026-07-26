// #1164 — pins render.js's hand-copied IS_DOWN_SLUG map to the canonical source
// (api/_is-down/slug-map.ts's SERVICE_ID_TO_SLUG). The extension bundle can't import from api/ at
// RUNTIME (it ships as static files, no build step pulling from this repo's api/ directory), but a
// Vitest test can import it directly — same reasoning worker/src/__tests__/feed-slug-sync.test.ts and
// src/utils/__tests__/feed-slug.test.js already use for their own hand-copies of this same mapping.
// Without this, a future slug-map.ts rename (like #1164's own claude→claude-api) could silently
// desync the extension's popup deep-links with no CI signal — exactly the drift class #1164's review
// flagged this map as missing a guard for.

import { describe, it, expect } from 'vitest'
import { isDownPath } from './render.js'
import { SERVICE_ID_TO_SLUG } from '../../api/_is-down/slug-map'

describe('IS_DOWN_SLUG ↔ api/is-down slug-map sync (#1164)', () => {
  it('every id the extension deep-links matches the canonical SERVICE_ID_TO_SLUG', () => {
    for (const id of ['claude', 'claudeai', 'claudecode']) {
      expect(isDownPath(id), `isDownPath('${id}')`).toBe(`/is-${SERVICE_ID_TO_SLUG[id]}-down`)
    }
  })
})
