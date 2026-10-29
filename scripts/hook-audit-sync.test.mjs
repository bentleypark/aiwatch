import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { planSync, isSignal, redactNote, hostFileName } from './hook-audit-sync.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOME = '/Users/someone'
const ts = (m) => `2026-10-29T10:${String(m).padStart(2, '0')}:00Z`
const line = (m, hook, decision, note = '') => JSON.stringify({ ts: ts(m), hook, decision, note })

test('per-turn telemetry is not synced; every decision line is', () => {
  assert.equal(isSignal({ hook: 'workflow-gates-reminder', decision: 'inject' }), false)
  assert.equal(isSignal({ hook: 'stop-nag-gate', decision: 'clean' }), false)
  for (const [hook, decision] of [
    ['stop-nag-gate', 'block'],
    ['review-loop-gate', 'record'],
    ['evidence-line-gate', 'clean'],
    ['evidence-line-gate', 'warn'],
    ['step35-verify-gate', 'deny'],
  ]) assert.equal(isSignal({ hook, decision }), true, `${hook}:${decision}`)
})

test('the home directory in a note is written as ~', () => {
  assert.equal(redactNote(`self-edit:${HOME}/repo/.claude/hooks/x.mjs`, HOME), 'self-edit:~/repo/.claude/hooks/x.mjs')
  assert.equal(redactNote(undefined, HOME), '')
})

test('planSync appends only new signal lines, redacted, and is idempotent', () => {
  const local = [
    line(1, 'workflow-gates-reminder', 'inject'),
    line(2, 'review-loop-gate', 'record', 'round-2:b=feat/x'),
    line(3, 'step35-verify-gate', 'pass', `self-edit-authorized:${HOME}/r/.claude/hooks/a.mjs`),
    'not json',
    line(4, 'stop-nag-gate', 'clean'),
  ].join('\n')
  const first = planSync(local, '', HOME)
  assert.deepEqual(first.map((l) => JSON.parse(l).ts), [ts(2), ts(3)])
  assert.equal(JSON.parse(first[1]).note, 'self-edit-authorized:~/r/.claude/hooks/a.mjs')
  assert.deepEqual(planSync(local, first.join('\n'), HOME), [])
  const more = local + '\n' + line(5, 'evidence-line-gate', 'warn', 'trigger=1 lines=0')
  assert.deepEqual(planSync(more, first.join('\n'), HOME).map((l) => JSON.parse(l).ts), [ts(5)])
})

test('two identical events in the same second are both synced, and only once', () => {
  const twice = [line(7, 'stop-nag-gate', 'block', 'ko-auto-proceed'), line(7, 'stop-nag-gate', 'block', 'ko-auto-proceed')].join('\n')
  const first = planSync(twice, '', HOME)
  assert.equal(first.length, 2)
  assert.deepEqual(planSync(twice, first.join('\n'), HOME), [])
  assert.equal(planSync(twice, first[0], HOME).length, 1)
  const differentNotes = [line(8, 'stop-nag-gate', 'block', 'en-shall-i'), line(8, 'stop-nag-gate', 'block', 'ko-next-step')].join('\n')
  assert.equal(planSync(differentNotes, JSON.stringify(JSON.parse(differentNotes.split('\n')[0])), HOME).length, 1)
})

test('the host file name is one safe path segment', () => {
  assert.equal(hostFileName('Some-MacBook-Pro.local'), 'Some-MacBook-Pro.jsonl')
  assert.equal(hostFileName('a b/c'), 'a-b-c.jsonl')
  assert.equal(hostFileName(''), 'unknown.jsonl')
})

function tmpBundle() {
  const root = mkdtempSync(join(tmpdir(), 'audit-sync-'))
  const bundle = join(root, 'memory')
  mkdirSync(bundle)
  return { root, bundle }
}

