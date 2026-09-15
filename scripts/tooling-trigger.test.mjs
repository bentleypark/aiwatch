// #1410 — tooling-trigger.sh routes each edited surface to the source of ground truth that covers it.
// Status-page/feed integrations → the live upstream response; SDK/binding files → first-party skill,
// else context7; UI → modern-web-guidance. The audit note prefix is asserted too, since it is how
// `hook-audit.jsonl` tells the arms apart.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const HOOKS = join(ROOT, '.claude', 'hooks')

// Runs the hook from a temp copy so its audit writes never touch the real .claude/hook-audit.jsonl.
function run(relPath) {
  const dir = mkdtempSync(join(tmpdir(), 'tooling-trigger-1410-'))
  try {
    cpSync(HOOKS, join(dir, '.claude', 'hooks'), { recursive: true })
    const result = spawnSync('bash', [join(dir, '.claude', 'hooks', 'tooling-trigger.sh')], {
      input: JSON.stringify({ tool_input: { file_path: join(ROOT, relPath) } }),
      encoding: 'utf8',
    })
    assert.equal(result.status, 0)
    const audit = (() => {
      try { return readFileSync(join(dir, '.claude', 'hook-audit.jsonl'), 'utf8') } catch { return '' }
    })()
    return {
      context: result.stdout ? JSON.parse(result.stdout).hookSpecificOutput.additionalContext : '',
      audit,
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('status-source files point at the live upstream, not a docs tool', () => {
  for (const p of [
    'worker/src/parsers/statuspage.ts', 'worker/src/services.ts', 'worker/src/changelog.ts',
    'worker/src/security-monitor.ts', 'worker/src/platform-monitor.ts', 'worker/src/reddit.ts',
  ]) {
    const { context, audit } = run(p)
    assert.match(context, /LIVE upstream/, p)
    assert.doesNotMatch(context, /context7|chub/, p)
    assert.match(audit, /upstream:/, p)
  }
})

test('SDK / binding files point at a first-party skill, then context7', () => {
  for (const p of ['worker/src/ai-analysis.ts', 'worker/src/anthropic.ts', 'package.json']) {
    const { context, audit } = run(p)
    assert.match(context, /claude-api/, p)
    assert.match(context, /context7/, p)
    assert.match(audit, /docs:/, p)
  }
})

test('no arm still names chub', () => {
  assert.doesNotMatch(readFileSync(join(HOOKS, 'tooling-trigger.sh'), 'utf8'), /chub/)
})

test('UI files keep the modern-web-guidance arm; tests and plain logic stay silent', () => {
  for (const p of [
    'src/components/Sidebar.jsx', 'src/pages/Overview.jsx', 'src/App.jsx', 'src/index.css',
    'api/_methodology/html-template.ts', 'api/is-down.ts', 'api/intro.ts',
  ]) {
    const ui = run(p)
    assert.match(ui.context, /modern-web-guidance/, p)
    assert.match(ui.audit, /modern-web:/, p)
  }
  assert.equal(run('worker/src/parsers/__tests__/statuspage.test.ts').context, '')
  assert.equal(run('worker/src/score.ts').context, '')
})
