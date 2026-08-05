// #541 — unit tests for the verify-after reminder logic. Run with `npm run test:scripts`
// (= `node --test "scripts/*.test.mjs"`). Uses node:test (no vitest) since this is a CI/automation
// script, not src/worker code.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseVerifyAfter, daysSinceDue, shouldFire, isValidIsoDate, parseTrustedAuthors, parseScanRepos, displayRef, findBodyDrift, isDriftCandidate, hasBodyDriftLabel, hasLabel, findStaleOverdueLabels, findInvalidVerifyAfterDates, planClosedScarRemovals, mergeClosedIssues, LIFECYCLE_LABELS, CLOSED_SCAR_LIMIT, findUndecidableVerifyAfter, hasUndecidableLabel, findOverdueEscalations, OVERDUE_ESCALATION_DAYS, buildReminderEmbeds, splitEscalatedDue, reminderLineKey } from './verify-reminders.mjs'
import { pairVerifyAssertions, parseDurableLine } from './verify-assertions.mjs'

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

// ── #966: blockquoted `verify-after` mentions must not fire ──────────────────────────────────────
test('parseVerifyAfter — skips a BLOCKQUOTE line; a real box on the same date still fires (#966)', () => {
  assert.deepEqual(parseVerifyAfter('> the `verify-after 2026-07-09` assert should auto-pass'), [])
  assert.deepEqual(parseVerifyAfter('  > indented quote: verify-after 2026-07-09 blah'), [])
  assert.deepEqual(parseVerifyAfter('> - [ ] verify-after 2026-07-09 quoted checklist'), [])
  // Non-quoted prose is still a legitimate reminder — do NOT over-suppress (#541 behaviour retained).
  assert.equal(parseVerifyAfter('Open: verify-after 2026-07-02 (prose ref)')[0].date, '2026-07-02')
})

test('parseVerifyAfter — the real #857 body shape yields ZERO hits once its box is ticked (#966)', () => {
  // Both of #857's pings came from these two blockquoted status notes, in the same run that
  // auto-verified + closed the issue. Its actual checkbox was already `- [x]`.
  const body = [
    '> **Status (2026-07-06):** Expected flip ~2026-07-08, so the `verify-after 2026-07-09`',
    '> `aiwatchScore >= 1` assert should **auto-pass** via the daily job.',
    '',
    '> ⚠️ The `verify-after 2026-07-09` assert was changed from `scoreConfidence == "medium"`.',
    '',
    '- [x] **verify-after 2026-07-09** — turbopuffer is actually scored',
  ].join('\n')
  assert.deepEqual(parseVerifyAfter(body), [])
})

test('parseVerifyAfter — the real aiwatch-reports#41 shape yields exactly ONE hit, the box (#966)', () => {
  const body = [
    '> **Status (2026-06-15):** The `verify-after 2026-07-02` reminder is now automated cross-repo.',
    '',
    '- [ ] **verify-after 2026-07-02** — the 2026-06 report auto-renders the trend section',
  ].join('\n')
  const hits = parseVerifyAfter(body)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].date, '2026-07-02')
  assert.match(hits[0].note, /2026-06 report/)
})

// ── #966: `verify-overdue` is a current-state label, so it must self-heal ─────────────────────────
test('hasLabel — object and string label shapes', () => {
  assert.equal(hasLabel([{ name: 'verify-overdue' }], 'verify-overdue'), true)
  assert.equal(hasLabel(['verify-overdue'], 'verify-overdue'), true)
  assert.equal(hasLabel([{ name: 'bug' }], 'verify-overdue'), false)
  assert.equal(hasLabel(null, 'verify-overdue'), false)
})

const OVERDUE = [{ name: 'verify-overdue' }]
const openBox = (d) => `- [ ] **verify-after ${d}** — check something`

test('findStaleOverdueLabels — clears when every verify-after line is ticked (#966)', () => {
  const considered = [
    { number: 857, repo: null, labels: OVERDUE, body: '- [x] **verify-after 2026-07-09** — done' },
    { number: 41, repo: null, labels: OVERDUE, body: openBox('2026-07-02') }, // still overdue → keep
    { number: 900, repo: null, labels: [{ name: 'bug' }], body: openBox('2026-01-01') }, // unlabeled
  ]
  assert.deepEqual(findStaleOverdueLabels(considered, '2026-07-09').map((i) => i.number), [857])
})

