// #891 Phase 4 — structural lint for the docs/reference OKF bundle.
// Run with `npm run test:scripts` (= `node --test scripts/*.test.mjs`), which CI runs in test.yml.
// Pins BOTH the pure check functions (fixtures) AND the real docs/reference bundle (must stay clean).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  OKF_TYPES,
  parseFrontmatter,
  stripInlineComment,
  hasUnquotedHashTruncation,
  frontmatterFindings,
  extractLocalMdLinks,
  linkResolutionFindings,
  indexDriftFindings,
  lintBundle,
  lintRealBundle,
} from './lint-okf-bundle.mjs'

const kinds = (findings) => findings.map((f) => f.kind).sort()

// ── frontmatter parsing + the YAML `#` gotcha ────────────────────────────────

test('stripInlineComment — plain scalar truncates at ` #`, quoted is verbatim', () => {
  assert.equal(stripInlineComment('KV Key Schema'), 'KV Key Schema')
  assert.equal(stripInlineComment('closes/refs #N'), 'closes/refs') // ` #` starts a comment
  assert.equal(stripInlineComment('#891 phase 4 lint'), '') // LEADING # → whole value is a comment → null
  assert.equal(stripInlineComment('CSP (#482)'), 'CSP (#482)') // `(#` — no leading space, safe
  assert.equal(stripInlineComment('"Tier-A verify-after (#873)"'), 'Tier-A verify-after (#873)') // quoted → verbatim
  assert.equal(stripInlineComment("'refs #N ok'"), 'refs #N ok')
})

test('hasUnquotedHashTruncation — flags unquoted leading-# AND whitespace-# values', () => {
  assert.equal(hasUnquotedHashTruncation('closes/refs #N'), true) // trailing ` #`
  assert.equal(hasUnquotedHashTruncation('#891 phase 4'), true) // LEADING # (the gotcha the tool exists for)
  assert.equal(hasUnquotedHashTruncation('CSP (#482)'), false) // `(#` — not ^# nor ` #`
  assert.equal(hasUnquotedHashTruncation('"#891 phase 4"'), false) // quoted → safe
  assert.equal(hasUnquotedHashTruncation('no hash here'), false)
})

test('parseFrontmatter — splits fields, exposes raw vs comment-stripped', () => {
  const src = ['---', 'type: reference', 'title: "KV Key Schema"', 'description: cache #dropped', '---', '', '# body'].join('\n')
  const { hasFrontmatter, fields, rawFields } = parseFrontmatter(src)
  assert.equal(hasFrontmatter, true)
  assert.equal(fields.type, 'reference')
  assert.equal(fields.title, 'KV Key Schema')
  assert.equal(fields.description, 'cache') // ` #dropped` stripped as a comment
  assert.equal(rawFields.description, 'cache #dropped') // raw retained
})

test('parseFrontmatter — no frontmatter block', () => {
  assert.equal(parseFrontmatter('# just a heading\n').hasFrontmatter, false)
})

test('parseFrontmatter — CRLF line endings parse consistently (all fields, no false missing)', () => {
  const src = ['---', 'type: reference', 'title: X', 'description: Y', '---', '', '# body'].join('\r\n')
  const { hasFrontmatter, fields } = parseFrontmatter(src)
  assert.equal(hasFrontmatter, true)
  assert.deepEqual(fields, { type: 'reference', title: 'X', description: 'Y' })
})

// ── frontmatterFindings ──────────────────────────────────────────────────────

test('frontmatterFindings — a well-formed page has no findings', () => {
  const src = ['---', 'type: reference', 'title: "KV Key Schema"', 'description: "keys, TTL, budget"', 'tags: [worker, kv]', '---'].join('\n')
  assert.deepEqual(frontmatterFindings('kv-schema.md', src), [])
})

test('frontmatterFindings — missing frontmatter is a single finding', () => {
  assert.deepEqual(kinds(frontmatterFindings('x.md', '# no frontmatter')), ['no-frontmatter'])
})

test('frontmatterFindings — missing required fields', () => {
  const src = ['---', 'type: reference', '---'].join('\n')
  assert.deepEqual(kinds(frontmatterFindings('x.md', src)), ['missing-field', 'missing-field']) // title + description
})

test('frontmatterFindings — unknown type is flagged', () => {
  const src = ['---', 'type: howto', 'title: X', 'description: Y', '---'].join('\n')
  assert.deepEqual(kinds(frontmatterFindings('x.md', src)), ['bad-type'])
  assert.ok(!OKF_TYPES.includes('howto'))
})

