// #657 follow-up — unit tests for hook-audit-summary.mjs's step-3.5 gate handling. Run with
// `npm run test:scripts`. Drives the script against a temp fixture via the HOOK_AUDIT_LOG override so
// the real (gitignored) log is untouched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONFIRM_RE, OVERRIDE_RE, HOOK_WORK_RE } from '../.claude/hooks/step35-verify-gate.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')

// A recent ts (within the last-7-days window) so violations land in the "last 7d" tally.
const TS = new Date(Date.now() - 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
const line = (hook, decision, note = '') => JSON.stringify({ ts: TS, hook, decision, note })

function runSummary(entries) {
  const dir = mkdtempSync(join(tmpdir(), 'hookaudit-'))
  const log = join(dir, 'hook-audit.jsonl')
  writeFileSync(log, entries.join('\n') + '\n')
  return execFileSync('node', ['scripts/hook-audit-summary.mjs', '--days', '30'], {
    encoding: 'utf8',
    env: { ...process.env, HOOK_AUDIT_LOG: log },
  })
}

test('summary surfaces a dedicated step-3.5 gate section with deny/pass + reasons', () => {
  const out = runSummary([
    line('step35-verify-gate', 'deny', 'commit:no-confirmation'),
    line('step35-verify-gate', 'pass', 'commit:confirmed'),
  ])
  assert.match(out, /step-3\.5 hard gate \(#657\)/)
  assert.match(out, /1 deny · 1 pass/)
  assert.match(out, /commit:no-confirmation=1/)
})

test('a step35 commit-deny counts as an intercepted violation; pass + fail-closed do NOT', () => {
  const out = runSummary([
    line('step35-verify-gate', 'deny', 'commit:no-confirmation'), // violation
    line('step35-verify-gate', 'deny', 'fail-closed'),            // gate-health, NOT a violation
    line('step35-verify-gate', 'pass', 'commit:confirmed'),       // allowed, NOT a violation
  ])
  // Exactly one intercepted violation (the commit-deny), shown as a step35-tagged kind.
  assert.match(out, /Violations intercepted[\s\S]*?\n\s+1 total/)
  assert.match(out, /step35:no-confirmation=1/)
  // fail-closed is reported as a gate-health line, not folded into the violation tally.
  assert.match(out, /fail-closed=1/)
  assert.match(out, /gate-health/)
})

test('the 🔁 section reports the round histogram and the untracked-round rate (#1150)', () => {
  const out = runSummary([
    line('review-loop-gate', 'pass', 'round-none:s=sessaaaa'),
    line('review-loop-gate', 'pass', 'round-none:s=sessaaaa'),
    line('review-loop-gate', 'pass', 'round-4:s=sessaaaa'),
    line('review-loop-gate', 'pass', 'round-12:s=sessbbbb'),
  ])
  assert.match(out, /🔁 review-loop telemetry \(#1150\)/)
  // Two digits must survive — the hook records rounds well past 9.
  assert.match(out, /first round number per spawn: R4=1\s+R12=1/)
  // The untracked rate is the instrument's blind spot and must be stated, not inferred by subtraction.
  assert.match(out, /no round declared=2 spawn\(s\)/)
  // `recorded` counts every spawn the hook logged — an untracked round is still a recorded spawn; only a
  // fail-open is not. So 4 here, of which 2 declared no round.
  assert.match(out, /4 reviewer spawn\(s\) recorded across 2 session\(s\) · busiest session 3 spawn\(s\)/)
  // `busiest session` is the depth proxy that needs no cooperation from the prompt — the one signal left
  // when a loop declares no rounds at all. Pinned to the fixture's max (sessaaaa has 3 of the 4 spawns).
  // Telemetry is never an enforcement tally: this hook cannot produce a violation.
  assert.match(out, /Violations intercepted[\s\S]*?\n\s+0 total/)
  // …and the report must not read as an override: an operator pasting a report into the chat types a
  // genuine user turn, which is what step35's wrapper skip-list structurally cannot filter. Asserted with
  // the REAL regexes — a hard-coded literal here would drift from them, which is the class of bug this
  // whole change is about. (There is no review-loop counterpart: that hook has no deny and no override.)
  assert.equal(OVERRIDE_RE.test(out), false)
})

test('both override phrases stay unquoted in a report that renders BOTH sections (#1150)', () => {
  // Guarding this inside a review-loop-only fixture was vacuous: the 🚦 step35 block never rendered, so
  // re-adding its quoted phrase passed. This fixture renders both.
  const out = runSummary([
    line('review-loop-gate', 'pass', 'round-4:s=sessaaaa'),
    line('step35-verify-gate', 'pass', 'commit:override'),
    line('step35-verify-gate', 'deny', 'commit:no-confirmation'),
  ])
  assert.match(out, /🔁 review-loop telemetry/)
  assert.match(out, /step-3\.5 hard gate/)
  // All three gate regexes, against the real strings: the report must read as neither a confirmation, an
  // override, nor an authorization to edit the hooks.
  assert.equal(OVERRIDE_RE.test(out), false)
  assert.equal(CONFIRM_RE.test(out), false)
  assert.equal(HOOK_WORK_RE.test(out), false)
})

test('a step35 deny is counted per event — review-loop telemetry cannot dilute it (#1150)', () => {
  // A step35 deny is 1:1 with a commit. #1150 briefly added a dedupe that would have collapsed retries.
  const out = runSummary([
    line('step35-verify-gate', 'deny', 'commit:no-confirmation'),
    line('step35-verify-gate', 'deny', 'commit:no-confirmation'),
    line('review-loop-gate', 'pass', 'round-4:s=sessaaaa'),
  ])
  assert.match(out, /Violations intercepted[\s\S]*?\n\s+2 total/)
  assert.match(out, /step35:no-confirmation=2/)
})

test('a review-loop fail-open is instrument health, never a finding, and keeps its cause (#1150)', () => {
  const out = runSummary([
    line('review-loop-gate', 'pass', 'fail-open:no-stdin'),
    line('review-loop-gate', 'pass', 'fail-open:no-prompt-field'),
    line('review-loop-gate', 'pass', 'fail-open:no-prompt-field'),
    // A reason carrying its own detail must stay distinguishable from its bare sibling — the stated
    // reason for bucketing on the whole reason rather than its first colon-segment. Without this line
    // that choice is untested: no current reason contains a colon, so `.split(':')[0]` is green.
    line('review-loop-gate', 'pass', 'fail-open:record-error:EACCES'),
    line('review-loop-gate', 'pass', 'round-4:s=sessaaaa'),
  ])
  assert.match(out, /Violations intercepted[\s\S]*?\n\s+0 total/)
  // Assert on the ❗ line specifically — matching anywhere also matches the raw-note echo in the
  // `Most recent N` tail, which is how an earlier version of this test passed against a broken bucket.
  const failOpenLine = out.split('\n').find((l) => l.includes('❗ fail-open=')) ?? ''
  assert.match(failOpenLine, /❗ fail-open=4/)
  for (const reason of ['no-prompt-field=2', 'no-stdin=1', 'record-error:EACCES=1']) {
    assert.ok(failOpenLine.includes(reason), `the ❗ line must keep "${reason}" distinct: ${failOpenLine}`)
  }
  // fail-opens carry no round: they must stay out of BOTH the histogram and the untracked-round count
  assert.match(out, /1 reviewer spawn\(s\) recorded/)
  assert.equal(/no round declared=/.test(out), false)
})

test('the 🔁 section parses notes the REAL hook wrote — the two cannot drift (#1150)', () => {
  // STRUCTURAL, not another assertion: every other fixture here hand-writes note strings, so a change to
  // the hook's note format would leave this suite green while the section silently stopped parsing. Two
  // review rounds found key-granularity bugs in exactly that seam. Here the hook produces the notes.
  const HOOK = join(REPO, '.claude', 'hooks', 'review-loop-gate.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'noteshape-'))
  const log = join(dir, 'audit.jsonl')
  const rv = (prompt) => ({ subagent_type: 'pr-review-toolkit:code-reviewer', description: 'Review', prompt })
  const fire = (toolInput, transcript_path) => execFileSync('node', [HOOK], {
    input: JSON.stringify({ tool_name: 'Agent', tool_input: toolInput, transcript_path }),
    encoding: 'utf8', env: { ...process.env, HOOK_AUDIT_LOG: log },
  })

  fire(rv('This is ROUND 7. Please review.'), join(dir, 'sess9999.jsonl'))   // → a round note
  fire(rv('review this PR'), join(dir, 'sess9999.jsonl'))                    // → an untracked-round note
  fire({ subagent_type: 'pr-review-toolkit:code-reviewer', description: 'Review' }, join(dir, 'sess9999.jsonl')) // → fail-open

  const written = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  assert.equal(written.length, 3, 'the hook must have written one line per fire')
  assert.equal(written[0].note, 'round-7:s=sess9999')

  const out = execFileSync('node', ['scripts/hook-audit-summary.mjs', '--days', '30'], {
    encoding: 'utf8', env: { ...process.env, HOOK_AUDIT_LOG: log },
  })
  assert.match(out, /first round number per spawn:[^\n]*R7=1/)
  assert.match(out, /no round declared=1 spawn\(s\)/)
  assert.match(out, /❗ fail-open=1[^\n]*no-prompt-field=1/)
  assert.match(out, /2 reviewer spawn\(s\) recorded across 1 session\(s\) · busiest session 2 spawn\(s\)/)
  assert.match(out, /Violations intercepted[\s\S]*?\n\s+0 total/)
})

test('per-day trend includes a deny column', () => {
  const out = runSummary([line('step35-verify-gate', 'deny', 'commit:no-confirmation')])
  assert.match(out, /\| deny \|/)
})

test('a pass via override is surfaced as the false-positive proxy; a confirmed pass is not', () => {
  const withOverride = runSummary([
    line('step35-verify-gate', 'pass', 'commit:override'),
    line('step35-verify-gate', 'pass', 'commit:confirmed'),
  ])
  assert.match(withOverride, /override=1 pass/)
  assert.match(withOverride, /false-positive proxy/)
  // A clean run (only genuine confirmations) must NOT print the override caveat line.
  const cleanOnly = runSummary([line('step35-verify-gate', 'pass', 'commit:confirmed')])
  assert.doesNotMatch(cleanOnly, /override=/)
})
