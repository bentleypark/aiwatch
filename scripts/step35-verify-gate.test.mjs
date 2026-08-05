// #657 — unit tests for the hard-deny step-3.5 gate's pure decision logic. Run with
// `npm run test:scripts` (= `node --test scripts/*.test.mjs`). The CLI/IO (transcript read, git diff,
// deny JSON) is covered by the artifact check in the PR; here we pin the unfabricable-signal logic.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isUiEdgePath, lastUiEditIndex, hasUserTurnAfter, decideCommit, CONFIRM_RE, OVERRIDE_RE, HOOK_WORK_RE, auditLine,
  HOOK_WORK_EXAMPLES, COMMIT_OVERRIDE_EXAMPLES, ADVICE,
  readEntries,
} from '../.claude/hooks/step35-verify-gate.mjs'

// ── fixtures matching the real transcript JSONL shape ──
const edit = (file_path) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path } }] } })
const bashWrite = (command) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } })
// Real human prompts store message.content as a STRING (verified against the live transcript schema).
const userText = (text, extra = {}) => ({ type: 'user', isMeta: false, isSidechain: false, message: { content: text }, ...extra })
// Some clients use an array with a leading text block — must also be detected.
const userTextArr = (text, extra = {}) => ({ type: 'user', isMeta: false, isSidechain: false, message: { content: [{ type: 'text', text }] }, ...extra })
// A tool-result turn is type:user with an ARRAY whose first block is tool_result — NOT a human message.
// The content must be text CONFIRM_RE actually matches: with filler like 'ok' (which it does not match)
// every assertion using this fixture was `false === false` and passed no matter what the array-shape
// filter did — the vacuity #1150's review found in three sibling assertions.
const toolResult = () => ({ type: 'user', isMeta: false, message: { content: [{ type: 'tool_result', content: '확인했고 잘 나옴' }] } })

test('isUiEdgePath — dashboard + Edge SSR are UI; worker/docs/tests are not', () => {
  assert.equal(isUiEdgePath('src/pages/Overview.jsx'), true)
  assert.equal(isUiEdgePath('src/locales/ko.js'), true)
  assert.equal(isUiEdgePath('api/_is-down/html-template.ts'), true) // Edge helper dirs are `_`-prefixed (#862)
  assert.equal(isUiEdgePath('api/_intro/html-template.ts'), true)
  // #1023 — the other user-facing Edge SSR pages (the blind spot that let the #1019 /methodology commit through)
  assert.equal(isUiEdgePath('api/_methodology/html-template.ts'), true)
  assert.equal(isUiEdgePath('api/_badges/html-template.ts'), true)
  assert.equal(isUiEdgePath('api/_plugin/html-template.ts'), true)
  assert.equal(isUiEdgePath('api/methodology.ts'), true)          // inline-content Function file form
  assert.equal(isUiEdgePath('api/plugin-privacy.ts'), true)       // NOT shadowed by `plugin`
  assert.equal(isUiEdgePath('api/extension-privacy.ts'), true)
  assert.equal(isUiEdgePath('api/confirm.ts'), true)
  assert.equal(isUiEdgePath('api/plugin.ts'), true)
  // #1023 — deliberately EXCLUDED (not human-rendered pages)
  assert.equal(isUiEdgePath('api/reports.ts'), false)            // proxy → aiwatch-reports, no own render
  assert.equal(isUiEdgePath('api/csp-report.ts'), false)         // violation sink
  assert.equal(isUiEdgePath('api/_shared/extension-cta.ts'), false) // shared helper (scoped out)
  // #1023 — prefix-collision guards (the `(?:/|\.tsx?)` boundary must not let a page name prefix a foreign file)
  assert.equal(isUiEdgePath('api/plugin-something.ts'), false)   // `plugin` must not shadow-match this
  assert.equal(isUiEdgePath('api/methodology-helper.ts'), false)
  assert.equal(isUiEdgePath('api/introspect.ts'), false)         // `intro` prefix
  assert.equal(isUiEdgePath('api/badge.ts'), false)              // page is `badges`, not `badge`
  assert.equal(isUiEdgePath('worker/src/services.ts'), false)
  assert.equal(isUiEdgePath('docs/reference/x.md'), false)
  assert.equal(isUiEdgePath('src/utils/__tests__/constants.test.js'), false) // test excluded
  assert.equal(isUiEdgePath('api/__tests__/methodology.test.ts'), false)     // test excluded even for a page name
  assert.equal(isUiEdgePath('tests/overview.spec.js'), false)
})

