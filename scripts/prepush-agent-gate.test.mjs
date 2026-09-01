// #1298 — unit tests for the pre-push agent-activation gate. Run with `npm run test:scripts`.
//
// WHY THIS FILE LOOKS THE WAY IT DOES. The previous attempt's suite passed while the hook was
// completely inert: it asserted that `settings.json` CONTAINED the hook's filename and matcher, and
// never that the command could run. A later review mutated that gate five ways — deleting the recorder,
// turning the deny exit into 0, commenting out the `main()` call entirely — and all five stayed green.
//
// So every test below that matters EXECUTES the shipped file as a subprocess and asserts its EXIT CODE.
// A gate that cannot be distinguished from a no-op by its own suite is the defect this whole issue is
// about, and a structural scan cannot make that distinction: "denied" and "never ran" look identical
// from outside unless you read the exit status.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  agentNameFromPath, changedAgentNames, rangeForLine, spawnedAgents, unverified,
} from '../.githooks/pre-push'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOOK = path.join(HERE, '..', '.githooks', 'pre-push')
const ZEROS = '0'.repeat(40)

// ── The decision, as pure functions ──────────────────────────────────────────

test('agentNameFromPath matches only a top-level agent definition', () => {
  assert.equal(agentNameFromPath('.claude/agents/review-findings-only.md'), 'review-findings-only')
  assert.equal(agentNameFromPath('worker/.claude/agents/x.md'), 'x')
  assert.equal(agentNameFromPath('.claude/hooks/review-loop-gate.mjs'), null)
  assert.equal(agentNameFromPath('docs/reference/code-review-policy.md'), null, 'a file that merely mentions an agent must not count')
  assert.equal(agentNameFromPath('.claude/agents/nested/x.md'), null)
  assert.equal(agentNameFromPath(undefined), null)
})

test('changedAgentNames covers add and modify, exempts delete, follows a rename', () => {
  assert.deepEqual(changedAgentNames('A\t.claude/agents/a.md\nM\t.claude/agents/b.md\nM\tworker/src/index.ts').sort(), ['a', 'b'])
  // A removed agent cannot be spawned, so demanding proof would be a deny with no honest exit.
  assert.deepEqual(changedAgentNames('D\t.claude/agents/gone.md'), [])
  assert.deepEqual(changedAgentNames('R100\t.claude/agents/old.md\t.claude/agents/new.md'), ['new'])
})

test('rangeForLine reads git’s stdin format, including both all-zero cases', () => {
  assert.equal(rangeForLine(`refs/heads/x aaa refs/heads/x bbb`), 'bbb..aaa')
  assert.equal(rangeForLine(`refs/heads/x aaa refs/heads/x ${ZEROS}`), 'origin/main...aaa', 'a branch the remote does not have yet')
  assert.equal(rangeForLine(`refs/heads/x ${ZEROS} refs/heads/x bbb`), null, 'a branch DELETION has nothing to inspect')
  assert.equal(rangeForLine(''), null)
})

test('spawnedAgents reads only this hook’s successful-spawn records', () => {
  const log = [
    JSON.stringify({ hook: 'agent-activation', decision: 'spawned', note: 'agent=alpha branch=feat/x' }),
    JSON.stringify({ hook: 'agent-activation', decision: 'deny', note: 'unverified=beta' }),
    JSON.stringify({ hook: 'review-loop', decision: 'inject', note: 'agent=gamma' }),
    'not json',
  ].join('\n')
  const got = spawnedAgents(log)
  assert.equal(got.has('alpha'), true)
  assert.equal(got.has('beta'), false, 'a deny record is not evidence of a spawn')
  assert.equal(got.has('gamma'), false, 'another hook’s record must not count')
})

test('unverified blocks an unspawned agent, passes a spawned one, and honours the override', () => {
  const diff = 'A\t.claude/agents/alpha.md'
  const rec = JSON.stringify({ hook: 'agent-activation', decision: 'spawned', note: 'agent=alpha' })
  assert.deepEqual(unverified(diff, '', undefined), ['alpha'])
  assert.deepEqual(unverified(diff, rec, undefined), [])
  assert.deepEqual(unverified(diff, '', '1'), [], 'AGENT_VERIFIED must be a real exit, or the deny is unsatisfiable')
})

test('unverified never blocks a diff that touches no agent', () => {
  // The false positive that matters most: ordinary work must pass untouched.
  assert.deepEqual(unverified('M\tworker/src/index.ts\nM\tCLAUDE.md', '', undefined), [])
})

