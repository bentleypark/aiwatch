#!/usr/bin/env node
// #533 type-check gate for the worker (Phase 4 — full tsc on production source).
//
// Runs `tsc --noEmit` over production worker source and FAILS on ANY type error.
// The motivating class was the #532 production outage: `kvPut` was used in
// services.ts but never imported (TS2304), which esbuild/`wrangler deploy
// --dry-run` does NOT catch (esbuild strips types without checking them), so it
// shipped and threw `ReferenceError` at runtime, crashing all of
// fetchAllServices(). Phase 1 gated on TS2304 alone; Phase 2 cleared the ~20
// pre-existing type-mismatch errors on hot paths; Phase 4 (here) promotes the
// gate to the WHOLE class — a HeadersInit/null/never/shape bug on a hot path is
// now caught at PR time too, not just an undefined name.
//
// Scope: production source only (the typecheck tsconfig excludes `__tests__`).
// Extending the gate to type-check test files (the ~120 test-file errors) is the
// remaining #533 exit-condition item, tracked separately.

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// tsc prints diagnostic paths relative to cwd; pin cwd to the repo root so the
// path filter below is correct regardless of where the script is invoked from.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// #533 Phase 4 (exit condition) — TWO passes, BOTH must be 0-error:
//  1. production source — strict @cloudflare/workers-types ONLY (no @types/node), so a prod file
//     referencing process/Buffer/node:fs FAILS (the worker has no nodejs_compat → that's a runtime
//     crash, the #532 class). Plus the cross-boundary files it ships (api/_is-down/region-status.ts).
//  2. test files — WITH @types/node + allowJs (they run under vitest/Node, use node:fs/__dirname for
//     source-sync invariants + import a few frontend .js helpers). Isolated to tests so the node
//     relaxation can't hide a prod node-API misuse.
// Phase 2 cleared the 16 prod-source errors; Phase 4 cleared the test-file errors AND promoted the
// gate from TS2304-only to ANY error code across the whole worker.
const PASSES = [
  { config: 'worker/tsconfig.typecheck.json', label: 'production source (strict, no node types)' },
  { config: 'worker/tsconfig.typecheck.tests.json', label: 'test files (node types)' },
]

// Fail-closed: a config/invocation-level failure (bad/missing tsconfig, no inputs, an npx/registry
// download miss, a compiler crash) means tsc never type-checked anything. Detect it explicitly so the
// gate never disables itself silently. TS5xxx = CLI/config errors; TS18003 = "no inputs found".
const FATAL_INVOCATION = /error TS(5\d{3}|18003)\b/

function runPass({ config, label }) {
  const res = spawnSync('npx', ['tsc', '--noEmit', '--pretty', 'false', '-p', config], {
    encoding: 'utf8',
    cwd: repoRoot,
  })
  if (res.error) {
    console.error(`❌ worker type-check (${label}): failed to spawn tsc:`, res.error.message)
    process.exit(1)
  }
  if (res.status === null) {
    console.error(`❌ worker type-check (${label}): tsc was killed by signal`, res.signal)
    process.exit(1)
  }
  const out = `${res.stdout || ''}${res.stderr || ''}`
  const diagnosticLines = out.split('\n').filter((line) => /error TS\d+/.test(line))
  if (FATAL_INVOCATION.test(out) || (res.status !== 0 && diagnosticLines.length === 0)) {
    console.error(
      `❌ worker type-check (${label}): tsc could not run (config/invocation error) — gate cannot vouch for the code.`,
    )
    console.error(out.trim() || `   (no output; exit status ${res.status})`)
    process.exit(1)
  }
  // node_modules is excluded (skipLibCheck also suppresses dependency .d.ts noise).
  return diagnosticLines.filter((line) => !line.includes('node_modules'))
}

let failed = false
for (const pass of PASSES) {
  const errs = runPass(pass)
  if (errs.length === 0) continue
  failed = true
  const undefCount = errs.filter((l) => l.includes('error TS2304')).length
  console.error(`❌ worker type-check: ${errs.length} type error(s) in ${pass.label}.`)
  console.error(
    undefCount > 0
      ? '   Includes undefined name(s) / missing import(s) (TS2304) — the #532 bug class esbuild / `wrangler deploy --dry-run` does NOT catch.\n'
      : '   esbuild / `wrangler deploy --dry-run` strips types without checking them, so these reach runtime undetected.\n',
  )
  for (const err of errs) console.error('   ' + err)
}
if (failed) process.exit(1)

console.log(
  '✅ worker type-check: 0 type errors — production source (strict, no node) + test files (full tsc --noEmit). [#533 Phase 4]',
)
