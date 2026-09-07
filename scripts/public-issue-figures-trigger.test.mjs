// #1354 — the public-issue figures reminder.
//
// What is pinned is the TRIGGER SET, the audit emission, and the settings wiring. Not classification:
// the hook matches a command name and hands the judgement back, deliberately, because deciding from an
// issue body whether a number is an adoption figure means parsing unbounded input to reach a verdict —
// the failure mode #1348 recorded. A test asserting a classification would invent a contract it lacks.
//
// The hook is spawned from a SANDBOX copy, never in place. `_audit.sh` resolves its log as
// `$HOOK_DIR/../hook-audit.jsonl` and honors no env override, so running the real file would append a
// genuine `warn` line to `.claude/hook-audit.jsonl` on every test run — the same log the gate system's
// effectiveness is read from. A test must not seed its own instrument (the rule and its wording come
// from `lint-korean-copy.test.mjs`, which this file initially failed to follow: 89 of the 89 entries in
// this worktree's log were this suite's own output).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const HOOKS = join(ROOT, '.claude', 'hooks')
const NAME = 'public-issue-figures-trigger.sh'
const LIST = join(HOOKS, 'public-issue-write-commands.txt')
/** The one place the trigger set lives; the hook reads this same file at run time. */
const SUBCOMMANDS = readFileSync(LIST, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))

