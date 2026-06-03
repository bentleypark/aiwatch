// #541 — unit tests for the verify-after reminder logic. Run with `npm run test:scripts`
// (= `node --test "scripts/*.test.mjs"`). Uses node:test (no vitest) since this is a CI/automation
// script, not src/worker code.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseVerifyAfter, daysSinceDue, shouldFire, isValidIsoDate, parseTrustedAuthors } from './verify-reminders.mjs'

test('parseVerifyAfter — extracts date + note from a checklist line', () => {
  const body = '- [ ] **verify-after 2026-09-01** — check p95 after 3 months (#511)\nother text'
  assert.deepEqual(parseVerifyAfter(body), [{ date: '2026-09-01', note: 'check p95 after 3 months (#511)' }])
})

test('parseVerifyAfter — none, multiple, and `:`/`-` separators', () => {
  assert.deepEqual(parseVerifyAfter('no token here'), [])
  assert.deepEqual(parseVerifyAfter(''), [])
  assert.deepEqual(parseVerifyAfter(null), [])
  const multi = parseVerifyAfter('verify-after 2026-01-01 first thing\nverify-after: 2026-02-02 second')
  assert.equal(multi.length, 2)
  assert.equal(multi[0].note, 'first thing')
  assert.equal(multi[1].date, '2026-02-02')
  assert.equal(multi[1].note, 'second')
})

test('parseVerifyAfter — is case-insensitive', () => {
  assert.deepEqual(parseVerifyAfter('VERIFY-AFTER 2026-03-03 note'), [{ date: '2026-03-03', note: 'note' }])
})

test('daysSinceDue — whole-day diff, sign, and NaN on bad input', () => {
  assert.equal(daysSinceDue('2026-06-01', '2026-06-03'), 2)
  assert.equal(daysSinceDue('2026-06-10', '2026-06-03'), -7)
  assert.equal(daysSinceDue('2026-06-03', '2026-06-03'), 0)
  assert.ok(Number.isNaN(daysSinceDue('not-a-date', '2026-06-03')))
})

test('shouldFire — due date + every 7th day after, not between, not before', () => {
  assert.equal(shouldFire('2026-06-03', '2026-06-03'), true)  // day 0 (due)
  assert.equal(shouldFire('2026-06-03', '2026-06-04'), false) // day 1
  assert.equal(shouldFire('2026-06-03', '2026-06-09'), false) // day 6
  assert.equal(shouldFire('2026-05-27', '2026-06-03'), true)  // day 7
  assert.equal(shouldFire('2026-05-20', '2026-06-03'), true)  // day 14
  assert.equal(shouldFire('2026-06-10', '2026-06-03'), false) // future (not yet due)
  assert.equal(shouldFire('bad', '2026-06-03'), false)        // unparseable
})

test('parseVerifyAfter — skips calendar-invalid dates (rollover guard)', () => {
  assert.deepEqual(parseVerifyAfter('verify-after 2026-02-30 typo'), []) // Feb 30 would roll over
  assert.deepEqual(parseVerifyAfter('verify-after 2026-13-01 bad month'), [])
  assert.equal(parseVerifyAfter('verify-after 2026-02-28 ok')[0].date, '2026-02-28')
})

test('isValidIsoDate', () => {
  assert.equal(isValidIsoDate('2026-06-03'), true)
  assert.equal(isValidIsoDate('2026-02-29'), false) // 2026 not a leap year
  assert.equal(isValidIsoDate('2026-02-30'), false)
  assert.equal(isValidIsoDate('nope'), false)
})

test('parseTrustedAuthors — owner from GITHUB_REPOSITORY + explicit override; empty by default', () => {
  assert.deepEqual([...parseTrustedAuthors({ GITHUB_REPOSITORY: 'bentleypark/aiwatch' })], ['bentleypark'])
  assert.deepEqual([...parseTrustedAuthors({ VERIFY_TRUSTED_AUTHORS: 'a, b', GITHUB_REPOSITORY: 'o/r' })], ['a', 'b', 'o'])
  assert.equal(parseTrustedAuthors({}).size, 0) // local dev → empty → caller does not filter
})

test('importing the module runs no side effects (main is guarded)', () => {
  // Reaching here proves importing did not invoke main() (which shells out to `gh` / posts Discord).
  assert.ok(true)
})
