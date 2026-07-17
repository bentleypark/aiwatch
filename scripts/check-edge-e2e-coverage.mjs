#!/usr/bin/env node
// #1051 — CI guard: every user-facing Edge SSR page in api/ must be reached by an e2e spec, AND
// every Edge project must actually be wired to run.
//
// The gap it closes: `/plugin` published an install command that resolved for nobody for months
// while "Edge E2E (Vercel Preview) pass" stayed green — `test:edge` ran only is-down/intro/reports/
// consent and never loaded the changed page. Six of nine pages had no e2e at all. An SSR unit test
// renders the template in-process and proves the STRING; only an e2e proves the DEPLOYED page serves.
//
// TWO checks, because #1051 had two halves and the spec-grep alone only covers one:
//   (a) COVERAGE — every api/ page is referenced by the CODE of a spec an EDGE project runs.
//   (b) WIRING   — every Edge project is in `test:edge` AND in `desktop`'s testIgnore.
// (b) is the half that actually shipped the bug: the specs for is-down/intro existed and ran; the
// pages nobody wired were simply absent from the project list. A guard that only greps specs would
// bless `tests/newpage.spec.js` that no project ever executes — the same invisibility, one level up.
//
// Coverage is deliberately a COVERAGE check, not a quality one: it asks "does any spec's CODE
// reference this path", not "is the assertion good". A page reached by a bad test is a review
// problem; a page reached by NO test is invisible, which is the failure mode that actually shipped.
//
// "CODE" is load-bearing. Comments and test titles are stripped before matching, or the guard is
// itself fail-open: this file's own spec has a header comment explaining the /plugin bug and a
// `test.describe('/plugin serves install commands …')` title — either would satisfy a raw grep while
// the PAGES table that does the actual navigating sat empty. Verified: with the strip in place,
// deleting /plugin from that table fails the guard; without it, the guard reported green.
//
// Run via `npm run test:scripts` (check-edge-e2e-coverage.test.mjs calls auditRepo against the real
// api/ + tests/ + playwright.config.js) and directly as a CLI.

import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
// Shared, not copied (#1006) — one comment tokenizer and one spec reader for both e2e guards.
import { stripComments, readSpecs } from './check-e2e-ga-guard.mjs'

// Endpoints under api/ that are NOT user-facing pages. Each needs a reason — the entry is a claim
// that no browser ever navigates here, and a wrong one silently exempts a real page forever.
export const NON_PAGE_ENDPOINTS = new Map([
  ['csp-report', 'POST-only CSP violation sink (#482) — 405 on GET, 204 on POST, renders no HTML'],
])

// Pages whose served path isn't `/<filename>`. Everything else defaults to `/<filename>`, so a new
// page needs no entry here — it just needs a spec that navigates to it. A RegExp value pins a shape
// a bare substring can't: `-down` alone would be satisfied by any `scroll-down` in any spec.
export const PAGE_PATH_OVERRIDES = new Map([
  // vercel.json rewrites /is-{slug}-down → /api/is-down?slug={slug}; no spec ever says "/is-down".
  ['is-down', /\/is-[a-z0-9-]+-down(?![a-z0-9-])/],
])

export function pagePathToken(stem) {
  return PAGE_PATH_OVERRIDES.get(stem) ?? `/${stem}`
}

