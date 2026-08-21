// #873 — unit tests for the Tier-A assertion evaluator (pure, no network, no eval).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseAssertionLine, parseLiteral, parseSelector, evalSelector, compare,
  evaluateAssertion, isAllowedUrl, resolveSource, pairVerifyAssertions, tickBox, runAssertion, findMalformedAssertLines,
  truncate, countOpenBoxes, countOpenVerifyAfter, planIssueAutoVerify, DEFAULT_ASSERT_BASE,
  isSuppressedReminderLine, findQuotedVerifyAfterBoxes, findBacktickQuotedVerifyBoxes, isBacktickQuotedOccurrence,
  liveVerifyOccurrences,
} from './verify-assertions.mjs'

test('parseAssertionLine — valid GET + selector + quoted expected', () => {
  const a = parseAssertionLine('      assert: GET /api/status | services[id=turbopuffer].scoreConfidence == "medium"')
  assert.deepEqual(a, { source: '/api/status', selector: 'services[id=turbopuffer].scoreConfidence', op: '==', expected: '"medium"' })
})

test('parseAssertionLine — GET optional, absolute url, numeric op', () => {
  const a = parseAssertionLine('assert: https://ai-watch.dev/api/report | predictionAccuracy.total >= 1')
  assert.deepEqual(a, { source: 'https://ai-watch.dev/api/report', selector: 'predictionAccuracy.total', op: '>=', expected: '1' })
})

test('parseAssertionLine — exists takes no operand', () => {
  const a = parseAssertionLine('assert: /api/status | supplyChainBanner exists')
  assert.deepEqual(a, { source: '/api/status', selector: 'supplyChainBanner', op: 'exists', expected: null })
})

test('parseAssertionLine — malformed → null', () => {
  assert.equal(parseAssertionLine('assert: /api/status services.foo == 1'), null) // no pipe
  assert.equal(parseAssertionLine('assert: /api/status | services.foo === 1'), null) // bad op
  assert.equal(parseAssertionLine('assert: /api/status | services.foo exists yes'), null) // exists + operand
  assert.equal(parseAssertionLine('assert: /api/status | services.foo =='), null) // value op, no operand
  assert.equal(parseAssertionLine('assert: /api/status | services[bad.foo == 1'), null) // bad selector
  assert.equal(parseAssertionLine('- [ ] verify-after 2026-07-09 — note'), null) // not an assert line
})

test('parseLiteral — string/quoted/bool/number/raw', () => {
  assert.equal(parseLiteral('"medium"'), 'medium')
  assert.equal(parseLiteral("'x'"), 'x')
  assert.equal(parseLiteral('true'), true)
  assert.equal(parseLiteral('false'), false)
  assert.equal(parseLiteral('42'), 42)
  assert.equal(parseLiteral('99.5'), 99.5)
  assert.equal(parseLiteral('operational'), 'operational')
  assert.equal(parseLiteral(null), null)
})

test('parseSelector — plain, filter, quoted filter, malformed', () => {
  assert.deepEqual(parseSelector('a.b.c'), [{ key: 'a', filter: null }, { key: 'b', filter: null }, { key: 'c', filter: null }])
  assert.deepEqual(parseSelector('services[id=turbopuffer].x'), [
    { key: 'services', filter: { key: 'id', value: 'turbopuffer' } }, { key: 'x', filter: null },
  ])
  assert.deepEqual(parseSelector('a[k="v w"]')[0].filter, { key: 'k', value: 'v w' })
  assert.equal(parseSelector('a..b'), null)
  assert.equal(parseSelector('a[bad'), null)
  assert.equal(parseSelector(''), null)
})

test('evalSelector — dot path + array filter', () => {
  const json = { services: [{ id: 'a', v: 1 }, { id: 'turbopuffer', scoreConfidence: 'medium' }], n: { deep: 5 } }
  assert.deepEqual(evalSelector(json, 'services[id=turbopuffer].scoreConfidence'), { found: true, value: 'medium' })
  assert.deepEqual(evalSelector(json, 'n.deep'), { found: true, value: 5 })
  assert.deepEqual(evalSelector(json, 'services[id=missing].x'), { found: false, value: undefined })
  assert.deepEqual(evalSelector(json, 'n.nope'), { found: false, value: undefined })
  assert.deepEqual(evalSelector(json, 'n[id=x].y'), { found: false, value: undefined }) // filter on non-array
})

test('evalSelector — filter matches by string coercion (numeric id)', () => {
  const json = { items: [{ id: 1, ok: true }, { id: 2, ok: false }] }
  assert.deepEqual(evalSelector(json, 'items[id=2].ok'), { found: true, value: false })
})

