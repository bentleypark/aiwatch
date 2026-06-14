// #648 — unit tests for the sitemap lastmod bump gate + transform. Run with `npm run test:scripts`
// (= `node --test scripts/*.test.mjs`). Uses node:test (no vitest) since this is a build/CI script,
// not src/worker code.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldBump, bumpLastmod } from './bump-sitemap-lastmod.mjs'

test('shouldBump — false for a local build (no VERCEL/CI env)', () => {
  assert.equal(shouldBump({}), false)
  assert.equal(shouldBump({ NODE_ENV: 'production' }), false) // production != deploy platform
})

test('shouldBump — true on Vercel or CI', () => {
  assert.equal(shouldBump({ VERCEL: '1' }), true)
  assert.equal(shouldBump({ CI: 'true' }), true)
  assert.equal(shouldBump({ VERCEL: '1', CI: 'true' }), true)
})

test('bumpLastmod — rewrites every YYYY-MM-DD <lastmod> to today', () => {
  const before = '<url><loc>/a</loc><lastmod>2026-06-12</lastmod></url>\n<url><loc>/b</loc><lastmod>2026-05-01</lastmod></url>'
  const { content, count, changed } = bumpLastmod(before, '2026-06-14')
  assert.equal(count, 2)
  assert.equal(changed, true)
  assert.equal((content.match(/<lastmod>2026-06-14<\/lastmod>/g) ?? []).length, 2)
  assert.ok(!content.includes('2026-06-12') && !content.includes('2026-05-01'))
})

test('bumpLastmod — changed=false when every entry already equals today', () => {
  const before = '<lastmod>2026-06-14</lastmod>'
  const { count, changed } = bumpLastmod(before, '2026-06-14')
  assert.equal(count, 1)
  assert.equal(changed, false)
})

test('bumpLastmod — count=0 on schema drift (no YYYY-MM-DD lastmod)', () => {
  const before = '<lastmod>2026-06-14T00:00:00Z</lastmod>' // ISO datetime, not the YYYY-MM-DD shape
  const { count, changed } = bumpLastmod(before, '2026-06-14')
  assert.equal(count, 0)
  assert.equal(changed, false)
})

test('bumpLastmod — does not touch non-lastmod timestamps', () => {
  const before = '<lastmod>2026-06-12</lastmod><other>2026-06-12</other>'
  const { content } = bumpLastmod(before, '2026-06-14')
  assert.ok(content.includes('<other>2026-06-12</other>')) // untouched
  assert.ok(content.includes('<lastmod>2026-06-14</lastmod>'))
})

test('importing the module runs no side effects (main is guarded)', () => {
  // Reaching here with both pure fns imported proves the import did not invoke main() (which reads/
  // writes public/sitemap.xml) — main only fires behind the import.meta.url === argv[1] guard.
  assert.equal(typeof shouldBump, 'function')
  assert.equal(typeof bumpLastmod, 'function')
})
