// #541 — unit tests for the verify-after reminder logic. Run with `npm run test:scripts`
// (= `node --test "scripts/*.test.mjs"`). Uses node:test (no vitest) since this is a CI/automation
// script, not src/worker code.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseVerifyAfter, daysSinceDue, shouldFire, isValidIsoDate, parseTrustedAuthors, parseScanRepos, displayRef, findBodyDrift, isDriftCandidate, hasBodyDriftLabel } from './verify-reminders.mjs'

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

test('parseVerifyAfter — skips a CHECKED checkbox line; unchecked + prose still fire (#541/#586)', () => {
  // A done item (`- [x]`) must STOP firing — ticking the box is the SSOT "done" action.
  assert.deepEqual(parseVerifyAfter('- [x] **verify-after 2026-06-12** — done'), [])
  assert.deepEqual(parseVerifyAfter('* [X] verify-after 2026-06-12 done (alt marker + caps)'), [])
  assert.deepEqual(parseVerifyAfter('+ [x] verify-after 2026-06-12 done (+ marker)'), [])
  assert.deepEqual(parseVerifyAfter('   - [x] verify-after 2026-06-12 indented done'), [])
  // Unchecked + prose lines are unaffected.
  assert.equal(parseVerifyAfter('- [ ] verify-after 2026-07-02 still open')[0].date, '2026-07-02')
  assert.equal(parseVerifyAfter('Open: verify-after 2026-07-02 (prose ref)')[0].date, '2026-07-02')
  // GFM needs a space after the marker — `-[x]` is literal text (NOT a checked task) → must still fire.
  assert.equal(parseVerifyAfter('-[x] verify-after 2026-07-02 not a real checkbox')[0].date, '2026-07-02')
  // The #586 shape: one done (skipped) + one open (fires) → only the open date returns.
  const body = '- [x] **verify-after 2026-06-12** — daily cron counters\n- [ ] **verify-after 2026-07-02** — archive month'
  assert.deepEqual(parseVerifyAfter(body), [{ date: '2026-07-02', note: 'archive month' }])
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
  assert.equal(parseTrustedAuthors({}).size, 0) // pure local → empty → caller does not filter
})

test('parseTrustedAuthors — also trusts scanned-repo owners (abuse-gate stays closed on a public sibling)', () => {
  // GITHUB_REPOSITORY empty but a concrete sibling is scanned → gate must NOT open: owner derived from the repo.
  assert.deepEqual([...parseTrustedAuthors({}, ['bentleypark/aiwatch-reports'])], ['bentleypark'])
  // main + different-owner sibling → both owners trusted (each gates its own repo's issues)
  assert.deepEqual([...parseTrustedAuthors({ GITHUB_REPOSITORY: 'o/main' }, ['x/sib'])], ['o', 'x'])
  // pure-local (repos:[null]) keeps the empty set → no filter
  assert.equal(parseTrustedAuthors({}, [null]).size, 0)
})

test('parseScanRepos — main repo + default reports sibling, de-duped, order-preserving', () => {
  // main repo from GITHUB_REPOSITORY + the default reports sibling
  assert.deepEqual(parseScanRepos({ GITHUB_REPOSITORY: 'bentleypark/aiwatch' }), ['bentleypark/aiwatch', 'bentleypark/aiwatch-reports'])
  // explicit extras override the default; main stays first
  assert.deepEqual(parseScanRepos({ GITHUB_REPOSITORY: 'o/main', VERIFY_EXTRA_REPOS: 'o/a, o/b' }), ['o/main', 'o/a', 'o/b'])
  // a sibling duplicating the main repo is de-duped
  assert.deepEqual(parseScanRepos({ GITHUB_REPOSITORY: 'o/r', VERIFY_EXTRA_REPOS: 'o/r' }), ['o/r'])
  // empty VERIFY_EXTRA_REPOS → main only (no sibling)
  assert.deepEqual(parseScanRepos({ GITHUB_REPOSITORY: 'o/main', VERIFY_EXTRA_REPOS: '' }), ['o/main'])
  // local dev (no GITHUB_REPOSITORY, no extras) → [null] = current repo, no --repo
  assert.deepEqual(parseScanRepos({ VERIFY_EXTRA_REPOS: '' }), [null])
})

