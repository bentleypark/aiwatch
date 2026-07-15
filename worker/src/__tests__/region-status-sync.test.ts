// #422 Phase 2 — pin the cross-mirror sync of SERVICE_REGIONS + REGION_DOCS_URL.
//
// Two independent copies live in this repo:
//   1. src/utils/regionStatus.js   — frontend (ServiceDetails RegionalAvailability card,
//                                              Overview ActionBanner region line)
//   2. api/_is-down/region-status.ts — Edge SSR (Is X Down? region recommendation line,
//                                                 separate compilation surface from `src/`)
//
// A Worker-side copy is planned but not in this PR — when it lands, extend this test to
// triangulate all three (same pattern as worker/src/__tests__/api-tier-sync.test.ts for
// API_TIER). For now, keep the SPA ↔ Edge pair locked.
//
// File 2 (api/_is-down/region-status.ts) can't be imported here — Edge Functions are a
// different compilation surface (no @vercel/edge types in this Workers test runner).
// Read it via fs and check structural parity. Catches forgotten additions; doesn't catch
// label typos (acceptable — labels are user-visible, a typo would be caught on first render
// of any region-aware service).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// Vitest resolves cross-package paths via the repo root; this works because frontend `src/`
// and worker `src/` share a single repo with one node_modules. The import is data-only.
import {
  SERVICE_REGIONS as frontendRegions,
  REGION_DOCS_URL as frontendDocs,
  REGION_SWITCHABLE as frontendSwitchable,
} from '../../../src/utils/regionStatus'

const REPO_ROOT = join(__dirname, '..', '..', '..')
const EDGE_FILE = readFileSync(join(REPO_ROOT, 'api/_is-down/region-status.ts'), 'utf-8')

