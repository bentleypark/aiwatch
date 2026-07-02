// #862 — regression guard for the Vercel Hobby-plan 12-Serverless-Function limit.
// Run with `npm run test:scripts` (= `node --test scripts/*.test.mjs`), which CI runs in test.yml.
// Pins BOTH the pure counting rule (fixtures) AND the real `api/` tree (must stay ≤ 12).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HOBBY_LIMIT,
  isUnderscoreExcluded,
  declaresEdgeRuntime,
  countedServerlessFunctions,
  countRealApiFunctions,
} from './check-vercel-function-count.mjs'

test('isUnderscoreExcluded — any `_`-prefixed segment excludes the file', () => {
  assert.equal(isUnderscoreExcluded('_shared/csp-nonce.ts'), true)
  assert.equal(isUnderscoreExcluded('__tests__/is-down.test.ts'), true)
  assert.equal(isUnderscoreExcluded('_is-down/html-template.ts'), true)
  assert.equal(isUnderscoreExcluded('_is-down/__tests__/ranking.test.ts'), true)
  assert.equal(isUnderscoreExcluded('is-down.ts'), false) // top-level handler, no underscore
  assert.equal(isUnderscoreExcluded('extension-privacy.test.ts'), false) // stray test, still counts
})

test('declaresEdgeRuntime — detects the edge config export', () => {
  assert.equal(declaresEdgeRuntime("export const config = { runtime: 'edge' }"), true)
  assert.equal(declaresEdgeRuntime('export const config = { runtime: "edge" }'), true)
  assert.equal(declaresEdgeRuntime('const x = 1 // no runtime here'), false)
})

test('countedServerlessFunctions — mirrors Vercel: edge + underscore excluded, rest counts', () => {
  const edge = "export const config = { runtime: 'edge' }"
  const helper = 'export function x() {}'
  const entries = [
    { path: 'is-down.ts', source: edge }, // edge handler → NOT counted
    { path: 'intro.ts', source: edge }, // edge handler → NOT counted
    { path: '_is-down/html-template.ts', source: helper }, // underscore dir → NOT counted
    { path: '_shared/csp-nonce.ts', source: helper }, // underscore dir → NOT counted
    { path: '__tests__/is-down.test.ts', source: helper }, // underscore dir → NOT counted
    { path: 'is-down/share-url.ts', source: helper }, // NON-underscore helper → COUNTS (the #862 bug shape)
    { path: 'extension-privacy.test.ts', source: helper }, // stray top-level test → COUNTS
    { path: 'types.d.ts', source: helper }, // .d.ts → ignored
  ]
  assert.deepEqual(countedServerlessFunctions(entries).sort(), [
    'extension-privacy.test.ts',
    'is-down/share-url.ts',
  ])
})

test('the #862 pre-fix layout (13) would be flagged; the post-fix layout (all `_`) is 0', () => {
  const helper = 'export function x() {}'
  const preFix = [
    'badges/html-template.ts',
    'extension-privacy.test.ts',
    'intro/announcements.ts',
    'intro/html-template.ts',
    'is-down/html-template.ts',
    'is-down/incident-grouping.ts',
    'is-down/incident-sort.ts',
    'is-down/ranking.ts',
    'is-down/region-status.ts',
    'is-down/seo-content.ts',
    'is-down/share-url.ts',
    'is-down/slug-map.ts',
    'methodology/html-template.ts',
  ].map((path) => ({ path, source: helper }))
  assert.equal(countedServerlessFunctions(preFix).length, 13)
  assert.ok(countedServerlessFunctions(preFix).length > HOBBY_LIMIT) // would fail the guard

  const postFix = preFix.map((e) => ({ ...e, path: e.path.replace(/^(is-down|intro|methodology|badges)\//, '_$1/') }))
    .map((e) => (e.path === 'extension-privacy.test.ts' ? { ...e, path: '__tests__/extension-privacy.test.ts' } : e))
  assert.equal(countedServerlessFunctions(postFix).length, 0)
})

// The real backstop: the actual `api/` tree must stay within the Hobby limit. This is what fails a PR
// that adds a non-underscore helper (the #862 recurrence) before it can merge + break the deploy.
test('REAL api/ tree stays within the Hobby 12-function limit', () => {
  const { count, files } = countRealApiFunctions()
  assert.ok(
    count <= HOBBY_LIMIT,
    `api/ has ${count} Vercel Serverless Functions (limit ${HOBBY_LIMIT}). Over-limit files:\n` +
      files.map((f) => `  • api/${f}`).join('\n') +
      `\nMove helpers into a \`_\`-prefixed dir, tests into __tests__/, or keep SSR handlers on runtime:'edge'.`,
  )
})
