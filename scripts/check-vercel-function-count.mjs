// Vercel Serverless-Function count guard (#862).
//
// WHY: Vercel builds every file under `api/` as an individual Function. On the Hobby plan a
// deployment may hold at most 12 SERVERLESS Functions ("No more than 12 Serverless Functions can be
// added to a Deployment on the Hobby plan" — errorCode `exceeded_serverless_functions_per_deployment`,
// errorStep `patchBuild`). In #862 a merge silently crossed 12→13 (a new `api/is-down/share-url.ts`
// helper) and EVERY production deploy failed AFTER a green build — the failure is in the deploy step,
// not the type-check, so `tsc`/`vite build`/unit tests all stay green and hide it. This guard
// replicates Vercel's counting rule so CI (`npm run test:scripts`) fails the PR BEFORE merge/deploy.
//
// COUNTING RULE (must mirror Vercel):
//  A file under `api/` is a Serverless Function that counts toward the limit UNLESS:
//   (a) any path segment starts with `_` — Vercel's documented underscore-exclusion. This covers
//       `_shared/`, `__tests__/`, and the #862 helper dirs `_is-down/ _intro/ _methodology/ _badges/`.
//   (b) the file declares `runtime: 'edge'` — Edge Functions do NOT count against the
//       Serverless-per-deployment limit (that was the exact #862 error class).
//  Everything else counts: non-edge top-level handlers AND any stray helper/`.test.ts` sitting in a
//  non-underscore path (e.g. the old top-level `api/extension-privacy.test.ts`).
//
// To ADD headroom: keep helper modules in `_`-prefixed dirs (mirrors `api/_shared/`), keep tests in
// `__tests__/`, and keep SSR handlers on the edge runtime. Do NOT just raise the limit — the ceiling
// is Vercel's, not ours.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

export const HOBBY_LIMIT = 12

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const API_DIR = join(REPO_ROOT, 'api')

// ── pure decision helpers (unit-tested) ──────────────────────────────────────

/** True when any path segment of an api-relative path starts with `_` (Vercel underscore-exclusion). */
export function isUnderscoreExcluded(apiRelPath) {
  return apiRelPath.split('/').some((seg) => seg.startsWith('_'))
}

/** True when file source declares the Edge runtime (Edge Functions don't count to the serverless limit). */
export function declaresEdgeRuntime(source) {
  return /runtime:\s*['"]edge['"]/.test(source)
}

/**
 * Given entries `{ path, source }` (path relative to `api/`), return the paths that COUNT as
 * Serverless Functions under Vercel's rule. Pure — the CLI supplies real files, tests supply fixtures.
 */
export function countedServerlessFunctions(entries) {
  return entries
    .filter((e) => (e.path.endsWith('.ts') || e.path.endsWith('.js')) && !e.path.endsWith('.d.ts'))
    .filter((e) => !isUnderscoreExcluded(e.path))
    .filter((e) => !declaresEdgeRuntime(e.source))
    .map((e) => e.path)
}

// ── filesystem walk (used by CLI + the integration test) ─────────────────────

/** Recursively collect `{ path, source }` for every .ts/.js file under `api/` (path relative to api/). */
export function collectApiEntries(apiDir = API_DIR) {
  const out = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(ts|js)$/.test(name)) out.push({ path: relative(apiDir, full), source: readFileSync(full, 'utf8') })
    }
  }
  walk(apiDir)
  return out
}

/** Count the real `api/` tree. Returns `{ count, files }`. */
export function countRealApiFunctions() {
  const files = countedServerlessFunctions(collectApiEntries()).sort()
  return { count: files.length, files }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function isMain() {
  return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
}

if (isMain()) {
  const { count, files } = countRealApiFunctions()
  const headroom = HOBBY_LIMIT - count
  console.log(`Vercel Serverless Functions under api/: ${count} / ${HOBBY_LIMIT} (headroom ${headroom})`)
  for (const f of files) console.log(`  • api/${f}`)
  if (count > HOBBY_LIMIT) {
    console.error(
      `\n❌ ${count} > ${HOBBY_LIMIT}: this deployment would FAIL on Vercel Hobby ` +
        `(exceeded_serverless_functions_per_deployment, #862).\n` +
        `   Fix: move helper modules into a \`_\`-prefixed dir (like api/_shared/), keep tests in ` +
        `__tests__/, or keep SSR handlers on \`runtime: 'edge'\`.`,
    )
    process.exit(1)
  }
  console.log(`✅ within the Hobby ${HOBBY_LIMIT}-function limit.`)
}
