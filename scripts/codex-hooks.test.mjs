import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const HOOKS = join(ROOT, '.claude', 'hooks')
const CONFIG = JSON.parse(readFileSync(join(ROOT, '.codex', 'hooks.json'), 'utf8'))

function configured(event, name) {
  return (CONFIG.hooks[event] ?? []).flatMap((group) => group.hooks ?? [])
    .find((hook) => hook.command.includes(name))
}

function run(name, input) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-hooks-'))
  const hooks = join(dir, '.claude', 'hooks')
  try {
    cpSync(HOOKS, hooks, { recursive: true })
    const result = spawnSync('bash', [join(hooks, name)], {
      input: JSON.stringify(input), encoding: 'utf8',
    })
    assert.equal(result.status, 0, `${name}: ${result.stderr}`)
    return {
      output: result.stdout.trim() ? JSON.parse(result.stdout) : null,
      audit: existsSync(join(dir, '.claude', 'hook-audit.jsonl'))
        ? readFileSync(join(dir, '.claude', 'hook-audit.jsonl'), 'utf8')
        : '',
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function advisory(output, event) {
  assert.equal(output?.hookSpecificOutput?.hookEventName, event)
  assert.equal(typeof output.hookSpecificOutput.additionalContext, 'string')
  assert.ok(output.hookSpecificOutput.additionalContext.length > 0)
}

test('Codex configuration wires the compatible hooks from the worktree root', () => {
  assert.deepEqual(Object.keys(CONFIG.hooks).sort(), ['PreToolUse', 'UserPromptSubmit'])
  for (const [event, name] of [
    ['UserPromptSubmit', 'workflow-gates-reminder.sh'],
    ['PreToolUse', 'git-mutation-gate.sh'],
    ['PreToolUse', 'public-issue-figures-trigger.sh'],
  ]) {
    const hook = configured(event, name)
    assert.ok(hook, `${name} is configured for ${event}`)
    assert.equal(hook.type, 'command')
    assert.match(hook.command, /git rev-parse --show-toplevel/)
    assert.doesNotMatch(hook.command, /CLAUDE_PROJECT_DIR/)
  }
  assert.equal(CONFIG.hooks.PreToolUse[0].matcher, '^Bash$')
  const editGroup = CONFIG.hooks.PreToolUse.find((group) => group.matcher === 'Edit|Write')
  assert.ok(editGroup)
  assert.equal(editGroup.hooks.length, 2)
})

test('workflow reminder accepts Codex UserPromptSubmit input and records its injection', () => {
  const { output, audit } = run('workflow-gates-reminder.sh', {
    session_id: 'codex-session', cwd: ROOT, hook_event_name: 'UserPromptSubmit', permission_mode: 'default',
  })
  advisory(output, 'UserPromptSubmit')
  assert.match(audit, /"hook":"workflow-gates-reminder"/)
  assert.match(audit, /"decision":"inject"/)
})

test('Bash reminders accept Codex PreToolUse input and preserve soft advisories', () => {
  const base = {
    session_id: 'codex-session', cwd: ROOT, hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_use_id: 'tool-1', permission_mode: 'default',
  }
  const mutation = run('git-mutation-gate.sh', { ...base, tool_input: { command: 'git commit -m test' } })
  advisory(mutation.output, 'PreToolUse')
  assert.match(mutation.audit, /"hook":"git-mutation-gate"/)

  const figures = run('public-issue-figures-trigger.sh', {
    ...base, tool_input: { command: 'gh issue comment 1 --body test' },
  })
  advisory(figures.output, 'PreToolUse')
  assert.match(figures.audit, /"hook":"public-issue-figures"/)
})