test('isUiEdgePath — absolute paths (Edit tool supplies absolute file_path, #664)', () => {
  // The Edit/Write tools require an absolute file_path — the gate must classify these too, else
  // lastUiEditIndex never finds a UI edit and every UI commit fail-closes.
  assert.equal(isUiEdgePath('/Users/x/dev/aiwatch/src/pages/ServiceDetails.jsx'), true)
  assert.equal(isUiEdgePath('/Users/x/dev/aiwatch/api/_is-down/html-template.ts'), true)
  assert.equal(isUiEdgePath('/Users/x/dev/aiwatch/worker/src/services.ts'), false) // absolute worker/src excluded
  assert.equal(isUiEdgePath('/Users/x/dev/aiwatch/src/utils/__tests__/calendar.test.js'), false) // absolute test excluded
  // worker/src/ guard runs before the api/src match → a worker path nesting api/_is-down stays non-UI (ordering pin)
  assert.equal(isUiEdgePath('worker/src/parsers/api/_is-down/x.ts'), false)
})

test('lastUiEditIndex — picks the last UI/Edge edit (Edit + Bash write); -1 when none', () => {
  assert.equal(lastUiEditIndex([userText('hi'), edit('src/a.jsx'), userText('ok')]), 1)
  assert.equal(lastUiEditIndex([edit('src/a.jsx'), edit('worker/src/b.ts'), edit('src/c.jsx')]), 2) // worker edit doesn't reset
  assert.equal(lastUiEditIndex([bashWrite('cat > src/x.js <<EOF\n...')]), 0)
  // #1023 — BASH_WRITE_RE also catches a heredoc/redirect write to the newly-covered Edge pages
  assert.equal(lastUiEditIndex([bashWrite('cat > api/_methodology/html-template.ts <<EOF\n...')]), 0)
  assert.equal(lastUiEditIndex([bashWrite('cat > api/plugin-privacy.ts <<EOF\n...')]), 0) // Function-file form
  assert.equal(lastUiEditIndex([bashWrite('cat > api/reports.ts <<EOF\n...')]), -1)        // proxy excluded
  assert.equal(lastUiEditIndex([edit('worker/src/b.ts'), edit('docs/x.md')]), -1) // no UI edit
  // #664 — absolute file_path (what the Edit tool actually supplies) must be found, not -1
  assert.equal(lastUiEditIndex([userText('hi'), edit('/Users/x/aiwatch/src/pages/Overview.jsx')]), 1)
  assert.equal(lastUiEditIndex([edit('/Users/x/aiwatch/worker/src/b.ts')]), -1) // absolute worker edit isn't UI
})

test('hasUserTurnAfter — detects both string-content (real prompts) and array-text human turns', () => {
  assert.equal(hasUserTurnAfter([edit('src/a.jsx'), userText('확인했고 잘 나옴')], 0, CONFIRM_RE), true)      // string content
  assert.equal(hasUserTurnAfter([edit('src/a.jsx'), userTextArr('looks good')], 0, CONFIRM_RE), true)        // array-text content
})

test('hasUserTurnAfter — only a genuine human text turn counts (not meta/sidechain/tool_result)', () => {
  const e = [edit('src/a.jsx'), userText('확인했고 잘 나옴')]
  assert.equal(hasUserTurnAfter(e, 0, CONFIRM_RE), true)
  // meta + sidechain + tool_result turns are ignored. NOTE the fixture text must be one CONFIRM_RE
  // actually matches: '확인' and 'ok' do NOT match it, so the earlier fixtures asserted false === false and
  // passed no matter what the filters did — vacuous, on the property this fail-closed gate rests on (#1150).
  // Each line below now goes red if its filter is removed.
  assert.equal(hasUserTurnAfter([edit('src/a.jsx'), userText('확인했고 잘 나옴', { isMeta: true })], 0, CONFIRM_RE), false)
  assert.equal(hasUserTurnAfter([edit('src/a.jsx'), userText('잘 나옴', { isSidechain: true })], 0, CONFIRM_RE), false)
  assert.equal(hasUserTurnAfter([edit('src/a.jsx'), toolResult()], 0, CONFIRM_RE), false)
  // A COMPACTION SUMMARY is the impostor with no tag: type:user, isMeta:false, plain string content —
  // but AGENT-authored, and it quotes earlier user turns verbatim, so an old confirmation is replayed as
  // a fresh one. Reproduced on a real session: blanking only this turn flipped the gate from PASS to
  // DENY. Every compaction turn found in this project's transcripts matches CONFIRM_RE (#1150).
  const compaction = userText('This session is being continued from a previous conversation… The user said "확인했고 잘 나옴".', { isCompactSummary: true })
  assert.equal(hasUserTurnAfter([edit('src/a.jsx'), compaction], 0, CONFIRM_RE), false)
  // …and the same text WITHOUT the flag/tag does count, so none of these is an always-false read
  assert.equal(hasUserTurnAfter([edit('src/a.jsx'), userText('This session is being continued… The user said "확인했고 잘 나옴".')], 0, CONFIRM_RE), true)
  assert.equal(hasUserTurnAfter([edit('src/a.jsx'), userText('확인했고 잘 나옴')], 0, CONFIRM_RE), true)
  // EVERY alternative of HARNESS_WRAPPER_RE, not a sample: a `!cat`/`!npm` echo of a confirm word, an
  // agent-authored task-notification summary, or a slash-command body must never authorise this gate.
  for (const w of ['command-name', 'command-message', 'local-command-caveat', 'local-command-stdout', 'task-notification', 'system-reminder', 'bash-input', 'bash-stdout', 'bash-stderr']) {
    assert.equal(hasUserTurnAfter([edit('src/a.jsx'), userText(`<${w}>확인했고 잘 나옴</${w}>`)], 0, CONFIRM_RE), false, w)
  }
  // a confirm BEFORE the edit doesn't count
  assert.equal(hasUserTurnAfter([userText('잘 나옴'), edit('src/a.jsx')], 1, CONFIRM_RE), false)
})

