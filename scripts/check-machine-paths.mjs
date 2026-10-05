// #1610 — machine-specific absolute paths in the always-read docs and skills.
//
// A path like `~/Desktop/<folder>/…` or `/Users/<name>/…` holds on the machine it was written on and
// nowhere else; a second machine had a different folder name, so every command citing the reports
// clone failed there.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export const SCANNED = ['CLAUDE.md', 'docs/reference', '.claude/skills']

const MACHINE_PATH_RE = /~\/Desktop\/|\/Users\/[A-Za-z0-9._-]+\//

/** Lines (1-based) that cite a machine-specific absolute path. Pure. */
export function findMachinePaths(text) {
  const out = []
  text.split('\n').forEach((line, i) => {
    if (MACHINE_PATH_RE.test(line)) out.push({ line: i + 1, text: line.trim() })
  })
  return out
}

/** Every tracked file under `SCANNED` with a hit, as `{ path, line, text }`. */
export function scanRepo(root = REPO_ROOT) {
  const files = execFileSync('git', ['ls-files', '-z', '--', ...SCANNED], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
  const hits = []
  for (const path of files) {
    for (const m of findMachinePaths(readFileSync(join(root, path), 'utf8'))) hits.push({ path, ...m })
  }
  return hits
}

function isMain() {
  return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
}

if (isMain()) {
  const hits = scanRepo()
  if (hits.length > 0) {
    for (const h of hits) console.error(`${h.path}:${h.line}: ${h.text}`)
    console.error(`\n❌ ${hits.length} machine-specific path(s).`)
    process.exit(1)
  }
  console.log('✅ no machine-specific paths in CLAUDE.md, docs/reference or .claude/skills.')
}
