#!/usr/bin/env node
// Phase 1 of #533: narrow type-check gate for the worker.
//
// Runs `tsc --noEmit` over production worker source and FAILS only on TS2304
// (undefined name / missing import) — the exact class that caused the #532
// production outage: `kvPut` was used in services.ts but never imported, which
// esbuild/`wrangler deploy --dry-run` does NOT catch (esbuild strips types
// without checking them), so it shipped and threw `ReferenceError` at runtime,
// crashing all of fetchAllServices().
//
// The worker has ~20 pre-existing *type-mismatch* errors (TS2345/TS2339/...) on
// hot paths, so tsc exits non-zero even on good code; fixing those + promoting
// this to a full zero-error gate is tracked in #533 Phases 2-4. This gate is
// green today and locks in the one bug class that silently reaches production.
//
// Scope note: TS2304 catches *undefined* names, not un-imported names that
// happen to collide with a runtime global (e.g. forgetting to import a local
// `crypto`/`Response` helper resolves to the Workers/DOM global → no TS2304).
// Those don't ReferenceError at runtime, so they're out of this gate's #532
// scope; a later phase (full type gate) is what catches shadowing mistakes.

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// tsc prints diagnostic paths relative to cwd; pin cwd to the repo root so the
// path filter below is correct regardless of where the script is invoked from.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const res = spawnSync(
  'npx',
  ['tsc', '--noEmit', '--pretty', 'false', '-p', 'worker/tsconfig.typecheck.json'],
  { encoding: 'utf8', cwd: repoRoot },
)

if (res.error) {
  console.error('❌ worker type-check: failed to spawn tsc:', res.error.message)
  process.exit(1)
}
if (res.status === null) {
  console.error('❌ worker type-check: tsc was killed by signal', res.signal)
  process.exit(1)
}

const out = `${res.stdout || ''}${res.stderr || ''}`

// Fail-closed: a config/invocation-level failure (bad/missing tsconfig, no
// inputs, an npx/registry download miss, a compiler crash) means tsc never
// type-checked anything. Detect it explicitly so the gate never disables itself
// silently. TS5xxx = CLI/config errors; TS18003 = "no inputs found".
const FATAL_INVOCATION = /error TS(5\d{3}|18003)\b/
const diagnosticLines = out.split('\n').filter((line) => /error TS\d+/.test(line))
if (FATAL_INVOCATION.test(out) || (res.status !== 0 && diagnosticLines.length === 0)) {
  console.error(
    '❌ worker type-check: tsc could not run (config/invocation error) — gate cannot vouch for the code.',
  )
  console.error(out.trim() || `   (no output; exit status ${res.status})`)
  process.exit(1)
}

// Undefined-name errors in any worker-bundled source — `worker/src/**` AND the
// cross-boundary files it imports and ships at runtime (e.g.
// api/is-down/region-status.ts via alerts.ts). Exclude only node_modules and
// test files. (The typecheck tsconfig already excludes tests; this is
// belt-and-suspenders.)
const undefErrors = diagnosticLines
  .filter((line) => line.includes('error TS2304'))
  .filter((line) => !line.includes('node_modules'))
  .filter((line) => !line.includes('__tests__') && !/\.test\.ts/.test(line))

if (undefErrors.length > 0) {
  console.error(
    '❌ worker type-check: undefined name(s) / missing import(s) detected (TS2304).',
  )
  console.error(
    '   This is the #532 bug class — esbuild / `wrangler deploy --dry-run` does NOT catch it.\n',
  )
  for (const err of undefErrors) console.error('   ' + err)
  process.exit(1)
}

console.log(
  '✅ worker type-check: 0 undefined-name errors in worker-bundled source (TS2304). [#533 Phase 1]',
)