test('compare — every operator', () => {
  assert.equal(compare('medium', '==', '"medium"'), true)
  assert.equal(compare('medium', '==', '"high"'), false)
  assert.equal(compare('medium', '!=', '"high"'), true)
  assert.equal(compare(5, '>=', '1'), true)
  assert.equal(compare(0, '>=', '1'), false)
  assert.equal(compare(3, '<=', '3'), true)
  assert.equal(compare(['a', 'b'], 'contains', '"a"'), true)
  assert.equal(compare(['a', 'b'], 'contains', '"z"'), false)
  assert.equal(compare('claude down', 'contains', '"down"'), true)
  assert.equal(compare('x', 'exists', null), true)
  assert.equal(compare(undefined, 'exists', null), false)
  assert.equal(compare(null, 'exists', null), false)
})

test('evaluateAssertion — pass / fail / selector-miss', () => {
  const json = { services: [{ id: 'turbopuffer', scoreConfidence: 'medium', uptime30d: 99.9 }] }
  assert.deepEqual(evaluateAssertion({ selector: 'services[id=turbopuffer].scoreConfidence', op: '==', expected: '"medium"' }, json),
    { pass: true, found: true, actual: 'medium' })
  assert.deepEqual(evaluateAssertion({ selector: 'services[id=turbopuffer].uptime30d', op: '>=', expected: '99' }, json),
    { pass: true, found: true, actual: 99.9 })
  assert.deepEqual(evaluateAssertion({ selector: 'services[id=turbopuffer].scoreConfidence', op: '==', expected: '"high"' }, json),
    { pass: false, found: true, actual: 'medium' })
  // selector-miss (value op) ⇒ pass:false, not a throw
  assert.deepEqual(evaluateAssertion({ selector: 'services[id=nope].x', op: '==', expected: '"y"' }, json),
    { pass: false, found: false, actual: undefined })
})

test('isAllowedUrl — allow exact (incl. pinned prod worker) + env extra; reject http/other', () => {
  assert.equal(isAllowedUrl('https://ai-watch.dev/api/status'), true)
  assert.equal(isAllowedUrl('https://api.ai-watch.dev/api/status'), true)
  assert.equal(isAllowedUrl('https://aiwatch-worker.p2c2kbf.workers.dev/api/status'), true) // pinned prod host
  assert.equal(isAllowedUrl('http://ai-watch.dev/api/status'), false) // not https
  assert.equal(isAllowedUrl('https://evil.com/api/status'), false)
  assert.equal(isAllowedUrl('not a url'), false)
  assert.equal(isAllowedUrl('https://localhost:8788/api/status', { VERIFY_ASSERT_ALLOW: 'localhost' }), true)
})

test('isAllowedUrl — SSRF bypass vectors are rejected (#873 review #2/#4)', () => {
  // userinfo trick: hostname resolves to evil.com, not the worker
  assert.equal(isAllowedUrl('https://aiwatch-worker.p2c2kbf.workers.dev@evil.com/x'), false)
  // suffix trick: the allowed label is a prefix of a longer attacker host
  assert.equal(isAllowedUrl('https://aiwatch-worker.p2c2kbf.workers.dev.evil.com/x'), false)
  assert.equal(isAllowedUrl('https://ai-watch.dev.evil.com/x'), false)
  // wildcard is GONE — a DIFFERENT worker subdomain (attacker's own CF account) must be rejected
  assert.equal(isAllowedUrl('https://aiwatch-worker.attacker.workers.dev/x'), false)
  assert.equal(isAllowedUrl('https://aiwatch-worker.workers.dev/x'), false)
  // uppercase host normalizes (new URL lowercases) → still allowed, not a bypass
  assert.equal(isAllowedUrl('https://AI-WATCH.DEV/api/status'), true)
})

test('resolveSource — relative→base, absolute allowlisted, non-allowlisted→null', () => {
  assert.equal(resolveSource('/api/status'), `${DEFAULT_ASSERT_BASE}/api/status`)
  assert.equal(resolveSource('https://ai-watch.dev/api/report'), 'https://ai-watch.dev/api/report')
  assert.equal(resolveSource('https://evil.com/x'), null)
  assert.equal(resolveSource('/api/status', { VERIFY_ASSERT_BASE: 'https://ai-watch.dev' }), 'https://ai-watch.dev/api/status')
})

test('pairVerifyAssertions — pairs verify-after with following assert, skips checked', () => {
  const body = [
    '- [ ] verify-after 2026-07-09 — turbopuffer probe warmed',
    '      assert: GET /api/status | services[id=turbopuffer].scoreConfidence == "medium"',
    '- [x] verify-after 2026-06-01 — already done',
    '      assert: /api/status | services[id=x].y == "z"',
    '- [ ] verify-after 2026-08-05 — no assertion here',
  ].join('\n')
  const items = pairVerifyAssertions(body)
  assert.equal(items.length, 2) // checked line skipped
  assert.equal(items[0].date, '2026-07-09')
  assert.equal(items[0].assertion.selector, 'services[id=turbopuffer].scoreConfidence')
  assert.equal(items[0].lineIndex, 0)
  assert.equal(items[1].date, '2026-08-05')
  assert.equal(items[1].assertion, null) // no following assert line
})

