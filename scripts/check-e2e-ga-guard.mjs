#!/usr/bin/env node
// #998 — CI guard: no e2e spec may escape the GA4 hit block in `tests/fixtures.js`.
//
// The block lives in a Playwright fixture, so it only applies to specs that actually import `test`
// from `./fixtures.js`. A new spec that reaches for '@playwright/test' out of habit silently sends
// real hits to the production GA4 property (VITE_GA4_ID / the id hardcoded in
// api/_shared/consent-init.ts) — invisibly, because a polluting run still passes.
//
// Two escapes are checked:
//   1. importing `test` from '@playwright/test' (either quote style)
//   2. `browser.newContext()` / `browser.newPage()` — both create a FRESH context, bypassing the
//      `context` fixture override — without a matching `blockGaHits()` call. (`ctx.newPage()` on an
//      already-blocked context is fine: it inherits the context's routes.)
//
// Not detected, because no spec does it today and the pattern is unbounded: a page-level catch-all
// route (`page.route('**/*', r => r.continue())`), which takes precedence over context-level routes,
// or `context.unrouteAll()`. Both are called out in the tests/fixtures.js header.
//
// Run via `npm run test:scripts` (node --test picks up check-e2e-ga-guard.test.mjs, which calls
// findGaGuardViolations against the real tests/ directory) and directly as a CLI.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Matches the SPECIFIER alone, not an import statement. A wrapped import list —
//   import {
//     test,
//   } from '@playwright/test'
// — is ordinary ESM formatting, and a line-anchored `^\s*import .* from …` pattern sails right past
// it; dropping the `from` too covers `await import(…)` / `require(…)` for free. Run against
// stripComments (strings intact), so a prose mention can only produce a fail-CLOSED false positive.
const PLAYWRIGHT_IMPORT_RE = /['"]@playwright\/test['"]/
// Anchored on `browser.` so `request.newContext()` (the API-request fixture, which never renders a
// page and so cannot reach GA4) doesn't trip it.
const OWN_CONTEXT_RE = /\bbrowser\s*\.\s*(newContext|newPage)\s*\(/g
const BLOCK_CALL_RE = /\bblockGaHits\s*\(/g

// Playwright's default testMatch under testDir collects more than flat `*.spec.js`.
const SPEC_FILE_RE = /\.(spec|test)\.[cm]?[jt]sx?$/

// Comments and string literals must be neutralized before counting, or the guard — the fail-closed
// backstop for a fail-open block — is itself fail-open. Two ways that bites, both real:
//   - a test TITLE mentioning blockGaHits() would satisfy the pairing for an unguarded context
//   - a `//` inside a string would be mistaken for a comment, and eating the rest of that line can
//     unbalance a quote and swallow the real code after it
// So this is ONE left-to-right pass with a single alternation: whichever token starts first wins,
// which is what makes "is this `//` a comment or part of a string?" answerable at all.
const TOKEN_RE = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g

function neutralize(source, { keepStrings }) {
  return source.replace(TOKEN_RE, (tok) => {
    // Comments → whitespace, newlines preserved so `^`-anchored /m checks still line up.
    if (tok.startsWith('//') || tok.startsWith('/*')) return tok.replace(/[^\n]/g, ' ')
    if (keepStrings) return tok
    const quote = tok[0] // keep the quotes, empty the body
    return quote + quote
  })
}

/** Comments removed, string literals intact — the import check needs the module specifier. */
export function stripComments(source) {
  return neutralize(source, { keepStrings: true })
}

/** Comments removed AND string bodies emptied — so no prose or title can satisfy a call count. */
export function stripNonCode(source) {
  return neutralize(source, { keepStrings: false })
}

function countMatches(source, re) {
  return (source.match(re) ?? []).length
}

// Returns a list of { file, reason } — empty when every spec is covered.
export function findGaGuardViolations(specs) {
  const violations = []
  for (const { file, source } of specs) {
    const code = stripNonCode(source) // comments gone, string bodies emptied
    const withStrings = stripComments(source) // comments gone, string literals intact

    if (PLAYWRIGHT_IMPORT_RE.test(withStrings)) {
      violations.push({
        file,
        reason: "imports from '@playwright/test' — import test/expect from './fixtures.js' instead, or the GA4 hit block does not apply",
      })
    }

    // Pair the calls rather than merely requiring one blockGaHits anywhere in the file: otherwise a
    // second, unguarded newContext() added later to an already-passing spec sails through.
    //
    // The two counts read DIFFERENT passes on purpose:
    //   - `own` takes the max across both passes. TOKEN_RE has no regex-literal alternative (that
    //     needs prev-token context to resolve the regex-vs-division ambiguity), so a quote inside a
    //     regex — `/won't/` — opens a phantom string in the strings-emptied pass and could swallow a
    //     `browser.newContext()` on the same line. It survives in the strings-intact pass, and a max
    //     can only RAISE the count, so that misparse stays fail-closed.
    //   - `blocked` reads ONLY the strings-emptied pass, so a test title mentioning blockGaHits()
    //     can never satisfy the pairing.
    // Residual (accepted, not closed): the same phantom string can also swallow a `//`, leaking a
    // comment that mentions blockGaHits( into the code pass and inflating `blocked`. It needs two
    // apostrophes AND that mention on one line; a max can't fix this side without reintroducing the
    // test-title hole. The real fix would be a regex-literal token, which isn't worth the ambiguity.
    const own = Math.max(countMatches(code, OWN_CONTEXT_RE), countMatches(withStrings, OWN_CONTEXT_RE))
    const blocked = countMatches(code, BLOCK_CALL_RE)
    if (own > blocked) {
      violations.push({
        file,
        reason: `${own} browser.newContext()/newPage() call(s) but only ${blocked} blockGaHits() call(s) — a self-made context bypasses the \`context\` fixture and reaches GA4`,
      })
    }
  }
  return violations
}

export function readSpecs(testsDir) {
  return readdirSync(testsDir, { recursive: true })
    .filter((f) => SPEC_FILE_RE.test(f))
    .sort()
    .map((f) => ({ file: f, source: readFileSync(join(testsDir, f), 'utf8') }))
}

export const TESTS_DIR = fileURLToPath(new URL('../tests', import.meta.url))

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const violations = findGaGuardViolations(readSpecs(TESTS_DIR))
  if (violations.length) {
    console.error('✗ e2e GA4 guard (#998) — these specs can send real hits to the production property:\n')
    for (const v of violations) console.error(`  tests/${v.file}\n    ${v.reason}\n`)
    process.exit(1)
  }
  console.log('✓ e2e GA4 guard (#998) — all specs route through tests/fixtures.js')
}