test('frontmatterFindings — unquoted `#` truncation in description is flagged', () => {
  const src = ['---', 'type: reference', 'title: X', 'description: put closes/refs #N in body', '---'].join('\n')
  const f = frontmatterFindings('x.md', src)
  assert.deepEqual(kinds(f), ['unquoted-hash'])
  assert.match(f[0].message, /wrap the value in quotes/)
})

test('frontmatterFindings — `(#N)` without a leading space is NOT flagged', () => {
  const src = ['---', 'type: reference', 'title: "CSP (#482)"', 'description: the CSP (#482) policy', '---'].join('\n')
  assert.deepEqual(frontmatterFindings('reference-csp.md', src), [])
})

test('frontmatterFindings — a description LEADING with `#` (YAML→null) is flagged', () => {
  const src = ['---', 'type: reference', 'title: X', 'description: #891 the bundle lint', '---'].join('\n')
  const f = frontmatterFindings('x.md', src)
  // the actionable finding must be present; the comment-only value also reads as an empty required field
  assert.ok(kinds(f).includes('unquoted-hash'), `expected unquoted-hash, got ${kinds(f)}`)
})

// ── link extraction + resolution ─────────────────────────────────────────────

test('extractLocalMdLinks — same-dir .md only, anchors stripped, URLs/paths ignored', () => {
  const src = [
    'see [KV](kv-schema.md) and [flow](data-flow.md#cron)',
    'external [okf](https://example.com/x.md) and [up](../CLAUDE.md) ignored',
  ].join('\n')
  assert.deepEqual(extractLocalMdLinks(src).sort(), ['data-flow.md', 'kv-schema.md'])
})

test('extractLocalMdLinks — `./foo.md` normalizes to the same-dir file (not dropped as pathed)', () => {
  assert.deepEqual(extractLocalMdLinks('see [k](./kv-schema.md)'), ['kv-schema.md'])
})

test('linkResolutionFindings — dangling same-dir link is flagged, resolved is not', () => {
  const names = new Set(['a.md', 'kv-schema.md'])
  assert.deepEqual(linkResolutionFindings('a.md', 'link [k](kv-schema.md)', names), [])
  const f = linkResolutionFindings('a.md', 'link [gone](removed-doc.md)', names)
  assert.deepEqual(kinds(f), ['broken-link'])
})

// ── index drift ──────────────────────────────────────────────────────────────

test('indexDriftFindings — clean bundle: all pages indexed, all links resolve', () => {
  const index = { name: 'index.md', source: '- [A](a.md)\n- [B](b.md)\n- [log](log.md)' }
  const entries = [index, { name: 'a.md', source: '' }, { name: 'b.md', source: '' }, { name: 'log.md', source: '' }]
  assert.deepEqual(indexDriftFindings(entries), [])
})

test('indexDriftFindings — a page absent from index.md is `not-indexed`', () => {
  const index = { name: 'index.md', source: '- [A](a.md)' }
  const entries = [index, { name: 'a.md', source: '' }, { name: 'b.md', source: '' }]
  const f = indexDriftFindings(entries)
  assert.deepEqual(kinds(f), ['not-indexed'])
  assert.equal(f[0].file, 'b.md')
})

test('indexDriftFindings — an index link with no file is `index-broken-link`', () => {
  const index = { name: 'index.md', source: '- [A](a.md)\n- [ghost](ghost.md)' }
  const entries = [index, { name: 'a.md', source: '' }]
  assert.deepEqual(kinds(indexDriftFindings(entries)), ['index-broken-link'])
})

test('indexDriftFindings — a bundle with no index.md is flagged', () => {
  assert.deepEqual(kinds(indexDriftFindings([{ name: 'a.md', source: '' }])), ['missing-index'])
})

// ── lintBundle composition ───────────────────────────────────────────────────

test('lintBundle — composes frontmatter + link + index findings', () => {
  const entries = [
    { name: 'index.md', source: '---\ntype: index\ntitle: I\ndescription: D\n---\n- [A](a.md)' },
    { name: 'a.md', source: '---\ntype: reference\ntitle: A\ndescription: D\n---\nlink [x](gone.md)' },
    { name: 'b.md', source: '# no frontmatter, not indexed' },
  ]
  const k = kinds(lintBundle(entries))
  assert.ok(k.includes('broken-link')) // a.md → gone.md
  assert.ok(k.includes('no-frontmatter')) // b.md
  assert.ok(k.includes('not-indexed')) // b.md absent from index
})

// ── the real backstop: docs/reference must stay clean ────────────────────────

test('REAL docs/reference bundle passes the OKF lint (0 findings)', () => {
  const { findings, count } = lintRealBundle()
  assert.equal(
    count,
    0,
    `docs/reference has ${count} OKF-lint finding(s):\n` + findings.map((f) => `  • [${f.kind}] ${f.file}: ${f.message}`).join('\n'),
  )
})
