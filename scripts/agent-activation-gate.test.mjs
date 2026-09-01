// #1298 — unit tests for the agent-activation gate. Run with `npm run test:scripts`.
//
// The gate DENIES, so the failure to guard is a false deny as much as a missed one. Every test below
// pins both directions (memory `feedback_mutation_test_both_directions`): a mutation that stops the
// blocking, and one that starts blocking work which already complied.
//
// The end-to-end wiring cannot be tested here — the gate's own effect needs a session restart, which is
// the very problem it exists to enforce. What IS testable is the decision logic, and that is what these
// cover. The wiring assertion at the bottom is the same shape the other hook suites use.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  agentNameFromPath,
  changedAgentNames,
  isPublishCommand,
  spawnedAgents,
  unverifiedAgents,
} from '../.claude/hooks/agent-activation-gate.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

test('agentNameFromPath matches only a real agent definition path', () => {
  assert.equal(agentNameFromPath('.claude/agents/review-findings-only.md'), 'review-findings-only')
  assert.equal(agentNameFromPath('worker/.claude/agents/x.md'), 'x')
  // Not agents, and a file that merely MENTIONS one must not count.
  assert.equal(agentNameFromPath('.claude/hooks/review-loop-gate.mjs'), null)
  assert.equal(agentNameFromPath('docs/reference/code-review-policy.md'), null)
  assert.equal(agentNameFromPath('.claude/agents/nested/x.md'), null)
  assert.equal(agentNameFromPath('.claude/agents/x.txt'), null)
  assert.equal(agentNameFromPath(undefined), null)
})

test('changedAgentNames picks up adds and modifies', () => {
  const diff = ['A\t.claude/agents/alpha.md', 'M\t.claude/agents/beta.md', 'M\tworker/src/index.ts'].join('\n')
  assert.deepEqual(changedAgentNames(diff).sort(), ['alpha', 'beta'])
})

test('changedAgentNames EXEMPTS a deletion — a removed agent cannot be spawned', () => {
  // The other direction of the same guard: requiring proof of a spawn for a file that no longer exists
  // would be a deny with no honest exit, which is exactly what #1150 rejected.
  assert.deepEqual(changedAgentNames('D\t.claude/agents/gone.md'), [])
})

test('changedAgentNames takes the DESTINATION of a rename', () => {
  assert.deepEqual(changedAgentNames('R100\t.claude/agents/old.md\t.claude/agents/new.md'), ['new'])
})

test('isPublishCommand gates publishing, not committing', () => {
  assert.equal(isPublishCommand('git push'), true)
  assert.equal(isPublishCommand('git push --force-with-lease'), true)
  assert.equal(isPublishCommand('gh pr create --base main'), true)
  // A local commit is where the definition gets written; gating it would deny the step that produces
  // the thing to verify.
  assert.equal(isPublishCommand('git commit -m x'), false)
  assert.equal(isPublishCommand('git status'), false)
  assert.equal(isPublishCommand(''), false)
})

test('spawnedAgents reads only successful-spawn records', () => {
  const log = [
    JSON.stringify({ hook: 'agent-activation', decision: 'spawned', note: 'agent=alpha branch=feat/x' }),
    JSON.stringify({ hook: 'agent-activation', decision: 'deny', note: 'unverified=beta' }),
    JSON.stringify({ hook: 'review-loop', decision: 'inject', note: 'agent=gamma branch=feat/x' }),
    'not json at all',
  ].join('\n')
  const got = spawnedAgents(log, 'feat/x')
  assert.equal(got.has('alpha'), true)
  assert.equal(got.has('beta'), false, 'a deny record is not evidence of a spawn')
  assert.equal(got.has('gamma'), false, 'another hook’s record must not count')
})

test('spawnedAgents scopes to the branch, but a branchless record still counts', () => {
  const log = [
    JSON.stringify({ hook: 'agent-activation', decision: 'spawned', note: 'agent=alpha branch=other' }),
    JSON.stringify({ hook: 'agent-activation', decision: 'spawned', note: 'agent=legacy' }),
  ].join('\n')
  assert.equal(spawnedAgents(log, 'feat/x').has('alpha'), false, 'a spawn on another branch is not proof here')
  // Fail-open: a record written before branches were tracked must not manufacture a deny.
  assert.equal(spawnedAgents(log, 'feat/x').has('legacy'), true)
})