// #1206 follow-up — the sub-block is the verify-after's LIST ITEM, not the run of lines immediately
// under it. The old scan broke at the first line that was neither `assert:` nor `durable:`, so a note
// that wrapped to a second line pushed its own sub-lines out of reach. Two open issues were in that
// state (#1245, #1224): the line was written correctly and the machine reported "no durable trace".
// The failure direction is what makes it worth pinning — the label says "you did not write one", never
// "I could not reach it".
test('pairVerifyAssertions — a wrapped NOTE does not strand the sub-lines (#1206)', () => {
  const body = [
    '- [ ] **verify-after 2026-09-19** — read the telemetry and compare against the baseline.',
    '      **The baseline is the PRE-#1246 log: 4 sessions at maxRound >= 7.** Compare shapes,',
    '      not like for like: how many BRANCHES reach maxRound >= 7, out of how many.',
    '      durable: `.claude/hook-audit.jsonl` (local-only, append-only, no rotation)',
  ].join('\n')
  const items = pairVerifyAssertions(body)
  assert.equal(items.length, 1)
  assert.ok(items[0].durable, 'the durable line is eight lines from the box, still inside the item')
  assert.match(items[0].durable, /hook-audit\.jsonl/)
})

test('pairVerifyAssertions — a wrapped note does not strand an assert: either (#1206)', () => {
  const body = [
    '- [ ] **verify-after 2026-09-19** — confirm the field ships on the public contract.',
    '      Context that wraps across a line, because that is how these get written.',
    '      assert: GET /api/v1/status | services[id=characterai].incidentSourceStale == true',
  ].join('\n')
  const [item] = pairVerifyAssertions(body)
  assert.ok(item.assertion, 'assert: must survive a wrapped note')
  assert.equal(item.assertion.selector, 'services[id=characterai].incidentSourceStale')
})

test('pairVerifyAssertions — the NEXT item does not inherit this one\'s sub-lines (#1206)', () => {
  // The boundary the item-scan has to respect: widening the scan must not let one box\'s durable
  // satisfy the box below it, which would hide exactly the undecidable lines #1206 exists to catch.
  const body = [
    '- [ ] **verify-after 2026-09-19** — first, with a wrapped note.',
    '      more note text here.',
    '      durable: artifact-A (90d)',
    '- [ ] **verify-after 2026-09-20** — second, with nothing of its own.',
  ].join('\n')
  const items = pairVerifyAssertions(body)
  assert.equal(items.length, 2)
  assert.equal(items[0].durable, 'artifact-A (90d)')
  assert.equal(items[1].durable, null, 'the second box names no artifact and must stay undecidable')
})

test('pairVerifyAssertions — a NESTED checkbox keeps its assert to itself (#1206)', () => {
  // The clause that stops the scan at the next checkbox had NO test: deleting it left the whole suite
  // green while both boxes took the nested assertion. The failure direction is the worst one available
  // here — `planIssueAutoVerify` ticks every passing item's lineIndex, so the OUTER box would be
  // auto-ticked on evidence belonging to a different verification, and close fires if it was the last
  // open box. The three sibling-box cases all sit at indent 0, where the indent break already fires, so
  // they cover the other half twice and this half not at all. An assert:, not a durable:, because only
  // the assertion reaches the auto-tick path.
  const body = [
    '- [ ] **verify-after 2026-09-19** — OUTER box, note wraps here',
    '      and continues onto a second line',
    '  - [ ] **verify-after 2026-09-20** — NESTED box',
    '        assert: GET /api/status | services[id=claude].status == "operational"',
  ].join('\n')
  const items = pairVerifyAssertions(body)
  assert.equal(items.length, 2)
  assert.equal(items[0].assertion, null, 'the outer box must not inherit the nested assertion')
  assert.ok(items[1].assertion, 'the nested box keeps its own')
  assert.equal(items[1].assertion.selector, 'services[id=claude].status')
})

test('pairVerifyAssertions — a markdown LINK bullet is a plain bullet, not a checkbox (#1206)', () => {
  // The break regex was a bare `\\[`, so `- [label](url)` ended the item and took the durable: with it —
  // which contradicted both the docstring and the reference page, each of which say a plain nested
  // bullet does not end it. `tickBox` can only act on `[ ]`, so `\\[[ xX]\\]` is the honest test.
  const body = [
    '- [ ] **verify-after 2026-09-19** — note',
    '  - [the dashboard](https://example.com) is where to look',
    '      durable: artifact-A',
  ].join('\n')
  const [item] = pairVerifyAssertions(body)
  assert.equal(item.durable, 'artifact-A', 'a link bullet must not end the item')
})

