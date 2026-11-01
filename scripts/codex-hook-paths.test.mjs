import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const HOOKS = join(ROOT, '.claude', 'hooks')

function run(name, command) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-hook-paths-'))
  try {
    const hooks = join(dir, '.claude', 'hooks')
    cpSync(HOOKS, hooks, { recursive: true })
    const result = spawnSync('bash', [join(hooks, name)], {
      input: JSON.stringify({
        session_id: 'codex-session', cwd: ROOT, hook_event_name: 'PreToolUse', tool_name: 'apply_patch',
        tool_use_id: 'tool-1', permission_mode: 'default', tool_input: { command },
      }),
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim() ? JSON.parse(result.stdout).hookSpecificOutput.additionalContext : ''
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('Codex apply_patch routes a status-source edit to the live-upstream reminder', () => {
  const text = run('tooling-trigger.sh', '*** Begin Patch\n*** Update File: worker/src/services.ts\n*** End Patch')
  assert.match(text, /LIVE upstream/)
})

test('Codex apply_patch scans every changed path until it finds Korean copy', () => {
  const text = run('korean-copy-trigger.sh', [
    '*** Begin Patch',
    '*** Update File: worker/src/score.ts',
    '*** Update File: src/locales/ko.js',
    '*** End Patch',
  ].join('\n'))
  assert.match(text, /npm run lint:korean/)
})

test('a Codex apply_patch with no watched path stays silent', () => {
  const text = run('tooling-trigger.sh', '*** Begin Patch\n*** Update File: worker/src/score.ts\n*** End Patch')
  assert.equal(text, '')
})
