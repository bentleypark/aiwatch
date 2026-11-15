import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { autocommit, changedFiles, commitMessage, LOCK_STALE_MS, MAX_FILES_IN_MESSAGE } from './memory-autocommit.mjs'

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

function clone(remote, root, name) {
  const dir = join(root, name)
  execFileSync('git', ['clone', '-q', remote, dir])
  sh(dir, 'config', 'user.email', 't@example.com')
  sh(dir, 'config', 'user.name', 't')
  return dir
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'memauto-'))
  const remote = join(root, 'remote.git')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote])
  const seed = join(root, 'seed')
  execFileSync('git', ['init', '-q', '-b', 'main', seed])
  sh(seed, 'config', 'user.email', 't@example.com')
  sh(seed, 'config', 'user.name', 't')
  writeFileSync(join(seed, 'page.md'), 'one\n')
  sh(seed, 'add', '-A')
  sh(seed, 'commit', '-q', '-m', 'seed')
  sh(seed, 'push', '-q', remote, 'main')
  return { root, remote, dir: clone(remote, root, 'bundle') }
}

const ok = () => ({ ok: true, out: '' })
const remoteSubject = (remote) => execFileSync('git', ['--git-dir', remote, 'log', '-1', '--format=%s', 'main'], { encoding: 'utf8' }).trim()

test('changedFiles reads plain, untracked and renamed entries', () => {
  assert.deepEqual(changedFiles(' M MEMORY.md\n?? new.md\nR  old.md -> moved.md\n'), ['MEMORY.md', 'new.md', 'moved.md'])
  assert.deepEqual(changedFiles(''), [])
})

test('commitMessage names the trigger and truncates a long file list', () => {
  const files = Array.from({ length: MAX_FILES_IN_MESSAGE + 2 }, (_, i) => `p${i}.md`)
  const m = commitMessage('daily', files, '2026-11-15')
  assert.match(m, /^auto\(daily\): 2026-11-15 — 10 file\(s\): p0\.md/)
  assert.match(m, /\(\+2 more\)$/)
})

test('a clean bundle is a no-op', () => {
  const { remote, dir } = setup()
  const r = autocommit({ dir, trigger: 'test', lint: ok })
  assert.equal(r.status, 'clean')
  assert.equal(remoteSubject(remote), 'seed')
})

test('a dirty bundle is committed and pushed', () => {
  const { remote, dir } = setup()
  writeFileSync(join(dir, 'page.md'), 'two\n')
  writeFileSync(join(dir, 'new.md'), 'x\n')
  const r = autocommit({ dir, trigger: 'test', lint: ok, date: '2026-11-15' })
  assert.equal(r.status, 'pushed')
  assert.equal(remoteSubject(remote), 'auto(test): 2026-11-15 — 2 file(s): page.md, new.md')
  assert.equal(sh(dir, 'status', '--porcelain'), '')
})

test('a lint finding commits nothing', () => {
  const { remote, dir } = setup()
  writeFileSync(join(dir, 'page.md'), 'two\n')
  let audited = false
  const r = autocommit({ dir, trigger: 'test', lint: () => ({ ok: false, out: 'dangling [[x]]' }), auditSync: () => ((audited = true), { ok: true }) })
  assert.equal(r.status, 'lint-failed')
  assert.equal(r.detail, 'dangling [[x]]')
  assert.ok(audited)
  assert.equal(sh(dir, 'log', '-1', '--format=%s'), 'seed')
  assert.equal(sh(dir, 'status', '--porcelain'), 'M page.md')
  assert.equal(remoteSubject(remote), 'seed')
})

test('a rebase conflict is aborted and the commit stays local', () => {
  const { root, remote, dir } = setup()
  const other = clone(remote, root, 'other')
  writeFileSync(join(other, 'page.md'), 'theirs\n')
  sh(other, 'commit', '-q', '-am', 'theirs')
  sh(other, 'push', '-q')
  writeFileSync(join(dir, 'page.md'), 'ours\n')
  const r = autocommit({ dir, trigger: 'test', lint: ok })
  assert.equal(r.status, 'committed-local')
  assert.ok(!existsSync(join(dir, '.git', 'rebase-merge')) && !existsSync(join(dir, '.git', 'rebase-apply')))
  assert.match(sh(dir, 'log', '-1', '--format=%s'), /^auto\(test\)/)
  assert.equal(remoteSubject(remote), 'theirs')
})