test('findMalformedAssertLines — an assert: that does not parse is reported, not swallowed (#1206)', () => {
  // The silent path this fix would otherwise have created: the durable: now survives a broken clause,
  // so the item reads as decidable, no `verify-undecidable` fires, and the auto-verify the author
  // believed they wrote never runs. Warn-only — it must not change what pairVerifyAssertions attaches.
  const body = [
    '- [ ] **verify-after 2026-12-01** — a future check whose clause has a typo',
    '      assert: GET /api/status | services[id=claude].status = "operational"',
    '      durable: archive:monthly:2026-11 (no TTL)',
  ].join('\n')
  const bad = findMalformedAssertLines(body)
  assert.equal(bad.length, 1)
  assert.equal(bad[0].lineIndex, 1)
  assert.match(bad[0].text, /^assert:/)
  const [item] = pairVerifyAssertions(body)
  assert.equal(item.assertion, null, 'still not an assertion')
  assert.equal(item.durable, 'archive:monthly:2026-11 (no TTL)', 'and the durable is still honoured')
})

test('findMalformedAssertLines — a well-formed clause, and an EXAMPLE in a fence, are not reported', () => {
  const good = [
    '- [ ] **verify-after 2026-12-01** — fine',
    '      assert: GET /api/status | services[id=claude].status == "operational"',
  ].join('\n')
  assert.deepEqual(findMalformedAssertLines(good), [])
  const fenced = [
    '- [ ] **verify-after 2026-12-01** — shows the grammar',
    '      ```',
    '      assert: nonsense with no pipe',
    '      ```',
  ].join('\n')
  assert.deepEqual(findMalformedAssertLines(fenced), [], 'an example is not a live clause')
})

test('pairVerifyAssertions — an unindented line ends the item (#1206)', () => {
  const body = [
    '- [ ] **verify-after 2026-09-19** — a box whose item ends at the heading below.',
    '',
    '## Some heading',
    'durable: not-mine',
  ].join('\n')
  const [item] = pairVerifyAssertions(body)
  assert.equal(item.durable, null, 'a top-level line is outside the item')
})

test('pairVerifyAssertions — a FENCED example assert: is not taken as live (#1206)', () => {
  // Newly reachable: before the item-scan, a fence line ended the block, so a quoted example could
  // never be read. The docs page and several issue bodies show the grammar this way.
  const body = [
    '- [ ] **verify-after 2026-09-19** — shows the grammar, then names its real artifact.',
    '      ```',
    '      assert: GET /api/status | services[id=x].y == "z"',
    '      ```',
    '      durable: artifact-B',
  ].join('\n')
  const [item] = pairVerifyAssertions(body)
  assert.equal(item.assertion, null, 'an example inside a fence is not an assertion')
  assert.equal(item.durable, 'artifact-B')
})

// #966 — pairVerifyAssertions is the scanner main() actually drives (parseVerifyAfter is its twin),
// so the blockquote guard MUST hold here or the daily ping keeps firing on quoted prose.
test('pairVerifyAssertions — skips BLOCKQUOTE lines, keeps the real box (#966)', () => {
  const body = [
    '> **Status (2026-07-06):** the `verify-after 2026-07-09` assert should auto-pass via the daily job.',
    '>       assert: GET /api/status | services[id=turbopuffer].aiwatchScore >= 1',
    '',
    '- [ ] **verify-after 2026-07-09** — turbopuffer is actually scored',
    '      assert: GET /api/status | services[id=turbopuffer].aiwatchScore >= 1',
  ].join('\n')
  const items = pairVerifyAssertions(body)
  assert.equal(items.length, 1)
  assert.equal(items[0].lineIndex, 3) // the checkbox, not the quote
  assert.equal(items[0].assertion.selector, 'services[id=turbopuffer].aiwatchScore')
})

test('pairVerifyAssertions — a body whose ONLY verify-after mentions are quoted yields nothing (#966)', () => {
  const body = [
    '> the `verify-after 2026-07-09` assert was changed to the honest `aiwatchScore >= 1`.',
    '  > indented quote: verify-after 2026-07-09 still narrative',
  ].join('\n')
  assert.deepEqual(pairVerifyAssertions(body), [])
})

