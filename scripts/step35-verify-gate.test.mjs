// #657 — unit tests for the hard-deny step-3.5 gate's pure decision logic. Run with
// `npm run test:scripts` (= `node --test scripts/*.test.mjs`). The CLI/IO (transcript read, git diff,
// deny JSON) is covered by the artifact check in the PR; here we pin the unfabricable-signal logic.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isUiEdgePath, lastUiEditIndex, hasUserTurnAfter, decideCommit, CONFIRM_RE, OVERRIDE_RE, HOOK_WORK_RE,
} from '../.claude/hooks/step35-verify-gate.mjs'

// ── fixtures matching the real transcript JSONL shape ──
const edit = (file_path) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path } }] } })
const bashWrite = (command) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } })
// Real human prompts store message.content as a STRING (verified against the live transcript schema).
const userText = (text, extra = {}) => ({ type: 'user', isMeta: false, isSidechain: false, message: { content: text }, ...extra })
// Some clients use an array with a leading text block — must also be detected.
const userTextArr = (text, extra = {}) => ({ type: 'user', isMeta: false, isSidechain: false, message: { content: [{ type: 'text', text }] }, ...extra })
// A tool-result turn is type:user with an ARRAY whose first block is tool_result — NOT a human message.
const toolResult = () => ({ type: 'user', isMeta: false, message: { content: [{ type: 'tool_result', content: 'ok' }] } })

test('isUiEdgePath — dashboard + Edge SSR are UI; worker/docs/tests are not', () => {
  assert.equal(isUiEdgePath('src/pages/Overview.jsx'), true)
  assert.equal(isUiEdgePath('src/locales/ko.js'), true)
  assert.equal(isUiEdgePath('api/is-down/html-template.ts'), true)
  assert.equal(isUiEdgePath('api/intro/html-template.ts'), true)
  assert.equal(isUiEdgePath('worker/src/services.ts'), false)
  assert.equal(isUiEdgePath('docs/reference/x.md'), false)
  assert.equal(isUiEdgePath('src/utils/__tests__/constants.test.js'), false) // test excluded
  assert.equal(isUiEdgePath('tests/overview.spec.js'), false)
})

test('lastUiEditIndex — picks the last UI/Edge edit (Edit + Bash write); -1 when none', () => {
  assert.equal(lastUiEditIndex([userText('hi'), edit('src/a.jsx'), userText('ok')]), 1)
  assert.equal(lastUiEditIndex([edit('src/a.jsx'), edit('worker/src/b.ts'), edit('src/c.jsx')]), 2) // worker edit doesn't reset
  assert.equal(lastUiEditIndex([bashWrite('cat > src/x.js <<EOF\n...')]), 0)
  assert.equal(lastUiEditIndex([edit('worker/src/b.ts'), edit('docs/x.md')]), -1) // no UI edit
})

test('hasUserTurnAfter — detects both string-content (real prompts) and array-text human turns', () => {
  assert.equal(hasUserTurnAfter([edit('src/a.jsx'), userText('확인했고 잘 나옴')], 0, CONFIRM_RE), true)      // string content
  assert.equal(hasUserTurnAfter([edit('src/a.jsx'), userTextArr('looks good')], 0, CONFIRM_RE), true)        // array-text content
})

test('hasUserTurnAfter — only a genuine human text turn counts (not meta/sidechain/tool_result)', () => {
  const e = [edit('src/a.jsx'), userText('확인했고 잘 나옴')]
  assert.equal(hasUserTurnAfter(e, 0, CONFIRM_RE), true)
  // meta + sidechain + tool_result turns are ignored
  assert.equal(hasUserTurnAfter([edit('src/a.jsx'), userText('확인', { isMeta: true })], 0, CONFIRM_RE), false)
  assert.equal(hasUserTurnAfter([edit('src/a.jsx'), userText('ok', { isSidechain: true })], 0, CONFIRM_RE), false)
  assert.equal(hasUserTurnAfter([edit('src/a.jsx'), toolResult()], 0, CONFIRM_RE), false)
  // a confirm BEFORE the edit doesn't count
  assert.equal(hasUserTurnAfter([userText('ok'), edit('src/a.jsx')], 1, CONFIRM_RE), false)
})