test('decideCommit — allows non-UI commits without a confirmation', () => {
  assert.deepEqual(decideCommit([], [edit('worker/src/b.ts')]), { deny: false, reason: 'not-ui' })
})

test('decideCommit — DENIES a UI commit with no post-edit user confirmation (the recurring miss)', () => {
  const d = decideCommit(['src/pages/Overview.jsx'], [edit('src/pages/Overview.jsx'), toolResult()])
  assert.equal(d.deny, true)
  assert.equal(d.reason, 'no-confirmation')
})

test('decideCommit — ALLOWS once a genuine user confirmation follows the last UI edit', () => {
  const e = [edit('src/pages/Overview.jsx'), userText('확인했고 잘 나옴, 커밋해')]
  assert.deepEqual(decideCommit(['src/pages/Overview.jsx'], e), { deny: false, reason: 'confirmed' })
})

test('decideCommit — #664 end-to-end: relative staged + ABSOLUTE edit + confirm → ALLOWS (the exact bug)', () => {
  // The real invocation mixes formats: stagedUiEdge is git-relative; the edit event's file_path is
  // absolute (Edit tool). Before #664 the absolute edit was invisible → fail-closed despite a valid
  // confirmation. This pins that a verified UI commit now PASSES, not just that isUiEdgePath is true.
  const e = [edit('/Users/x/aiwatch/src/pages/Overview.jsx'), userText('브라우저 확인 OK, 커밋해')]
  assert.deepEqual(decideCommit(['src/pages/Overview.jsx'], e), { deny: false, reason: 'confirmed' })
})

test('decideCommit — #664: absolute UI edit with NO confirmation still DENIES (gate not weakened)', () => {
  const e = [edit('/Users/x/aiwatch/src/pages/Overview.jsx'), toolResult()]
  assert.equal(decideCommit(['src/pages/Overview.jsx'], e).deny, true)
})

test('decideCommit — a post-edit test/doc edit does NOT re-trigger the gate (confirmation still valid)', () => {
  // edit UI → user confirms → edit a test file (not UI) → commit. The last UI edit is index 0, the
  // confirmation is after it, so it stays allowed even though a later (non-UI) edit happened.
  const e = [edit('src/pages/Overview.jsx'), userText('잘 나옴'), edit('tests/overview.spec.js')]
  assert.deepEqual(decideCommit(['src/pages/Overview.jsx'], e), { deny: false, reason: 'confirmed' })
})

test('decideCommit — explicit override lifts the gate, tagged as `override` (false-positive proxy)', () => {
  const e = [edit('src/pages/Overview.jsx'), userText('검증 생략하고 커밋해줘')]
  assert.deepEqual(decideCommit(['src/pages/Overview.jsx'], e), { deny: false, reason: 'override' })
})

test('decideCommit — UI staged but no edit event in transcript → fail-closed deny (override-able)', () => {
  assert.equal(decideCommit(['src/pages/Overview.jsx'], [userText('hello')]).deny, true)
  assert.equal(decideCommit(['src/pages/Overview.jsx'], [userText('skip verify and commit')]).deny, false)
})

test('HOOK_WORK_RE — authorizes self-edits ONLY on stated intent toward the gate/hook (narrow)', () => {
  // Intent + target, in either order and either language.
  assert.match('훅 작업 진행', HOOK_WORK_RE)
  assert.match('게이트 수정 진행', HOOK_WORK_RE)
  assert.match('work on the gate hook', HOOK_WORK_RE)
  assert.match('훅 수정해줘', HOOK_WORK_RE)
  assert.match('훅 고쳐줘', HOOK_WORK_RE)
  assert.match('fix the hook', HOOK_WORK_RE)
  // must NOT authorize on incidental "gate"/"hook"/issue-number prose (would weaken self-protection)
  assert.doesNotMatch('add a category to the overview', HOOK_WORK_RE)
  assert.doesNotMatch('why does the gate keep firing', HOOK_WORK_RE)
  assert.doesNotMatch('update the gate component on the settings page', HOOK_WORK_RE)
  assert.doesNotMatch('fix issue #659 overview', HOOK_WORK_RE)
  // #1150 REMOVED the bare-name alternatives (`#657`, `step35`, `step-3.5 gate`): naming a thing is not
  // authorizing work on it, and `npm run hook-audit`'s own output contains this hook's name and issue
  // number — so pasting that report into the chat authorized the agent to edit its own gate. Both forms
  // below must now be refused; the cost is that the user states intent, which every real
  // authorization in this repo's history already did.
  assert.doesNotMatch('#657', HOOK_WORK_RE)
  assert.doesNotMatch('657 작업 진행', HOOK_WORK_RE)
  assert.doesNotMatch('step35 고쳐줘', HOOK_WORK_RE)
  assert.doesNotMatch('step-3.5 hard gate (#657):', HOOK_WORK_RE) // the report's own heading
})