// False negatives are the dangerous direction: a real reminder that stops firing is worse than a
// noisy ping. Pin that the blockquote guard did NOT over-suppress the shapes that must still fire.
test('pairVerifyAssertions — non-quoted prose and `>` mid-line still fire (#966 over-suppression guard)', () => {
  assert.equal(pairVerifyAssertions('Open: verify-after 2026-07-02 (prose ref)')[0].date, '2026-07-02')
  // A `>` that is not the line's first non-space char is a comparison, not a blockquote.
  assert.equal(pairVerifyAssertions('- [ ] verify-after 2026-07-02 — score > 5')[0].date, '2026-07-02')
  // Guard is blockquote-LINE-only: a token inside a fenced block or a table row still fires. Accepted
  // (real bodies don't do this); documented so a future "why did my code sample ping?" is unsurprising.
  assert.equal(pairVerifyAssertions('| verify-after 2026-07-02 | a table row |')[0].date, '2026-07-02')
})

test('findQuotedVerifyAfterBoxes — flags a quoted OPEN box, ignores quoted prose (#966)', () => {
  const body = [
    '> **Status:** the `verify-after 2026-07-09` assert should auto-pass.', // prose — expected, silent
    '> - [ ] verify-after 2026-09-01 quoted live reminder',                 // DANGEROUS — never fires
    '>   - [ ] **verify-after 2026-09-02** indented inside quote',          // also dangerous
    '> - [x] verify-after 2026-09-03 quoted but already done',              // done — not a live loss
    '- [ ] verify-after 2026-09-04 a normal box',                           // fires; not quoted
  ].join('\n')
  const found = findQuotedVerifyAfterBoxes(body)
  assert.deepEqual(found.map((f) => f.lineIndex), [1, 2])
})

test('findQuotedVerifyAfterBoxes — nested quote markers + empty bodies (#966)', () => {
  assert.equal(findQuotedVerifyAfterBoxes('> > - [ ] verify-after 2026-09-01 double-quoted').length, 1)
  assert.deepEqual(findQuotedVerifyAfterBoxes(''), [])
  assert.deepEqual(findQuotedVerifyAfterBoxes(null), [])
  assert.deepEqual(findQuotedVerifyAfterBoxes('> just a quote, no token'), [])
})

test('isSuppressedReminderLine — checked boxes and blockquotes only, unchanged by #1215', () => {
  assert.equal(isSuppressedReminderLine('- [x] verify-after 2026-01-01'), true)
  assert.equal(isSuppressedReminderLine('   * [X] verify-after 2026-01-01'), true)
  assert.equal(isSuppressedReminderLine('> quoted'), true)
  assert.equal(isSuppressedReminderLine('   > indented quote'), true)
  assert.equal(isSuppressedReminderLine('- [ ] verify-after 2026-01-01'), false)
  assert.equal(isSuppressedReminderLine('plain prose verify-after 2026-01-01'), false)
  // GFM renders `-[x]` (no space) as literal text, not a task — must still fire (#586 edge, retained).
  assert.equal(isSuppressedReminderLine('-[x] verify-after 2026-01-01'), false)
  // #1215 — backtick-quoting is deliberately NOT a whole-line property here; it's filtered per-match
  // by the callers (see isBacktickQuotedOccurrence below), so this line-level gate stays untouched —
  // a line can carry both a real box and a backtick citation of a different date (aiwatch-reports#76).
  assert.equal(isSuppressedReminderLine('Found while reading the #1153 `verify-after 2026-07-30` box against production'), false)
})

test('isBacktickQuotedOccurrence — the exact #1189/#1089 citation shapes are wrapped, a real box is not (#1215)', () => {
  const l1 = 'Found while reading the #1153 `verify-after 2026-07-30` box against production'
  assert.equal(isBacktickQuotedOccurrence(l1, l1.indexOf('verify-after')), true)

  const l2 = 'a **decision deferred to `verify-after 2026-08-20`** below'
  assert.equal(isBacktickQuotedOccurrence(l2, l2.indexOf('verify-after')), true)

  const l3 = '- [ ] **verify-after 2026-08-03** — regenerate. Depends on `verify-after 2026-08-02`.'
  const firstIdx = l3.indexOf('verify-after')
  const secondIdx = l3.indexOf('verify-after', firstIdx + 1)
  assert.equal(isBacktickQuotedOccurrence(l3, firstIdx), false) // the bold box's own date — real
  assert.equal(isBacktickQuotedOccurrence(l3, secondIdx), true) // the trailing citation — quoted

  // A bare mention with no wrapping backticks at all.
  const l4 = 'Open: verify-after 2026-07-02 (prose ref)'
  assert.equal(isBacktickQuotedOccurrence(l4, l4.indexOf('verify-after')), false)
})

