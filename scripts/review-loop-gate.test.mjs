// #1150 — unit tests for the review-loop telemetry hook. Run with `npm run test:scripts`.
//
// The hook never blocks, so the failure mode to guard is not a false deny — it is recording nothing, or
// recording something the summary cannot read. Both are silent. So every test below pins either the note
// the hook writes or the wiring that makes it run, in both directions (memory
// `feedback_mutation_test_both_directions`): a mutation that stops the recording, or that changes the note
// shape, has to turn one of these red.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, mkdirSync, cpSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  isPrReviewSpawn, REVIEW_AGENT_PREFIX, declaredRound, sessionId, noteFor, auditLine,
} from '../.claude/hooks/review-loop-gate.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOOK = join(REPO, '.claude', 'hooks', 'review-loop-gate.mjs')

/** Drive the real CLI with a stdin payload, HOOK_AUDIT_LOG sandboxed. */
function runHook(toolInput, { transcript = 'abcdef12.jsonl' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'revloop-'))
  const log = join(dir, 'audit.jsonl')
  const payload = { tool_name: 'Agent', tool_input: toolInput }
  if (transcript) payload.transcript_path = join(dir, transcript)
  const stdout = execFileSync('node', [HOOK], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, HOOK_AUDIT_LOG: log } })
  const audit = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
  return { stdout, audit }
}
// Real spawns always carry `description` too (memory `feedback_faithful_fixtures`).
const review = (prompt) => ({ subagent_type: 'pr-review-toolkit:code-reviewer', description: 'Review the diff', prompt })

test('isPrReviewSpawn — prefix-anchored, so a lookalike suffix does not match', () => {
  assert.equal(isPrReviewSpawn({ subagent_type: 'pr-review-toolkit:code-reviewer' }), true)
  assert.equal(isPrReviewSpawn({ subagent_type: 'pr-review-toolkit:silent-failure-hunter' }), true)
  assert.equal(isPrReviewSpawn({ subagent_type: 'x-pr-review-toolkit:code-reviewer' }), false) // anchor, not includes
  assert.equal(isPrReviewSpawn({ subagent_type: 'Explore' }), false)
  assert.equal(isPrReviewSpawn({}), false)
  assert.equal(isPrReviewSpawn(undefined), false)
})

test('REVIEW_AGENT_PREFIX stays in lockstep with the documented review command', () => {
  // A plugin re-namespacing (cf. #920) would stop the telemetry with NO trace — a non-matching spawn exits
  // before any audit line. Pin the prefix to the command the workflow documents in-repo (the installed
  // plugin lives under ~/.claude/plugins, a machine-global path CI does not have).
  assert.ok(readFileSync(join(REPO, '.claude', 'skills', 'ship-issue', 'SKILL.md'), 'utf8').includes(`/${REVIEW_AGENT_PREFIX}:review-pr`))
  assert.ok(readFileSync(join(REPO, 'CLAUDE.md'), 'utf8').includes(`${REVIEW_AGENT_PREFIX}:review-pr`))
})

test('declaredRound — reads a self-declared round in both languages and separators', () => {
  assert.equal(declaredRound('This is ROUND 4.'), 4)
  assert.equal(declaredRound('round #7 of the loop'), 7)
  assert.equal(declaredRound('round-4 review of the diff'), 4) // this repo hyphenates routinely
  assert.equal(declaredRound('ROUND 2 review of the diff'), 2)
  assert.equal(declaredRound('이번은 라운드 5.'), 5)
  assert.equal(declaredRound('9라운드째다'), 9)
  assert.equal(declaredRound('review this PR'), 0)
  assert.equal(declaredRound(undefined), 0)
})