test('CONFIRM_RE — matches real verification phrasing, NOT incidental 확인/ok prose', () => {
  for (const ok of ['확인했고 잘 나옴', '확인 완료', '확인 했어', '잘 나옴', '괜찮음', '문제없어요', '정상 작동', 'looks good', 'lgtm', 'verified', 'works fine']) {
    assert.match(ok, CONFIRM_RE)
  }
  // the false-positives the review found on real transcript prose — must NOT lift the gate
  for (const no of ['647 테스트 실패 확인', '확인 안 했어', '(a) OK, (b) later', 'ok now also add a button', '다음 작업 진행', 'okay so the layout is broken, fix it']) {
    assert.doesNotMatch(no, CONFIRM_RE)
  }
})

test('OVERRIDE_RE — sanity', () => {
  assert.match('검증 생략하고 커밋', OVERRIDE_RE)
  assert.match('skip verify and commit', OVERRIDE_RE)
})

test('hasUserTurnAfter — skips harness-injected user turns (command stdout / task-notification)', () => {
  // a slash-command stdout or task-notification is string-content + isMeta:false but NOT a human
  // confirmation; its text must never lift the gate even if it contains a confirm word.
  const e = [edit('src/a.jsx'), userText('<local-command-stdout>확인 완료</local-command-stdout>'), userText('<task-notification>잘 나옴</task-notification>')]
  assert.equal(hasUserTurnAfter(e, 0, CONFIRM_RE), false)
})

// CLI regression (#657): the flag check must read the command HEAD, not the commit MESSAGE body —
// a message that merely discusses "--no-verify" (this very commit did) must not be mistaken for it.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Isolate the gate's audit write to a throwaway log so these CLI runs don't pollute the real
// (gitignored) telemetry the #659 monitoring depends on.
const TMP_AUDIT = join(mkdtempSync(join(tmpdir(), 'step35-')), 'hook-audit.jsonl')
const runHook = (input) => {
  try { return execFileSync('node', ['.claude/hooks/step35-verify-gate.mjs'], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, HOOK_AUDIT_LOG: TMP_AUDIT } }) }
  catch (e) { return e.stdout || '' }
}
/** Drive EVERY deny path the gate has and return each RENDERED `permissionDecisionReason`, paired with
 *  the regex that branch consults. Rendering rather than reading the source is what makes the advice pin
 *  total — see the guard in the ADVICE test below for what source-scraping missed. */
function renderedDenies() {
  const dir = mkdtempSync(join(tmpdir(), 'step35-deny-'))
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' })
  git('init', '-q')
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'x.jsx'), 'export default () => null\n')
  git('add', 'src/x.jsx') // a staged UI file → the commit branch is reachable; no commit is ever made
  const transcript = (name, entries) => {
    const p = join(dir, name)
    writeFileSync(p, entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
    return p
  }
  const bare = transcript('bare.jsonl', [userText('아무 말')])
  const edited = transcript('edited.jsonl', [edit('src/x.jsx'), userText('아무 말')])
  const reasonOf = (input) => JSON.parse(runHook(input)).hookSpecificOutput.permissionDecisionReason
  const commit = { tool_name: 'Bash', tool_input: { command: 'git commit -m x' }, cwd: dir }
  return [
    { label: 'self-edit', accepts: () => HOOK_WORK_RE, reason: reasonOf({ tool_name: 'Edit', tool_input: { file_path: join(dir, '.claude', 'hooks', 'x.mjs') }, transcript_path: bare }) },
    { label: 'no-verify', accepts: () => OVERRIDE_RE, reason: reasonOf({ tool_name: 'Bash', tool_input: { command: 'git commit --no-verify -m x' }, cwd: '/tmp' }) },
    { label: 'commit:no-edit-event', accepts: () => OVERRIDE_RE, reason: reasonOf({ ...commit, transcript_path: bare }) },
    { label: 'commit:no-confirmation', accepts: () => OVERRIDE_RE, reason: reasonOf({ ...commit, transcript_path: edited }) },
    // A transcript path that EXISTS but cannot be read (a directory) throws inside the try → fail-closed.
    { label: 'fail-closed', accepts: () => OVERRIDE_RE, reason: reasonOf({ ...commit, transcript_path: dir }) },
  ]
}