// ── The hook as git actually runs it: exit codes, not string shapes ──────────

/** Run the shipped hook in a throwaway repo, feeding it git's real stdin format. */
function runHook({ agentChange, audit = '', env = {} }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'prepush-'))
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@t'); git('config', 'user.name', 't')
  writeFileSync(path.join(dir, 'seed.txt'), 'seed')
  git('add', '-A'); git('commit', '-qm', 'seed')
  const base = git('rev-parse', 'HEAD').trim()

  if (agentChange) {
    mkdirSync(path.join(dir, '.claude', 'agents'), { recursive: true })
    writeFileSync(path.join(dir, '.claude/agents/alpha.md'), '---\nname: alpha\n---\nbody\n')
  } else {
    writeFileSync(path.join(dir, 'seed.txt'), 'changed')
  }
  git('add', '-A'); git('commit', '-qm', 'change')
  const head = git('rev-parse', 'HEAD').trim()
  if (audit) {
    mkdirSync(path.join(dir, '.claude'), { recursive: true })
    writeFileSync(path.join(dir, '.claude/hook-audit.jsonl'), audit)
  }

  const r = spawnSync('node', [HOOK], {
    cwd: dir,
    input: `refs/heads/main ${head} refs/heads/main ${base}\n`,
    encoding: 'utf8',
    // HOME is redirected so a real audit log on this machine cannot make the test pass.
    env: { ...process.env, HOME: dir, AGENT_VERIFIED: '', ...env },
  })
  return { code: r.status, stderr: r.stderr || '' }
}

test('EXECUTED: a push touching no agent exits 0', () => {
  const { code } = runHook({ agentChange: false })
  assert.equal(code, 0)
})

test('EXECUTED: a push adding an unspawned agent exits NON-ZERO and says which', () => {
  // This is the assertion whose absence let the previous gate ship inert. `exit 0` here means the hook
  // ran and decided nothing — indistinguishable from a hook that was never wired, unless the code is
  // read. Deleting the deny, or the `main()` call, turns this red.
  const { code, stderr } = runHook({ agentChange: true })
  assert.notEqual(code, 0, 'the gate did not block — it is inert')
  assert.match(stderr, /BLOCKED/)
  assert.match(stderr, /alpha/, 'the deny must name the agent it is about')
  assert.match(stderr, /AGENT_VERIFIED=1/, 'the deny must state its own escape, or it is unsatisfiable')
})

test('EXECUTED: a recorded spawn lets the same push through', () => {
  const { code } = runHook({
    agentChange: true,
    audit: JSON.stringify({ hook: 'agent-activation', decision: 'spawned', note: 'agent=alpha branch=main' }) + '\n',
  })
  assert.equal(code, 0)
})

test('EXECUTED: AGENT_VERIFIED=1 is a real exit', () => {
  const { code } = runHook({ agentChange: true, env: { AGENT_VERIFIED: '1' } })
  assert.equal(code, 0)
})

test('EXECUTED: empty stdin fails OPEN rather than blocking a push it cannot judge', () => {
  const r = spawnSync('node', [HOOK], { input: '', encoding: 'utf8' })
  assert.equal(r.status, 0)
})

test('the hook is executable and shebanged — git runs it directly, unlike a Claude hook', () => {
  // The previous gate died on exactly this: a `.mjs` committed 100644 and invoked bare exits 126, which
  // is a non-blocking error rather than a deny. Claude hooks are wired with an explicit `node`; git is
  // not, so here the mode bit is load-bearing.
  assert.ok(statSync(HOOK).mode & 0o111, 'pre-push has no exec bit — git will not run it')
  const first = execFileSync('head', ['-1', HOOK], { encoding: 'utf8' })
  assert.match(first, /^#!.*\bnode\b/)
})

test('the repo ships the core.hooksPath wiring, or the hook is dead on every clone', () => {
  // `.git/hooks` is not version-controlled, so a committed hook does nothing until git is pointed at
  // `.githooks`. Without this the gate is present in the tree and inert everywhere — the same failure
  // mode as before, one layer over.
  const pkg = JSON.parse(execFileSync('cat', [path.join(HERE, '..', 'package.json')], { encoding: 'utf8' }))
  const prepare = pkg.scripts?.prepare ?? ''
  assert.match(prepare, /core\.hooksPath\s+\.githooks/, 'no prepare script points git at .githooks')
})
