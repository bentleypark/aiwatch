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

function fixture(commits = []) {
  const dir = mkdtempSync(join(tmpdir(), 'vercel-ignore-'))
  git(dir, 'init', '-q')
  commit(dir, { 'README.md': 'base\n' })
  const base = git(dir, 'rev-parse', 'HEAD').trim()
  for (const files of commits) commit(dir, files)
  return { dir, base, head: git(dir, 'rev-parse', 'HEAD').trim() }
}

function run(dir, env = {}, path = process.env.PATH) {
  const { VERCEL_GIT_PREVIOUS_SHA: _inherited, ...inherited } = process.env
  return spawnSync('bash', [script], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...inherited, VERCEL_ENV: 'preview', PATH: path, ...env },
  })
}

function withFixture(commits, fn) {
  const fx = fixture(commits)
  try { fn(fx) } finally { rmSync(fx.dir, { recursive: true, force: true }) }
}

test('preview builds when a watched path changed since the last deployment, not only in the tip (#1415)', () => {
  for (const path of watchedPaths) {
    withFixture([{ [path]: 'changed\n' }, { 'docs/note.md': 'tip\n' }], ({ dir, base }) => {
      const result = run(dir, { VERCEL_GIT_PREVIOUS_SHA: base })
      assert.equal(result.status, 1, path)
      assert.doesNotMatch(result.stderr, /failed/, path)
    })
  }
})

test('preview skips only after a successful diff since the last deployment finds no watched paths (#1415)', () => {
  withFixture([{ 'worker/src/index.ts': 'changed\n' }, { 'docs/note.md': 'tip\n' }], ({ dir, base }) => {
    assert.equal(run(dir, { VERCEL_GIT_PREVIOUS_SHA: base }).status, 0)
  })
})

test('a branch with no previous successful deployment builds (#1415)', () => {
  withFixture([{ 'docs/note.md': 'only docs\n' }], ({ dir }) => {
    for (const env of [{}, { VERCEL_GIT_PREVIOUS_SHA: '' }]) {
      const result = run(dir, env)
      assert.equal(result.status, 1)
      assert.match(result.stderr, /no previous successful deployment/)
    }
  })
})

test('a previous SHA outside the shallow clone builds instead of skipping (#1415)', () => {
  withFixture([{ 'docs/note.md': 'only docs\n' }], ({ dir }) => {
    const result = run(dir, { VERCEL_GIT_PREVIOUS_SHA: 'f'.repeat(40) })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /git diff against f{40} failed/)
  })
})

test('a git diff error keeps the build instead of being treated as unchanged (#1415)', () => {
  withFixture([{ 'docs/note.md': 'only docs\n' }], ({ dir, base }) => {
    const bin = mkdtempSync(join(tmpdir(), 'vercel-ignore-bin-'))
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
    writeFileSync(join(bin, 'git'), `#!/usr/bin/env bash\nif [ "$1" = diff ]; then exit 2; fi\nexec ${realGit} "$@"\n`)
    chmodSync(join(bin, 'git'), 0o755)
    try {
      const result = run(dir, { VERCEL_GIT_PREVIOUS_SHA: base }, `${bin}:${process.env.PATH}`)
      assert.equal(result.status, 1)
      assert.match(result.stderr, /git diff against .* failed/)
    } finally {
      rmSync(bin, { recursive: true, force: true })
    }
  })
})

test('production builds even when nothing changed since its previous deployment (#1415)', () => {
  withFixture([{ 'src/App.jsx': 'changed\n' }], ({ dir, head }) => {
    assert.equal(run(dir, { VERCEL_GIT_PREVIOUS_SHA: head }).status, 0, 'control: preview with an unchanged tree skips')
    assert.equal(run(dir, { VERCEL_ENV: 'production', VERCEL_GIT_PREVIOUS_SHA: head }).status, 1)
  })
})

test('any VERCEL_ENV other than preview builds even when nothing changed (#1415)', () => {
  withFixture([{ 'docs/note.md': 'only docs\n' }], ({ dir, head }) => {
    for (const VERCEL_ENV of ['', 'development', 'production']) {
      const result = run(dir, { VERCEL_ENV, VERCEL_GIT_PREVIOUS_SHA: head })
      assert.equal(result.status, 1, VERCEL_ENV)
      assert.match(result.stderr, /is not preview/)
    }
  })
})

test('vercel routes ignoreCommand through the tested script (#1415)', () => {
  const config = JSON.parse(readFileSync(join(repoRoot, 'vercel.json'), 'utf8'))
  assert.equal(config.ignoreCommand, 'bash scripts/vercel-should-build.sh')
})