test('declaredRound — digit boundaries keep an ISSUE NUMBER from becoming a round', () => {
  // `(\d{1,2})\s*라운드` without the lookbehind pulled `50` out of `1150`; the prefix branches need the
  // trailing `(?!\d)` for the same reason on `round 1150`.
  assert.equal(declaredRound('이슈 1150 라운드 3 리뷰'), 3)
  assert.equal(declaredRound('#1150 라운드 게이트 작업'), 0)
  assert.equal(declaredRound('라운드 1150'), 0)
  assert.equal(declaredRound('1150라운드'), 0)
  assert.equal(declaredRound('round 1150'), 0)
  assert.equal(declaredRound('see #12 라운드'), 0)
})

test('declaredRound — takes the FIRST mention, which mislabels a recital but costs nothing else', () => {
  // With no deny path this is a labelling choice, not a gate: the alternative (highest) mis-declared other
  // real phrasings, e.g. a prompt quoting "#1110 rounds 3 and 5".
  assert.equal(declaredRound('Round 3 flagged X. This is round 4.'), 3)
  assert.equal(declaredRound('late rounds catch real defects (#1052 round 4; #1110 rounds 3 and 5)'), 4)
})

test('sessionId — the first 8 chars of the transcript filename, or unknown', () => {
  assert.equal(sessionId('/x/y/586d6253-f33a-4c90.jsonl'), '586d6253')
  assert.equal(sessionId('short.jsonl'), 'short')
  assert.equal(sessionId(''), 'unknown')
  assert.equal(sessionId(undefined), 'unknown')
})

test('noteFor — the note shape the summary parses, incl. round-none as a first-class outcome', () => {
  assert.equal(noteFor('This is ROUND 4.', '/x/sess1234.jsonl'), 'round-4:s=sess1234')
  assert.equal(noteFor('review this PR', '/x/sess1234.jsonl'), 'round-none:s=sess1234')
  assert.equal(noteFor('ROUND 12 review', '/x/sess1234.jsonl'), 'round-12:s=sess1234') // two digits survive
  assert.equal(noteFor('This is ROUND 4.', undefined), 'round-4:s=unknown')
})

// ── CLI integration ──

test('CLI — a non-review spawn records nothing at all', () => {
  const { stdout, audit } = runHook({ subagent_type: 'Explore', description: 'find x', prompt: 'find x' })
  assert.equal(stdout.trim(), '')
  assert.equal(audit.length, 0)
})

test('CLI — a review spawn records exactly one pass line, and NEVER blocks', () => {
  for (const prompt of ['This is ROUND 4. Please review.', 'review this PR', 'ROUND 12. Nothing matters.']) {
    const { stdout, audit } = runHook(review(prompt))
    // The hook has no deny path: any stdout at all would be a decision this hook must not make.
    assert.equal(stdout.trim(), '', `must emit no decision for: ${prompt}`)
    assert.equal(audit.length, 1)
    assert.equal(audit[0].decision, 'pass')
    assert.equal(audit[0].note, noteFor(prompt, 'abcdef12.jsonl'))
  }
})

test('CLI — an undeclared round is RECORDED, not skipped (it is the signal, not an error)', () => {
  const { audit } = runHook(review('review this PR'))
  assert.match(audit[0].note, /^round-none:s=abcdef12$/)
})