test('isBacktickQuotedOccurrence — the closing backtick may come after a trailing note inside the span, not just immediately after the date (#1215 round-2 finding)', () => {
  const l = '- [ ] `verify-after 2026-08-02 archive check` cited'
  assert.equal(isBacktickQuotedOccurrence(l, l.indexOf('verify-after')), true)
})

test('isBacktickQuotedOccurrence — an unrelated stray backtick on EITHER side does not falsely suppress a real box (open side stays anchored, #1215 round-3 finding)', () => {
  // Must have a backtick on BOTH sides of the match, or the close-side `indexOf` check alone (not the
  // open-side anchor) could make this pass for the wrong reason — round-3 review caught exactly that:
  // the original version of this test had no backtick after the match, so it passed via the close side
  // returning false, never exercising the open-side anchor it claimed to pin.
  const l = 'stray ` then **verify-after 2026-03-03** and `code` after'
  assert.equal(isBacktickQuotedOccurrence(l, l.indexOf('verify-after')), false)
})

test('pairVerifyAssertions — a real box still fires even when the same line cites a different date in backticks (#1215, aiwatch-reports#76 shape)', () => {
  const body = "- [ ] **verify-after 2026-08-03** — regenerate the report. Depends on aiwatch#1002's `verify-after 2026-08-02` archive check."
  const found = pairVerifyAssertions(body)
  assert.equal(found.length, 1)
  assert.equal(found[0].date, '2026-08-03')
})

test('pairVerifyAssertions — a real box still fires when the CITATION PRECEDES it on the same line (#1215 review finding)', () => {
  // VERIFY_RE's trailing note capture is greedy, so a naive matchAll on the full pattern would let the
  // FIRST match's note swallow the rest of the line — including a real box coming AFTER a citation —
  // and never surface it as a match at all. This is the reverse text order from aiwatch-reports#76, and
  // it must not silently drop the real date instead of merely skipping the citation.
  const body = "Per #1153's `verify-after 2026-07-30` note — our own **verify-after 2026-09-09** still stands"
  const found = pairVerifyAssertions(body)
  assert.equal(found.length, 1)
  assert.equal(found[0].date, '2026-09-09')
})

test('liveVerifyOccurrences — finds a live match regardless of how many backtick citations precede it (#1215)', () => {
  const line = 'cites `verify-after 2026-01-01` and `verify-after 2026-02-02` but ours is verify-after 2026-03-03 — ok'
  const found = liveVerifyOccurrences(line)
  assert.equal(found.length, 1)
  assert.equal(found[0][1], '2026-03-03')
})

test('liveVerifyOccurrences — empty when every occurrence on the line is backtick-quoted', () => {
  const line = 'Found while reading the #1153 `verify-after 2026-07-30` box against production'
  assert.deepEqual(liveVerifyOccurrences(line), [])
})

test('pairVerifyAssertions and parseVerifyAfter agree on a line with TWO live dates — both take only the first (#1215 round-2 finding)', () => {
  const line = '- [ ] **verify-after 2026-03-03** then also verify-after 2026-04-04 tail'
  assert.deepEqual(pairVerifyAssertions(line).map((f) => f.date), ['2026-03-03'])
})

test('findBacktickQuotedVerifyBoxes — flags a backtick-wrapped OPEN box, ignores a box that merely CITES another date in backticks (#1215)', () => {
  const body = [
    'Found while reading the #1153 `verify-after 2026-07-30` box against production.', // prose — expected, silent
    '- [ ] `verify-after 2026-09-01` accidentally backtick-wrapped date — DANGEROUS, never fires',
    '- [x] `verify-after 2026-09-02` already done — not a live loss',
    '- [ ] verify-after 2026-09-03 a normal box, not backtick-wrapped',
    "- [ ] **verify-after 2026-09-04** — real box that cites `verify-after 2026-09-05` in its own note", // aiwatch-reports#76 shape — must NOT flag
  ].join('\n')
  const found = findBacktickQuotedVerifyBoxes(body)
  assert.deepEqual(found.map((f) => f.lineIndex), [1])
})

test('findBacktickQuotedVerifyBoxes — empty bodies + no token (#1215)', () => {
  assert.deepEqual(findBacktickQuotedVerifyBoxes(''), [])
  assert.deepEqual(findBacktickQuotedVerifyBoxes(null), [])
  assert.deepEqual(findBacktickQuotedVerifyBoxes('- [ ] just a normal box, no token'), [])
})

test('pairVerifyAssertions — tolerates a blank line before the assert', () => {
  const body = '- [ ] verify-after 2026-07-09 — x\n\n      assert: /api/status | a.b exists'
  const items = pairVerifyAssertions(body)
  assert.equal(items[0].assertion.op, 'exists')
})

