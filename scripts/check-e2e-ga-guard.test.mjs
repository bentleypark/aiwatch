// #998 — unit tests for the e2e GA4 guard + the GA host matcher, plus the real-tests/ assertion
// that makes the guard a CI gate.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findGaGuardViolations, stripComments, stripNonCode, readSpecs, TESTS_DIR } from './check-e2e-ga-guard.mjs'
import { GA_HIT_RE } from '../tests/ga-hosts.js'

const spec = (source) => [{ file: 'x.spec.js', source }]

// --- GA_HIT_RE: fails OPEN if wrong, so pin both sides of the carve-out -----------------------

test('GA_HIT_RE matches every GA4 collect endpoint the CSP allows', () => {
  for (const url of [
    'https://www.google-analytics.com/g/collect?v=2&tid=G-D4ZWVHQ7JK',
    'https://region1.google-analytics.com/g/collect?v=2',
    'https://analytics.google.com/g/collect?v=2',
    'https://www.google-analytics.com/mp/collect',
  ]) {
    assert.ok(GA_HIT_RE.test(url), `must block ${url}`)
  }
})

test('GA_HIT_RE does NOT match gtag.js — consent.spec needs the loader to reach the browser', () => {
  assert.ok(!GA_HIT_RE.test('https://www.googletagmanager.com/gtag/js?id=G-D4ZWVHQ7JK'))
})

// --- import escape ----------------------------------------------------------------------------

test('flags a spec importing from @playwright/test — single or double quoted', () => {
  for (const source of [
    "import { test, expect } from '@playwright/test'\n",
    'import { test, expect } from "@playwright/test"\n',
    "import * as pw from '@playwright/test'\n",
  ]) {
    const v = findGaGuardViolations(spec(source))
    assert.equal(v.length, 1, `should flag: ${source.trim()}`)
    assert.match(v[0].reason, /@playwright\/test/)
  }
})

test('flags a dynamic import / require of @playwright/test too', () => {
  for (const source of [
    "const { test } = await import('@playwright/test')\n",
    "const { test } = require('@playwright/test')\n",
  ]) {
    assert.equal(findGaGuardViolations(spec(source)).length, 1, `should flag: ${source.trim()}`)
  }
})

test('flags a WRAPPED import of @playwright/test — the likeliest way the hole reopens', () => {
  // Ordinary ESM formatting for a growing import list. A line-anchored `import … from …` pattern
  // would sail straight past this.
  const source = ["import {", '  test,', '  expect,', "} from '@playwright/test'", ''].join('\n')
  const v = findGaGuardViolations(spec(source))
  assert.equal(v.length, 1)
  assert.match(v[0].reason, /@playwright\/test/)
})

test('accepts a spec importing from ./fixtures.js', () => {
  assert.deepEqual(findGaGuardViolations(spec("import { test, expect } from './fixtures.js'\n")), [])
})

test('a mention of @playwright/test in a comment is not a violation', () => {
  const source = "// historically imported from '@playwright/test'\nimport { test } from './fixtures.js'\n"
  assert.deepEqual(findGaGuardViolations(spec(source)), [])
})

// --- self-made context / page escape ----------------------------------------------------------

test('flags browser.newContext() and browser.newPage() without blockGaHits', () => {
  for (const call of ['browser.newContext()', 'browser.newPage()']) {
    const source = `import { test } from './fixtures.js'\nconst c = await ${call}\n`
    const v = findGaGuardViolations(spec(source))
    assert.equal(v.length, 1, `should flag: ${call}`)
    assert.match(v[0].reason, /bypasses the `context` fixture/)
  }
})

test('accepts browser.newContext() when blockGaHits is called on it', () => {
  const source =
    "import { test, blockGaHits } from './fixtures.js'\nconst ctx = await browser.newContext()\nawait blockGaHits(ctx)\n"
  assert.deepEqual(findGaGuardViolations(spec(source)), [])
})