test('CLI — every fail-open path still records, and names itself', () => {
  // Recording nothing is the only failure mode left, so each abandon path must be distinguishable from a
  // healthy run — a silent instrument looks exactly like a quiet week.
  const dir = mkdtempSync(join(tmpdir(), 'revloop-fo-'))
  const call = (payload) => {
    const log = join(dir, `a${Math.random().toString(36).slice(2)}.jsonl`)
    const stdout = execFileSync('node', [HOOK], { input: payload, encoding: 'utf8', env: { ...process.env, HOOK_AUDIT_LOG: log } })
    const audit = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
    return { stdout, audit }
  }
  const RV = '"subagent_type":"pr-review-toolkit:code-reviewer"'

  assert.match(call('not json at all').audit.at(-1).note, /fail-open:no-stdin/)
  // A missing `prompt` is a schema drift, and must be recorded as one EVEN THOUGH `description` is present
  // (it always is on a real spawn) — a fallback would record the round of a 3-5 word summary as data.
  const drift = call(`{"tool_input":{${RV},"description":"Review the diff","instructions":"x"}}`)
  assert.equal(drift.stdout.trim(), '')
  assert.match(drift.audit.at(-1).note, /fail-open:no-prompt-field/)
  // control: the same payload WITH a prompt records a round, so the guard is not always-fail-open
  assert.match(call(`{"tool_input":{${RV},"prompt":"This is ROUND 5."}}`).audit.at(-1).note, /^round-5:s=unknown$/)
  // A payload with no `tool_input` — `null`, or a renamed harness key — must be RECORDED as a drift, not
  // fall through to the silent not-a-review-spawn exit. Otherwise the instrument goes blind and the log
  // looks exactly like a quiet week.
  for (const p of ['null', '{"tool_name":"Agent","toolInput":{"subagent_type":"pr-review-toolkit:x","prompt":"ROUND 4"}}']) {
    const r = call(p)
    assert.equal(r.stdout.trim(), '', p)
    assert.match(r.audit.at(-1).note, /fail-open:no-tool-input/, p)
  }
  // control: a well-formed payload for a NON-review spawn stays silent — this must not become a fail-open
  assert.equal(call('{"tool_name":"Agent","tool_input":{"subagent_type":"Explore","prompt":"x"}}').audit.length, 0)
})

