// #1281 — PreToolUse soft reminders must use the channel the harness delivers.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const HOOKS = join(ROOT, '.claude', 'hooks')

function run(name, input, mutate = false) {
  const dir = mkdtempSync(join(tmpdir(), 'soft-hook-1281-'))
  const hooks = join(dir, '.claude', 'hooks')
  const hook = join(hooks, name)
  try {
    cpSync(join(HOOKS, '_audit.sh'), join(hooks, '_audit.sh'))
    const source = readFileSync(join(HOOKS, name), 'utf8')
    writeFileSync(hook, mutate ? source.replaceAll('hookSpecificOutput', 'systemMessage') : source)
    const result = spawnSync('bash', [hook], { input: JSON.stringify(input), encoding: 'utf8' })
    assert.equal(result.status, 0)
    return JSON.parse(result.stdout)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function assertPreToolUseAdvisory(output) {
  assert.deepEqual(Object.keys(output), ['hookSpecificOutput'])
  assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse')
  assert.equal(typeof output.hookSpecificOutput.additionalContext, 'string')
  assert.ok(output.hookSpecificOutput.additionalContext.length > 0)
}

test('all three soft PreToolUse reminders use hookSpecificOutput.additionalContext', () => {
  assertPreToolUseAdvisory(run('git-mutation-gate.sh', { tool_input: { command: 'git commit -m x' }, cwd: ROOT }))
  assertPreToolUseAdvisory(run('tooling-trigger.sh', { tool_input: { file_path: join(ROOT, 'worker/src/services.ts') } }))
  assertPreToolUseAdvisory(run('korean-copy-trigger.sh', { tool_input: { file_path: join(ROOT, 'src/locales/ko.js') } }))
})

test('the channel contract catches a mutant that restores top-level systemMessage', () => {
  for (const [name, input] of [
    ['git-mutation-gate.sh', { tool_input: { command: 'git commit -m x' }, cwd: ROOT }],
    ['tooling-trigger.sh', { tool_input: { file_path: join(ROOT, 'worker/src/services.ts') } }],
    ['korean-copy-trigger.sh', { tool_input: { file_path: join(ROOT, 'src/locales/ko.js') } }],
  ]) {
    assert.throws(() => assertPreToolUseAdvisory(run(name, input, true)), /hookSpecificOutput/)
  }
})
