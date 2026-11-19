import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, copyFileSync, realpathSync, readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { isMain } from './is-main.mjs'

function linkedDir() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'is-main-')))
  const real = join(root, 'real')
  mkdirSync(real)
  symlinkSync(real, join(root, 'link'))
  return { root, real, link: join(root, 'link') }
}

test('isMain is true when argv[1] reaches the module through a symlinked directory', () => {
  const { real, link } = linkedDir()
  writeFileSync(join(real, 'm.mjs'), '')
  assert.equal(isMain(pathToFileURL(join(real, 'm.mjs')).href, join(link, 'm.mjs')), true)
  assert.equal(isMain(pathToFileURL(join(link, 'm.mjs')).href, join(real, 'm.mjs')), true)
})

test('isMain is true for a path that percent-encodes (a space and a #)', () => {
  const { real } = linkedDir()
  const dir = join(real, 'a b#c')
  mkdirSync(dir)
  writeFileSync(join(dir, 'm.mjs'), '')
  assert.equal(isMain(pathToFileURL(join(dir, 'm.mjs')).href, join(dir, 'm.mjs')), true)
})

test('isMain is false for another file, a missing path, or no argv[1]', () => {
  const { real } = linkedDir()
  writeFileSync(join(real, 'm.mjs'), '')
  writeFileSync(join(real, 'other.mjs'), '')
  const url = pathToFileURL(join(real, 'm.mjs')).href
  assert.equal(isMain(url, join(real, 'other.mjs')), false)
  assert.equal(isMain(url, join(real, 'missing.mjs')), false)
  assert.equal(isMain(url, undefined), false)
})

test('a shipped script run through a symlinked path still runs its main and prints', () => {
  const { real, link } = linkedDir()
  mkdirSync(join(real, 'scripts'))
  for (const f of ['check-conflict-markers.mjs', 'is-main.mjs']) copyFileSync(new URL(f, import.meta.url), join(real, 'scripts', f))
  spawnSync('git', ['init', '-q'], { cwd: real })
  spawnSync('git', ['add', 'scripts'], { cwd: real })
  const direct = spawnSync(process.execPath, [join(real, 'scripts', 'check-conflict-markers.mjs')], { cwd: real, encoding: 'utf8' })
  const viaLink = spawnSync(process.execPath, [join(link, 'scripts', 'check-conflict-markers.mjs')], { cwd: real, encoding: 'utf8' })
  assert.notEqual(direct.stdout + direct.stderr, '', 'the direct run prints')
  assert.equal(viaLink.stdout + viaLink.stderr, direct.stdout + direct.stderr)
  assert.equal(viaLink.status, direct.status)
})

test('lint-decision-graph.mjs run through a symlinked path still lints the bundle', () => {
  const { real, link } = linkedDir()
  mkdirSync(join(real, 'scripts'))
  for (const f of ['lint-decision-graph.mjs', 'is-main.mjs']) copyFileSync(new URL(f, import.meta.url), join(real, 'scripts', f))
  const bundle = realpathSync(mkdtempSync(join(tmpdir(), 'is-main-bundle-')))
  writeFileSync(join(bundle, 'decision_solo.md'), '---\nname: solo\n---\nNo edges, no links.')
  const run = spawnSync(process.execPath, [join(link, 'scripts', 'lint-decision-graph.mjs')], { cwd: real, encoding: 'utf8', env: { ...process.env, MEMORY_DIR: bundle } })
  assert.match(run.stdout, /1 pages/, run.stdout + run.stderr)
})

const ENDS_WITH_GUARDS = new Set(['scripts/patch-archive-automonitor.mjs', 'scripts/patch-archive-officialuptime-scrub.mjs', 'scripts/patch-archive-uptimesource.mjs', 'scripts/scrape-mistral-status.mjs'])

test('no entry point in scripts/ or .githooks/ outside is-main.mjs compares process.argv[1] itself', () => {
  const repo = dirname(dirname(fileURLToPath(import.meta.url)))
  const files = [
    ...readdirSync(join(repo, 'scripts')).filter((f) => /\.(mjs|ts)$/.test(f) && !/\.test\./.test(f)).map((f) => `scripts/${f}`),
    ...readdirSync(join(repo, '.githooks')).map((f) => `.githooks/${f}`),
  ]
  const offenders = files.filter((f) => f !== 'scripts/is-main.mjs' && !ENDS_WITH_GUARDS.has(f)
    && readFileSync(join(repo, f), 'utf8').split('\n').some((l) => !/^\s*\/\//.test(l) && l.includes('process.argv[1]')))
  assert.deepEqual(offenders, [])
})