test('tickBox — flips [ ]→[x] on the target line only', () => {
  const body = '- [ ] verify-after 2026-07-09 — x\n      assert: /api/status | a.b exists'
  const out = tickBox(body, 0)
  assert.match(out.split('\n')[0], /- \[x\] verify-after/)
  assert.equal(out.split('\n')[1], '      assert: /api/status | a.b exists') // untouched
  assert.equal(tickBox(body, 99), body) // out-of-range → unchanged
  // anchored: a prose line with a stray literal `[ ]` (not a task marker) is NOT ticked
  const prose = 'verify-after 2026-07-09 — check the [ ] state'
  assert.equal(tickBox(prose, 0), prose)
})

test('countOpenBoxes / countOpenVerifyAfter', () => {
  const body = [
    '- [ ] verify-after 2026-07-09 — a',
    '- [x] verify-after 2026-06-01 — done',
    '- [ ] some other acceptance item (not a verify)',
    'plain line',
  ].join('\n')
  assert.equal(countOpenBoxes(body), 2)          // two `- [ ]`
  assert.equal(countOpenVerifyAfter(body), 1)    // only the open verify-after line
  assert.equal(countOpenBoxes(''), 0)
  assert.equal(countOpenVerifyAfter(''), 0)
})

test('countOpenVerifyAfter — an open box whose only verify-after is a backtick citation does not count (#1215)', () => {
  // Load-bearing for planIssueAutoVerify's dropLabel: counting this box would pin verify-blocked open
  // forever, since pairVerifyAssertions would never parse a live reminder off this line either.
  const body = [
    '- [ ] doc note citing `verify-after 2026-07-30` for context, not a real box',
    '- [ ] **verify-after 2026-08-20** — the actual live reminder',
  ].join('\n')
  assert.equal(countOpenVerifyAfter(body), 1)
})

test('planIssueAutoVerify — dropLabel fires even when a citation-only box is still unchecked (#1215)', () => {
  const body = [
    '- [ ] **verify-after 2026-08-03** — the real, assertable box',
    '      assert: GET /api/status | services[id=x].ok == true',
    '- [ ] doc note citing `verify-after 2026-07-30` for context, not a real box',
  ].join('\n')
  const plan = planIssueAutoVerify(body, [{ lineIndex: 0, status: 'pass' }])
  assert.equal(plan.dropLabel, true)
})

test('planIssueAutoVerify — ticks passers; dropLabel when no open verify-after; close when no open box', () => {
  // One verify-after (assert passes) + one non-verify acceptance box still open → drop label, DON'T close.
  const body1 = '- [ ] verify-after 2026-07-09 — probe\n      assert: /api/status | a.b == "x"\n- [ ] ship the code'
  const p1 = planIssueAutoVerify(body1, [{ lineIndex: 0, status: 'pass' }])
  assert.equal(p1.passCount, 1)
  assert.match(p1.newBody.split('\n')[0], /- \[x\] verify-after/)
  assert.equal(p1.dropLabel, true)   // no open verify-after remains
  assert.equal(p1.close, false)      // the acceptance box is still open

  // Sole verify-after passes, nothing else open → drop label AND close.
  const body2 = '- [ ] verify-after 2026-07-09 — probe\n      assert: /api/status | a.b == "x"'
  const p2 = planIssueAutoVerify(body2, [{ lineIndex: 0, status: 'pass' }])
  assert.equal(p2.dropLabel, true)
  assert.equal(p2.close, true)

  // Two verify-after lines, one passes one fails → tick the passer, KEEP label (one still open).
  const body3 = '- [ ] verify-after 2026-07-09 — a\n      assert: /api/status | a == 1\n- [ ] verify-after 2026-08-01 — b\n      assert: /api/status | b == 2'
  const p3 = planIssueAutoVerify(body3, [{ lineIndex: 0, status: 'pass' }, { lineIndex: 2, status: 'fail' }])
  assert.equal(p3.passCount, 1)
  assert.equal(p3.dropLabel, false)  // line 2 verify-after still open
  assert.equal(p3.close, false)
  assert.match(p3.newBody.split('\n')[0], /- \[x\]/)
  assert.match(p3.newBody.split('\n')[2], /- \[ \]/) // failer untouched

  // No passers → no mutation.
  const p4 = planIssueAutoVerify(body2, [{ lineIndex: 0, status: 'skip' }])
  assert.equal(p4.passCount, 0)
  assert.equal(p4.dropLabel, false)
  assert.equal(p4.close, false)
  assert.equal(p4.newBody, body2)

  // #873 review #1 — a PROSE verify-after line (no `- [ ]` box) is a no-op tick → NOT counted as
  // ticked, so it can't drive a repeating comment/label/close on every daily run.
  const prose = 'verify-after 2026-07-09 — prose, no checkbox\n      assert: /api/status | a.b == "x"'
  const p5 = planIssueAutoVerify(prose, [{ lineIndex: 0, status: 'pass' }])
  assert.equal(p5.passCount, 0)
  assert.equal(p5.dropLabel, false)
  assert.equal(p5.close, false)
  assert.equal(p5.newBody, prose) // unchanged
})

