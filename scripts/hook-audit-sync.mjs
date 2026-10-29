#!/usr/bin/env node
// #1844 — copy the gitignored hook audit log's signal lines into the private memory bundle, one
// append-only file per machine (`audit/<host>.jsonl`), so the record survives a laptop change and
// `npm run hook-audit` can read every machine's lines.
//
// Run:  npm run hook-audit:sync            (HOOK_AUDIT_HOST overrides the file name)

import { readFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { homedir, hostname } from 'node:os'
import { fileURLToPath } from 'node:url'
import { resolveMemoryDir, pointerPathFor } from './lint-decision-graph.mjs'

/** Per-turn telemetry: one line every turn, no decision in it. */
export const LOW_SIGNAL = new Set(['workflow-gates-reminder:inject', 'stop-nag-gate:clean'])

export const isSignal = (e) => !LOW_SIGNAL.has(`${e.hook}:${e.decision}`)

export function redactNote(note, home = homedir()) {
  const s = typeof note === 'string' ? note : ''
  return home ? s.split(home).join('~') : s
}

export const entryKey = (e, home = homedir()) =>
  JSON.stringify([e.ts, e.hook, e.decision, redactNote(e.note, home)])

export function parseLines(text) {
  const out = []
  for (const l of String(text ?? '').split('\n')) {
    if (!l.trim()) continue
    try {
      const e = JSON.parse(l)
      if (e && typeof e === 'object') out.push(e)
    } catch {}
  }
  return out
}

/** Removes one occurrence of each key in `taken` from `entries`; repeated events stay repeated. Pure. */
export function subtractOnce(entries, taken, home = homedir()) {
  const left = new Map()
  for (const e of taken) {
    const k = entryKey(e, home)
    left.set(k, (left.get(k) ?? 0) + 1)
  }
  return entries.filter((e) => {
    const k = entryKey(e, home)
    const n = left.get(k) ?? 0
    if (n === 0) return true
    left.set(k, n - 1)
    return false
  })
}

/** The lines to append: local signal entries, redacted, beyond those already in the shared file. Pure. */
export function planSync(localText, sharedText, home = homedir()) {
  return subtractOnce(parseLines(localText).filter(isSignal), parseLines(sharedText), home)
    .map((e) => JSON.stringify({ ...e, note: redactNote(e.note, home) }))
}

export function hostFileName(name = process.env.HOOK_AUDIT_HOST || hostname()) {
  const base = String(name).split('.')[0].replace(/[^A-Za-z0-9_-]/g, '-')
  return `${base || 'unknown'}.jsonl`
}

/** `<bundle>/audit`, or null when the bundle is not configured. */
export function sharedAuditDir(env = process.env.MEMORY_DIR, scriptUrl = import.meta.url) {
  let pointerText = null
  try { pointerText = readFileSync(pointerPathFor(scriptUrl), 'utf8') } catch {}
  const dir = resolveMemoryDir(env, pointerText)
  return dir ? join(dir, 'audit') : null
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url))
  const local = process.env.HOOK_AUDIT_LOG ? resolve(process.env.HOOK_AUDIT_LOG) : resolve(here, '..', '.claude', 'hook-audit.jsonl')
  const dir = sharedAuditDir()
  if (!dir || !existsSync(dirname(dir))) {
    console.error(dir ? `memory bundle not found at: ${dirname(dir)}` : 'memory bundle location not configured')
    console.error(`Set MEMORY_DIR, or write the bundle's path into ${pointerPathFor(import.meta.url)}.`)
    process.exit(2)
  }
  if (!existsSync(local)) {
    console.log(`No local hook audit log (${local}). Nothing to sync.`)
    return
  }
  mkdirSync(dir, { recursive: true })
  const target = join(dir, hostFileName())
  const add = planSync(readFileSync(local, 'utf8'), existsSync(target) ? readFileSync(target, 'utf8') : '')
  if (add.length) appendFileSync(target, add.join('\n') + '\n')
  console.log(`hook-audit sync: +${add.length} line(s) → ${target}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main()
