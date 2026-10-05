import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findMachinePaths, scanRepo } from './check-machine-paths.mjs'

test('finds a ~/Desktop path and a /Users/<name>/ path', () => {
  const text = ['ok', 'cd ~/Desktop/bentely/aiwatch/aiwatch-reports', 'see /Users/bentley/Desktop/x', 'ok'].join('\n')
  assert.deepEqual(findMachinePaths(text).map((m) => m.line), [2, 3])
})

test('accepts paths relative to the checkout or $HOME-agnostic', () => {
  const text = [
    'cd ../aiwatch-reports',
    'PATH="$(brew --prefix ruby)/bin:$PATH"',
    'the harness memory dir `~/.claude/projects/<slug>/memory/`',
    '`/Users` alone, or /Users/<name> without a trailing slash',
  ].join('\n')
  assert.deepEqual(findMachinePaths(text), [])
})

test('scanRepo reads only the scanned roots', () => {
  const dir = mkdtempSync(join(tmpdir(), 'machine-paths-'))
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir })
    mkdirSync(join(dir, '.claude/skills/x'), { recursive: true })
    mkdirSync(join(dir, 'scripts'))
    writeFileSync(join(dir, 'CLAUDE.md'), 'clean\n')
    writeFileSync(join(dir, '.claude/skills/x/SKILL.md'), 'a\ncd ~/Desktop/foo\n')
    writeFileSync(join(dir, 'scripts/t.test.mjs'), "isUiEdgePath('/Users/x/dev/aiwatch/src/a.jsx')\n")
    execFileSync('git', ['add', '.'], { cwd: dir })
    assert.deepEqual(scanRepo(dir).map((h) => `${h.path}:${h.line}`), ['.claude/skills/x/SKILL.md:2'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI — the shipped script exits 0 on the real repo', () => {
  const out = execFileSync(process.execPath, [fileURLToPath(new URL('./check-machine-paths.mjs', import.meta.url))], { encoding: 'utf8' })
  assert.match(out, /no machine-specific paths/)
})