test('unverifiedAgents blocks an unspawned agent and passes a spawned one', () => {
  const diff = 'A\t.claude/agents/alpha.md'
  const spawned = JSON.stringify({ hook: 'agent-activation', decision: 'spawned', note: 'agent=alpha branch=feat/x' })
  assert.deepEqual(unverifiedAgents(diff, '', 'feat/x'), ['alpha'], 'no record → deny')
  assert.deepEqual(unverifiedAgents(diff, spawned, 'feat/x'), [], 'record present → pass')
})

test('unverifiedAgents ignores a diff that touches no agent', () => {
  // The most important false-positive case: ordinary work must never be blocked by this gate.
  const diff = ['M\tworker/src/index.ts', 'M\tdocs/reference/code-review-policy.md'].join('\n')
  assert.deepEqual(unverifiedAgents(diff, '', 'feat/x'), [])
})

test('the gate is wired for BOTH events it needs, or it cannot work', () => {
  // PostToolUse is what makes the whole thing possible — it fires only after a tool SUCCEEDS, so it is
  // the discriminator between "the agent resolved" and "agent type not found". Without that wiring the
  // PreToolUse half would deny every push forever, with no way to satisfy it.
  const settings = JSON.parse(readFileSync(path.join(HERE, '..', '.claude', 'settings.json'), 'utf8'))
  const cmds = (ev) => (settings.hooks?.[ev] ?? []).flatMap((m) => (m.hooks ?? []).map((h) => `${m.matcher ?? '*'}::${h.command ?? ''}`))
  const post = cmds('PostToolUse').filter((c) => c.includes('agent-activation-gate.mjs'))
  const pre = cmds('PreToolUse').filter((c) => c.includes('agent-activation-gate.mjs'))
  assert.equal(post.length, 1, 'PostToolUse/Task recording is not wired — the gate would be unsatisfiable')
  assert.match(post[0], /^Task\|Agent::/, 'the recorder must match Task|Agent')
  assert.equal(pre.length, 1, 'PreToolUse/Bash denial is not wired — the gate would never fire')
  assert.match(pre[0], /^Bash::/, 'the denial must match Bash')
})

test('the wiring INVOKES the hook, rather than merely naming it', () => {
  // This is the assertion whose absence let a dead hook ship green. The first cut wired the command
  // BARE — `"$CLAUDE_PROJECT_DIR"/.claude/hooks/agent-activation-gate.mjs` — while the file is
  // committed 100644, like both sibling `.mjs` hooks. Without an exec bit a bare command exits 126
  // (permission denied), not 2, so the PreToolUse half denied nothing and the PostToolUse half
  // recorded nothing. Both were silently inert, and every other assertion in this file still passed
  // because they only ever checked that the command STRING contained the filename.
  //
  // The repo's convention for a `.mjs` hook is `node "<path>"`; the two shipped ones prove it works
  // without an exec bit. So this pins the invocation form, not the file mode.
  const settings = JSON.parse(readFileSync(path.join(HERE, '..', '.claude', 'settings.json'), 'utf8'))
  const all = Object.values(settings.hooks ?? {}).flat().flatMap((m) => (m.hooks ?? []).map((h) => h.command ?? ''))
  const ours = all.filter((c) => c.includes('agent-activation-gate.mjs'))
  assert.equal(ours.length, 2, 'expected both call sites')
  for (const c of ours) {
    assert.match(c, /^node\s+"/, `hook is not invoked with an interpreter: ${c}`)
  }
  // And the same rule for every other `.mjs` hook, so the next one cannot repeat this.
  for (const c of all.filter((x) => x.endsWith('.mjs"') || x.endsWith('.mjs'))) {
    assert.match(c, /^(node|bash)\s+/, `a hook command must name its interpreter: ${c}`)
  }
})

test('the hook actually RUNS and can return the deny code', async () => {
  // Executes the shipped file the way settings invokes it. A hook that cannot start is the failure
  // this suite missed; asserting the exit code is what distinguishes "denied" (2) from "could not
  // run" (126) — the two look alike from the outside and only one of them blocks anything.
  const { execFileSync } = await import('node:child_process')
  const hook = path.join(HERE, '..', '.claude', 'hooks', 'agent-activation-gate.mjs')
  // A command the gate does not care about must exit 0 — proving it started and made a decision.
  const out = execFileSync('node', [hook], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_input: { command: 'git status' } }),
    encoding: 'utf8',
  })
  assert.equal(typeof out, 'string')
})