test('truncate — caps long display strings', () => {
  assert.equal(truncate('short'), 'short')
  const long = 'x'.repeat(200)
  assert.match(truncate(long), /^x{120}… \(200 chars\)$/)
})

test('runAssertion — pass / fail / skip via injected fetch', async () => {
  const a = { source: '/api/status', selector: 'services[id=turbopuffer].scoreConfidence', op: '==', expected: '"medium"' }
  const okFetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ services: [{ id: 'turbopuffer', scoreConfidence: 'medium' }] }) })
  assert.deepEqual((await runAssertion(a, { fetchImpl: okFetch })).status, 'pass')

  const failFetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ services: [{ id: 'turbopuffer', scoreConfidence: 'low' }] }) })
  assert.deepEqual((await runAssertion(a, { fetchImpl: failFetch })).status, 'fail')

  // HTTP error → skip (fail-open, keep reminder)
  const httpErr = () => Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) })
  assert.equal((await runAssertion(a, { fetchImpl: httpErr })).status, 'skip')

  // fetch throws → skip
  const throws = () => Promise.reject(new Error('network'))
  assert.equal((await runAssertion(a, { fetchImpl: throws })).status, 'skip')

  // bad JSON (res.json() throws) → skip (fail-open, never a false pass)
  const badJson = () => Promise.resolve({ ok: true, json: () => Promise.reject(new Error('invalid json')) })
  assert.equal((await runAssertion(a, { fetchImpl: badJson })).status, 'skip')

  // non-allowlisted source → skip without fetching
  let called = false
  const spy = () => { called = true; return Promise.resolve({ ok: true, json: () => ({}) }) }
  const r = await runAssertion({ ...a, source: 'https://evil.com/x' }, { fetchImpl: spy })
  assert.equal(r.status, 'skip')
  assert.equal(called, false)
})

// ── #1206: the verify-after sub-block (assert: / durable:) ──────────────────────
// These live HERE, next to the existing pairVerifyAssertions cases, because this is the file the next
// person editing the sub-block scan will read. verify-reminders.test.mjs covers the consumers.

test('pairVerifyAssertions — durable: above assert: must not hide the assert (#1206)', () => {
  const VA = '- [ ] **verify-after 2026-09-01** — check it'
  const A = '      assert: GET /api/status | services[id=claude].status == "operational"'
  const D = '      durable: archive:monthly:2026-08 (no TTL)'
  for (const body of [`${VA}\n${D}\n${A}`, `${VA}\n${A}\n${D}`]) {
    const [it] = pairVerifyAssertions(body)
    assert.ok(it.assertion, `assert: found regardless of order:\n${body}`)
    assert.equal(it.durable, 'archive:monthly:2026-08 (no TTL)')
  }
  // A REPEATED marker must not end the block and strand what follows — that is the same silent
  // auto-verify loss the ordering fix exists to prevent.
  const [dup] = pairVerifyAssertions(`${VA}\n${D}\n      durable: second one\n${A}`)
  assert.ok(dup.assertion, 'a second durable: does not strand the assert: below it')
  assert.equal(dup.durable, 'archive:monthly:2026-08 (no TTL)', 'first of each marker wins')
})

test('pairVerifyAssertions — the sub-block ends at the ITEM boundary, not at the first non-marker', () => {
  const VA = '- [ ] **verify-after 2026-09-01** — check it'
  const A = '      assert: GET /api/status | services[id=claude].status == "operational"'
  // Unindented prose is OUTSIDE the item, so an assert: beyond it still is not this line's.
  const [it] = pairVerifyAssertions(`${VA}\nplain prose\n${A}`)
  assert.equal(it.assertion, null, "an assert: below unrelated top-level prose is not this line's")
  assert.equal(it.durable, null)
  // #1206 follow-up — CHANGED deliberately. A malformed `assert:` used to END the block, which meant a
  // typo in the clause silently discarded a perfectly good `durable:` under it: one author error
  // compounded into a second, and the issue was then labelled `verify-undecidable` while naming its
  // artifact two lines down. The malformed line is still not an assertion; it just no longer takes the
  // rest of the item with it. The typo itself is surfaced by `findMalformedAssertLines`, tested above.
  const [bad] = pairVerifyAssertions(`${VA}\n      assert: nonsense with no pipe\n      durable: x`)
  assert.equal(bad.assertion, null, 'a broken clause is still not an assertion')
  assert.equal(bad.durable, 'x', 'but it no longer strands the durable: below it')
})
