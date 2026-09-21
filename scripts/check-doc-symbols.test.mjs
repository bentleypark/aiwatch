import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  stripFencedBlocks, isCodeShaped, isMemoryPageName, isRemovalContext, REMOVAL_WINDOW_CHARS,
  extractInlineTokens, parseAllowlist, auditDocSymbols,
  docFiles, collectSourceBlob,
  parseServiceConfigs, fieldMembership, isSentenceEnd, isAbsenceContext,
  tsCommentText, auditMembership, membershipDocs, readServiceConfigs, readDeclaredFields, declaredConfigFields,
  MEMBERSHIP_ALLOW_FILE, membershipBindings, splitTsSource, auditTree,
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

// ── #1444: membership claims ─────────────────────────────────────────────────
// The symbol check asks whether a name EXISTS; these ask whether a stated MEMBERSHIP is true. The
// one-off audit written during #1434 failed its own positive control — its window truncated at the `.`
// in `e.g.`, the construct these enumerations are written with — and reported CLEAN with a known-bad
// claim injected. So every assertion below is a control, positive or negative.

const SERVICES = readServiceConfigs(ROOT)
const DECLARED = readDeclaredFields(ROOT)
const audit = (content, file = 'x.md') => auditMembership({ docs: [{ file, content }], services: SERVICES, declared: DECLARED })
  .map((f) => `${f.field}<-${f.id}`)

test('#1444: the parsed roster equals service-groups.ts — a degraded brace-match reddens here', () => {
  // GROUP_MEMBERS is an independent list of every service id, itself CI-pinned to the frontend by
  // service-groups-sync.test.ts. Comparing against it needs no hand-typed count.
  const groups = readFileSync(join(ROOT, 'worker/src/service-groups.ts'), 'utf8')
  const block = groups.slice(groups.indexOf('GROUP_MEMBERS'), groups.indexOf('const ID_TO_GROUP'))
  const roster = new Set([...block.matchAll(/'([a-z0-9]+)'/g)].map((m) => m[1]))
  assert.deepEqual(new Set(SERVICES.map((s) => s.id)), roster)
})

test('#1444: the two halves of splitTsSource stay line-aligned, literals included', () => {
  // The trailing-comment rule below reads `codeLines[i]` for comment line `i`, so the halves have to
  // number the same. A multi-line template literal used to add lines to `code` and none to `comments`,
  // after which every block boundary landed on the wrong line. Both scanned files hold today, but by
  // accident — neither contains such a literal.
  const lines = (s) => s.split('\n').length
  for (const f of ['worker/src/services.ts', 'worker/src/types.ts']) {
    const src = readFileSync(join(ROOT, f), 'utf8')
    const { code, comments } = splitTsSource(src)
    assert.equal(lines(code), lines(src), f)
    assert.equal(lines(comments), lines(src), f)
  }
  const withLiteral = 'const a = `l1\nl2\nl3`\n// note\nconst b = 1\n'
  const split = splitTsSource(withLiteral)
  assert.equal(lines(split.comments), lines(withLiteral), 'a multi-line literal desynchronised the halves')
  assert.equal(lines(split.code), lines(withLiteral))
})

test('#1444: a config line with a TRAILING comment ends the block, it does not fuse across it', () => {
  // 29 config lines in services.ts carry one. Joining across a config entry fuses a service's docblock,
  // its entry, and the NEXT service's docblock into one logical line, where a field name in one
  // service's comment governs an id run in another's — a claim present in no comment.
  const ts = [
    '  // The dynamic breakdown uses displayAllComponents.',
    "  { id: 'cohere', displayAllComponents: true },  // pairs with elevenlabs/replicate below",
    '  // unrelated prose',
  ].join('\n')
  assert.equal(tsCommentText(ts).split('\n').length, 3, 'blocks were fused across the config line')
  assert.deepEqual(audit(tsCommentText(ts), 'services.ts'), [])
})