test('displayRef — bare #N for main/local, qualified for a sibling', () => {
  const env = { GITHUB_REPOSITORY: 'bentleypark/aiwatch' }
  assert.equal(displayRef('bentleypark/aiwatch', 41, env), '#41')            // main repo → bare
  assert.equal(displayRef('bentleypark/aiwatch-reports', 41, env), 'aiwatch-reports#41') // sibling → qualified
  assert.equal(displayRef(null, 41, env), '#41')                            // local/current → bare
})

test('findBodyDrift — counts unchecked NON-verify-after boxes; excludes verify-after + checked + empty', () => {
  // A synced verify-blocked body: impl boxes ticked, only the verify-after line open → NO drift.
  const synced = '- [x] shipped the fix\n- [x] docs\n- [ ] **verify-after 2026-07-14** — check prod'
  assert.equal(findBodyDrift(synced).count, 0)
  // Drifted body: shipped code but impl boxes still unchecked → drift on the non-verify-after boxes.
  const drifted = '- [x] one\n- [ ] Layer 1 graduated text\n- [ ] Layer 2 clamp\n- [ ] **verify-after 2026-07-08** — behavioral'
  const d = findBodyDrift(drifted)
  assert.equal(d.count, 2)
  assert.deepEqual(d.samples, ['Layer 1 graduated text', 'Layer 2 clamp'])
  // Empty / null / no boxes → no drift.
  assert.equal(findBodyDrift('').count, 0)
  assert.equal(findBodyDrift(null).count, 0)
  assert.equal(findBodyDrift('just prose, no checkboxes').count, 0)
  // `-[ ]` (no space, GFM literal text) is not a checkbox → not counted.
  assert.equal(findBodyDrift('-[ ] not a real checkbox').count, 0)
  // A verify-after with a `:`/`-` separator is still excluded.
  assert.equal(findBodyDrift('- [ ] verify-after: 2026-08-01 rejoin ranking').count, 0)
  // samples cap at 5.
  const many = Array.from({ length: 8 }, (_, i) => `- [ ] item ${i}`).join('\n')
  assert.equal(findBodyDrift(many).count, 8)
  assert.equal(findBodyDrift(many).samples.length, 5)
})

test('isDriftCandidate — verify-blocked AND NOT tracking; accepts {name} or string labels', () => {
  assert.equal(isDriftCandidate([{ name: 'verify-blocked' }, { name: 'bug' }]), true)
  assert.equal(isDriftCandidate(['verify-blocked']), true)
  // tracking umbrella is exempt (legitimately keeps open sub-items)
  assert.equal(isDriftCandidate([{ name: 'verify-blocked' }, { name: 'tracking' }]), false)
  // not verify-blocked → not a candidate
  assert.equal(isDriftCandidate([{ name: 'bug' }]), false)
  assert.equal(isDriftCandidate([]), false)
  assert.equal(isDriftCandidate(null), false)
})

test('hasBodyDriftLabel — detects the self-heal label', () => {
  assert.equal(hasBodyDriftLabel([{ name: 'body-drift' }, { name: 'verify-blocked' }]), true)
  assert.equal(hasBodyDriftLabel(['body-drift']), true)
  assert.equal(hasBodyDriftLabel([{ name: 'verify-blocked' }]), false)
  assert.equal(hasBodyDriftLabel(null), false)
})

test('importing the module runs no side effects (main is guarded)', () => {
  // Reaching here proves importing did not invoke main() (which shells out to `gh` / posts Discord).
  assert.ok(true)
})
