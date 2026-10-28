import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { moduleFiles, hasEntryLine, auditDirectoryMap, auditTree, MAP_FILE, ALLOW_FILE } from './check-directory-map.mjs'

const SCRIPT = fileURLToPath(new URL('./check-directory-map.mjs', import.meta.url))
const REAL_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** A throwaway tree shaped like the repo: two module dirs and the page. */
function fixture({ map, allow }) {
  const dir = mkdtempSync(join(tmpdir(), 'directory-map-'))
  mkdirSync(join(dir, 'worker/src/parsers'), { recursive: true })
  mkdirSync(join(dir, 'api'), { recursive: true })
  mkdirSync(join(dir, 'docs/reference'), { recursive: true })
  for (const f of ['worker/src/a.ts', 'worker/src/b.ts', 'api/z.ts']) writeFileSync(join(dir, f), '')
  writeFileSync(join(dir, MAP_FILE), map)
  if (allow !== undefined) writeFileSync(join(dir, ALLOW_FILE), allow)
  return dir
}

function runMain(root) {
  const code = `import { main } from ${JSON.stringify(new URL('./check-directory-map.mjs', import.meta.url).href)}; main(${JSON.stringify(root)})`
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' })
}

test('moduleFiles lists top-level .ts of both dirs, without tests, declarations, other types or subdirectories', () => {
  const dir = fixture({ map: '' })
  try {
    for (const f of ['worker/src/a.test.ts', 'worker/src/types.d.ts', 'worker/src/c.js', 'worker/src/parsers/p.ts']) writeFileSync(join(dir, f), '')
    assert.deepEqual(moduleFiles(dir), ['api/z.ts', 'worker/src/a.ts', 'worker/src/b.ts'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const ENTRY_CASES = [
  ['an indented entry', '    cache-ttl.ts # why', true],
  ['spaces before the #', '    cache-ttl.ts   # why', true],
  ['a tab before the #', '    cache-ttl.ts\t# why', true],
  ['a name ending the line', '    cache-ttl.ts', true],
  ['a mention inside another entry', '    other.ts # reads cache-ttl.ts and more', false],
  ['a removed-module comment line', '    # (#679) cache-ttl.ts was REMOVED', false],
  ['a longer name ending the same way', '    xcache-ttl.ts # why', false],
  ['a longer extension', '    cache-ttl.tsx # why', false],
  ['a line that is not indented', 'cache-ttl.ts # why', false],
]
for (const [label, line, expected] of ENTRY_CASES) {
  test(`hasEntryLine — ${label}`, () => {
    assert.equal(hasEntryLine(line, 'worker/src/cache-ttl.ts'), expected)
  })
}

test('hasEntryLine — the dot in a file name is literal', () => {
  assert.equal(hasEntryLine('    abts # why', 'worker/src/a.ts'), false)
})

test('auditDirectoryMap reports a module with no entry and skips an allowlisted one', () => {
  const files = ['api/z.ts', 'worker/src/a.ts', 'worker/src/b.ts']
  const mapText = '  z.ts # why\n    a.ts # why\n'
  assert.deepEqual(auditDirectoryMap({ files, mapText }), ['worker/src/b.ts'])
  assert.deepEqual(auditDirectoryMap({ files, mapText, allow: new Map([['worker/src/b.ts', 'why']]) }), [])
})

test('the real tree: every module has an entry line, and both directories are scanned', () => {
  const { files, missing, noReason } = auditTree(REAL_ROOT)
  assert.deepEqual(missing, [])
  assert.deepEqual(noReason, [])
  assert.ok(files.includes('worker/src/index.ts') && files.includes('api/is-down.ts'), 'a scan that finds neither directory passes vacuously')
})

test('mutation — deleting a real entry line makes that module a finding', () => {
  const { files } = auditTree(REAL_ROOT)
  const mapText = readFileSync(join(REAL_ROOT, MAP_FILE), 'utf8')
  const target = 'worker/src/index.ts'
  const mutated = mapText.split('\n').filter((l) => !hasEntryLine(l, target)).join('\n')
  assert.notEqual(mutated, mapText, 'the mutation must remove at least one line')
  assert.deepEqual(auditDirectoryMap({ files, mapText }), [])
  assert.deepEqual(auditDirectoryMap({ files, mapText: mutated }), [target])
})

test('CLI — the shipped script exits 0 on the real repo and says how many modules it checked', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /directory-map: \d+ modules, each with an entry line/)
})

test('CLI — a module with no entry exits 1 and names it; an allowlist entry with a reason lets it through', () => {
  const dir = fixture({ map: '  z.ts # why\n    a.ts # why\n' })
  try {
    const bad = runMain(dir)
    assert.equal(bad.status, 1)
    assert.match(bad.stderr, /worker\/src\/b\.ts/)
    writeFileSync(join(dir, ALLOW_FILE), 'worker/src/b.ts  # generated, no entry on purpose\n')
    assert.equal(runMain(dir).status, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI — an allowlist entry with no reason fails', () => {
  const dir = fixture({ map: '  z.ts # why\n    a.ts # why\n    b.ts # why\n', allow: 'worker/src/b.ts\n' })
  try {
    const r = runMain(dir)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /without a reason/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