test('CLI: a commit MESSAGE mentioning --no-verify is NOT blocked; the actual flag IS', () => {
  const msgBody = runHook({ tool_name: 'Bash', tool_input: { command: "git commit -F - <<'EOF'\ndocs: explain --no-verify usage\nEOF" }, cwd: '/tmp' })
  assert.doesNotMatch(msgBody, /deny/) // message-only mention → allowed
  const realFlag = runHook({ tool_name: 'Bash', tool_input: { command: 'git commit --no-verify -m x' }, cwd: '/tmp' })
  assert.match(realFlag, /"permissionDecision":"deny"/) // actual flag → denied
})

// #657 follow-up — audit logging so `npm run hook-audit` can observe this hard gate.
test('auditLine — emits a parseable JSONL line in the _audit.sh schema', () => {
  const line = auditLine('deny', 'commit:no-confirmation', '2026-06-14T00:00:00Z')
  const o = JSON.parse(line) // must be valid JSON (corrupt log = blind monitoring)
  assert.equal(o.hook, 'step35-verify-gate')
  assert.equal(o.decision, 'deny')
  assert.equal(o.note, 'commit:no-confirmation')
  assert.equal(o.ts, '2026-06-14T00:00:00Z')
  // Same field set/order as _audit.sh so the summary parser treats both identically.
  assert.deepEqual(Object.keys(o), ['ts', 'hook', 'decision', 'note'])
})

test('auditLine — single-lines + JSON-escapes the note so a stray char cannot corrupt the log', () => {
  const line = auditLine('deny', 'self-edit:src/a"b\\c\nnext', '2026-06-14T00:00:00Z')
  const o = JSON.parse(line) // would throw if escaping were wrong
  assert.equal(o.note, 'self-edit:src/a"b\\c next') // newline → space; quote/backslash preserved via JSON
  assert.equal(line.split('\n').length, 1) // never multi-line (one entry = one line)
})

