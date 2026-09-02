import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  stripFencedBlocks, isCodeShaped, isMemoryPageName, isRemovalContext, REMOVAL_WINDOW_CHARS,
  extractInlineTokens, parseAllowlist, auditDocSymbols,
  docFiles, collectSourceBlob,
} from './check-doc-symbols.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// #1100 — the scan is small; the value is the false-positive control, so that is what these pin.

test('isCodeShaped: only camelCase or _-containing identifiers, ≥4 chars', () => {
  for (const t of ['violationsOf', 'isViolation', 'CACHE_NAME', 'fetch_all', 'parseFoo']) assert.ok(isCodeShaped(t), t)
  for (const t of ['services', 'path', 'true', 'API', 'foo', 'ok']) assert.ok(!isCodeShaped(t), t) // bare lowercase / ALLCAPS-no-_ / too short
})

test('stripFencedBlocks removes ``` and ~~~ blocks so their tokens are not read as claims', () => {
  const md = 'prose `realOne`\n```\nconst `fakeInBlock` = madeUpSymbol\n```\nmore `realTwo`'
  const stripped = stripFencedBlocks(md)
  assert.ok(!stripped.includes('madeUpSymbol'))
  assert.ok(stripped.includes('realOne') && stripped.includes('realTwo'))
})

test('isMemoryPageName recognises wiki page names (OKF-mirror refs), not code symbols', () => {
  for (const t of ['feedback_verify_claims', 'decision_x', 'initiative_growth', 'constraint_solo_capacity']) assert.ok(isMemoryPageName(t), t)
  assert.ok(!isMemoryPageName('estimate_uptime'), 'a non-type-prefixed snake symbol is NOT a page name')
})

test('isRemovalContext catches the "#713 removed X" shape in both languages', () => {
  assert.ok(isRemovalContext('#713 removed `estimateUptimeFromIncidents` entirely'))
  assert.ok(isRemovalContext('the `assumedUptime` fallback is now gone'))
  assert.ok(isRemovalContext('the old `fooBar` was renamed'))
  assert.ok(isRemovalContext('#713이 `estimateFoo`를 제거했다'))
  assert.ok(!isRemovalContext('`computeIncidentIoUptime` returns null on a chart-only page'), 'present-tense behaviour is NOT removal')
})

test('extractInlineTokens skips fenced blocks, removal lines, stoplist, and page names', () => {
  const md = [
    'A present-tense `realSymbol` claim.',              // extracted
    '#713 removed `goneSymbol` for good.',              // skipped: removal line
    'uses `JSON` and `Promise` heavily.',               // skipped: stoplist
    'see [[wiki]] page `feedback_something_here`.',      // skipped: page name
    'a bare `services` word.',                          // skipped: not code-shaped
    '```\n`blockSymbol`\n```',                          // skipped: fenced
  ].join('\n')
  const toks = extractInlineTokens(stripFencedBlocks(md))
  assert.deepEqual([...toks], ['realSymbol'])
})

test('parseAllowlist: token + reason; a reason-less entry is reported', () => {
  const { allow, noReason } = parseAllowlist('# header\nfoo  # because external\nbar\nbaz # ok')
  assert.equal(allow.get('foo'), 'because external')
  assert.deepEqual(noReason, ['bar'])
})

// ── the core contract, with mutation coverage ──

const DOCS = [{
  file: 'x.md',
  content: [
    'Cites `computeIncidentIoUptime` which exists.',    // present in blob → pass
    'Cites `violationsOf` which does NOT exist.',        // absent → FINDING
    'History: #713 removed `estimateUptimeFromIncidents`.', // removal ctx → skip
    'External `SessionStart` hook.',                     // allowlisted → skip
  ].join('\n'),
}]
const BLOB = 'export function computeIncidentIoUptime() {}' // only the real one exists
const ALLOW = new Map([['SessionStart', 'harness event']])

test('auditDocSymbols flags ONLY the invented symbol', () => {
  const findings = auditDocSymbols({ docs: DOCS, sourceBlob: BLOB, allow: ALLOW })
  assert.deepEqual(findings.map((f) => f.token), ['violationsOf'])
})