describe('SERVICE_REGIONS cross-mirror sync (#422 Phase 2)', () => {
  it('api/_is-down/region-status.ts inline copy contains every canonical service id', () => {
    for (const id of Object.keys(frontendRegions)) {
      // Match `  id: [` line (TS object key, the Edge file uses `'id'` quoting for none of
      // these because all are valid identifiers). Anchor to start-of-line + 2-space indent
      // to avoid false matches in comments.
      const re = new RegExp(`^  ${id}: \\[`, 'm')
      expect(re.test(EDGE_FILE), `api/_is-down/region-status.ts is missing SERVICE_REGIONS["${id}"]`).toBe(true)
    }
  })

  it('api/_is-down/region-status.ts inline copy contains every canonical region key', () => {
    // For each (svcId, regions) pair, every region.key must appear as a quoted string
    // literal somewhere inside the Edge file's SERVICE_REGIONS object. Single quotes
    // because TS prettier default; double would also be valid — check both.
    for (const [svcId, regions] of Object.entries(frontendRegions)) {
      for (const region of regions) {
        const needleSingle = `key: '${region.key}'`
        const needleDouble = `key: "${region.key}"`
        const found = EDGE_FILE.includes(needleSingle) || EDGE_FILE.includes(needleDouble)
        expect(found, `Edge file missing region key "${region.key}" for ${svcId}`).toBe(true)
      }
    }
  })

  it('region count per service matches (SPA ≡ Edge inline)', () => {
    // Count occurrences of `key: '...'` per service block. If counts diverge for any
    // service, the Edge file has either an extra or missing region — caught here even
    // if the per-key string-match above passes due to a stray duplicate.
    for (const [svcId, regions] of Object.entries(frontendRegions)) {
      const blockRe = new RegExp(`${svcId}: \\[([\\s\\S]*?)\\]`, 'm')
      const match = EDGE_FILE.match(blockRe)
      expect(match, `Edge file: could not locate ${svcId} region array`).toBeTruthy()
      const block = match![1]
      const keyMatches = block.match(/key:\s*['"]/g) ?? []
      expect(keyMatches.length, `${svcId} region count mismatch — SPA=${regions.length}, Edge=${keyMatches.length}`).toBe(regions.length)
    }
  })

  // #973 — the old version of this test only asserted that each SPA doc-url KEY appeared in the
  // Edge file. It never compared the URL VALUES, and never checked the reverse direction, so
  // fixing a rotted URL in one mirror (or deleting an entry from one) stayed green. That is
  // exactly the drift that shipped: both mirrors held a pinecone URL Pinecone had retired.
  // NOTE this pins mirror EQUALITY, not URL correctness — a link that 301s to the wrong page
  // still returns 200, so only a human looking at the landing page can catch rot (step 3.5).
  it('REGION_DOCS_URL is byte-identical across mirrors (ids AND urls, both directions)', () => {
    expect(parseEdgeDocsUrl()).toEqual(frontendDocs)
  })

  it('REGION_SWITCHABLE membership matches across mirrors', () => {
    expect(parseEdgeStringSet('REGION_SWITCHABLE')).toEqual([...frontendSwitchable].sort())
  })

  // Every switchable service must be region-aware, else `recommendedRegion` can never resolve
  // and the entry is a silent no-op.
  it('every REGION_SWITCHABLE service has a SERVICE_REGIONS map', () => {
    for (const id of frontendSwitchable) {
      expect(Object.keys(frontendRegions), `REGION_SWITCHABLE["${id}"] has no SERVICE_REGIONS entry`).toContain(id)
    }
  })

  // A docs link is only ever rendered next to a recommended region, so a doc url for a
  // non-switchable service is unreachable — the dead `chatgpt` entry #973 removed.
  it('every REGION_DOCS_URL service is switchable (no unreachable doc links)', () => {
    for (const id of Object.keys(frontendDocs)) {
      expect(frontendSwitchable.has(id), `REGION_DOCS_URL["${id}"] is not switchable — the link can never render`).toBe(true)
    }
  })
})

// These parsers read the Edge file as TEXT (it can't be imported here — different compilation
// surface). A reformat or a service id outside the expected charset would make them read nothing.
// Each therefore asserts a non-empty result BEFORE its caller diffs it, so "the parser broke" fails
// with that message instead of masquerading as a full-object "the mirrors drifted" diff.

/** Extract the Edge file's `REGION_DOCS_URL` object literal as a plain id→url record. */
function parseEdgeDocsUrl(): Record<string, string> {
  const block = sliceObjectLiteral('REGION_DOCS_URL')
  const out: Record<string, string> = {}
  for (const [, id, url] of block.matchAll(/^\s*([a-zA-Z0-9_-]+):\s*['"]([^'"]+)['"]/gm)) out[id] = url
  expect(Object.keys(out).length, 'parser read 0 REGION_DOCS_URL entries — Edge file formatting changed, not a data drift').toBeGreaterThan(0)
  return out
}

/** Extract a `new Set([...])` of string literals from the Edge file, sorted. */
function parseEdgeStringSet(name: string): string[] {
  const m = EDGE_FILE.match(new RegExp(`export const ${name}(?![A-Za-z0-9_]) = new Set\\(\\[([^\\]]*)\\]`))
  expect(m, `Edge file: could not locate export const ${name}`).toBeTruthy()
  const ids = [...m![1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]).sort()
  expect(ids.length, `parser read 0 ${name} members — Edge file formatting changed, not a data drift`).toBeGreaterThan(0)
  return ids
}

/** Body of a top-level `export const <name> = { ... }` in the Edge file, comments stripped. */
function sliceObjectLiteral(name: string): string {
  // Anchored on a non-identifier char after `name`, else an unanchored substring match would
  // prefix-match a RENAMED export (`REGION_DOCS_URL` would still find `REGION_DOCS_URLS`) and the
  // test would pass on a file that no longer exports what it claims to pin.
  const start = EDGE_FILE.search(new RegExp(`export const ${name}(?![A-Za-z0-9_])`))
  expect(start, `Edge file: could not locate export const ${name}`).toBeGreaterThan(-1)
  const open = EDGE_FILE.indexOf('{', start)
  const close = EDGE_FILE.indexOf('\n}', open)
  return EDGE_FILE.slice(open, close).replace(/^\s*\/\/.*$/gm, '')
}