test('#1444: a config example written in a COMMENT is not config', () => {
  // services.ts is both the claim corpus and the truth those claims are checked against, so a
  // `{ id: … }` example in a comment would silence a false claim about that service — fail-open, in the
  // one direction a guard must never fail. One scanner splits the file; the halves cannot disagree.
  const src = readFileSync(join(ROOT, 'worker/src/services.ts'), 'utf8')
  const example = "\n// Shape reference, not live config:\n"
    + "//   { id: 'kimi', name: 'K', statusUrl: 'x', componentDenylist: ['Website'] }\n"
  // Through readServiceConfigs, not parseServiceConfigs — the defect is the WIRING, and calling the
  // pure fn leaves reverting that wiring green.
  const root = mkdtempSync(join(tmpdir(), 'doc-membership-'))
  mkdirSync(join(root, 'worker/src'), { recursive: true })
  writeFileSync(join(root, 'worker/src/services.ts'), src + example)
  const withExample = readServiceConfigs(root)
  assert.equal(withExample.length, SERVICES.length, 'a commented-out entry was counted as a service')
  assert.ok(!withExample.find((s) => s.id === 'kimi').keys.has('componentDenylist'),
    'a field set only in a comment example entered the membership truth')
  rmSync(root, { recursive: true, force: true })
  // and the same scanner still hands that text to the CLAIM side
  assert.ok(tsCommentText(example).includes('Shape reference'))
})

test('#1444: the brace matcher is quote-aware — a brace inside a string value does not shift depth', () => {
  // Asserted by parseServiceConfigs\' docblock and exercised by nothing in the real config, so without
  // this the property is a claim. A `}` in a component name ends the entry early and drops every key
  // after it; a `{` swallows the next entry whole.
  // A LONE `}` — a balanced `} {` cancels out in the key scanner and discriminates nothing there.
  const src = "const S = [\n"
    + "  { id: 'aa', name: 'A }', statusUrl: 'x', displayAllComponents: true },\n"
    + "  { id: 'bb', name: 'B {', statusUrl: 'y', componentGroups: {} },\n]"
  const parsed = parseServiceConfigs(src)
  assert.deepEqual(parsed.map((s) => s.id), ['aa', 'bb'], 'a braced string ended an entry early')
  assert.ok(parsed[0].keys.has('displayAllComponents'), 'keys after the `}` string were dropped')
  assert.ok(parsed[1].keys.has('componentGroups'), 'keys after the `{` string were dropped')
})

test('#1444: membership is read off the config, not off a hand-kept list', () => {
  const members = fieldMembership(SERVICES)
  // The round-15 finding on #1434: four different spellings of this set across docs and comments, the
  // narrowest of them `cohere/groq`.
  assert.deepEqual([...members.get('displayAllComponents')].sort(), ['bfl', 'cerebras', 'cohere', 'fireworks', 'groq'])
  assert.ok(!members.has('id') && !members.has('name'), 'non-camelCase keys are prose, not citations')
  for (const s of SERVICES) assert.ok(s.keys.has('statusUrl'), `${s.id} parsed without statusUrl`)
})

// ── positive controls: real #1434 claims, verbatim from 1c48d0cd^ ──
// Re-derive one with `git show 1c48d0cd^:<file>` before editing it; a paraphrase certifies a capability
// the check may not have on the real construct — which is what round 1 of this PR shipped.

test('#1444 POSITIVE CONTROL: api-endpoints.md charged cerebras to statusComponentIds', () => {
  // cerebras runs `displayAllComponents`; it has never set `statusComponentIds`.
  const line = 'from `statusComponentIds` (#604: cerebras/runway/langsmith/copilot/windsurf), `displayComponentIds` (#606: elevenlabs/replicate/cursor)'
  assert.ok(audit(line).includes('statusComponentIds<-cerebras'))
})

