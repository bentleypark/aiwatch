// #873 — unit tests for the Tier-A assertion evaluator (pure, no network, no eval).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseAssertionLine, parseLiteral, parseSelector, evalSelector, compare,
  evaluateAssertion, isAllowedUrl, resolveSource, pairVerifyAssertions, tickBox, runAssertion,
  truncate, countOpenBoxes, countOpenVerifyAfter, planIssueAutoVerify, DEFAULT_ASSERT_BASE,
  isSuppressedReminderLine, findQuotedVerifyAfterBoxes,
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

test('isSuppressedReminderLine — checked boxes and blockquotes only (#966)', () => {
  assert.equal(isSuppressedReminderLine('- [x] verify-after 2026-01-01'), true)
  assert.equal(isSuppressedReminderLine('   * [X] verify-after 2026-01-01'), true)
  assert.equal(isSuppressedReminderLine('> quoted'), true)
  assert.equal(isSuppressedReminderLine('   > indented quote'), true)
  assert.equal(isSuppressedReminderLine('- [ ] verify-after 2026-01-01'), false)
  assert.equal(isSuppressedReminderLine('plain prose verify-after 2026-01-01'), false)
  // GFM renders `-[x]` (no space) as literal text, not a task — must still fire (#586 edge, retained).
  assert.equal(isSuppressedReminderLine('-[x] verify-after 2026-01-01'), false)
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

test('pairVerifyAssertions — the sub-block ends at the first line that is neither marker', () => {
  const VA = '- [ ] **verify-after 2026-09-01** — check it'
  const A = '      assert: GET /api/status | services[id=claude].status == "operational"'
  const [it] = pairVerifyAssertions(`${VA}\nplain prose\n${A}`)
  assert.equal(it.assertion, null, "an assert: below unrelated prose is not this line's")
  assert.equal(it.durable, null)
  // A MALFORMED assert: is not a marker, so it ends the block (pre-existing behaviour, kept on
  // purpose: a broken clause must not swallow the real content underneath it).
  const [bad] = pairVerifyAssertions(`${VA}\n      assert: nonsense with no pipe\n      durable: x`)
  assert.equal(bad.assertion, null)
  assert.equal(bad.durable, null)
})
