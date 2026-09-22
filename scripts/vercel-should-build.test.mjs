import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const script = join(repoRoot, 'scripts/vercel-should-build.sh')
const watchedPaths = ['src/App.jsx', 'public/x.png', 'index.html', 'api/intro.ts', 'vercel.json', 'vite.config.js', 'tests/example.spec.js']
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' })

function commit(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  git(dir, 'add', '-A')
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'change')
}

function fixture({ includeBase = true, commits = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vercel-ignore-'))
  git(dir, 'init', '-q')
  commit(dir, { 'README.md': 'base\n' })
  git(dir, 'branch', '-M', 'main')
  if (includeBase) git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  git(dir, 'checkout', '-qb', 'preview')
  for (const files of commits) commit(dir, files)
  return dir
}

function run(dir, env = {}, path = process.env.PATH) {
  return spawnSync('bash', [script], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, VERCEL_ENV: 'preview', PATH: path, ...env },
  })
}

function withFixture(spec, fn) {
  const dir = fixture(spec)
  try { fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('preview builds when any watched path changed before the tip commit (#1415)', () => {
  for (const path of watchedPaths) {
    withFixture({ commits: [{ [path]: 'changed\n' }, { 'docs/note.md': 'tip\n' }] }, (dir) => {
      const result = run(dir)
      assert.equal(result.status, 1, path)
      assert.doesNotMatch(result.stderr, /git diff failed/, path)
    })
  }
})

test('preview skips only after a successful whole-branch diff finds no watched paths (#1415)', () => {
  withFixture({ commits: [{ 'worker/src/index.ts': 'changed\n' }, { 'docs/note.md': 'tip\n' }] }, (dir) => {
    assert.equal(run(dir).status, 0)
  })
})

test('production always builds even without a preview base ref (#1415)', () => {
  withFixture({ includeBase: false }, (dir) => {
    assert.equal(run(dir, { VERCEL_ENV: 'production' }).status, 1)
  })
})

test('a missing preview base keeps the build instead of skipping it (#1415)', () => {
  withFixture({ includeBase: false }, (dir) => {
    const result = run(dir)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /origin\/main is unavailable/)
  })
})

test('a git diff error keeps the build instead of being treated as unchanged (#1415)', () => {
  withFixture({ commits: [{ 'api/intro.ts': 'changed\n' }] }, (dir) => {
    const bin = mkdtempSync(join(tmpdir(), 'vercel-ignore-bin-'))
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
    writeFileSync(join(bin, 'git'), `#!/usr/bin/env bash\nif [ "$1" = diff ]; then exit 2; fi\nexec ${realGit} "$@"\n`)
    chmodSync(join(bin, 'git'), 0o755)
    try {
      const result = run(dir, {}, `${bin}:${process.env.PATH}`)
      assert.equal(result.status, 1)
      assert.match(result.stderr, /git diff failed/)
    } finally {
      rmSync(bin, { recursive: true, force: true })
    }
  })
})

test('vercel routes ignoreCommand through the tested script (#1415)', () => {
  const config = JSON.parse(readFileSync(join(repoRoot, 'vercel.json'), 'utf8'))
  assert.equal(config.ignoreCommand, 'bash scripts/vercel-should-build.sh')
})
