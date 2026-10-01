// Leftover merge-conflict markers in tracked files.
//
// A marker in code fails the build; in Markdown it renders, and nothing else in CI reads the text —
// `docs/reference/directory-map.md` carried one from #1485 until this check. `=======` alone is not
// matched: it is also a setext heading underline.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const MARKER_RE = /^(<{7}|>{7})( |$)/

/** Lines (1-based) that open or close a conflict block. Pure. */
export function findConflictMarkers(text) {
  const out = []
  text.split('\n').forEach((line, i) => {
    if (MARKER_RE.test(line)) out.push({ line: i + 1, text: line })
  })
  return out
}

/** Every tracked text file with a marker, as `{ path, line, text }`. */
export function scanRepo(root = REPO_ROOT) {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
  const hits = []
  for (const path of files) {
    for (const m of findConflictMarkers(readFileSync(join(root, path), 'utf8'))) hits.push({ path, ...m })
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
    console.error(`\n❌ ${hits.length} leftover merge-conflict marker line(s).`)
    process.exit(1)
  }
  console.log('✅ no merge-conflict markers in tracked files.')
}