// The bug the first draft shipped: `due` is throttled by shouldFire's `d % 7 === 0`, so an overdue
// issue is absent from `due` on 6 of every 7 days. Keying the clear off `due` flapped the label.
test('findStaleOverdueLabels — KEEPS the label on a non-cadence day (weekly-throttle trap, #966)', () => {
  const considered = [{ number: 41, repo: null, labels: OVERDUE, body: openBox('2026-07-02') }]
  // 2026-07-09 is d=7 → shouldFire true (a ping day). 2026-07-10 is d=8 → NOT a ping day.
  assert.equal(shouldFire('2026-07-02', '2026-07-09'), true)
  assert.equal(shouldFire('2026-07-02', '2026-07-10'), false)
  // Still overdue on BOTH days, so the label must survive the non-firing day.
  assert.deepEqual(findStaleOverdueLabels(considered, '2026-07-09'), [])
  assert.deepEqual(findStaleOverdueLabels(considered, '2026-07-10'), [])
  // …and every other day in the gap.
  for (const day of ['2026-07-11', '2026-07-12', '2026-07-15']) {
    assert.deepEqual(findStaleOverdueLabels(considered, day), [], `flapped on ${day}`)
  }
})

test('findStaleOverdueLabels — a line ticked THIS run no longer counts as overdue (#966)', () => {
  // The fetched body still shows `- [ ]`; the auto-verify pass ticked it moments ago. This is #857's
  // exact path: auto-verified + closed + unlabeled in a single run.
  const considered = [{ number: 857, repo: null, labels: OVERDUE, body: openBox('2026-07-09') }]
  assert.deepEqual(findStaleOverdueLabels(considered, '2026-07-09'), []) // no tickedKeys → keep
  const ticked = new Set(['#857#0'])
  assert.deepEqual(findStaleOverdueLabels(considered, '2026-07-09', ticked).map((i) => i.number), [857])
})

// Fail-safe, not fail-open: the ping loop already skips an invalid date, so clearing the label too
// would take the issue completely dark (no ping, no label, no warning).
test('findStaleOverdueLabels — an INVALID date KEEPS the label (fail-safe) (#966)', () => {
  const considered = [{ number: 8, repo: null, labels: OVERDUE, body: '- [ ] verify-after 2026-13-45 typo' }]
  assert.deepEqual(findStaleOverdueLabels(considered, '2026-07-09'), [])
  // Even alongside a resolved line, the bad date holds the label open.
  const mixed = [{ number: 9, repo: null, labels: OVERDUE, body: ['- [x] verify-after 2026-01-01 done', '- [ ] verify-after 2026-02-30 typo'].join('\n') }]
  assert.deepEqual(findStaleOverdueLabels(mixed, '2026-07-09'), [])
})

test('findInvalidVerifyAfterDates — surfaces typos, ignores valid + quoted lines (#966)', () => {
  const body = [
    '- [ ] verify-after 2026-02-30 rolls over',
    '- [ ] verify-after 2026-13-01 bad month',
    '- [ ] verify-after 2026-02-28 fine',
    '> quoted verify-after 2026-13-01 narrative', // suppressed upstream → not our problem
  ].join('\n')
  assert.deepEqual(findInvalidVerifyAfterDates(body).map((i) => i.date), ['2026-02-30', '2026-13-01'])
  assert.deepEqual(findInvalidVerifyAfterDates(''), [])
})

test('findStaleOverdueLabels — a not-yet-due date clears (label was never warranted) (#966)', () => {
  const considered = [{ number: 5, repo: null, labels: OVERDUE, body: openBox('2027-01-01') }]
  assert.deepEqual(findStaleOverdueLabels(considered, '2026-07-09').map((i) => i.number), [5])
})

test('findStaleOverdueLabels — a blockquoted date does not hold the label open (#966)', () => {
  const considered = [{ number: 6, repo: null, labels: OVERDUE, body: '> quoted verify-after 2026-01-01 note' }]
  assert.deepEqual(findStaleOverdueLabels(considered, '2026-07-09').map((i) => i.number), [6])
})

test('findStaleOverdueLabels — same number in different repos does not collide (#966)', () => {
  const considered = [
    { number: 41, repo: null, labels: OVERDUE, body: openBox('2026-07-02') }, // overdue → keep
    { number: 41, repo: 'o/aiwatch-reports', labels: OVERDUE, body: '- [x] verify-after 2026-07-02' }, // clear
  ]
  const stale = findStaleOverdueLabels(considered, '2026-07-09')
  assert.equal(stale.length, 1)
  assert.equal(stale[0].repo, 'o/aiwatch-reports')
  // tickedKeys must also be repo-scoped: ticking the sibling's line must not clear the main repo's.
  const ticked = new Set(['o/aiwatch-reports#41#0'])
  assert.deepEqual(findStaleOverdueLabels(considered, '2026-07-09', ticked).map((i) => i.repo),
    ['o/aiwatch-reports'])
})

