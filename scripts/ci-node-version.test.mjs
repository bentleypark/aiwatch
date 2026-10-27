// #1807 — every `actions/setup-node` step reads the Node version from `.nvmrc` with `check-latest: true`,
// and no workflow pins one inline. setup-node lets an inline `node-version:` win over
// `node-version-file:`, and without `check-latest` it takes whatever matching version the runner has
// cached, so either one would silently keep a job off the latest security release.
//
// `aiwatch-reports` carries its own copy of this guard (`scripts/ci-node-version.test.js`).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = join(repoRoot, '.github/workflows')

const SETUP_NODE = /^\s*(-\s*)?["']?uses["']?\s*:\s*["']?actions\/setup-node@/
const INLINE_PIN = /^\s*["']?node-version["']?\s*:/
const FROM_NVMRC = /^\s*["']?node-version-file["']?\s*:\s*["']?\.nvmrc["']?\s*(#.*)?$/
const CHECK_LATEST = /^\s*["']?check-latest["']?\s*:\s*["']?true["']?\s*(#.*)?$/

/** Problems in one workflow's text; empty when every setup-node step reads `.nvmrc` and checks latest. */
export function nodeVersionViolations(text) {
  const lines = text.split('\n')
  const problems = lines
    .map((l, i) => (INLINE_PIN.test(l) ? `line ${i + 1}: inline node-version` : null))
    .filter(Boolean)
  const steps = lines.filter((l) => SETUP_NODE.test(l)).length
  const fromFile = lines.filter((l) => FROM_NVMRC.test(l)).length
  const latest = lines.filter((l) => CHECK_LATEST.test(l)).length
  if (steps !== fromFile) problems.push(`${steps} setup-node step(s), ${fromFile} node-version-file: .nvmrc`)
  if (steps !== latest) problems.push(`${steps} setup-node step(s), ${latest} check-latest: true`)
  return problems
}

/** `.nvmrc` holds one bare major. */
export function isBareMajor(nvmrc) {
  return /^\d+\n?$/.test(nvmrc)
}

const workflows = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f))

test('every workflow takes its Node version from .nvmrc', () => {
  const found = Object.fromEntries(
    workflows.map((f) => [f, nodeVersionViolations(readFileSync(join(DIR, f), 'utf8'))]).filter(([, p]) => p.length),
  )
  assert.deepEqual(found, {})
})

test('the scan sees the real setup-node steps', () => {
  const steps = workflows.flatMap((f) => readFileSync(join(DIR, f), 'utf8').split('\n')).filter((l) => SETUP_NODE.test(l))
  assert.ok(steps.length > 0)
})

test('.nvmrc is one bare major', () => {
  assert.ok(isBareMajor(readFileSync(join(repoRoot, '.nvmrc'), 'utf8')))
})

const step = (withLines) => ['    steps:', '      - uses: actions/checkout@v7', '      - uses: actions/setup-node@v7', '        with:', ...withLines].join('\n')

const FILE = '          node-version-file: .nvmrc'
const LATEST = '          check-latest: true'

test('fixture: a step reading .nvmrc with check-latest passes', () => {
  assert.deepEqual(nodeVersionViolations(step([FILE, LATEST])), [])
  assert.deepEqual(nodeVersionViolations(step(["          node-version-file: '.nvmrc'", "          check-latest: 'true'"])), [])
})

test('fixture: an inline pin fails, alone or next to node-version-file', () => {
  assert.equal(nodeVersionViolations(step(['          node-version: 20', LATEST])).length, 2)
  assert.deepEqual(nodeVersionViolations(step([FILE, LATEST, "          node-version: '20'"])), ['line 7: inline node-version'])
})

test('fixture: a setup-node step with no version source fails', () => {
  assert.deepEqual(nodeVersionViolations(step([LATEST])), ['1 setup-node step(s), 0 node-version-file: .nvmrc'])
})

test('fixture: node-version-file pointing elsewhere fails', () => {
  assert.equal(nodeVersionViolations(step(['          node-version-file: package.json', LATEST])).length, 1)
})

test('fixture: missing or false check-latest fails', () => {
  assert.deepEqual(nodeVersionViolations(step([FILE])), ['1 setup-node step(s), 0 check-latest: true'])
  assert.deepEqual(nodeVersionViolations(step([FILE, '          check-latest: false'])), ['1 setup-node step(s), 0 check-latest: true'])
})

test('fixture: isBareMajor', () => {
  assert.ok(isBareMajor('24\n'))
  assert.ok(isBareMajor('24'))
  assert.ok(!isBareMajor('v24\n'))
  assert.ok(!isBareMajor('24.x\n'))
  assert.ok(!isBareMajor('lts/*\n'))
})