test('an unpushed auto commit is pushed on a later clean run', () => {
  const { remote, dir } = setup()
  writeFileSync(join(dir, 'page.md'), 'local\n')
  sh(dir, 'commit', '-q', '-am', 'auto(test): left local')
  assert.equal(autocommit({ dir, trigger: 'test', lint: ok }).status, 'pushed')
  assert.equal(remoteSubject(remote), 'auto(test): left local')
})

test('a hand commit ahead is never pushed', () => {
  const { remote, dir } = setup()
  writeFileSync(join(dir, 'page.md'), 'local\n')
  sh(dir, 'commit', '-q', '-am', 'by hand')
  assert.equal(autocommit({ dir, trigger: 'test', lint: ok }).status, 'committed-local')
  writeFileSync(join(dir, 'new.md'), 'x\n')
  const r = autocommit({ dir, trigger: 'test', lint: ok })
  assert.equal(r.status, 'committed-local')
  assert.match(r.detail, /by hand/)
  assert.equal(remoteSubject(remote), 'seed')
})

test('a fresh lock skips the run; a stale one is taken over', () => {
  const { remote, dir } = setup()
  writeFileSync(join(dir, 'page.md'), 'two\n')
  const lock = join(dir, '.git', 'autocommit.lock')
  mkdirSync(lock)
  assert.equal(autocommit({ dir, trigger: 'test', lint: ok }).status, 'locked')
  assert.equal(remoteSubject(remote), 'seed')
  const old = (Date.now() - LOCK_STALE_MS - 1000) / 1000
  utimesSync(lock, old, old)
  assert.equal(autocommit({ dir, trigger: 'test', lint: ok }).status, 'pushed')
  assert.ok(!existsSync(lock))
})

