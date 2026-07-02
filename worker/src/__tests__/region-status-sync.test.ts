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
import { SERVICE_REGIONS as frontendRegions, REGION_DOCS_URL as frontendDocs } from '../../../src/utils/regionStatus'

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

  it('every service id in REGION_DOCS_URL also appears in the Edge file', () => {
    for (const id of Object.keys(frontendDocs)) {
      const re = new RegExp(`^  ${id}: ['"]`, 'm')
      expect(re.test(EDGE_FILE), `Edge file missing REGION_DOCS_URL["${id}"]`).toBe(true)
    }
  })
})
