// #961 — regression guard for the CI gap where a docs-only PR started NO jobs.
//
// `test.yml` sets `paths-ignore` at the WORKFLOW level, so a PR touching only those paths runs
// none of its jobs — including the `unit` job that carries the OKF structural lint. The lint that
// guards `docs/reference/` was therefore skipped exactly when `docs/reference/` changed.
//
// `docs-lint.yml` closes that hole by firing on precisely the paths `test.yml` ignores. The two
// files must stay complementary: **every path `test.yml` ignores must be a path `docs-lint.yml`
// watches**, or a doc path silently becomes ungated again. That invariant is what this file pins.
//
// A regex parser rather than a YAML dependency: the two blocks have a fixed, trivial shape, and the
// parser itself is unit-tested against a synthetic fixture below.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const wf = (name) => readFileSync(join(repoRoot, '.github/workflows', name), 'utf8')

/**
 * Parse one YAML scalar — `'a'`, `"a"`, or bare `a` — stripping any trailing `# comment`.
 * A quoted scalar must consume the whole item (bar a comment): otherwise an escaped-quote form
 * like `- 'a''b.md'` would silently yield `a`. Throw instead — a wrong value here is invisible,
 * and this parser exists so the guard cannot silently stop guarding.
 */
function scalar(raw, context) {
  const quoted = raw.match(/^'([^']*)'/) ?? raw.match(/^"([^"]*)"/)
  if (quoted) {
    const rest = raw.slice(quoted[0].length).trim()
    if (rest !== '' && !rest.startsWith('#')) {
      throw new Error(`trailing text after quoted scalar in ${context}: ${JSON.stringify(raw)}`)
    }
    return quoted[1]
  }
  const bare = raw.match(/^([^\s#]+)/)
  if (bare) return bare[1]
  throw new Error(`unparseable YAML scalar in ${context}: ${JSON.stringify(raw)}`)
}

/**
 * Collect the entries of a `paths:` / `paths-ignore:` list nested under an `on:` trigger.
 * Returns [] when the trigger or the key is absent. Pure.
 *
 *   on:
 *     pull_request:        <- trigger
 *       paths-ignore:      <- key
 *         - 'docs/**'      <- collected (quote style irrelevant; trailing `# comment` stripped)
 *
 * THROWS on a list item it cannot destructure. That is deliberate: an earlier version matched only
 * single-quoted entries and `break`ed on anything else, so a single double-quoted path added to
 * `test.yml` would truncate the parsed list and the sync assertion below would go GREEN while the
 * new path was left ungated — the guard would silently stop guarding. Fail loud instead.
 */
export function pathsUnder(yaml, trigger, key) {
  const lines = yaml.split('\n')
  const triggerAt = lines.findIndex((l) => l.match(new RegExp(`^  ${trigger}:\\s*$`)))
  if (triggerAt === -1) return []

  const where = `${trigger}.${key}`
  const out = []
  let inKey = false

  for (const line of lines.slice(triggerAt + 1)) {
    if (/^\S/.test(line) || /^  \S/.test(line)) break // left the trigger block

    const keyLine = line.match(new RegExp(`^    ${key}:(.*)$`))
    if (keyLine) {
      const inline = keyLine[1].trim()
      if (inline === '') {
        inKey = true // block style — entries follow
        continue
      }
      const flow = inline.match(/^\[(.*)\]$/) // flow style — `paths: ['a', "b", c]`
      if (!flow) throw new Error(`unrecognised ${where} value: ${JSON.stringify(inline)}`)
      return flow[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => scalar(s, where))
    }

    if (!inKey) continue
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const item = line.match(/^\s+- (.*)$/)
    if (item) {
      out.push(scalar(item[1].trim(), where))
      continue
    }
    if (/^    \S/.test(line)) break // sibling key at the trigger's indent — list ended
    throw new Error(`unexpected line inside ${where}: ${JSON.stringify(line)}`)
  }
  return out
}

test('pathsUnder parses a nested paths list and strips trailing comments', () => {
  const fixture = [
    'on:',
    '  push:',
    '    branches: [main]',
    '    paths-ignore:',
    "      - 'a.md'",
    "      - 'docs/**'   # inline comment",
    '  pull_request:',
    '    paths:',
    "      - 'b.md'",
    'jobs:',
  ].join('\n')

  assert.deepEqual(pathsUnder(fixture, 'push', 'paths-ignore'), ['a.md', 'docs/**'])
  assert.deepEqual(pathsUnder(fixture, 'pull_request', 'paths'), ['b.md'])
  assert.deepEqual(pathsUnder(fixture, 'push', 'paths'), [], 'absent key → []')
  assert.deepEqual(pathsUnder(fixture, 'schedule', 'paths'), [], 'absent trigger → []')
})

test('pathsUnder does not leak entries across sibling triggers', () => {
  const fixture = ['on:', '  push:', '    paths:', "      - 'x.md'", '  pull_request:', '    paths:', "      - 'y.md'"].join('\n')
  assert.deepEqual(pathsUnder(fixture, 'push', 'paths'), ['x.md'])
})

test('pathsUnder accepts every quote style, blank lines and comment lines', () => {
  const fixture = [
    'on:',
    '  push:',
    '    paths-ignore:',
    "      - 'single.md'",
    '      - "double.md"',
    '      - bare.md',
    '',
    '      # a standalone comment',
    "      - 'docs/**'",
    'jobs:',
  ].join('\n')
  assert.deepEqual(pathsUnder(fixture, 'push', 'paths-ignore'), ['single.md', 'double.md', 'bare.md', 'docs/**'])
})

test('pathsUnder reads flow-style lists', () => {
  const fixture = ['on:', '  push:', "    paths-ignore: ['a.md', \"b.md\", c.md]", 'jobs:'].join('\n')
  assert.deepEqual(pathsUnder(fixture, 'push', 'paths-ignore'), ['a.md', 'b.md', 'c.md'])
})

// The regression this parser exists to prevent: a MIXED-quote edit must never truncate the list.
// The old single-quote-only matcher `break`ed on `- "assets/**"`, so `ignored` lost every entry
// after it and the sync assertion passed while `assets/**` ran no CI at all.
test('a double-quoted entry does not truncate the list (guard cannot silently stop guarding)', () => {
  const fixture = [
    'on:',
    '  pull_request:',
    '    paths-ignore:',
    "      - '*.md'",
    '      - "assets/**"',
    "      - 'docs/**'",
    'jobs:',
  ].join('\n')
  assert.deepEqual(pathsUnder(fixture, 'pull_request', 'paths-ignore'), ['*.md', 'assets/**', 'docs/**'])
})

test('pathsUnder throws on a list item it cannot destructure, rather than dropping it', () => {
  const fixture = ['on:', '  push:', '    paths-ignore:', "      - 'ok.md'", '      - # nothing here', 'jobs:'].join('\n')
  assert.throws(() => pathsUnder(fixture, 'push', 'paths-ignore'), /unparseable YAML scalar/)
})

// The only case where the parser could return a WRONG value instead of throwing: YAML's escaped
// single-quote (`''`). Real YAML reads `'a''b.md'` as `a'b.md`; a naive match stops at the second
// quote and yields `a`. Silently wrong is the failure mode this whole file exists to prevent.
test('pathsUnder throws on an escaped-quote scalar rather than silently truncating it', () => {
  const fixture = ['on:', '  push:', '    paths-ignore:', "      - 'a''b.md'", 'jobs:'].join('\n')
  assert.throws(() => pathsUnder(fixture, 'push', 'paths-ignore'), /trailing text after quoted scalar/)
})

test('pathsUnder still accepts a legitimate trailing comment after a quoted scalar', () => {
  const fixture = ['on:', '  push:', '    paths:', "      - 'docs/**'    # the bundle", 'jobs:'].join('\n')
  assert.deepEqual(pathsUnder(fixture, 'push', 'paths'), ['docs/**'])
})

for (const trigger of ['push', 'pull_request']) {
  test(`every path test.yml ignores on ${trigger} is watched by docs-lint.yml (#961)`, () => {
    const ignored = pathsUnder(wf('test.yml'), trigger, 'paths-ignore')
    const watched = pathsUnder(wf('docs-lint.yml'), trigger, 'paths')

    assert.ok(ignored.length > 0, `test.yml must still declare paths-ignore on ${trigger}`)

    const ungated = ignored.filter((p) => !watched.includes(p))
    assert.deepEqual(
      ungated,
      [],
      `these paths run NO CI: test.yml ignores them and docs-lint.yml does not watch them → ${ungated.join(', ')}`,
    )
  })
}

test('docs-lint.yml guards its own inputs — the lint script and itself', () => {
  const watched = pathsUnder(wf('docs-lint.yml'), 'pull_request', 'paths')
  assert.ok(watched.includes('scripts/lint-okf-bundle.mjs'), 'a change to the lint must re-run the lint')
  assert.ok(watched.includes('.github/workflows/docs-lint.yml'), 'a change to the guard must re-run the guard')
})