// A test/describe TITLE is prose that merely happens to be a string, so stripComments (which keeps
// strings — the PAGES table needs its literals) isn't enough. Empties the title argument only.
//
// Known limits, both fail-OPEN — a page could report covered while nothing loads it:
//   - `test.each([…])('title')` isn't matched (no spec uses that form today).
//   - a `test.skip` / `test.fixme` body still counts, so a page whose only test is skipped passes.
// Neither is cheaply grep-detectable. They are review's job; this guard catches the page that has
// no spec at all, which is the one nobody notices.
const TEST_TITLE_RE = /\b((?:test|it|describe)(?:\.\w+)*)\(\s*(['"`])(?:\\.|(?!\2)[\s\S])*?\2/g

export function stripTestTitles(source) {
  return source.replace(TEST_TITLE_RE, "$1(''")
}

/** Comments gone, test titles emptied, data strings intact — what "the spec's code" means here. */
export function specCode(source) {
  return stripTestTitles(stripComments(source))
}

/**
 * A spec "covers" a page when its CODE references the page's path token. String tokens match
 * boundary-aware: a bare `includes('/plugin')` is satisfied by '/plugin-privacy', which would let
 * /plugin sit uncovered while the guard reports green — the exact false-pass this guard exists to
 * prevent, one level up. So the token must not be followed by a path-continuing character.
 */
export function specCoversPage(specSource, token) {
  const code = specCode(specSource)
  if (token instanceof RegExp) return token.test(code)
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`${escaped}(?![a-z0-9-])`).test(code)
}

/** @returns {string[]} page stems with no e2e spec navigating to them. */
export function findEdgeE2eGaps(pageStems, specSources) {
  return pageStems
    .filter((stem) => !NON_PAGE_ENDPOINTS.has(stem))
    .filter((stem) => {
      const token = pagePathToken(stem)
      return !specSources.some((src) => specCoversPage(src, token))
    })
}

// ── Wiring ───────────────────────────────────────────────────────────────────
// These take the IMPORTED config (its real `projects` array, with real RegExp objects), not the
// file's text. A text parse of playwright.config.js was the first attempt and it was fail-open four
// separate ways — `use: {...EDGE_USE, viewport}` matched nothing, a project declaring `use:` before
// `name:` vanished, `--project=edge-pages-v2` satisfied `edge-pages`, and the `testIgnore` grep took
// the first one in the file without checking it was desktop's. Every one of those reports WIRED when
// it isn't: the same shape as the bug this guard exists to prevent. Importing costs nothing — the
// config is a plain object, `globalSetup` is a string literal that defineConfig never resolves, and
// @playwright/test is already a devDependency wherever test:scripts runs.

/** Edge projects = those carrying the preview bypass storageState (i.e. `use: EDGE_USE`). */
export function findEdgeProjects(projects, bypassState) {
  return projects.filter((p) => p.use?.storageState === bypassState)
}

/** Exact `--project=<name>` flags — substring matching would let `edge-pages-v2` satisfy `edge-pages`. */
export function projectFlags(script) {
  return [...String(script).matchAll(/--project=(\S+)/g)].map((m) => m[1])
}

/** Edge projects missing from `test:edge` — specs that exist but that no CI job runs (#1051's half). */
export function findUnwiredEdgeProjects(projects, bypassState, testEdgeScript) {
  const wired = projectFlags(testEdgeScript)
  return findEdgeProjects(projects, bypassState)
    .filter((p) => !wired.includes(p.name))
    .map((p) => p.name)
}

/**
 * Edge specs the `desktop` project would ALSO run — against Vite :5173, where Edge paths 404.
 * Runs the REAL regexes against the REAL spec filenames rather than comparing pattern text, so an
 * equivalent-but-differently-written testIgnore can't produce a phantom leak (or hide a real one).
 * @returns {string[]} `project:file` pairs desktop fails to ignore.
 */
export function findDesktopLeaks(projects, bypassState, specFiles) {
  const desktop = projects.find((p) => p.name === 'desktop')
  if (!desktop) return ['(fail-closed: no `desktop` project — this check can no longer see leaks)']
  // Playwright also accepts a string/array here. Both would throw an opaque `.test is not a
  // function` deep in the loop; say so in this guard's own voice instead.
  const notRe = [...findEdgeProjects(projects, bypassState).map((p) => [`${p.name}.testMatch`, p.testMatch]), ['desktop.testIgnore', desktop.testIgnore]]
    .filter(([, v]) => v !== undefined && !(v instanceof RegExp))
    .map(([k]) => `${k} is not a RegExp — this check only understands RegExp patterns.`)
  if (notRe.length) return notRe
  const leaks = []
  for (const p of findEdgeProjects(projects, bypassState)) {
    for (const file of specFiles.filter((f) => p.testMatch?.test(f))) {
      if (!desktop.testIgnore?.test(file)) leaks.push(`${p.name}:${file}`)
    }
  }
  return leaks
}

// ── Reading ──────────────────────────────────────────────────────────────────

/**
 * Edge page stems = flat `*.ts` files directly under api/. Vercel would also route
 * `api/foo/index.ts` → `/api/foo`, which this would never see — so the caller must pin that every
 * api/ subdirectory is `_`-prefixed (a helper, #867). See findApiPageDirs.
 */
export function readPageStems(apiDir) {
  return readdirSync(apiDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
    .map((e) => e.name.replace(/\.ts$/, ''))
    .sort()
}

/** Non-`_`-prefixed subdirectories of api/ — each would be a routable page this guard cannot see. */
export function findApiPageDirs(apiDir) {
  return readdirSync(apiDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
    .map((e) => e.name)
}

export function readSpecSources(testsDir) {
  return readSpecs(testsDir).map((s) => s.source)
}

// ── Repo wiring ──────────────────────────────────────────────────────────────

/** Every problem in the real repo — shared by the CLI and the test, so they can't diverge. */
export async function auditRepo(repoRoot) {
  const { EDGE_BYPASS_STATE } = await import(pathToFileURL(join(repoRoot, 'playwright/edge-bypass-setup.js')))
  const config = (await import(pathToFileURL(join(repoRoot, 'playwright.config.js')))).default
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  const specs = readSpecs(join(repoRoot, 'tests'))
  const problems = []

  const edge = findEdgeProjects(config.projects, EDGE_BYPASS_STATE)
  // Fail closed: if the classifier stops recognizing ANY Edge project (EDGE_USE refactored away),
  // both wiring checks would silently return [] — green, guarding nothing.
  if (!edge.length) {
    problems.push('no project carries the EDGE_BYPASS_STATE storageState — the Edge-project classifier is broken, so the wiring checks below are blind.')
  }
  // Only specs an EDGE project runs can cover an Edge page. A `desktop`-project spec asserting
  // `a[href="/badges"]` mentions the path but executes against Vite :5173, where Edge paths 404 —
  // counting it would report /badges covered while nothing loads it. Not hypothetical: Sidebar.jsx
  // links /methodology, /badges and /plugin, so a future desktop nav spec would otherwise disarm
  // this guard for exactly the three pages #1051 was about.
  const edgeSpecs = specs.filter((s) => edge.some((p) => p.testMatch?.test(s.file)))
  for (const stem of findEdgeE2eGaps(readPageStems(join(repoRoot, 'api')), edgeSpecs.map((s) => s.source))) {
    problems.push(`api/${stem}.ts serves ${pagePathToken(stem)} — no Edge-project spec navigates there.`)
  }
  for (const name of findUnwiredEdgeProjects(config.projects, EDGE_BYPASS_STATE, pkg.scripts?.['test:edge'])) {
    problems.push(`project '${name}' is an Edge project but package.json test:edge lacks --project=${name} — nothing runs it.`)
  }
  for (const leak of findDesktopLeaks(config.projects, EDGE_BYPASS_STATE, specs.map((s) => s.file))) {
    problems.push(`${leak} — the desktop project's testIgnore misses this Edge spec, so desktop would run it against Vite :5173, where Edge paths 404.`)
  }
  for (const dir of findApiPageDirs(join(repoRoot, 'api'))) {
    problems.push(`api/${dir}/ is a non-'_'-prefixed directory — it may route as a page this guard cannot enumerate. Prefix it '_' (helper) or make it a flat api/*.ts.`)
  }
  return problems
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = await auditRepo(join(dirname(fileURLToPath(import.meta.url)), '..'))
  if (problems.length) {
    console.error('✘ Edge e2e coverage/wiring problems:\n')
    for (const p of problems) console.error(`  - ${p}`)
    console.error(
      '\nAn Edge page needs THREE things in sync (test:edge is the one #1051 actually missed):\n' +
        '  1. a spec that navigates to it — add it to the PAGES table in tests/edge-pages.spec.js\n' +
        '  2. a project in playwright.config.js + that spec in the `desktop` project testIgnore\n' +
        '  3. `--project=<name>` in package.json test:edge\n' +
        "If it isn't a page, add it to NON_PAGE_ENDPOINTS in this file WITH a reason.",
    )
    process.exit(1)
  }
  console.log('✔ Every Edge SSR page is reached by an e2e spec, and every Edge project is wired to run.')
}
