// #1193 — every provider family must have a reachable group is-down page.
//
// `/is-<familySlug>-down` is not a route the code derives; it exists only because someone hand-added
// a rewrite to vercel.json. Several producers across the worker build that URL from `FAMILY_GROUPS`
// with no runtime check, and their links are handed out to be pasted publicly.
//
// The failure is quiet, which is why it is pinned here rather than left to a runtime guard: without
// a rewrite the URL falls through to the SPA catch-all and answers 200 with the dashboard shell —
// not a 404 — so nothing logs and nothing breaks visibly. There is also nothing useful for an alert
// path to do about a config omission at send time.
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { FAMILY_GROUPS } from '../_is-down/slug-map'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')
const vercelConfig = JSON.parse(readFileSync(join(repoRoot, 'vercel.json'), 'utf8')) as {
  rewrites: { source: string; destination: string }[]
}

describe('FAMILY_GROUPS ↔ vercel.json group routes', () => {
  it('every family has a /is-<slug>-down rewrite pointing at its own group page', () => {
    for (const [key, family] of Object.entries(FAMILY_GROUPS)) {
      const rewrite = vercelConfig.rewrites.find((r) => r.source === `/is-${family.slug}-down`)
      expect(rewrite, `no vercel.json rewrite for family '${key}' (/is-${family.slug}-down)`).toBeTruthy()
      // The rewrite must resolve to THIS family, not merely to the group handler — a copy-paste that
      // left another family's query string would render the wrong provider's page behind a correct
      // -looking URL, and nothing about that is observable from a status code.
      expect(rewrite!.destination).toBe(`/api/is-down-group?family=${family.slug}`)
    }
  })

  it('every family rewrite outranks the SPA catch-all', () => {
    // Vercel matches rewrites in array order. Appending is the natural way to "add a line", and an
    // entry added below the `/(.*)` catch-all is dead: the URL serves the SPA shell at 200, the
    // existence assertion above still passes, and the operator has already pasted the link.
    const catchAll = vercelConfig.rewrites.findIndex((r) => r.source === '/(.*)')
    expect(catchAll, 'no SPA catch-all rewrite found — this assertion is stale').toBeGreaterThanOrEqual(0)
    for (const family of Object.values(FAMILY_GROUPS)) {
      const i = vercelConfig.rewrites.findIndex((r) => r.source === `/is-${family.slug}-down`)
      expect(i, `/is-${family.slug}-down is shadowed by the SPA catch-all`).toBeLessThan(catchAll)
    }
  })

  it('the group handler the rewrites point at exists', () => {
    // The other way a pinned rewrite becomes a dead link.
    expect(existsSync(join(repoRoot, 'api/is-down-group.ts'))).toBe(true)
  })

  it('every group rewrite corresponds to a real family (no route to a deleted one)', () => {
    const slugs = new Set(Object.values(FAMILY_GROUPS).map((f) => f.slug))
    for (const r of vercelConfig.rewrites) {
      if (!r.destination.startsWith('/api/is-down-group')) continue
      const family = new URL(r.destination, 'https://x').searchParams.get('family')
      expect(slugs.has(family ?? ''), `rewrite ${r.source} points at unknown family '${family}'`).toBe(true)
    }
  })
})