test('#1444 POSITIVE CONTROL: the list binds to the field BEFORE it, not the nearest one', () => {
  // Same line: `cerebras/runway/…` sits 9 chars after `statusComponentIds` and 4 before
  // `displayComponentIds`. Binding to the nearest charges runway/copilot/windsurf — all real
  // statusComponentIds members — to displayComponentIds, three false positives from one list.
  const line = 'from `statusComponentIds` (#604: cerebras/runway/langsmith/copilot/windsurf), `displayComponentIds` (#606: kimi/cursor)'
  assert.deepEqual(audit(line), ['statusComponentIds<-cerebras'])
})

test('#1444 POSITIVE CONTROL: adding-a-service.md, the `e.g.` form inside a parenthetical', () => {
  // #1384 took replicate off `displayComponentIds`. The #1434 one-off audit truncated at the `.` of
  // `e.g.` and reported CLEAN on exactly this line.
  const line = '   - **Curated allowlist** → `displayComponentIds: [ids]` (a few stable surfaces; e.g. elevenlabs, replicate, assemblyai).'
  // elevenlabs joined replicate off this path in #1445, so today's config flags both.
  assert.deepEqual(audit(line), ['displayComponentIds<-elevenlabs', 'displayComponentIds<-replicate'])
})

test('#1444 NEGATIVE CONTROL: status-determination.md, a list a full sentence after its field', () => {
  // The claim is real and pre-#1445 it was wrong, but the list is a sentence away from the name it
  // enumerates. Binding across that gap charged most runs in this corpus to a field they do not
  // enumerate, each a TRUE sentence. Out of scope, by measurement.
  const line = '2. **`displayComponentIds` (#606)** — explicit curated allowlist of surface ids (display-only).'
    + ' Single-owner pages: elevenlabs, replicate, assemblyai, deepgram, characterai, junie, voyageai, pinecone.'
  assert.deepEqual(audit(line), [])
})

test('#1444 POSITIVE CONTROL: a claim wrapped across comment lines is still one claim', () => {
  // A line-scoped scan sees the name on one line and the list on the next, and reports nothing.
  const ts = [
    '  // The dynamic breakdown. `displayAllComponents`',
    '  // covers: cohere/groq/elevenlabs.',
    "  { id: 'zz', displayAllComponents: true },",
  ].join('\n')
  assert.deepEqual(audit(tsCommentText(ts), 'services.ts'), ['displayAllComponents<-elevenlabs'])
})

test('#1444 NEGATIVE CONTROL: a list the field merely passes near is not its enumeration', () => {
  // Round 5's finding, as the reproduction that produced it: drop `displayComponentIds` from codex and
  // this real services.ts comment becomes a false claim under a proximity-only binding, while the
  // sentence itself stays true. Asserted against a config where codex DOES set the field and one where
  // it does not, so the test cannot pass by accident of today's roster.
  const line = '// displayComponentIds (#606 Cat B): the official "ChatGPT" group. Display-only; disjoint from openai/codex.'
  assert.deepEqual(audit(line, 'services.ts'), [])
  const without = SERVICES.map((s) => (s.id === 'codex'
    ? { ...s, keys: new Set([...s.keys].filter((k) => k !== 'displayComponentIds')) } : s))
  assert.deepEqual(auditMembership({ docs: [{ file: 'services.ts', content: line }], services: without, declared: DECLARED }), [])
})

test('#1444: a sentence end between the name and the list ends the claim', () => {
  const same = '`displayAllComponents` covers: cohere/groq/elevenlabs'
  const across = '`displayAllComponents` is the dynamic path. Its users are cohere/groq/elevenlabs'
  assert.deepEqual(audit(same), ['displayAllComponents<-elevenlabs'])
  assert.deepEqual(audit(across), [])
})

// ── negative controls: every false positive measured while building this ──

test('#1444 NEGATIVE CONTROL: a single id in prose is not an enumeration', () => {
  // Reading one means parsing the sentence around it, and each attempt flagged a TRUE sentence:
  // `…give \`Website\` via componentDenylist and mistral gives \`le chat\` via incidentExclude` charged
  // mistral to componentDenylist, and the answer was to rewrite correct prose.
  assert.deepEqual(audit('cohere/groq/together/cerebras give `Website` via componentDenylist and mistral gives `le chat` via incidentExclude'), [])
  assert.deepEqual(audit('// e.g. replicate: the ids → \'Inference and Training\'.\ncomponentGroups?: x', 'types.ts'), [])
})