test('auditLine — default ts is a Z-suffixed second-precision ISO timestamp', () => {
  assert.match(JSON.parse(auditLine('pass', 'commit:confirmed')).ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
})


test('readEntries tolerates a torn trailing line (the harness appends while we read) (#1150)', () => {
  // Not cosmetic: if a partial line threw, main()'s outer catch turns it into `fail-closed` + DENY, so
  // every UI commit made mid-append would be a false deny on this HARD gate.
  const dir = mkdtempSync(join(tmpdir(), 'step35-torn-'))
  const tp = join(dir, 't.jsonl')
  writeFileSync(tp, [
    JSON.stringify({ type: 'user', isMeta: false, message: { content: '확인했고 잘 나옴' } }),
    '{"type":"user","mess',
  ].join('\n'))
  const entries = readEntries(tp)
  assert.equal(entries.length, 1, 'the intact line survives, the torn one is skipped')
  assert.equal(hasUserTurnAfter(entries, -1, CONFIRM_RE), true)
})

test('the hook-audit report cannot authorise this gate when pasted into the chat (#1150)', () => {
  // `npm run hook-audit` echoes this gate's own notes and names. An operator pasting it types a genuine
  // role:user turn, which the harness-wrapper skip-list structurally cannot filter — and it used to lift
  // the UI/Edge commit gate (`commit:confirmed`) AND authorise .claude/hooks self-edits (the hook's own
  // name matched HOOK_WORK_RE). Both are producer-side now; this asserts the report stays inert.
  const dir = mkdtempSync(join(tmpdir(), 'step35-paste-'))
  const log = join(dir, 'audit.jsonl')
  // MAXIMAL fixture: every note kind either gate emits, so every CONDITIONAL line of the report renders.
  // A fixture of only the unconditional lines was vacuous one level down — the ❗ fail-closed line, the
  // 🔁 untracked-round line and the 🔁 fail-open line never appeared in the string under test, so a
  // reword introducing "확인했" or "fix the hook" into any of them would have passed.
  const at = (n) => `2026-07-28T00:${String(10 + n).padStart(2, '0')}:00Z`
  const notes = [
    ['step35-verify-gate', 'deny', 'commit:no-confirmation'],
    ['step35-verify-gate', 'deny', 'commit:no-edit-event'],
    ['step35-verify-gate', 'deny', 'no-verify'],
    ['step35-verify-gate', 'deny', 'fail-closed'],
    ['step35-verify-gate', 'deny', 'self-edit:/repo/.claude/hooks/step35-verify-gate.mjs'],
    ['step35-verify-gate', 'pass', 'commit:confirmed'],
    ['step35-verify-gate', 'pass', 'commit:override'],
    ['step35-verify-gate', 'pass', 'self-edit-authorized:/repo/.claude/hooks/review-loop-gate.mjs'],
    ['review-loop-gate', 'pass', 'round-4:s=sess1234'],
    ['review-loop-gate', 'pass', 'round-none:s=sess1234'],
    ['review-loop-gate', 'pass', 'fail-open:no-stdin'],
    ['review-loop-gate', 'pass', 'fail-open:no-prompt-field'],
    ['review-loop-gate', 'pass', 'fail-open:no-tool-input'],
    ['review-loop-gate', 'pass', 'fail-open:record-error'],
    // A note the hook ACTUALLY emits. This arm was `''` — a stub — so the report's one free-form producer
    // was never in the string under test: `stop-nag-gate.sh` used to append 120 chars of the assistant's
    // own closing line, which is exactly the step-3.5 hand-off shape ("브라우저에서 확인해 보시고
    // 문제없으면 커밋 진행할까요?") and made a pasted report satisfy CONFIRM_RE and HOOK_WORK_RE (#1150).
    ['stop-nag-gate', 'block', 'ko-auto-proceed'],
    ['git-mutation-gate', 'warn', 'no_verify=1'],
  ]
  writeFileSync(log, notes.map(([hook, decision, note], i) =>
    JSON.stringify({ ts: at(i), hook, decision, note })).join('\n') + '\n')
  const report = execFileSync('node', ['scripts/hook-audit-summary.mjs', '--days', '2', '--last', '25'],
    { encoding: 'utf8', env: { ...process.env, HOOK_AUDIT_LOG: log } })
  // the fixture must actually exercise every conditional line, or this passes by rendering nothing
  for (const marker of [/step-3\.5 hard gate/, /review-loop telemetry/, /❗ fail-closed=/, /no round declared=/, /fail-open=/, /override=/]) {
    assert.match(report, marker, `the fixture must render ${marker} for the guard below to mean anything`)
  }
  assert.equal(CONFIRM_RE.test(report), false, 'the report must not read as an in-browser confirmation')
  assert.equal(HOOK_WORK_RE.test(report), false, 'the report must not read as authorising hook self-edits')
  assert.equal(OVERRIDE_RE.test(report), false, 'the report must not read as a verification override')
  // …and a real human confirmation still works, so this is not satisfied by a broken CONFIRM_RE
  assert.equal(CONFIRM_RE.test('브라우저에서 확인했고 잘 나옴'), true)
  assert.equal(HOOK_WORK_RE.test('훅 작업 진행'), true)
  // The producer side of the same invariant: no hook may write free-form prose into a note, because the
  // report echoes notes verbatim and the fixture above can only cover the vocabulary it knows about.
  // Asserted on the VOCABULARY, not on the line that writes it: pinning the `audit "block" "${nag}"`
  // syntax would break on an unbraced `$nag` or an indent while still allowing a reworded id like
  // `looks good` to poison the report. Every value `nag` can take must be refused by all three regexes.
  const nagSrc = readFileSync(new URL('../.claude/hooks/stop-nag-gate.sh', import.meta.url), 'utf8')
  const nagIds = [...nagSrc.matchAll(/^\s*nag="([^"]+)"/gm)].map((m) => m[1])
  assert.ok(nagIds.length >= 5, `expected the classified nag ids, found ${JSON.stringify(nagIds)}`)
  for (const id of nagIds) {
    for (const [name, re] of [['CONFIRM_RE', CONFIRM_RE], ['OVERRIDE_RE', OVERRIDE_RE], ['HOOK_WORK_RE', HOOK_WORK_RE]]) {
      assert.equal(re.test(id), false, `stop-nag id "${id}" reads as ${name}; the report echoes notes verbatim`)
    }
  }
})

test('every advice phrase is accepted by the regex its own branch consults (#1150)', () => {
  // Lockstep with NO source parsing. Three earlier attempts at this pin failed in three different ways:
  // the copy hard-coded `"#657"` after the regex stopped accepting it; then `"검증 생략"` survived because
  // the test OR-ed all three regexes instead of the one the self-edit branch consults; and the extraction
  // regex reached only 2 of 5 `denyJson` call sites — missing the commit deny, the message an operator
  // actually reads. `ADVICE` pairs each phrase list with its governing regex, and every deny message is
  // built from those lists, so there is nothing left to scrape.
  for (const { phrases, accepts } of ADVICE) {
    assert.ok(phrases.length > 0)
    for (const phrase of phrases) {
      assert.ok(accepts().test(phrase), `deny copy advises "${phrase}" but its own branch's regex refuses it`)
    }
  }
  // The self-edit branch consults HOOK_WORK_RE ALONE, so a commit-override phrase must not lift it: a
  // generic verification-skip must never authorize rewriting the gate that checks it.
  for (const phrase of COMMIT_OVERRIDE_EXAMPLES) assert.equal(HOOK_WORK_RE.test(phrase), false)
  // …and no deny message may advise a phrase its own branch would refuse — asserted on the RENDERED
  // message. The previous version scraped the `denyJson(` call sites with a `[^`]*` capture, which
  // truncates at the nested backtick inside `${…EXAMPLES.map((p) => `"${p}"`)}` — i.e. exactly where the
  // advice is interpolated — so a stale literal appended BESIDE a correct interpolation stayed green, as
  // did a double-quoted 5th call site (invisible to the scan AND to its own count). Rendering covers the
  // `why` fragment and every quote style; a NEW call site is covered only by the count below.
  const denies = renderedDenies()
  for (const { label, accepts, reason } of denies) {
    for (const [, quoted] of reason.matchAll(/"([^"]+)"/g)) {
      assert.ok(accepts().test(quoted), `the ${label} deny advises "${quoted}" but its own branch's regex refuses it`)
    }
    // …and NOTHING ELSE in the message may read as authorization. A deny is the text an operator is most
    // likely to paste back ("why did this fire?"), which types a genuine role:user turn the wrapper
    // skip-list structurally cannot filter — the same producer-side rule this change applies to
    // `hook-audit-summary.mjs`, on the surface that had been left out of it. Three messages failed this:
    // the self-edit deny said "for hook/gate work", and the fail-closed deny said "confirmed in-browser".
    // Those lift the gate while logging `self-edit-authorized` / `commit:confirmed` — invisible to the
    // #659 false-positive metric, which only watches `commit:override`.
    const incidental = ADVICE.flatMap(({ phrases }) => phrases).reduce((s, p) => s.split(p).join(' '), reason)
    for (const [name, re] of [['CONFIRM_RE', CONFIRM_RE], ['OVERRIDE_RE', OVERRIDE_RE], ['HOOK_WORK_RE', HOOK_WORK_RE]]) {
      assert.equal(re.test(incidental), false, `the ${label} deny reads as ${name} outside its quoted advice: ${incidental}`)
    }
  }
  // A count only — no capture to truncate. Excludes the declaration, and allows one call site to render
  // several messages (the commit deny has two `why` variants), so this says what its message says.
  const src = readFileSync(new URL('../.claude/hooks/step35-verify-gate.mjs', import.meta.url), 'utf8')
  const sites = (src.match(/console\.log\(denyJson\(/g) ?? []).length
  assert.equal(sites, 4, 'a new deny call site must be added to renderedDenies() or its message is unpinned')
  assert.ok(denies.length >= sites) // ≥, not ==: the commit site renders two messages, one per `why`
})

test('the advice phrases the docs quote are the ones the gate actually accepts (#1150)', () => {
  // CLAUDE.md and workflow-hooks.md hard-code these phrases for a human to read and type. That is the
  // same copy↔regex drift `ADVICE` exists to kill, one layer out, and `lint:docs` checks symbol names,
  // not phrases.
  for (const rel of ['../CLAUDE.md', '../docs/reference/workflow-hooks.md']) {
    const doc = readFileSync(new URL(rel, import.meta.url), 'utf8')
    for (const { phrases, accepts } of ADVICE) {
      for (const phrase of phrases) {
        if (doc.includes(phrase)) assert.ok(accepts().test(phrase), `${rel} quotes "${phrase}" but its branch's regex refuses it`)
      }
    }
    // …and the doc must quote at least one phrase from EACH list, or that list's arm is vacuous here —
    // OR-ing across the lists left the override arm permanently unchecked in workflow-hooks.md.
    for (const { phrases } of ADVICE) {
      assert.ok(phrases.some((p) => doc.includes(p)), `${rel} quotes none of ${JSON.stringify(phrases)}, so that list is unpinned here`)
    }
  }
})

test('CLI: the HARD gate still runs from a path a URL would escape (space, #) (#1150)', () => {
  // `review-loop-gate.test.mjs` pins this for the telemetry hook, where the cost is a missing audit line.
  // Here the cost is the whole gate: the old `import.meta.url === \`file://${process.argv[1]}\`` idiom
  // never compares equal when the path percent-encodes, so `main()` never runs and the process exits 0 —
  // a HARD, fail-CLOSED gate failing OPEN, with no audit line to say it did. A space in
  // $CLAUDE_PROJECT_DIR is all it takes, so the fix needs its own pin here.
  for (const dirName of ['sp ace', 'hash#dir']) {
    const dir = join(mkdtempSync(join(tmpdir(), 'step35-esc-')), dirName)
    mkdirSync(dir, { recursive: true })
    const hook = join(dir, 'step35-verify-gate.mjs')
    cpSync(new URL('../.claude/hooks/step35-verify-gate.mjs', import.meta.url), hook)
    const out = execFileSync('node', [hook], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git commit --no-verify -m x' }, cwd: '/tmp' }),
      encoding: 'utf8', env: { ...process.env, HOOK_AUDIT_LOG: join(dir, 'audit.jsonl') },
    })
    assert.match(out, /"permissionDecision":"deny"/, `the gate went silent when run from "${dirName}"`)
  }
})

test('HOOK_WORK_RE — each token guard is load-bearing on its own (#1150)', () => {
  // One fixture per guarded edge, each refused by THAT edge alone — a fixture two guards both block
  // cannot tell a correct cleanup from a wrong one, which is the property this test exists to have.
  assert.equal(HOOK_WORK_RE.test('branch fix/1150-gate pushed'), false)     // branch 2, target leading edge
  assert.equal(HOOK_WORK_RE.test('worktrees/fix-1150 gate log'), false)     // branch 2, verb suffix
  assert.equal(HOOK_WORK_RE.test('self-edit:/w/hooks/gate.mjs'), false)     // branch 2, verb leading edge
  assert.equal(HOOK_WORK_RE.test('fix/1184-push-advisory-gate 작업중'), false) // branch 1, target leading edge
  assert.equal(HOOK_WORK_RE.test('the seven .claude/hooks workflow hooks'), false) // branch 1, verb trailing edge
  // Control: real stated intent still authorizes, so the assertions above are not a broken-regex artifact.
  for (const phrase of HOOK_WORK_EXAMPLES) assert.equal(HOOK_WORK_RE.test(phrase), true)
  // …including inflected forms. The verb suffix is `(?![-_])` rather than `(?![-\w])` so English inflects,
  // and the branch-1 trailing guard is ASCII-scoped so Korean does — a HARD deny the user cannot lift by
  // writing naturally is the failure mode this gate least affords.
  for (const phrase of ['훅 수정해줘', 'fixed the hook', 'editing the gate', 'working on the gate']) {
    assert.equal(HOOK_WORK_RE.test(phrase), true, `"${phrase}" is ordinary stated intent and must authorize`)
  }
})

test('the repo\'s own prose does not authorize a self-edit when pasted (#1150)', () => {
  // The vector these guards exist for, asserted on the real files rather than on invented strings: this
  // change's own doc reword ("the seven .claude/hooks workflow hooks") read as "hooks work" and matched.
  // The docs DO quote the advice phrases — that is their job, and a deliberate paste of one is a real
  // authorization — so the assertion is that nothing ELSE in them matches.
  for (const rel of ['../CLAUDE.md', '../docs/reference/workflow-hooks.md']) {
    const doc = readFileSync(new URL(rel, import.meta.url), 'utf8')
    const hits = [...doc.matchAll(new RegExp(HOOK_WORK_RE.source, 'gi'))]
      .map((m) => doc.slice(Math.max(0, m.index - 60), m.index + 60))
      .filter((ctx) => !HOOK_WORK_EXAMPLES.some((p) => ctx.includes(p)))
    assert.deepEqual(hits, [], `${rel} incidentally reads as authorization to edit the hooks`)
  }
})

test('CLI: a .claude/hooks self-edit is DENIED unauthorized and ALLOWED on stated intent (#1150)', () => {
  // The most important untested path in this gate: "the agent may rewrite its own gate". Every existing
  // test covered the regexes; nothing covered the branch that consults them, so `if (authorized)` →
  // `if (true)`, swapping HOOK_WORK_RE for CONFIRM_RE, and deleting the branch outright all shipped green.
  const dir = mkdtempSync(join(tmpdir(), 'step35-selfedit-'))
  const tp = join(dir, 't.jsonl')
  const target = join(dir, '.claude', 'hooks', 'review-loop-gate.mjs')
  const withTurn = (text) => {
    writeFileSync(tp, JSON.stringify({ type: 'user', isMeta: false, isSidechain: false, message: { content: text } }) + '\n')
    return runHook({ tool_name: 'Edit', tool_input: { file_path: target }, transcript_path: tp })
  }
  // A pasted audit report authorizes nothing — including one carrying this gate's own note shape, whose
  // absolute worktree path used to read as "fix … gate" (#1150).
  assert.match(withTurn('step-3.5 hard gate (#657): 1 deny · 2 pass'), /"permissionDecision":"deny"/)
  assert.match(withTurn(`self-edit:/Users/x/aiwatch/.claude/worktrees/fix-1150-gate/.claude/hooks/step35-verify-gate.mjs`), /"permissionDecision":"deny"/)
  // Stated intent lifts it — and this is the phrase the deny message itself advises.
  for (const phrase of HOOK_WORK_EXAMPLES) {
    assert.equal(withTurn(`${phrase} 진행해줘`).trim(), '', `stated intent "${phrase}" must authorize the self-edit`)
  }
  // A NON-protected path is never gated here, so the deny above is not an always-deny.
  writeFileSync(tp, JSON.stringify({ type: 'user', isMeta: false, message: { content: 'hi' } }) + '\n')
  assert.equal(runHook({ tool_name: 'Edit', tool_input: { file_path: join(dir, 'src', 'x.jsx') }, transcript_path: tp }).trim(), '')
})