test('CLI — a failed audit write warns on stderr instead of vanishing', () => {
  // The header calls this write the deliverable, so a swallowed failure would leave the loop unobserved
  // while the hook still appears to run. Point the log at an unwritable path and assert the trace.
  const dir = mkdtempSync(join(tmpdir(), 'revloop-warn-'))
  const res = execFileSync('node', [HOOK], {
    input: JSON.stringify({ tool_name: 'Agent', tool_input: review('This is ROUND 4.') }),
    encoding: 'utf8',
    env: { ...process.env, HOOK_AUDIT_LOG: join(dir, 'nope', 'deeper', 'audit.jsonl') },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  assert.equal(res.trim(), '', 'a failed write must still not block')
  // stderr is not captured by execFileSync's return; re-run capturing it via a shell
  const stderr = execFileSync('sh', ['-c',
    `printf %s ${JSON.stringify(JSON.stringify({ tool_name: 'Agent', tool_input: review('This is ROUND 4.') }))} | HOOK_AUDIT_LOG=${JSON.stringify(join(dir, 'nope', 'deeper', 'audit.jsonl'))} node ${JSON.stringify(HOOK)} 2>&1 1>/dev/null`,
  ], { encoding: 'utf8' })
  assert.match(stderr, /audit write failed \(ENOENT\)/)
})

test('CLI — a missing transcript_path still records the round (only the session is unknown)', () => {
  const { audit } = runHook(review('This is ROUND 6.'), { transcript: null })
  assert.equal(audit.length, 1)
  assert.equal(audit[0].note, 'round-6:s=unknown')
})

test('the hook is WIRED in .claude/settings.json, at the path settings actually names', () => {
  // A hook whose only output is a log line is invisible when unwired: nothing fails, the log just stops.
  // Checking only that OUR OWN path constant exists left a misspelt `command` and a renamed
  // `$CLAUDE_PROJECT_DIR` both green.
  const settings = JSON.parse(readFileSync(join(REPO, '.claude', 'settings.json'), 'utf8'))
  const mine = (settings.hooks?.PreToolUse ?? [])
    .filter((g) => (g.hooks ?? []).some((h) => String(h.command ?? '').includes('review-loop-gate.mjs')))
  assert.equal(mine.length, 1, 'exactly one PreToolUse group must wire review-loop-gate.mjs')
  const re = new RegExp(mine[0].matcher)
  assert.ok(re.test('Task') && re.test('Agent'), 'matcher must select the Task and Agent tools')
  const entry = mine[0].hooks.find((h) => String(h.command ?? '').includes('review-loop-gate.mjs'))
  assert.equal(entry.type, 'command', 'a non-command hook type would never execute the script')
  const wired = String(entry.command).replace(/^node\s+/, '').replace(/^"|"$/g, '').replace('$CLAUDE_PROJECT_DIR', REPO)
  assert.ok(existsSync(wired), `the wired path must exist on disk: ${wired}`)
})

test('auditLine — valid JSON, hook name pinned, control chars + quotes + backslashes escaped', () => {
  const o = JSON.parse(auditLine('pass', 'round-4:s=sess1234', '2026-07-24T00:00:00Z'))
  assert.equal(o.hook, 'review-loop-gate')
  assert.equal(o.decision, 'pass')
  assert.equal(o.note, 'round-4:s=sess1234')
  // a note carrying a newline, a quote and a backslash must still parse — a corrupt line is silently
  // dropped by the summary, so the failure mode is invisible observability loss
  assert.equal(JSON.parse(auditLine('pass', 'a\nb"c\\d', '2026-07-24T00:00:00Z')).note, 'a b"c\\d')
})

test('the hook writes where the summary reads, with HOOK_AUDIT_LOG UNSET (#1150)', () => {
  // The claim the revert rests on, exercised end-to-end. Every other test sets HOOK_AUDIT_LOG, so the
  // production branch was dead code to this suite: dropping the `'..'` from the default path, or renaming
  // the file, both stayed green. Build a miniature checkout, fire the hook with the env var DELETED, and
  // require the summary — reading ITS own default — to find the line.
  // `realpathSync` is required: macOS tmpdir is a symlink, and the entry guard compares real paths.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'revloop-default-')))
  mkdirSync(join(root, '.claude', 'hooks'), { recursive: true })
  mkdirSync(join(root, 'scripts'), { recursive: true })
  cpSync(HOOK, join(root, '.claude', 'hooks', 'review-loop-gate.mjs'))
  cpSync(join(REPO, 'scripts', 'hook-audit-summary.mjs'), join(root, 'scripts', 'hook-audit-summary.mjs'))
  const env = { ...process.env }
  delete env.HOOK_AUDIT_LOG

  execFileSync('node', [join(root, '.claude', 'hooks', 'review-loop-gate.mjs')], {
    input: JSON.stringify({ tool_name: 'Agent', transcript_path: join(root, 'sess0001.jsonl'), tool_input: review('This is ROUND 4.') }),
    encoding: 'utf8', env,
  })
  assert.ok(existsSync(join(root, '.claude', 'hook-audit.jsonl')), 'the hook must write to <root>/.claude/hook-audit.jsonl')
  const out = execFileSync('node', ['scripts/hook-audit-summary.mjs'], { cwd: root, encoding: 'utf8', env })
  assert.match(out, /🔁 review-loop telemetry[\s\S]*?R4=1/, 'the summary must find it at its own default path')
})

test('the hook still runs from a path a URL would escape (space, #) (#1150)', () => {
  // `import.meta.url === `file://${process.argv[1]}`` never compares equal when the path percent-encodes,
  // so the hook exited 0 having recorded nothing — measured, with no audit line and no stderr. For an
  // instrument whose only failure mode is silence that is the worst case, and the same idiom guards the
  // HARD gate, where a space in $CLAUDE_PROJECT_DIR would disable it just as quietly.
  for (const dirName of ['sp ace', 'hash#dir', 'plus+dir']) {
    const dir = join(mkdtempSync(join(tmpdir(), 'revloop-esc-')), dirName)
    mkdirSync(dir, { recursive: true })
    const hook = join(dir, 'review-loop-gate.mjs')
    cpSync(HOOK, hook)
    const log = join(dir, 'audit.jsonl')
    execFileSync('node', [hook], {
      input: JSON.stringify({ tool_name: 'Agent', tool_input: review('This is ROUND 4.') }),
      encoding: 'utf8', env: { ...process.env, HOOK_AUDIT_LOG: log },
    })
    assert.ok(existsSync(log), `the hook recorded nothing when run from "${dirName}"`)
    assert.match(readFileSync(log, 'utf8'), /"note":"round-4:s=unknown"/, dirName)
  }
})