test('a rejected push is reported, not called pushed', () => {
  const { remote, dir } = setup()
  writeFileSync(join(remote, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  writeFileSync(join(dir, 'page.md'), 'two\n')
  const r = autocommit({ dir, trigger: 'test', lint: ok })
  assert.equal(r.status, 'committed-local')
  assert.match(r.detail, /^push:/)
})

test('a failed commit stops before pull and push', () => {
  const { remote, dir } = setup()
  writeFileSync(join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  writeFileSync(join(dir, 'page.md'), 'two\n')
  const r = autocommit({ dir, trigger: 'test', lint: ok })
  assert.equal(r.status, 'commit-failed')
  assert.equal(remoteSubject(remote), 'seed')
})

test('a branch with no upstream is reported, not called clean', () => {
  const { dir } = setup()
  sh(dir, 'checkout', '-q', '-b', 'side')
  assert.equal(autocommit({ dir, trigger: 'test', lint: ok }).status, 'no-upstream')
})

function conflicted(root, remote, dir) {
  const other = clone(remote, root, 'other')
  writeFileSync(join(other, 'page.md'), 'theirs\n')
  sh(other, 'commit', '-q', '-am', 'theirs')
  sh(other, 'push', '-q')
  sh(dir, 'fetch', '-q')
}

test('a stash pop conflict on a branch is left untouched', () => {
  const { root, remote, dir } = setup()
  conflicted(root, remote, dir)
  writeFileSync(join(dir, 'page.md'), 'wip\n')
  sh(dir, 'stash', '-q')
  sh(dir, 'merge', '-q', '--ff-only', '@{u}')
  try { sh(dir, 'stash', 'pop', '-q') } catch {}
  assert.ok(sh(dir, 'diff', '--name-only', '--diff-filter=U').includes('page.md'))
  assert.ok(sh(dir, 'symbolic-ref', '-q', 'HEAD'))
  assert.equal(autocommit({ dir, trigger: 'test', lint: ok }).status, 'busy')
  assert.equal(remoteSubject(remote), 'theirs')
})

test('a detached HEAD with no conflict is left untouched', () => {
  const { remote, dir } = setup()
  sh(dir, 'checkout', '-q', '--detach')
  writeFileSync(join(dir, 'page.md'), 'two\n')
  assert.equal(autocommit({ dir, trigger: 'test', lint: ok }).status, 'busy')
  assert.equal(remoteSubject(remote), 'seed')
})

function resolvedConflict(root, remote, dir, start) {
  conflicted(root, remote, dir)
  writeFileSync(join(dir, 'page.md'), 'ours\n')
  sh(dir, 'commit', '-q', '-am', 'ours by hand')
  sh(dir, 'branch', '-q', 'mine')
  sh(dir, 'reset', '-q', '--hard', '@{u}')
  try { start(dir) } catch {}
  writeFileSync(join(dir, 'page.md'), 'resolved\n')
  sh(dir, 'add', 'page.md')
  assert.equal(sh(dir, 'diff', '--name-only', '--diff-filter=U'), '')
}

for (const [name, start] of [
  ['merge', (d) => sh(d, 'merge', '-q', 'mine')],
  ['cherry-pick', (d) => sh(d, 'cherry-pick', 'mine')],
  ['revert', (d) => {
    writeFileSync(join(d, 'page.md'), 'a\n'); sh(d, 'commit', '-q', '-am', 'a')
    writeFileSync(join(d, 'page.md'), 'b\n'); sh(d, 'commit', '-q', '-am', 'b')
    sh(d, 'revert', '--no-edit', 'HEAD~1')
  }],
  ['am', (d) => { const patch = sh(d, 'format-patch', '-1', 'mine', '-o', join(d, '.git', 'p')); sh(d, 'am', '-3', patch) }],
]) {
  test(`a ${name} with its conflict resolved but not continued is left untouched`, () => {
    const { root, remote, dir } = setup()
    resolvedConflict(root, remote, dir, start)
    const r = autocommit({ dir, trigger: 'test', lint: ok })
    assert.equal(r.status, 'busy')
    assert.equal(remoteSubject(remote), 'theirs')
  })
}

test('a failed audit sync is reported on a pushed run too', () => {
  const { dir } = setup()
  writeFileSync(join(dir, 'page.md'), 'two\n')
  const r = autocommit({ dir, trigger: 'test', lint: ok, auditSync: () => ({ ok: false, out: 'AUDIT BROKE' }) })
  assert.equal(r.status, 'pushed')
  assert.match(r.detail, /audit sync: AUDIT BROKE/)
})

test('a multi-commit cherry-pick committed by hand mid-sequence is left untouched', () => {
  const { root, remote, dir } = setup()
  writeFileSync(join(dir, 'page.md'), 'p1\n'); sh(dir, 'commit', '-q', '-am', 'auto(daily): p1')
  writeFileSync(join(dir, 'p2.md'), 'p2\n'); sh(dir, 'add', 'p2.md'); sh(dir, 'commit', '-q', '-m', 'auto(daily): p2')
  sh(dir, 'branch', '-q', 'mine')
  sh(dir, 'reset', '-q', '--hard', 'origin/main')
  conflicted(root, remote, dir)
  sh(dir, 'reset', '-q', '--hard', '@{u}')
  try { sh(dir, 'cherry-pick', 'mine~1', 'mine') } catch {}
  writeFileSync(join(dir, 'page.md'), 'resolved\n')
  sh(dir, 'add', 'page.md')
  sh(dir, 'commit', '-q', '--no-edit')
  assert.ok(!existsSync(join(dir, '.git', 'CHERRY_PICK_HEAD')) && existsSync(join(dir, '.git', 'sequencer')))
  writeFileSync(join(dir, 'wip.md'), 'x\n')
  assert.equal(autocommit({ dir, trigger: 'test', lint: ok }).status, 'busy')
  assert.equal(remoteSubject(remote), 'theirs')
})

test('a stopped rebase left behind after checking the branch out again is left untouched', () => {
  const { remote, dir } = setup()
  writeFileSync(join(dir, 'a.md'), 'a\n'); sh(dir, 'add', 'a.md'); sh(dir, 'commit', '-q', '-m', 'auto(x): a')
  writeFileSync(join(dir, 'b.md'), 'b\n'); sh(dir, 'add', 'b.md'); sh(dir, 'commit', '-q', '-m', 'auto(x): b')
  try { sh(dir, 'rebase', '-q', '-x', 'false', 'HEAD~2') } catch {}
  sh(dir, 'checkout', '-q', 'main')
  assert.ok(existsSync(join(dir, '.git', 'rebase-merge')))
  writeFileSync(join(dir, 'wip.md'), 'wip\n')
  assert.equal(autocommit({ dir, trigger: 'test', lint: ok }).status, 'busy')
  assert.ok(existsSync(join(dir, 'wip.md')))
  assert.equal(remoteSubject(remote), 'seed')
})