test('#1444 NEGATIVE CONTROL: a negation BEFORE the citation governs the list after it', () => {
  // kv-schema.md's real shape. The earlier fixture for this put the list past the reach, so the reach
  // declined it and the test stayed green with no absence guard at all.
  const line = 'for a service with **no** `statusComponentIds` at all (turbopuffer, fireworks today).'
  assert.deepEqual(audit(line), [])
  assert.equal(audit(line.replace('**no** ', '')).length, 2, 'without the negation it IS the claim')
})

test('#1444 NEGATIVE CONTROL: a negation before a CHAIN of citations governs all of them', () => {
  // discord-alert-paths.md's real shape: the negation precedes the FIRST citation, and the list binds
  // to the LAST, so a lead window measured from the governing citation alone cannot see it.
  const line = 'A service with no `statusComponentId`/`statusComponentIds`/`displayComponentIds`'
    + ' (turbopuffer, fireworks) has `uptimeScope` fall back to `config.incidentIoComponentId`.'
  assert.deepEqual(audit(line), [])
  assert.equal(audit(line.replace('with no ', 'with ')).length, 2, 'without the negation it IS the claim')
})

test('#1444 NEGATIVE CONTROL: the lead stops at a sentence end, like the introducer does', () => {
  const line = '`componentGroupsInline` is not set anywhere. `displayAllComponents` covers cohere/elevenlabs'
  assert.deepEqual(audit(line), ['displayAllComponents<-elevenlabs'], 'a negation in the PREVIOUS sentence must not reach forward')
})

test('#1444 NEGATIVE CONTROL: a negation AFTER the list governs it too', () => {
  const line = 'Positioned AFTER the `statusComponentIds` branch (BFL keeps its curated worst-of).'
    + ' cohere/groq/together/fireworks have no statusComponent* so they returned at branch 1 already.'
  assert.deepEqual(audit(line), [])
})

test('#1444 NEGATIVE CONTROL: a sentence break alone ends the binding, with no negation present', () => {
  // kv-schema.md's real shape. Nothing here denies membership — the list simply belongs to the next
  // sentence — so the binding, not the absence guard, has to be what declines it.
  const across = 'see the `holdShortIncidents` row below). Tier-1 (`claude`/`openai`/`gemini`) stay alertable.'
  assert.deepEqual(audit(across), [])
  assert.equal(audit(across.replace('row below).', 'row below,')).length, 3, 'without the break it IS the claim')
})

test('#1444: a list written with backticks or bold is the same list', () => {
  // `` `a`/`b` `` is the corpus's usual spelling; dropping the decoration tolerance loses it silently.
  for (const run of ['cohere/groq/elevenlabs', '`cohere`/`groq`/`elevenlabs`', '**cohere**, **groq**, **elevenlabs**']) {
    assert.deepEqual(audit(`\`displayAllComponents\` covers ${run}`), ['displayAllComponents<-elevenlabs'], run)
  }
})

test('#1444 NEGATIVE CONTROL: an introducer longer than the reach is a different clause', () => {
  // Straddles RUN_MAX_GAP by one character either side, so widening the reach reddens as loudly as
  // narrowing it. Literals, not `RUN_MAX_GAP ± 1`: a fixture derived from the constant moves with it
  // and pins nothing.
  const at = (n) => `\`displayAllComponents\` ${'x'.repeat(n)} cohere/groq/elevenlabs`
  assert.equal(audit(at(37)).length, 1, 'a 40-character introducer is within the reach')
  assert.deepEqual(audit(at(38)), [], 'a 41-character one is not')
})

// ── mutation coverage: each guard, removed, must resurface a measured artifact ──