test('decideCommit — allows non-UI commits without a confirmation', () => {
  assert.deepEqual(decideCommit([], [edit('worker/src/b.ts')]), { deny: false })
})

test('decideCommit — DENIES a UI commit with no post-edit user confirmation (the recurring miss)', () => {
  const d = decideCommit(['src/pages/Overview.jsx'], [edit('src/pages/Overview.jsx'), toolResult()])
  assert.equal(d.deny, true)
  assert.equal(d.reason, 'no-confirmation')
})

test('decideCommit — ALLOWS once a genuine user confirmation follows the last UI edit', () => {
  const e = [edit('src/pages/Overview.jsx'), userText('확인했고 잘 나옴, 커밋해')]
  assert.deepEqual(decideCommit(['src/pages/Overview.jsx'], e), { deny: false })
})

test('decideCommit — a post-edit test/doc edit does NOT re-trigger the gate (confirmation still valid)', () => {
  // edit UI → user confirms → edit a test file (not UI) → commit. The last UI edit is index 0, the
  // confirmation is after it, so it stays allowed even though a later (non-UI) edit happened.
  const e = [edit('src/pages/Overview.jsx'), userText('잘 나옴'), edit('tests/overview.spec.js')]
  assert.deepEqual(decideCommit(['src/pages/Overview.jsx'], e), { deny: false })
})

test('decideCommit — explicit override lifts the gate', () => {
  const e = [edit('src/pages/Overview.jsx'), userText('검증 생략하고 커밋해줘')]
  assert.deepEqual(decideCommit(['src/pages/Overview.jsx'], e), { deny: false })
})

test('decideCommit — UI staged but no edit event in transcript → fail-closed deny (override-able)', () => {
  assert.equal(decideCommit(['src/pages/Overview.jsx'], [userText('hello')]).deny, true)
  assert.equal(decideCommit(['src/pages/Overview.jsx'], [userText('skip verify and commit')]).deny, false)
})

test('HOOK_WORK_RE — authorizes self-edits ONLY on explicit gate/hook work (narrow)', () => {
  assert.match('657 작업 진행', HOOK_WORK_RE)          // the user's authorization for #657
  assert.match('#657', HOOK_WORK_RE)
  assert.match('work on the gate hook', HOOK_WORK_RE)
  assert.match('훅 수정해줘', HOOK_WORK_RE)
  assert.match('step35 고쳐줘', HOOK_WORK_RE)
  // must NOT authorize on incidental "gate"/"hook"/issue-number prose (would weaken self-protection)
  assert.doesNotMatch('add a category to the overview', HOOK_WORK_RE)
  assert.doesNotMatch('why does the gate keep firing', HOOK_WORK_RE)
  assert.doesNotMatch('update the gate component on the settings page', HOOK_WORK_RE)
  assert.doesNotMatch('fix issue #659 overview', HOOK_WORK_RE)
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
const runHook = (input) => {
  try { return execFileSync('node', ['.claude/hooks/step35-verify-gate.mjs'], { input: JSON.stringify(input), encoding: 'utf8' }) }
  catch (e) { return e.stdout || '' }
}
test('CLI: a commit MESSAGE mentioning --no-verify is NOT blocked; the actual flag IS', () => {
  const msgBody = runHook({ tool_name: 'Bash', tool_input: { command: "git commit -F - <<'EOF'\ndocs: explain --no-verify usage\nEOF" }, cwd: '/tmp' })
  assert.doesNotMatch(msgBody, /deny/) // message-only mention → allowed
  const realFlag = runHook({ tool_name: 'Bash', tool_input: { command: 'git commit --no-verify -m x' }, cwd: '/tmp' })
  assert.match(realFlag, /"permissionDecision":"deny"/) // actual flag → denied
})
