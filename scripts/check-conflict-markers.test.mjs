import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findConflictMarkers, scanRepo } from './check-conflict-markers.mjs'

const LT = '<'.repeat(7)
const GT = '>'.repeat(7)
const EQ = '='.repeat(7)

test('finds the opening and closing markers of a conflict block', () => {
  const text = ['a', `${LT} HEAD`, 'ours', EQ, 'theirs', `${GT} 4d2d2690 (fix: x)`, 'b'].join('\n')
  assert.deepEqual(findConflictMarkers(text).map((m) => m.line), [2, 6])
})

test('matches a bare marker with no label', () => {
  assert.equal(findConflictMarkers(`${LT}\nx\n${GT}`).length, 2)
})

test('ignores a setext heading underline and markers that are not at line start', () => {
  assert.deepEqual(findConflictMarkers(`Title\n${EQ}\n  ${LT} HEAD\nx ${GT} y`), [])
})

test('ignores runs of eight or more', () => {
  assert.deepEqual(findConflictMarkers(`${LT}<\n${GT}>`), [])
})

test('scanRepo reads tracked files and reports the marker it finds', () => {
  const dir = mkdtempSync(join(tmpdir(), 'conflict-markers-'))
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir })
    writeFileSync(join(dir, 'clean.md'), 'nothing here\n')
    writeFileSync(join(dir, 'doc.md'), ['x', `${LT} HEAD`, 'a', EQ, 'b', `${GT} abc`].join('\n'))
    execFileSync('git', ['add', '.'], { cwd: dir })
    assert.deepEqual(scanRepo(dir).map((h) => `${h.path}:${h.line}`), ['doc.md:2', 'doc.md:6'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the repository has no leftover markers', () => {
  assert.deepEqual(scanRepo(), [])
})