test('#1444: `/** … */` blocks are part of the scanned corpus, not only `//` lines', () => {
  // 25 of them in types.ts and 52 in services.ts. The real-tree assertion asserts EMPTINESS, so losing
  // this branch removes corpus without reddening anything there.
  const ts = ['/**', ' * `displayAllComponents` covers: cohere/groq/elevenlabs.', ' */', 'const x = 1'].join('\n')
  assert.deepEqual(audit(tsCommentText(ts), 'types.ts'), ['displayAllComponents<-elevenlabs'])
  assert.ok(tsCommentText(readFileSync(join(ROOT, 'worker/src/types.ts'), 'utf8')).includes('per-component breakdown'),
    'a real `/** … */` docblock is missing from the extracted prose')
})

test('#1444 MUTATION: a naive `//` comment scan turns every https:// config line into prose', () => {
  const ts = "  { id: 'zz', statusUrl: 'https://status.zz.io', incidentKeywords: ['claude'] },"
  assert.equal(tsCommentText(ts), '', 'a URL is not a comment')
  assert.ok((ts.match(/\/\/[^\n]*/g) || []).join('').includes('incidentKeywords'), 'the naive scan swallows it')
})

test('#1444 MUTATION: isSentenceEnd must read the NEXT character, not a regex that always matches', () => {
  // `/\s|$/.test(ch)` is true for EVERY single character, because `$` matches at the end of it. That
  // bug ends a sentence at the first `.`, `incident.io` and `2026-09-01` included.
  assert.ok(!isSentenceEnd('incident.io page', 'incident'.length), 'a dot inside a token is not a sentence end')
  assert.ok(isSentenceEnd('gone. Next', 4))
  assert.ok(!isSentenceEnd('surfaces, e.g. elevenlabs', 'surfaces, e.g'.length), 'e.g. is not a sentence end')
})

test('#1444: a negation in the INTRODUCER denies the claim; one anywhere else does not', () => {
  // The scope is the whole point. Judging the surrounding sentences instead silences six of the eight
  // enumerations this check can see, each over a negation about something else — measured by injecting
  // a non-member into every one of the eight: 2 of 8 caught that way, 8 of 8 this way.
  for (const intro of ['is not set on', 'never covers', 'lists no service but']) {
    assert.deepEqual(audit(`\`displayAllComponents\` ${intro} cohere/elevenlabs`), [], intro)
  }
  assert.deepEqual(audit('`displayAllComponents` covers cohere/elevenlabs'), ['displayAllComponents<-elevenlabs'])
  assert.deepEqual(audit('`displayAllComponents` covers cohere/elevenlabs. It is not on replicate'),
    ['displayAllComponents<-elevenlabs'], 'a negation in the NEXT sentence must not reach back')
  assert.deepEqual(audit('`componentDenylist` is served no-store for cohere/elevenlabs'),
    ['componentDenylist<-elevenlabs'], '`no-store` is not the word "no"')
})