/** Run the hook from a throwaway `.claude/hooks/` so its audit line lands in a throwaway log. */
function fire(command) {
  const dir = mkdtempSync(join(tmpdir(), 'pubfig-1354-'))
  const hooks = join(dir, '.claude', 'hooks')
  mkdirSync(hooks, { recursive: true })
  try {
    cpSync(join(HOOKS, '_audit.sh'), join(hooks, '_audit.sh'))
    cpSync(join(HOOKS, NAME), join(hooks, NAME))
    cpSync(LIST, join(hooks, 'public-issue-write-commands.txt'))
    const r = spawnSync('bash', [join(hooks, NAME)], {
      input: JSON.stringify({ tool_input: { command } }), encoding: 'utf8',
    })
    // Exit 0 on every path: a PreToolUse reminder that can fail a turn is not a reminder.
    assert.equal(r.status, 0, `${command} exited ${r.status}`)
    const log = join(dir, '.claude', 'hook-audit.jsonl')
    return { out: r.stdout.trim(), audit: existsSync(log) ? readFileSync(log, 'utf8').trim() : '' }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// The commands the hook must fire on. The lockstep tests below hold this list and the shared data file
// to each other in both directions, so a subcommand added to one without the other fails rather than
// shipping a live-but-unpinned trigger — which is exactly what `gh pr review` was for one round.
const FIRING_COMMANDS = [
    'gh issue create --title x --body y',
    'gh issue edit 1354 --body-file b.md',
    'gh issue comment 1354 --body-file c.md',
    'gh pr create --title x --body-file b.md',
    'gh pr edit 1356 --body-file b.md',
    'gh pr comment 1356 --body x',
    // close/reopen take `--comment`, so they publish prose too — the first version of this hook
    // asserted they could not, and pinned that mistake here.
    'gh issue close 1354 --comment "shipped"',
    'gh issue reopen 1354 -c "reopening"',
    'gh pr close 1356 --comment "superseded"',
    'gh pr reopen 1356',
  'gh pr review 1356 --comment --body "looks fine"',
  'SP=/tmp/x && gh issue comment 1 --body-file "$SP/b.md"',  // the real shape: a compound command
]

test('fires on every command in FIRING_COMMANDS', () => {
  for (const c of FIRING_COMMANDS) {
    const { out } = fire(c)
    assert.match(out, /hookSpecificOutput/, c)
    assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /#1354/, c)
  }
})

test('FIRING_COMMANDS covers every subcommand in the shared list', () => {
  // The list is DATA read by both the hook and this test. The previous version of this check parsed the
  // hook's shell `case` with a regex, which matched `*"gh issue edit"*` but silently missed `*"gh api"*`
  // and any unquoted glob — a guard blind to exactly the arm most likely to be added next. There is no
  // longer anything to parse: two lists are compared.
  assert.ok(SUBCOMMANDS.length > 0, 'the list is empty — the READ is what broke, not the hook')
  for (const sub of SUBCOMMANDS) {
    assert.ok(FIRING_COMMANDS.some((c) => c.includes(sub)), `'${sub}' is in the list but no FIRING_COMMANDS entry exercises it`)
  }
})

test('every FIRING_COMMANDS entry corresponds to a listed subcommand', () => {
  // The other direction: a test command that no longer matches anything would pass `fires on…` only if
  // the hook still fired for some unrelated reason, and would otherwise rot silently.
  for (const c of FIRING_COMMANDS) {
    assert.ok(SUBCOMMANDS.some((sub) => c.includes(sub)), `no listed subcommand matches the test command '${c}'`)
  }
})

test('is silent on reads and on unrelated commands', () => {
  // Reads publish nothing. Firing on them is pure noise, and noise is what stops a soft reminder from
  // being read at all.
  for (const c of [
    'gh issue view 1354',
    'gh issue list --label area:biz',
    'gh pr checks 1356',
    'gh pr view 1356 --json state',
    'gh pr status',
    'git commit -m "chore: x"',
    'npm run test:scripts',
  ]) {
    assert.equal(fire(c).out, '', c)
  }
})

test('records one warn line in the audit log when it fires, and none when it does not', () => {
  // The audit line is the hook's only durable trace and the entire subject of the workflow-hooks.md
  // section this shipped with. Deleting the `audit` call left every other assertion green.
  const fired = fire('gh issue comment 1354 --body x')
  assert.equal(fired.audit.split('\n').filter(Boolean).length, 1, fired.audit)
  const entry = JSON.parse(fired.audit)
  assert.equal(entry.hook, 'public-issue-figures')
  assert.equal(entry.decision, 'warn')

  assert.equal(fire('gh issue view 1354').audit, '')
})

test('a missing command is silent rather than an error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pubfig-1354-'))
  const hooks = join(dir, '.claude', 'hooks')
  mkdirSync(hooks, { recursive: true })
  try {
    cpSync(join(HOOKS, '_audit.sh'), join(hooks, '_audit.sh'))
    cpSync(join(HOOKS, NAME), join(hooks, NAME))
    cpSync(LIST, join(hooks, 'public-issue-write-commands.txt'))
    const r = spawnSync('bash', [join(hooks, NAME)], { input: JSON.stringify({ tool_input: {} }), encoding: 'utf8' })
    assert.equal(r.status, 0)
    assert.equal(r.stdout.trim(), '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the hook is WIRED in .claude/settings.json — right matcher, right type, real path', () => {
  // Two hooks in this repo have shipped inert, so a suite that only exercises the script proves
  // nothing. Three things have to hold together and each fails differently: a wiring under the
  // `Edit|Write|MultiEdit` matcher never receives `.tool_input.command`, which is the only field this
  // hook reads; a non-`command` type never executes the script at all; and a path that does not exist
  // is a silent no-op. The first two both survived a version of this test that checked only the path.
  const cfg = JSON.parse(readFileSync(join(ROOT, '.claude', 'settings.json'), 'utf8'))
  const groups = (cfg.hooks?.PreToolUse ?? []).filter((g) => (g.hooks ?? []).some((h) => (h.command ?? '').includes(NAME)))
  assert.equal(groups.length, 1, `expected exactly one PreToolUse group to wire ${NAME}, got ${groups.length}`)

  const re = new RegExp(groups[0].matcher ?? '')
  assert.ok(re.test('Bash'), `matcher ${JSON.stringify(groups[0].matcher)} must select the Bash tool`)

  const entries = groups[0].hooks.filter((h) => (h.command ?? '').includes(NAME))
  assert.equal(entries.length, 1)
  assert.equal(entries[0].type, 'command', 'a non-command hook type would never execute the script')

  const wired = entries[0].command.replace('$CLAUDE_PROJECT_DIR', ROOT).replace(/^bash\s+"?|"?$/g, '')
  assert.ok(existsSync(wired), `the wired path must exist on disk: ${wired}`)
})