test('the CLI writes <bundle>/audit/<host>.jsonl and a second run adds nothing', () => {
  const { root, bundle } = tmpBundle()
  const log = join(root, 'hook-audit.jsonl')
  writeFileSync(log, [line(1, 'workflow-gates-reminder', 'inject'), line(2, 'stop-nag-gate', 'block', 'en-shall-i')].join('\n') + '\n')
  const env = { ...process.env, HOOK_AUDIT_LOG: log, MEMORY_DIR: bundle, HOOK_AUDIT_HOST: 'box-a' }
  const run = () => execFileSync('node', ['scripts/hook-audit-sync.mjs'], { cwd: REPO, encoding: 'utf8', env })
  assert.match(run(), /\+1 line\(s\)/)
  assert.match(run(), /\+0 line\(s\)/)
  const synced = readFileSync(join(bundle, 'audit', 'box-a.jsonl'), 'utf8').trim().split('\n')
  assert.deepEqual(synced.map((l) => JSON.parse(l).decision), ['block'])
})

test('the CLI exits 2 when the configured bundle does not exist', () => {
  const { root } = tmpBundle()
  let status = 0
  try {
    execFileSync('node', ['scripts/hook-audit-sync.mjs'], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, HOOK_AUDIT_LOG: join(root, 'x.jsonl'), MEMORY_DIR: join(root, 'nope') },
    })
  } catch (e) {
    status = e.status
  }
  assert.equal(status, 2)
})

test('npm run hook-audit merges the local log with every machine file, once per event', () => {
  const { root, bundle } = tmpBundle()
  const shared = join(bundle, 'audit')
  mkdirSync(shared)
  const recent = (h) => new Date(Date.now() - h * 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const ev = (h, note) => JSON.stringify({ ts: recent(h), hook: 'evidence-line-gate', decision: 'warn', note })
  const local = join(root, 'hook-audit.jsonl')
  writeFileSync(local, ev(1, 'trigger=1 lines=0') + '\n')
  writeFileSync(join(shared, 'box-a.jsonl'), ev(1, 'trigger=1 lines=0') + '\n')
  writeFileSync(join(shared, 'box-b.jsonl'), ev(2, 'trigger=1 lines=0') + '\n')
  const out = execFileSync('node', ['scripts/hook-audit-summary.mjs', '--days', '30'], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, HOOK_AUDIT_LOG: local, HOOK_AUDIT_SHARED_DIR: shared },
  })
  assert.match(out, /2 final message\(s\) checked/)
  const alone = execFileSync('node', ['scripts/hook-audit-summary.mjs', '--days', '30'], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, HOOK_AUDIT_LOG: local, HOOK_AUDIT_SHARED_DIR: '' },
  })
  assert.match(alone, /1 final message\(s\) checked/)
})

test('with no env override, npm run hook-audit reads the bundle named in .memory-dir', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'audit-default-')))
  mkdirSync(join(root, 'scripts'))
  mkdirSync(join(root, '.claude'))
  for (const f of ['hook-audit-summary.mjs', 'hook-audit-sync.mjs', 'lint-decision-graph.mjs']) {
    cpSync(join(REPO, 'scripts', f), join(root, 'scripts', f))
  }
  const bundle = join(root, 'bundle')
  mkdirSync(join(bundle, 'audit'), { recursive: true })
  writeFileSync(join(root, '.memory-dir'), bundle + '\n')
  const recent = new Date(Date.now() - 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  writeFileSync(
    join(bundle, 'audit', 'box-b.jsonl'),
    JSON.stringify({ ts: recent, hook: 'evidence-line-gate', decision: 'warn', note: 'trigger=1 lines=0' }) + '\n',
  )
  const env = { ...process.env }
  for (const k of ['HOOK_AUDIT_LOG', 'HOOK_AUDIT_SHARED_DIR', 'MEMORY_DIR']) delete env[k]
  const out = execFileSync('node', ['scripts/hook-audit-summary.mjs', '--days', '30'], { cwd: root, encoding: 'utf8', env })
  assert.match(out, /\+ 1 machine file\(s\)/)
  assert.match(out, /1 final message\(s\) checked/)
})