test('substring existence is grep-faithful — a truncation passes', () => {
  const docs = [{ file: 'y.md', content: 'The `incidentKeyword` token.' }]
  // source has the plural; a reader greps `incidentKeyword` and finds it.
  const findings = auditDocSymbols({ docs, sourceBlob: 'const incidentKeywords = []', allow: new Map() })
  assert.deepEqual(findings, [], 'a substring of a real symbol must not be a finding')
})

test('MUTATION: dropping the existence check flips the real symbol to a false finding', () => {
  // Emulate the mutation `if (sourceBlob.includes(tok)) continue` → removed: computeIncidentIoUptime
  // would then be reported despite existing. The real audit must NOT do that.
  const findings = auditDocSymbols({ docs: DOCS, sourceBlob: BLOB, allow: ALLOW })
  assert.ok(!findings.some((f) => f.token === 'computeIncidentIoUptime'),
    'a symbol present in source must never be flagged (guards the existence check)')
})

test('MUTATION: without removal-context skip, the removed symbol would be flagged', () => {
  // The removal-context skip is what keeps a correct "#713 removed X" line clean. Assert it holds:
  const findings = auditDocSymbols({ docs: DOCS, sourceBlob: BLOB, allow: ALLOW })
  assert.ok(!findings.some((f) => f.token === 'estimateUptimeFromIncidents'),
    'a symbol cited in a removal-context line must not be flagged')
})

// ── real-repo assertion: this is what makes CI fail on a NEW dangling symbol ──
// (mirrors check-edge-e2e-coverage.test.mjs calling its audit against the real tree; the unit tests
//  above pin the pure fns, but only THIS runs the actual docs, so a made-up symbol introduced later
//  fails `npm run test:scripts`.)
test('the real CLAUDE.md + docs/reference are clean (or allowlisted)', () => {
  const docs = docFiles(ROOT).map((f) => ({ file: f, content: readFileSync(join(ROOT, f), 'utf8') }))
  const sourceBlob = collectSourceBlob(ROOT)
  const allowPath = join(ROOT, 'docs/reference/doc-symbols-allow.txt')
  const { allow, noReason } = parseAllowlist(existsSync(allowPath) ? readFileSync(allowPath, 'utf8') : '')
  assert.deepEqual(noReason, [], 'every allowlist entry needs a `# reason`')
  const findings = auditDocSymbols({ docs, sourceBlob, allow })
  assert.deepEqual(
    findings.map((f) => `${f.file}: \`${f.token}\``), [],
    'a doc cites a symbol absent from source and not allowlisted — fix the name or allowlist it with a reason',
  )
})

// #1100 review — self-pollution guard. The lint scans scripts/ (its own files) and .github/, which
// once embedded the invented-symbol examples (`violationsOf`, …) as string literals — registering
// those very names as "exists" and blinding the lint to the #1076 case it exists to catch. This pins
// that the checker's own files are excluded from the blob, so its headline example is still caught.
test('the real source blob does NOT contain the checker\'s own example symbols', () => {
  const blob = collectSourceBlob(ROOT)
  for (const example of ['violationsOf', 'estimateFoo', 'madeUpSymbol', 'goneSymbol']) {
    assert.ok(!blob.includes(example), `\`${example}\` leaked into the source blob → lint would miss the #1076 case`)
  }
})

test('a doc re-introducing the #1076 headline example IS flagged against the real blob', () => {
  const docs = [{ file: 'z.md', content: 'This line justifies itself with `violationsOf`.' }]
  const findings = auditDocSymbols({ docs, sourceBlob: collectSourceBlob(ROOT), allow: new Map() })
  assert.deepEqual(findings.map((f) => f.token), ['violationsOf'])
})

// ── #1312: the window, and the dead stem it was hiding ───────────────────────

test('#1312: `delet` fires on its inflections — the trailing word-boundary made it match NOTHING', () => {
  for (const w of ['deleted', 'deleting', 'delete', 'deletion']) {
    assert.ok(isRemovalContext(`#713 ${w} the helper`), `stem does not match "${w}"`)
  }
})

test('#1312: `dropped`/`deprecated` are NOT removal contexts — reviving those stems is a new rule', () => {
  // Both were dead the same way as `delet` and stay dead: in these docs "dropped" is a runtime discard
  // and "deprecation" is a data value, not a note that a symbol is gone. Without these negatives the
  // suite is green while that coverage silently disappears.
  assert.ok(!isRemovalContext('an untagged incident is dropped before scoring'))
  assert.ok(!isRemovalContext('the poll is dropping under load'))
  assert.ok(!isRemovalContext('keywords: compliance/access-revocation-or-deprecation'))
})

