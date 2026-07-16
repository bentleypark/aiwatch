// #541 — unit tests for the verify-after reminder logic. Run with `npm run test:scripts`
// (= `node --test "scripts/*.test.mjs"`). Uses node:test (no vitest) since this is a CI/automation
// script, not src/worker code.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseVerifyAfter, daysSinceDue, shouldFire, isValidIsoDate, parseTrustedAuthors, parseScanRepos, displayRef, findBodyDrift, isDriftCandidate, hasBodyDriftLabel, hasLabel, findStaleOverdueLabels, findInvalidVerifyAfterDates, planClosedScarRemovals, mergeClosedIssues, LIFECYCLE_LABELS, CLOSED_SCAR_LIMIT } from './verify-reminders.mjs'

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

test('LIFECYCLE_LABELS — covers exactly the three labels this job applies', () => {
  assert.deepEqual([...LIFECYCLE_LABELS].sort(), ['body-drift', 'verify-blocked', 'verify-overdue'])
})

test('CLOSED_SCAR_LIMIT — a page size the fetch can compare against to warn on truncation', () => {
  assert.equal(typeof CLOSED_SCAR_LIMIT, 'number')
  assert.ok(CLOSED_SCAR_LIMIT > 0)
})
