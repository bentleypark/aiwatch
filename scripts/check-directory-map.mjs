#!/usr/bin/env node
// #1817 — CI guard: every top-level worker/src/*.ts and api/*.ts has its own entry line in
// docs/reference/directory-map.md, whose contract is one `path # why` line per module (its first
// paragraph), or an allowlist entry with a reason.
//
// An entry line STARTS with the file name.
//
// Top-level files only; subdirectories (parsers/, _shared/, …) are out of scope. The match is on the
// basename.
//
// Run via `npm run test:scripts` (check-directory-map.test.mjs asserts the real tree) and as a CLI.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAllowlist } from './check-doc-symbols.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export const MODULE_DIRS = ['worker/src', 'api']
export const MAP_FILE = 'docs/reference/directory-map.md'
export const ALLOW_FILE = 'docs/reference/directory-map-allow.txt'

/** Top-level `.ts` modules of MODULE_DIRS as repo-relative paths, tests and declaration files excluded. */
export function moduleFiles(root = ROOT, dirs = MODULE_DIRS) {
  const out = []
  for (const dir of dirs) {
    for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.ts') && !/\.(test|d)\.ts$/.test(e.name)) out.push(`${dir}/${e.name}`)
    }
  }
  return out.sort()
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Does an indented line of the page start with this module's file name? */
export function hasEntryLine(mapText, file) {
  const name = file.split('/').pop()
  return new RegExp(`^[ \\t]+${escapeRe(name)}(?=[ \\t]|$)`, 'm').test(mapText)
}

/** The modules with neither an entry line nor an allowlist entry. */
export function auditDirectoryMap({ files, mapText, allow = new Map() }) {
  return files.filter((f) => !allow.has(f) && !hasEntryLine(mapText, f))
}

export function auditTree(root = ROOT) {
  const allowPath = join(root, ALLOW_FILE)
  const { allow, noReason } = parseAllowlist(existsSync(allowPath) ? readFileSync(allowPath, 'utf8') : '')
  const files = moduleFiles(root)
  const mapText = readFileSync(join(root, MAP_FILE), 'utf8')
  return { files, noReason, allowed: allow.size, missing: auditDirectoryMap({ files, mapText, allow }) }
}

export function main(root = ROOT) {
  const { files, noReason, allowed, missing } = auditTree(root)
  if (noReason.length) {
    console.error(`❌ allowlist entries without a reason (add \`# why\`): ${noReason.join(', ')}`)
    process.exit(1)
  }
  if (missing.length) {
    console.error(`❌ directory-map: ${missing.length} module(s) have no entry line in ${MAP_FILE}:`)
    for (const f of missing) console.error(`   ${f}`)
    console.error(`\nAdd \`${missing[0].split('/').pop()}   # why it exists\` under its directory in the tree there, or, if it`)
    console.error(`deliberately has no entry, add \`path  # reason\` to ${ALLOW_FILE}.`)
    process.exit(1)
  }
  console.log(`✅ directory-map: ${files.length} modules, each with an entry line (${allowed} allowlisted)`)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