test('#1312: the window governs a nearby verb and not a distant one', () => {
  const near = `#713 removed it. ${'x'.repeat(50)} \`fabricatedHelperName\``
  const far = `#713 removed it. ${'x'.repeat(REMOVAL_WINDOW_CHARS + 50)} \`fabricatedHelperName\``
  assert.ok(!extractInlineTokens(near).has('fabricatedHelperName'), 'a verb this close must exempt')
  assert.ok(extractInlineTokens(far).has('fabricatedHelperName'), 'a verb this far must not')
})

test('#1312: a pipe inside an inline code span does not blind the rest of the line', () => {
  // The splitter tried first cut at table pipes, including pipes INSIDE `` `string | null` ``. That left
  // two fragments with unbalanced backticks and every identifier after the cut stopped being extracted —
  // a coverage LOSS versus the line-scoped original, in real spans in this corpus.
  const line = 'the field is `string | null`, produced by `fabricatedHelperName`'
  assert.ok(extractInlineTokens(line).has('fabricatedHelperName'))
})

test('#1312: the canonical removal ROW stays exempt — verb and symbol in different cells', () => {
  // The other direction the splitter got wrong: cell-scoping severs `| \`oldFn\` | removed in #713 |`,
  // turning the most likely way a doc records a removal into a false positive.
  const row = '| `estimateUptimeFromIncidents` | removed in #713 | gone |'
  assert.equal(extractInlineTokens(row).size, 0)
})

test('#1312: one removal citation no longer immunises a whole 16k-character row', () => {
  const row = '| `growth:daily` | #713 removed `estimateUptimeFromIncidents` entirely |'
    + ` ${'filler. '.repeat(60)} it calls \`fabricatedHelperName\` daily |`
  const toks = extractInlineTokens(row)
  assert.ok(toks.has('fabricatedHelperName'), 'a citation far from the verb must still be checked')
  assert.ok(!toks.has('estimateUptimeFromIncidents'), 'the citation beside the verb stays exempt')
})

test('#1312 MUTATION: judging the whole line re-hides the fabricated symbol', () => {
  // Guards the fix itself: with a line-wide skip this row yields nothing, because the removal note far
  // to the left covers the fabricated name. That was the defect.
  const row = '| `growth:daily` | #713 removed `estimateUptimeFromIncidents` entirely |'
    + ` ${'filler. '.repeat(60)} it calls \`fabricatedHelperName\` daily |`
  const lineScoped = (prose) => {
    const out = new Set()
    for (const line of prose.split('\n')) {
      if (isRemovalContext(line)) continue
      for (const m of line.matchAll(/(?<!`)`([^`\n]+)`(?!`)/g)) {
        const head = m[1].trim().match(/^([A-Za-z_][A-Za-z0-9_]*)/)
        if (head && isCodeShaped(head[1])) out.add(head[1])
      }
    }
    return out
  }
  assert.equal(lineScoped(row).size, 0, 'the old scope saw nothing here — that was the defect')
  assert.ok(extractInlineTokens(row).has('fabricatedHelperName'), 'the shipped window sees it')
})

test('#1312 REAL DOCS: a fabricated symbol planted in the longest table row is caught', () => {
  // A pure-function test cannot prove the blind spot is closed in the corpus this gate actually reads.
  // Plant a name in kv-schema.md's real `growth:daily` cell — the 16.6k-character line — and require the
  // audit to flag it. This assertion fails on the pre-#1312 script.
  const file = join(ROOT, 'docs/reference/kv-schema.md')
  const raw = readFileSync(file, 'utf8')
  assert.ok(raw.includes('`readPluginPolls`'), 'anchor symbol missing — re-anchor this test, do not delete it')
  const mutated = raw.replace('`readPluginPolls`', '`readPluginPollsFabricated1312`')
  assert.notEqual(mutated, raw, 'mutation did not apply')
  const findings = auditDocSymbols({ docs: [{ file, content: mutated }], sourceBlob: 'nothing here', allow: new Map() })
  assert.ok(
    findings.some((f) => f.token === 'readPluginPollsFabricated1312'),
    'a fabricated symbol in the longest row went unflagged — the #1312 blind spot is back',
  )
})