test('#1444: fenced blocks ARE scanned for membership, unlike for the symbol lint', () => {
  // directory-map.md's entire body is one fence, and it is where the per-module annotations live, so
  // stripping it (as #1100 does, for code examples) drops that prose out of the scanned corpus.
  const map = membershipDocs(ROOT).find((d) => d.file === 'docs/reference/directory-map.md')
  assert.ok(/^[ \t]*```/m.test(map.content), 'the fence was stripped — the annotations went with it')
  assert.ok(map.content.includes('flapSuppression'), 'the enumerations inside it are not in the corpus')
})

test('#1444: a field NO service sets is still checkable — its member set is empty, not absent', () => {
  // Derived from the interface, not from observed keys. Otherwise deleting a field's last setter makes
  // every claim about it MORE wrong and the gate GREENER, and 17 fields have exactly one setter today.
  const declared = declaredConfigFields(readFileSync(join(ROOT, 'worker/src/types.ts'), 'utf8'))
  assert.ok(declared.includes('componentGroupsInline'))
  const members = fieldMembership(SERVICES, declared)
  assert.deepEqual([...members.get('componentGroupsInline')], [], 'zero setters is a member set, not a gap')
  assert.deepEqual(audit('`componentGroupsInline` is set on cohere/groq'),
    ['componentGroupsInline<-cohere', 'componentGroupsInline<-groq'])
  // and the inversion itself: wiping a field from every service must never REMOVE a finding
  const claim = [{ file: 'k.md', content: '`componentGroups` folds models for kimi/cohere' }]
  const before = auditMembership({ docs: claim, services: SERVICES, declared })
  const wiped = SERVICES.map((s) => ({ ...s, keys: new Set([...s.keys].filter((k) => k !== 'componentGroups')) }))
  assert.ok(auditMembership({ docs: claim, services: wiped, declared }).length >= before.length,
    'deleting the last setter made the gate greener')
})

// ── real-tree assertion: this is what fails CI on a new wrong membership ──

test('#1444: `file:field:id` allowlist, so a true sentence is never the thing that has to change', () => {
  const line = '`displayAllComponents` covers cohere/elevenlabs'
  const at = (file, allow) => auditMembership({
    docs: [{ file, content: line }], services: SERVICES, declared: DECLARED, allow: new Map(allow),
  }).length
  assert.deepEqual(audit(line), ['displayAllComponents<-elevenlabs'])
  assert.equal(at('a.md', [['a.md:displayAllComponents:elevenlabs', 'true sentence, not an enumeration']]), 0)
  // #1444's evidence is the SAME wrong pair repeated across files, so an entry must not blanket them:
  assert.equal(at('b.md', [['a.md:displayAllComponents:elevenlabs', 'written for a.md']]), 1,
    'an entry for one file silenced the same claim in another')
  for (const key of ['a.md:displayComponentIds:elevenlabs', 'a.md:displayAllComponents:replicate']) {
    assert.equal(at('a.md', [[key, 'wrong pair']]), 1, `${key} must not silence a different pair`)
  }
})

test('#1444 RATCHET: the number of enumerations this gate actually checks', () => {
  // The real-tree assertion below asserts EMPTINESS, so it cannot tell "clean" from "nothing bound":
  // a copy edit that lengthens an introducer past the reach deletes a site from coverage in silence.
  // Only one site carries an anchor of its own, so this count is what makes such a drop visible.
  // If it moved, find out WHICH site and why before touching the number.
  const bound = membershipBindings({ docs: membershipDocs(ROOT), services: SERVICES, declared: DECLARED })
  assert.equal(bound.length, 8, `coverage moved:\n${bound.map((b) => `  ${b.file}: ${b.field} <- ${b.run}`).join('\n')}`)
  // and the number the CLI shows an operator has to BE that number, not a proxy that never moves
  const out = execFileSync('node', [join(ROOT, 'scripts/check-doc-symbols.mjs')], { cwd: ROOT, encoding: 'utf8' })
  assert.match(out, new RegExp(`doc-membership lint: ${bound.length} enumeration`))
})

test('#1444: the shipped allowlist is empty and every entry would need a reason', () => {
  const { allow, noReason } = parseAllowlist(readFileSync(join(ROOT, MEMBERSHIP_ALLOW_FILE), 'utf8'))
  assert.equal(allow.size, 0, 'the tree starts with no entries — #1444 exit condition')
  assert.deepEqual(noReason, [])
  assert.deepEqual(parseAllowlist('displayAllComponents:elevenlabs').noReason, ['displayAllComponents:elevenlabs'],
    'a reason-less entry is itself a failure')
})

test('#1444 WIRING: the CLI passes `declared` and `allow`, neither of which moves a count', () => {
  // `docs` and `services` are pinned by the ratchet, because cutting them moves the bound count. These
  // two do not, so cutting either left all 50 tests green: the escape hatch stopped working, and a
  // zero-setter field stopped being checked, in silence. Only behaviour at a real root catches it.
  const root = mkdtempSync(join(tmpdir(), 'audit-tree-'))
  const write = (rel, body) => {
    mkdirSync(join(root, dirname(rel)), { recursive: true })
    writeFileSync(join(root, rel), body)
  }
  write('worker/src/services.ts', 'export const SERVICES = [\n'
    + "  { id: 'cohere', name: 'C', statusUrl: 'x', displayAllComponents: true },\n"
    + "  { id: 'groq', name: 'G', statusUrl: 'y', displayAllComponents: true },\n]\n")
  write('worker/src/types.ts', 'export interface ServiceConfig {\n  displayAllComponents?: boolean\n  componentGroupsInline?: boolean\n}\n')
  // a zero-setter field with a list after it: only `declared` makes this checkable at all
  write('CLAUDE.md', 'The `componentGroupsInline` layout is set on cohere/groq today.\n')
  write('docs/reference/keep.md', '# keep\n')
  write(MEMBERSHIP_ALLOW_FILE, '')
  assert.deepEqual(auditTree(root).membership.map((f) => `${f.field}<-${f.id}`),
    ['componentGroupsInline<-cohere', 'componentGroupsInline<-groq'], '`declared` is not wired in')

  write(MEMBERSHIP_ALLOW_FILE, 'CLAUDE.md:componentGroupsInline:cohere  # true sentence\nCLAUDE.md:componentGroupsInline:groq  # ditto\n')
  assert.deepEqual(auditTree(root).membership, [], '`allow` is not wired in')
  write(MEMBERSHIP_ALLOW_FILE, 'CLAUDE.md:componentGroupsInline:cohere\n')
  assert.deepEqual(auditTree(root).noReason, ['CLAUDE.md:componentGroupsInline:cohere'],
    'a reason-less entry must be reported from the membership allowlist too')
  rmSync(root, { recursive: true, force: true })
})

test('#1444 WIRING: membershipDocs reads every corpus the headline claim names', () => {
  // Without this the whole corpus can go to `[]` and the real-tree assertion below still passes,
  // because it asserts emptiness. Same poisoned-source shape as lint-korean-copy (#1094).
  const docs = membershipDocs(ROOT)
  for (const f of ['CLAUDE.md', 'worker/src/services.ts', 'worker/src/types.ts']) {
    assert.ok(docs.find((x) => x.file === f)?.content.length > 500, `${f} is not in the scanned corpus`)
  }
  assert.ok(docs.some((x) => x.file.startsWith('docs/reference/')), 'docs/reference is not in the scanned corpus')
  const poisoned = docs.map((x) => (x.file === 'CLAUDE.md'
    ? { ...x, content: `${x.content}\nThe \`displayAllComponents\` set is cohere, groq, elevenlabs.` }
    : x))
  assert.ok(auditMembership({ docs: poisoned, services: SERVICES, declared: DECLARED }).some((f) => f.id === 'elevenlabs'))
})

test('#1444: the real docs + services.ts/types.ts comments carry no wrong membership', () => {
  const findings = auditMembership({ docs: membershipDocs(ROOT), services: SERVICES, declared: DECLARED })
  assert.deepEqual(
    findings.map((f) => `${f.file}: \`${f.field}\` ← ${f.id} — «${f.run}»`), [],
    'a doc or comment names a service on a config path it is not on — fix it, or delete the enumeration',
  )
})

test('#1444 REAL DOCS: a wrong member planted in a real enumeration is caught', () => {
  // A pure-function control cannot prove the gate reads the corpus it is pointed at.
  const file = join(ROOT, 'docs/reference/api-endpoints.md')
  const raw = readFileSync(file, 'utf8')
  assert.ok(raw.includes('#606: cohere/groq'), 'anchor enumeration missing — re-anchor this test, do not delete it')
  const mutated = raw.replace('#606: cohere/groq', '#606: cohere/groq/elevenlabs')
  assert.notEqual(mutated, raw, 'mutation did not apply')
  const findings = auditMembership({ docs: [{ file, content: mutated }], services: SERVICES, declared: DECLARED })
  assert.deepEqual(findings.map((f) => f.id), ['elevenlabs'])
})
