import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// #1268 — every Edge SSR surface that reads the Worker does so through a bare module constant, and
// pointing one at a local worker is a step-3.5 ritual: CLAUDE.md's local-verify flow tells you to run
// the dashboard against `npm run dev:worker`, and `api/is-down.ts` hard-codes the production host, so
// checking an is-down change locally means editing this line and remembering to put it back. It was
// edited and restored twice while #1268 was being verified.
//
// Nothing caught it. The whole `test:src` suite is green with `WORKER_API = 'http://localhost:8788'`
// in the tree, and neither workflow hook looks for it — so the failure mode is a merge in which all 43
// `/is-*-down` pages, the reports proxy and the group route fetch a host that does not exist in
// production, and every one of them serves its 503 fallback. An SEO-surface outage with a green CI.
//
// The precedent is one file over: `api/__tests__/confirm.test.ts` pins exactly this hazard for
// `api/confirm.ts`'s derived host ("a local worker would make EVERY production confirm silently POST to
// localhost:8788"). These three constants had no equivalent.
//
// Read from source rather than imported: these modules are Edge Functions with top-level side effects,
// and the assertion is about the literal that ships, not about a value some code path computes.

const PROD_WORKER = 'https://aiwatch-worker.p2c2kbf.workers.dev'
/** Repo-root relative, which is where `npm run test:src` runs vitest from. A wrong cwd throws ENOENT —
 *  i.e. it fails loudly rather than quietly reading nothing, which is the failure mode that would matter
 *  for a guard like this. (`import.meta.url` does not resolve to a filesystem path under this config.) */
const readSource = (file: string) => readFileSync(join(process.cwd(), 'api', file), 'utf8')
const SURFACES = ['is-down.ts', 'is-down-group.ts', 'reports.ts']
// The const-name assertion is scoped to the three `WORKER_API` declarations; the localhost sweep is not.
// `_is-down/html-template.ts` carries an in-code instruction to make exactly this swap ("a one-line swap
// to http://localhost:8788/api/report-issue is the only change needed for local verification"), which
// makes it the constant an is-down check is MOST likely to touch — the guard's coverage would have been
// the inverse of the documented ritual. `_badges/html-template.ts` and `_shared/audience-beacon.ts` hold
// the same class of hardcoded worker URL.
const NO_LOCALHOST = [...SURFACES, '_is-down/html-template.ts', '_badges/html-template.ts', '_shared/audience-beacon.ts']

describe('#1268 — Edge surfaces point at the production Worker', () => {
  it.each(SURFACES)('%s declares WORKER_API as the production host', (file) => {
    const src = readSource(file)
    const decl = src.match(/^const WORKER_API = '([^']+)'/m)
    expect(decl, `${file} has no top-level WORKER_API declaration — if it moved, move this guard with it`).not.toBeNull()
    expect(decl![1], `${file} would ship pointing at ${decl![1]}`).toBe(PROD_WORKER)
  })

  it.each(NO_LOCALHOST)('%s ships no localhost URL in a string literal', (file) => {
    // Catches the same mistake made anywhere else in the file — a second fetch, a debug fallback, a
    // commented-out line someone uncomments later.
    //
    // A quote is required before the scheme, so this matches a VALUE and not prose. `_is-down/
    // html-template.ts` documents the swap in a comment ("a one-line swap to
    // http://localhost:8788/api/report-issue is the only change needed for local verification") — that
    // sentence is the reason the file is on this list, and flagging it would make the guard cry wolf on
    // the very instruction it exists to backstop.
    expect(readSource(file)).not.toMatch(/['"`]https?:\/\/localhost:\d+/)
  })
})