test('pairs the calls — a SECOND unguarded newContext() in an already-guarded file is flagged', () => {
  const source = [
    "import { test, blockGaHits } from './fixtures.js'",
    'const a = await browser.newContext()',
    'await blockGaHits(a)',
    'const b = await browser.newContext()', // <- unguarded
    '',
  ].join('\n')
  const v = findGaGuardViolations(spec(source))
  assert.equal(v.length, 1)
  assert.match(v[0].reason, /2 browser\.newContext\(\)\/newPage\(\) call\(s\) but only 1/)
})

test('blockGaHits mentioned only in a comment does not satisfy the pairing', () => {
  const source =
    "import { test } from './fixtures.js'\n// remember to call blockGaHits(ctx)\nconst ctx = await browser.newContext()\n"
  assert.equal(findGaGuardViolations(spec(source)).length, 1)
})

test('does not flag ctx.newPage() on an already-blocked context, nor request.newContext()', () => {
  const source = [
    "import { test, blockGaHits } from './fixtures.js'",
    'const ctx = await browser.newContext()',
    'await blockGaHits(ctx)',
    'const page = await ctx.newPage()',
    'const api = await request.newContext()',
    '',
  ].join('\n')
  assert.deepEqual(findGaGuardViolations(spec(source)), [])
})

test('a blockGaHits() mention inside a STRING (e.g. a test title) does not satisfy the pairing', () => {
  const source = [
    "import { test } from './fixtures.js'",
    "test('own context is guarded with blockGaHits()', async ({ browser }) => {",
    '  const ctx = await browser.newContext()',
    '})',
    '',
  ].join('\n')
  const v = findGaGuardViolations(spec(source))
  assert.equal(v.length, 1, 'a test title must not count as a blockGaHits call')
})

test('a `//` inside a string does not eat the code after it', () => {
  // The `//` must not be read as a comment: doing so unbalances the quote and can swallow the
  // newContext() line that follows, making an unguarded spec invisible to the guard.
  const source = [
    "import { test } from './fixtures.js'",
    'const s = `a // b`',
    'const ctx = await browser.newContext()',
    'const t = `z`',
    '',
  ].join('\n')
  const v = findGaGuardViolations(spec(source))
  assert.equal(v.length, 1, 'the newContext() after a string containing // must still be seen')
})

test('a quote inside a regex literal cannot hide a newContext() from the guard', () => {
  // TOKEN_RE has no regex-literal alternative, so `/won't/` opens a phantom string in the
  // strings-emptied pass. Taking the max of both passes for the `own` count keeps that misparse
  // fail-CLOSED: the call still shows up in the strings-intact pass.
  const source = ["import { test } from './fixtures.js'", "if (/won't/.test(t)) { const ctx = await browser.newContext() }", ''].join('\n')
  const v = findGaGuardViolations(spec(source))
  assert.equal(v.length, 1, 'a newContext() next to a regex containing a quote must still be seen')
})

test('stripNonCode keeps code but empties string bodies; stripComments keeps specifiers', () => {
  const src = "import x from '@playwright/test' // note\nconst u = 'https://x.dev/a'\n"
  assert.match(stripComments(src), /'@playwright\/test'/)
  assert.doesNotMatch(stripComments(src), /note/)
  assert.doesNotMatch(stripNonCode(src), /x\.dev/)
  assert.match(stripNonCode(src), /const u = ''/)
})

// --- the gate itself --------------------------------------------------------------------------

// Fails CI if someone adds a spec that could send hits to the production GA4 property.
test('every spec Playwright runs is covered by the GA4 block', () => {
  const specs = readSpecs(TESTS_DIR)
  assert.ok(specs.length > 10, `expected the real tests/ dir, found ${specs.length} specs`)
  const violations = findGaGuardViolations(specs)
  assert.deepEqual(
    violations,
    [],
    `specs can reach GA4:\n${violations.map((v) => `  tests/${v.file} — ${v.reason}`).join('\n')}`,
  )
})
