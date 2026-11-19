#!/usr/bin/env node
// #2006 — commit and push the memory bundle once its structural lint passes.
// Run by the `SessionEnd` hook, the last step of `memory-ingest`, and a daily launchd job:
//   node scripts/memory-autocommit.mjs --trigger session-end|ingest|daily
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveMemoryDir, pointerPathFor } from './lint-decision-graph.mjs'
import { isMain } from './is-main.mjs'

export const LOCK_STALE_MS = 10 * 60 * 1000
export const MAX_FILES_IN_MESSAGE = 8
const NETWORK_TIMEOUT_MS = 20_000
const IN_PROGRESS_REFS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']
const IN_PROGRESS_PATHS = ['rebase-apply', 'rebase-merge', 'sequencer']

/** Paths from `git status --porcelain`; a rename reports its new path. Pure. */
export function changedFiles(porcelain) {
  return String(porcelain ?? '')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => l.slice(3))
    .map((p) => (p.includes(' -> ') ? p.split(' -> ').pop() : p))
}

/** Pure. */
export function commitMessage(trigger, files, date) {
  const shown = files.slice(0, MAX_FILES_IN_MESSAGE).join(', ')
  const more = files.length > MAX_FILES_IN_MESSAGE ? ` (+${files.length - MAX_FILES_IN_MESSAGE} more)` : ''
  return `auto(${trigger}): ${date} — ${files.length} file(s): ${shown}${more}`
}

export function gitRunner(dir) {
  return (args, { network = false } = {}) => {
    const r = spawnSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      timeout: network ? NETWORK_TIMEOUT_MS : undefined,
    })
    return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trimEnd() }
  }
}

function acquireLock(lockDir, now) {
  try {
    mkdirSync(lockDir)
    return true
  } catch {
    try {
      if (now - statSync(lockDir).mtimeMs < LOCK_STALE_MS) return false
      rmSync(lockDir, { recursive: true, force: true })
      mkdirSync(lockDir)
      return true
    } catch {
      return false
    }
  }
}

/**
 * Returns `{ status, detail }`; status is one of
 * locked | busy | no-upstream | clean | lint-failed | commit-failed | committed-local | pushed.
 */
export function autocommit({ dir, trigger, lint, auditSync, git = gitRunner(dir), now = Date.now(), date = new Date(now).toISOString().slice(0, 10) }) {
  const lockDir = join(dir, '.git', 'autocommit.lock')
  if (!acquireLock(lockDir, now)) return { status: 'locked', detail: lockDir }
  let audit = { ok: true }
  try {
    const r = run()
    return audit.ok ? r : { ...r, detail: [r.detail, `audit sync: ${audit.out}`].filter(Boolean).join(' | ') }
  } finally {
    rmSync(lockDir, { recursive: true, force: true })
  }
  function run() {
    if (!git(['symbolic-ref', '-q', 'HEAD']).ok) return { status: 'busy', detail: 'HEAD is detached (a rebase may be in progress)' }
    const unmerged = git(['diff', '--name-only', '--diff-filter=U'])
    if (unmerged.out) return { status: 'busy', detail: `unmerged paths: ${unmerged.out}` }
    const inProgress = IN_PROGRESS_REFS.filter((ref) => git(['rev-parse', '-q', '--verify', ref]).ok)
    for (const path of IN_PROGRESS_PATHS) if (existsSync(git(['rev-parse', '--path-format=absolute', '--git-path', path]).out)) inProgress.push(path)
    if (inProgress.length) return { status: 'busy', detail: `in progress: ${inProgress.join(', ')}` }
    audit = auditSync ? auditSync() : { ok: true }
    const files = changedFiles(git(['status', '--porcelain']).out)
    if (files.length) {
      const l = lint()
      if (!l.ok) return { status: 'lint-failed', detail: l.out }
      git(['add', '-A'])
      const c = git(['commit', '-q', '-m', commitMessage(trigger, files, date)])
      if (!c.ok) return { status: 'commit-failed', detail: c.out }
    }
    const ahead = git(['log', '--format=%s', '@{u}..HEAD'])
    if (!ahead.ok) return { status: 'no-upstream', detail: ahead.out }
    if (!ahead.out) return { status: 'clean', detail: '' }
    const byHand = ahead.out.split('\n').filter((s) => !s.startsWith('auto('))
    if (byHand.length) return { status: 'committed-local', detail: `hand commit(s) ahead, push them by hand: ${byHand.join(' | ')}` }
    const pull = git(['pull', '--rebase', '-q'], { network: true })
    if (!pull.ok) {
      git(['rebase', '--abort'])
      return { status: 'committed-local', detail: `pull --rebase: ${pull.out}` }
    }
    const push = git(['push', '-q'], { network: true })
    if (!push.ok) return { status: 'committed-local', detail: `push: ${push.out}` }
    return { status: 'pushed', detail: files.length ? `${files.length} file(s)` : 'earlier local commit(s)' }
  }
}

function runNode(script, dir) {
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, MEMORY_DIR: dir } })
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() }
}

if (isMain(import.meta.url)) {
  const i = process.argv.indexOf('--trigger')
  const trigger = i > 0 ? process.argv[i + 1] : 'manual'
  const pointer = pointerPathFor(import.meta.url)
  const dir = resolveMemoryDir(process.env.MEMORY_DIR, existsSync(pointer) ? readFileSync(pointer, 'utf8') : '')
  if (!dir || !existsSync(join(dir, '.git'))) {
    console.error(`memory-autocommit: no bundle git repo (MEMORY_DIR or ${pointer})`)
    process.exit(2)
  }
  const here = dirname(fileURLToPath(import.meta.url))
  const r = autocommit({
    dir,
    trigger,
    lint: () => runNode(join(here, 'lint-decision-graph.mjs'), dir),
    auditSync: () => runNode(join(here, 'hook-audit-sync.mjs'), dir),
  })
  console.error(`memory-autocommit (${trigger}): ${r.status}${r.detail ? ` — ${r.detail.split('\n').slice(-3).join(' | ')}` : ''}`)
  process.exit(r.status === 'clean' || r.status === 'pushed' || r.status === 'locked' ? 0 : 1)
}