test('findStaleOverdueLabels — multiple lines: one still overdue keeps the label', () => {
  const body = [openBox('2026-01-01'), openBox('2027-01-01')].join('\n')
  const considered = [{ number: 7, repo: null, labels: OVERDUE, body }]
  assert.deepEqual(findStaleOverdueLabels(considered, '2026-07-09'), []) // 2026-01-01 still overdue
})

test('findStaleOverdueLabels — empty / bodyless inputs are safe', () => {
  assert.deepEqual(findStaleOverdueLabels([], '2026-07-09'), [])
  assert.deepEqual(findStaleOverdueLabels(null, '2026-07-09'), [])
  assert.deepEqual(findStaleOverdueLabels([{ number: 1, repo: null, labels: OVERDUE, body: '' }], '2026-07-09')
    .map((i) => i.number), [1]) // no verify-after line at all → nothing holds it open
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


// ── #1037 — closed-issue label scars ────────────────────────────────────────────
// The bug: every self-heal here derives from an OPEN issue's body and the scan is `--state open`, so a
// lifecycle label still on at close time is stranded forever. #966 was filed on exactly that evidence
// (#857) but only fixed the open case. Closed IS the terminal state → the labels are unconditionally
// meaningless, so these assert the no-date-logic rule.

test('planClosedScarRemovals — a closed issue wearing a lifecycle label is planned for removal', () => {
  const plan = planClosedScarRemovals([{ number: 857, repo: null, labels: [{ name: 'verify-overdue' }] }])
  assert.deepEqual(plan, [{ repo: null, number: 857, labels: ['verify-overdue'] }])
})

test('planClosedScarRemovals — groups ALL of one issue\'s stale labels into a single edit (#547 wore all three)', () => {
  const plan = planClosedScarRemovals([
    { number: 547, repo: null, labels: [{ name: 'verify-overdue' }, { name: 'verify-blocked' }, { name: 'body-drift' }] },
  ])
  assert.equal(plan.length, 1, 'one issue → one edit, not one per label')
  assert.deepEqual(plan[0].labels, ['verify-overdue', 'verify-blocked', 'body-drift'])
})

test('planClosedScarRemovals — leaves non-lifecycle labels alone', () => {
  const plan = planClosedScarRemovals([
    { number: 1, repo: null, labels: [{ name: 'bug' }, { name: 'area:ops' }, { name: 'verify-blocked' }] },
  ])
  assert.deepEqual(plan[0].labels, ['verify-blocked'], 'only lifecycle labels are stripped')
})

test('planClosedScarRemovals — an issue with no lifecycle label is skipped entirely', () => {
  assert.deepEqual(planClosedScarRemovals([{ number: 2, repo: null, labels: [{ name: 'bug' }] }]), [])
  assert.deepEqual(planClosedScarRemovals([]), [])
  assert.deepEqual(planClosedScarRemovals(null), [])
})

test('planClosedScarRemovals — carries the repo through for the sibling scan', () => {
  const plan = planClosedScarRemovals([
    { number: 54, repo: 'bentleypark/aiwatch-reports', labels: [{ name: 'verify-blocked' }] },
  ])
  assert.equal(plan[0].repo, 'bentleypark/aiwatch-reports')
})

test('planClosedScarRemovals — accepts plain string labels (hasLabel dual shape)', () => {
  assert.deepEqual(planClosedScarRemovals([{ number: 3, repo: null, labels: ['body-drift'] }]),
    [{ repo: null, number: 3, labels: ['body-drift'] }])
})

test('mergeClosedIssues — one issue returned by two per-label queries yields ONE entry, labels unioned', () => {
  // The fetch runs one query per label, so an issue wearing two comes back twice. Without the merge it
  // would get one edit per label — the exact waste the grouping exists to avoid.
  const merged = mergeClosedIssues([
    [{ number: 547, repo: null, labels: [{ name: 'verify-overdue' }, { name: 'body-drift' }] }],
    [{ number: 547, repo: null, labels: [{ name: 'verify-overdue' }, { name: 'verify-blocked' }] }],
  ])
  assert.equal(merged.length, 1)
  const plan = planClosedScarRemovals(merged)
  assert.equal(plan.length, 1)
  assert.deepEqual(plan[0].labels, ['verify-overdue', 'verify-blocked', 'body-drift'])
})

test('mergeClosedIssues — same number in DIFFERENT repos stays distinct (sibling scan collides on numbers)', () => {
  const merged = mergeClosedIssues([
    [{ number: 54, repo: null, labels: [{ name: 'verify-blocked' }] }],
    [{ number: 54, repo: 'bentleypark/aiwatch-reports', labels: [{ name: 'verify-blocked' }] }],
  ])
  assert.equal(merged.length, 2, 'repo is part of the identity')
})

test('mergeClosedIssues — flattens the REAL caller shape: repo[] of label[] of issue[]', () => {
  // Regression pin. The caller nests per-repo over per-label (`repos.map(fetchClosedScars)`), so the
  // input is THREE levels deep. A one-level flat yielded arrays instead of issues and silently dropped
  // every scar — green tests, zero effect in production. Mirror the caller's shape exactly.
  const perRepoPerLabel = [
    // repo A → [verify-overdue[], verify-blocked[], body-drift[]]
    [
      [{ number: 857, repo: null, labels: [{ name: 'verify-overdue' }] }],
      [{ number: 547, repo: null, labels: [{ name: 'verify-blocked' }] }],
      [],
    ],
    // repo B (sibling) → same shape
    [
      [],
      [{ number: 41, repo: 'bentleypark/aiwatch-reports', labels: [{ name: 'verify-blocked' }] }],
      [],
    ],
  ]
  const plan = planClosedScarRemovals(mergeClosedIssues(perRepoPerLabel))
  assert.equal(plan.length, 3, 'every scar across both repos is planned')
  assert.deepEqual(plan.map((p) => p.number).sort((a, b) => a - b), [41, 547, 857])
})

test('mergeClosedIssues — tolerates empty input', () => {
  assert.deepEqual(mergeClosedIssues([]), [])
  assert.deepEqual(mergeClosedIssues(null), [])
})

test('mergeClosedIssues — WARNS on a shape-drifted entry instead of dropping it silently', () => {
  // A silent drop is how the one-level-flat bug hid: 0 scars reads exactly like a clean board. This
  // file's #966 guards exist on the rule that a dropped reminder must never look like a quiet day, and
  // the sweep must honor it too.
  const warnings = []
  const merged = mergeClosedIssues([[null, { labels: [] }]], (m) => warnings.push(m))
  assert.deepEqual(merged, [], 'the malformed entry is still skipped')
  assert.equal(warnings.length, 2, 'but every skip is announced')
  assert.match(warnings[0], /shape drift/)
})

test('LIFECYCLE_LABELS — covers exactly the labels this job applies', () => {
  assert.deepEqual([...LIFECYCLE_LABELS].sort(),
    ['body-drift', 'verify-blocked', 'verify-overdue', 'verify-undecidable'])
})

test('CLOSED_SCAR_LIMIT — a page size the fetch can compare against to warn on truncation', () => {
  assert.equal(typeof CLOSED_SCAR_LIMIT, 'number')
  assert.ok(CLOSED_SCAR_LIMIT > 0)
})

// ── #1206: undecidable verify-after + overdue escalation ────────────────────────

// Fixed clock. findUndecidableVerifyAfter is now window-scoped (not-yet-due), so a test that
// relied on the real date would start failing the moment the calendar passed its fixtures.
const NOW = '2026-08-05'
const VA = (date, note = 'check the thing') => `- [ ] **verify-after ${date}** — ${note}`
const ASSERT = '      assert: GET /api/status | services[id=claude].status == "operational"'
const DURABLE = '      durable: incidents:monthly:2026-08 (60d retention, outlives the date)'

test('parseDurableLine — reads the artifact, tolerates case/indent, rejects everything else', () => {
  assert.equal(parseDurableLine('      durable: incidents:monthly:2026-08'), 'incidents:monthly:2026-08')
  assert.equal(parseDurableLine('DURABLE:   Discord #ops-alerts  '), 'Discord #ops-alerts')
  assert.equal(parseDurableLine('durable:'), null, 'a marker naming nothing is not an answer')
  assert.equal(parseDurableLine('   durable'), null)
  assert.equal(parseDurableLine('this line mentions durable: things in prose'), null, 'must be the whole line')
  assert.equal(parseDurableLine(ASSERT), null)
})

test('findUndecidableVerifyAfter — an assert: OR a durable: makes a line decidable', () => {
  assert.equal(findUndecidableVerifyAfter(VA('2026-09-01'), NOW).length, 1, 'bare dated line is undecidable')
  assert.equal(findUndecidableVerifyAfter(`${VA('2026-09-01')}\n${ASSERT}`, NOW).length, 0, 'assert: decides it')
  assert.equal(findUndecidableVerifyAfter(`${VA('2026-09-01')}\n${DURABLE}`, NOW).length, 0, 'durable: decides it')
  assert.equal(findUndecidableVerifyAfter(`${VA('2026-09-01')}\n${DURABLE}\n${ASSERT}`, NOW).length, 0, 'both')
})

test('findUndecidableVerifyAfter — skips lines the reminder scan already suppresses', () => {
  assert.equal(findUndecidableVerifyAfter(`- [x] **verify-after 2026-09-01** — done`, NOW).length, 0, 'checked box')
  assert.equal(findUndecidableVerifyAfter(`> ${VA('2026-09-01')}`, NOW).length, 0, 'blockquote (#966)')
  assert.equal(findUndecidableVerifyAfter('', NOW).length, 0)
  assert.equal(findUndecidableVerifyAfter(null, NOW).length, 0)
  // An invalid date is findInvalidVerifyAfterDates' job — flagging it twice would double-label.
  assert.equal(findUndecidableVerifyAfter('- [ ] **verify-after 2026-02-30** — typo', NOW).length, 0)
})

test('findUndecidableVerifyAfter — reports each undecidable line, not just the first', () => {
  const body = [VA('2026-09-01', 'first'), ASSERT, VA('2026-09-02', 'second'), VA('2026-09-03', 'third')].join('\n')
  assert.deepEqual(findUndecidableVerifyAfter(body, NOW).map((i) => i.date), ['2026-09-02', '2026-09-03'])
})

test('hasUndecidableLabel — reads gh label objects and plain strings', () => {
  assert.equal(hasUndecidableLabel([{ name: 'verify-undecidable' }]), true)
  assert.equal(hasUndecidableLabel(['verify-undecidable']), true)
  assert.equal(hasUndecidableLabel([{ name: 'verify-overdue' }]), false)
  assert.equal(hasUndecidableLabel([]), false)
  assert.equal(hasUndecidableLabel(undefined), false)
})

test('OVERDUE_ESCALATION_DAYS — four unanswered weekly pings, the rationale the source gives', () => {
  // NOT "above the 27-day worst case" — that figure came from a bad grep and is retracted; the
  // measured worst case on the board when this shipped was 6 days. The number is justified by the
  // ping cadence instead, so pin it to that: 4 x the weekly interval.
  assert.equal(typeof OVERDUE_ESCALATION_DAYS, 'number')
  assert.equal(OVERDUE_ESCALATION_DAYS, 30)
  assert.ok(OVERDUE_ESCALATION_DAYS >= 4 * 7, 'at least four weekly pings must have gone unanswered')
})

test('findOverdueEscalations — fires only past the threshold, worst line first', () => {
  const iss = (number, date) => ({ number, title: `t${number}`, body: VA(date), labels: [] })
  const today = '2026-08-05'
  const out = findOverdueEscalations([
    iss(1, '2026-07-01'), // 35d
    iss(2, '2026-07-20'), // 16d — under the bar
    iss(3, '2026-06-01'), // 65d
    iss(4, '2026-09-01'), // future
  ], today)
  assert.deepEqual(out.map((e) => e.number), [3, 1], 'only the escalated ones, oldest first')
  assert.equal(out[0].days, 65)
  assert.equal(out[1].days, 35)
})

test('findOverdueEscalations — exactly AT the threshold escalates', () => {
  const at = { number: 1, title: 't', body: VA('2026-07-06'), labels: [] } // 30d before 2026-08-05
  assert.equal(findOverdueEscalations([at], '2026-08-05').length, 1)
  const under = { number: 2, title: 't', body: VA('2026-07-07'), labels: [] } // 29d
  assert.equal(findOverdueEscalations([under], '2026-08-05').length, 0)
})

test('findOverdueEscalations — an assert-carrying line never escalates', () => {
  // It is not waiting on a human; the auto-verify pass drains it the moment the signal lands.
  const body = `${VA('2026-06-01')}\n${ASSERT}`
  assert.equal(findOverdueEscalations([{ number: 1, title: 't', body, labels: [] }], '2026-08-05').length, 0)
  // ...but a durable: one DOES — a named artifact still needs a human to go and read it.
  const durableBody = `${VA('2026-06-01')}\n${DURABLE}`
  assert.equal(findOverdueEscalations([{ number: 2, title: 't', body: durableBody, labels: [] }], '2026-08-05').length, 1)
})

test('findOverdueEscalations — a line ticked THIS run is not escalated', () => {
  const iss = { repo: null, number: 7, title: 't', body: VA('2026-06-01'), labels: [] }
  assert.equal(findOverdueEscalations([iss], '2026-08-05').length, 1, 'escalates without the tick')
  assert.equal(findOverdueEscalations([iss], '2026-08-05', new Set(['#7#0'])).length, 0, 'and not with it')
})

test('findOverdueEscalations — one row per LINE, so it can be joined against the per-line due list', () => {
  // A per-issue rollup keyed to the worst line silently mismatched `due` (which is per line): the
  // escalation vanished when the worst line was not the one firing that day, and the same issue
  // appeared in BOTH embeds when two lines fired together.
  const body = [VA('2026-07-01', 'newer'), VA('2026-06-01', 'older')].join('\n')
  const out = findOverdueEscalations([{ number: 1, title: 't', body, labels: [] }], '2026-08-05')
  assert.equal(out.length, 2, 'both over-threshold lines are reported')
  assert.deepEqual(out.map((e) => e.note), ['older', 'newer'], 'oldest first')
  assert.deepEqual(out.map((e) => e.date), ['2026-06-01', '2026-07-01'])
})

test('buildReminderEmbeds — routine and escalated are separate embeds, each omitted when empty', () => {
  const routine = [{ ref: '#1', title: 'a', note: 'look', date: '2026-08-05', overdueDays: 0 }]
  const esc = [{ ref: '#2', title: 'b', note: 'decide', date: '2026-06-01', overdueDays: 65 }]
  assert.equal(buildReminderEmbeds(routine, []).length, 1)
  assert.equal(buildReminderEmbeds([], esc).length, 1)
  const both = buildReminderEmbeds(routine, esc)
  assert.equal(both.length, 2)
  assert.match(both[0].title, /verification due/)
  assert.match(both[1].title, /needs a disposition/)
  assert.match(both[1].description, /reopen trigger/, 'the escalation says what the disposition IS')
  assert.match(both[1].description, new RegExp(String(OVERDUE_ESCALATION_DAYS)), 'and names the window')
  assert.ok(!both[0].description.includes('#2'), 'an escalated item is not ALSO in the routine list')
  assert.equal(buildReminderEmbeds([], []).length, 0)
})

// Real-shape assertion: #827's actual `## Production-gated verification` block, verbatim as it stood
// on 2026-08-05. Synthetic fixtures pin the grammar; this pins the grammar people actually WRITE —
// bold markers, em-dashes, backticked prose, a real indented assert:, and a mix of ticked/unticked.
const REAL_827_BLOCK = [
  '## Production-gated verification',
  '',
  '- [x] **verify-after 2026-07-14** — F2 Phase 1 RAG grounding block in the AI-analysis prompt. **Verified via `incident-history.test.ts`** — deterministic pin. _closed on test evidence 2026-07-08_',
  '- [x] **verify-after 2026-07-07** — corpus keystone: `incident:history:{svcId}` KV created on resolution. **VERIFIED with real prod data 2026-07-08**.',
  '- [x] **verify-after 2026-08-05** — monthly aggregate (F1 daily accuracy line + F3 precondition). Machine-checkable:',
  '      assert: GET /api/report?month=2026-07 | predictionAccuracy.total >= 1',
  '- [x] **verify-after 2026-07-14** — F4 predicted-vs-actual across the 6 surfaces. **Verified via `incident-history.test.ts:55`**.',
  '- [ ] **verify-after 2026-08-05** — F3 (the one remaining, report-site + time-gated): after the July monthly archive builds (~Aug 1), build the aiwatch-reports "AI Prediction Accuracy" section from `/api/report` (worker side #840 already live).',
].join('\n')

// The open F3 line is dated 2026-08-05, so exercise the window the guard actually acts in: BEFORE
// the date, when adding instrumentation or naming an artifact is still cheap.
const BEFORE_827_DUE = '2026-08-01'

test('real #827 block — flags the one open human-ping line and nothing else', () => {
  const found = findUndecidableVerifyAfter(REAL_827_BLOCK, BEFORE_827_DUE)
  assert.equal(found.length, 1, `exactly the open F3 line: ${JSON.stringify(found.map((f) => f.date))}`)
  assert.equal(found[0].date, '2026-08-05')
  assert.match(found[0].note, /F3/)
  // The ticked assert-carrying line must not be flagged — it is both checked AND decidable, and
  // double-flagging a satisfied line is how a label becomes noise nobody reads.
  assert.ok(!found.some((f) => /Machine-checkable/.test(f.note)))
})

test('real #827 block — adding a durable: line to the open item clears the flag', () => {
  const fixed = REAL_827_BLOCK.replace(
    /(- \[ \] \*\*verify-after 2026-08-05\*\*[^\n]*)/,
    '$1\n      durable: aiwatch-reports/_data/2026-07.json (committed archive snapshot, permanent)',
  )
  assert.equal(findUndecidableVerifyAfter(fixed, BEFORE_827_DUE).length, 0, 'naming the artifact is what clears it')
})

test('real #827 block — the flag hands off to verify-overdue once the date arrives', () => {
  // Not a gap: past the date the item is in the ping → escalation flow, and a second permanently-lit
  // label on the same issue is the failure mode this guard exists to avoid.
  assert.equal(findUndecidableVerifyAfter(REAL_827_BLOCK, BEFORE_827_DUE).length, 1, 'flagged while pending')
  assert.equal(findUndecidableVerifyAfter(REAL_827_BLOCK, '2026-08-05').length, 0, 'silent on the due date')
  assert.equal(findUndecidableVerifyAfter(REAL_827_BLOCK, '2026-09-05').length, 0, 'and after it')
})

test('real #827 block — the assert: line still parses inside the real body', () => {
  // Guards the sub-block scan against the real indentation/prose, not just the synthetic fixture.
  const withAssert = pairVerifyAssertions(REAL_827_BLOCK).filter((i) => i.assertion)
  assert.equal(withAssert.length, 0, 'the assert-carrying line is CHECKED, so the open-line scan skips it')
  const reopened = REAL_827_BLOCK.replace('- [x] **verify-after 2026-08-05** — monthly aggregate', '- [ ] **verify-after 2026-08-05** — monthly aggregate')
  const nowOpen = pairVerifyAssertions(reopened).filter((i) => i.assertion)
  assert.equal(nowOpen.length, 1, 'and it is found once that line is open')
  assert.equal(nowOpen[0].assertion.selector, 'predictionAccuracy.total')
})

// ── #1206 wiring: the join between `due` and the escalation list ────────────────
// Extracted from main() precisely because every mutation of the inlined version survived the suite:
// dropping the escalation argument to postDiscord, removing the firing filter, or leaving an
// escalated line in both buckets. Pure fn green is not wiring green (feedback_mutation_test_both_directions).

const DUE = (number, date, repo = null, lineIndex = 0) => ({ number, repo, ref: displayRef(repo, number, {}), title: `t${number}`, date, note: 'n', lineIndex, overdueDays: 0 })
const ESC = (number, date, days, repo = null, lineIndex = 0) => ({ number, repo, title: `t${number}`, date, note: 'n', days, lineIndex })

test('reminderLineKey — identifies a LINE, so two same-date lines do not collide', () => {
  // Keying on the date collapsed them: if one escalated, the other was stripped from the routine
  // bucket too and vanished from Discord, with verify-overdue still applied so nothing looked wrong.
  assert.notEqual(
    reminderLineKey({ repo: null, number: 9, date: '2026-06-01', lineIndex: 3 }),
    reminderLineKey({ repo: null, number: 9, date: '2026-06-01', lineIndex: 4 }),
  )
  // ...and the repo still separates a sibling issue with the same number.
  assert.notEqual(
    reminderLineKey({ repo: 'o/aiwatch', number: 41, lineIndex: 0 }),
    reminderLineKey({ repo: 'o/aiwatch-reports', number: 41, lineIndex: 0 }),
  )
  assert.equal(reminderLineKey({ repo: null, number: 41, lineIndex: 2 }), '#41#2')
})

test('splitEscalatedDue — an escalated line moves buckets, it is never in both', () => {
  const due = [DUE(1, '2026-08-05'), DUE(2, '2026-06-01')]
  const { routineDue, escalatedNow } = splitEscalatedDue(due, [ESC(2, '2026-06-01', 65)])
  assert.deepEqual(routineDue.map((d) => d.number), [1], 'the escalated line leaves the routine list')
  assert.deepEqual(escalatedNow.map((e) => e.number), [2])
  assert.equal(escalatedNow[0].overdueDays, 65, 'and carries its age for the embed')
  assert.equal(escalatedNow[0].ref, '#2')
})

test('splitEscalatedDue — only escalations FIRING this run are posted', () => {
  // A standing escalation not on its weekly cadence must stay silent; posting daily is the spam the
  // `% 7` throttle exists to prevent.
  const { routineDue, escalatedNow } = splitEscalatedDue([DUE(1, '2026-08-05')], [ESC(2, '2026-06-01', 65)])
  assert.equal(escalatedNow.length, 0, 'not firing → not posted')
  assert.deepEqual(routineDue.map((d) => d.number), [1], 'and the routine list is untouched')
})

test('splitEscalatedDue — a multi-line issue splits per line, not per issue', () => {
  // The exact shape that broke the per-issue rollup: one line escalated, one merely due, same issue.
  const due = [DUE(7, '2026-06-03', null, 0), DUE(7, '2026-07-25', null, 1)]
  const { routineDue, escalatedNow } = splitEscalatedDue(due, [ESC(7, '2026-06-03', 63, null, 0)])
  assert.deepEqual(escalatedNow.map((e) => e.date), ['2026-06-03'])
  assert.deepEqual(routineDue.map((d) => d.date), ['2026-07-25'], 'the younger line stays routine')
})

test('splitEscalatedDue — two lines sharing a DATE are still distinct (4 open issues look like this)', () => {
  // A machine-checked part and a human-checked part dated the same day. Only the human one escalates;
  // the assert-carrying one must stay in the routine bucket rather than disappear with it.
  const due = [DUE(9, '2026-06-01', null, 4), DUE(9, '2026-06-01', null, 7)]
  const { routineDue, escalatedNow } = splitEscalatedDue(due, [ESC(9, '2026-06-01', 65, null, 7)])
  assert.deepEqual(escalatedNow.map((e) => e.lineIndex), [7])
  assert.deepEqual(routineDue.map((d) => d.lineIndex), [4], 'the sibling line is NOT swallowed')
})

test('splitEscalatedDue — matches on repo too, so a sibling escalation is not lost', () => {
  const due = [DUE(41, '2026-06-01', 'o/aiwatch-reports')]
  const sameNumberOtherRepo = [ESC(41, '2026-06-01', 65, 'o/aiwatch')]
  assert.equal(splitEscalatedDue(due, sameNumberOtherRepo).escalatedNow.length, 0, 'a different repo is a different line')
  const matching = [ESC(41, '2026-06-01', 65, 'o/aiwatch-reports')]
  assert.equal(splitEscalatedDue(due, matching).escalatedNow.length, 1)
})

test('splitEscalatedDue — empty / absent inputs are safe', () => {
  assert.deepEqual(splitEscalatedDue([], []), { routineDue: [], escalatedNow: [] })
  assert.deepEqual(splitEscalatedDue(undefined, undefined), { routineDue: [], escalatedNow: [] })
})

test('the closed-issue sweep actually strips verify-undecidable (#1037 consumer, not the constant)', () => {
  // Asserting LIFECYCLE_LABELS' contents is a prose mirror of the constant; this pins the CONSUMER,
  // so hardcoding the old three-label list inside planClosedScarRemovals fails.
  const planned = planClosedScarRemovals([{ number: 9, labels: [{ name: 'verify-undecidable' }, { name: 'verify-overdue' }] }])
  assert.equal(planned.length, 1)
  assert.deepEqual(planned[0].labels.sort(), ['verify-overdue', 'verify-undecidable'])
})

test('findUndecidableVerifyAfter — a calendar-invalid date is never flagged, even when it rolls FORWARD', () => {
  // 2026-02-30 rolls to 2026-03-02. At NOW that is in the past, so the not-yet-due scope hides it and
  // the isValidIsoDate guard reads as inert; at a January clock it is in the FUTURE and only the guard
  // stops it being double-labelled alongside findInvalidVerifyAfterDates.
  const body = '- [ ] **verify-after 2026-02-30** — typo'
  assert.equal(findUndecidableVerifyAfter(body, '2026-01-01').length, 0)
  assert.equal(findInvalidVerifyAfterDates(body).length, 1, 'and it IS reported, by the scanner that owns it')
})
