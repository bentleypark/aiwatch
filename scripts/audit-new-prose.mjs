#!/usr/bin/env node
// Lists the prose a diff adds — code comments, Markdown sentences, long string literals — and marks the
// sentences that assert a date, a cause, a quantity, a history, an absolute or a negated behaviour. It never says a
// sentence is true: a listed sentence needs a checkable source or a deletion.
// Usage: node scripts/audit-new-prose.mjs [--base=REF] [--head=REF] [--all] [--json] [--strict]
// Default: merge-base(HEAD, origin/main) .. working tree, untracked files included. --strict exits 1
// when a flagged sentence carries no source.

import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const WORKTREE = 'WORKTREE'
const MIN_WORDS = 4
const MIN_STRING_WORDS = 8

export const SKIP_PATH = /(^|\/)(node_modules|dist|\.wrangler|coverage)\/|package-lock\.json$|(^|\/)src\/locales\/|\.snap$/

export const MARKERS = [
  ['date', /\b20\d{2}-\d{2}-\d{2}\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? (?:\d{1,2}\b|20\d{2}\b)/],
  ['causal', /\b(?:because|hence|so (?:that|the|an?|one|it|no|there|every|each)|which is why|that is why|the reason|due to|therefore)\b/i],
  ['absolute', /\b(?:never|always|cannot|impossible|guarantee[sd]?|no longer|at most|only (?:after|when|if|once)|exactly (?:once|one))\b/i],
  ['quantity', /(?:~|≈)\s?\d|\b\d+(?:\.\d+)?%|\b\d+(?:\.\d+)?\s?(?:ms|s|sec|seconds?|min|minutes?|h|hours?|days?|weeks?|x|writes?\/day|reads?\/day|KB|MB)\b/i],
  ['history', /\b(?:began|started|stopped|restored|previously|originally|formerly|used to|shipped in|introduced (?:in|by)|moved|took|renamed|replaced|already|still)\b/i],
  ['negated', /\b(?:did|does|do|is|are|was|were|has|have|had)(?: not|n't)\b/i],
]

const TEST_PATH = /(^|\/)__tests__\/|\.(?:test|spec)\.[cm]?[jt]sx?$/

// A backticked command name counts only when a space follows it: an invocation, not a bare mention
// of a file or module that happens to start with the same word.
const SOURCE = /#\d+|https?:\/\/|`(?:npx|npm|git|gh|curl|node|wrangler|grep|rg) [^`]*`/

const EXT_KIND = {
  md: 'markdown',
  ts: 'js', tsx: 'js', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', css: 'js',
  sh: 'hash', yml: 'hash', yaml: 'hash', py: 'hash', toml: 'hash',
}

// git C-quotes a path (wraps it in "..." and backslash-escapes) whenever it holds a quote, a
// backslash, a tab, a newline or a non-printable byte — regardless of core.quotepath, which only
// governs non-ASCII bytes. Octal escapes are BYTES, not codepoints, so they are collected and decoded
// as one UTF-8 buffer rather than char-by-char (a multi-byte character can span several \nnn escapes).
// A literal (non-escaped) character is pushed the same way, one JS string unit at a time, EXCEPT a
// surrogate pair (an astral character, e.g. an emoji): pushing each half separately would encode two
// lone surrogates instead of the one real codepoint, so a high surrogate is paired with its low half
// before encoding.
function unquotePath(quoted) {
  const body = quoted.slice(1, -1)
  const bytes = []
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c !== '\\') {
      const code = c.charCodeAt(0)
      const isHighSurrogate = code >= 0xd800 && code <= 0xdbff
      const span = isHighSurrogate && i + 1 < body.length ? body.slice(i, i + 2) : c
      bytes.push(...Buffer.from(span, 'utf8'))
      i += span.length - 1
      continue
    }
    const n = body[i + 1]
    const BYTE_ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 }
    if (n in BYTE_ESCAPES) { bytes.push(BYTE_ESCAPES[n]); i++ }
    else if (n === '"' || n === '\\') { bytes.push(n.charCodeAt(0)); i++ }
    else if (/[0-7]/.test(n)) { bytes.push(parseInt(body.slice(i + 1, i + 4), 8)); i += 3 }
    else { bytes.push(...Buffer.from(n ?? '', 'utf8')); i++ }
  }
  return Buffer.from(bytes).toString('utf8')
}

/** The `+++ ` token, quoted or not, ends the header. An UNQUOTED token carries a trailing tab only
 *  when the bare name itself contains a space — git's way of marking where the (required, otherwise
 *  ambiguous) name ends, never part of the path. A quoted token is closed by its own unescaped
 *  closing quote — a space or a tab inside it is just more quoted content, not a terminator. */
function headerPath(afterMarker) {
  if (!afterMarker.startsWith('"')) return afterMarker.replace(/\t.*$/, '')
  for (let i = 1; i < afterMarker.length; i++) {
    if (afterMarker[i] === '\\') { i++; continue }
    if (afterMarker[i] === '"') return unquotePath(afterMarker.slice(0, i + 1))
  }
  return unquotePath(afterMarker) // unterminated: malformed input, best-effort
}

// A `diff --git` block with no `+++ ` header (binary content, mode-only change) yields no entry here.
// A deletion maps to `file = null` below and is likewise left out of the returned Map.
export function parseDiff(text) {
  const added = new Map()
  let file = null
  let line = 0
  // The `+++ ` header appears ONLY once per file, before its first `@@` hunk. Gating header
  // recognition on that POSITION — not inside a hunk — rather than on a line's own text is what
  // keeps a `+++`-prefixed CONTENT line (an added line whose own text happens to start that way)
  // from being misread as a new file's header. `diff --git` resets the position for the next file,
  // whether or not the previous one ended cleanly.
  let inHunk = false
  for (const raw of text.split('\n')) {
    if (raw.startsWith('diff --git ')) { inHunk = false; continue }
    if (!inHunk && raw.startsWith('+++ ')) {
      const path = headerPath(raw.slice(4))
      file = raw === '+++ /dev/null' ? null : path.replace(/^b\//, '')
      if (file && !added.has(file)) added.set(file, new Set())
      continue
    }
    if (raw.startsWith('@@')) {
      const m = /\+(\d+)(?:,(\d+))?/.exec(raw)
      line = m ? Number(m[1]) : 0
      inHunk = true
      continue
    }
    if (inHunk && file && raw.startsWith('+')) added.get(file).add(line++)
  }
  return added
}

const wordCount = (s) => (s.match(/[A-Za-z][A-Za-z'-]*/g) ?? []).length

function paragraphs(lines, isProse) {
  const units = []
  let cur = null
  lines.forEach((text, i) => {
    const t = isProse(text, i)
    if (t === null) { cur = null; return }
    if (t.newUnit || !cur) { cur = { start: i + 1, parts: [] }; units.push(cur) }
    cur.parts.push({ line: i + 1, text: t.text })
  })
  return units
}

function markdownUnits(lines) {
  let fence = false
  let front = lines[0]?.trim() === '---'
  return paragraphs(lines, (raw, i) => {
    const t = raw.trim()
    if (front) { if (i > 0 && t === '---') front = false; return null }
    if (/^(```|~~~)/.test(t)) { fence = !fence; return null }
    if (fence || t === '' || /^#{1,6}\s/.test(t) || /^<!--.*-->$/.test(t) || /^\|?[\s:|-]+\|?$/.test(t)) return null
    const isRow = t.startsWith('|')
    const isItem = /^(?:[-*+]|\d+\.)\s/.test(t)
    const text = (isRow ? t.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()).join(' | ') : t.replace(/^(?:[-*+]|\d+\.)\s+/, '')).replace(/\*\*/g, '')
    return { text, newUnit: isRow || isItem }
  }).map((u) => ({ kind: 'docs', ...u }))
}

function commentUnits(lines, kind) {
  let block = false
  const units = paragraphs(lines, (raw) => {
    const t = raw.trim()
    if (kind === 'hash') return /^#(?!!)/.test(t) ? { text: t.replace(/^#+\s?/, '') } : null
    if (block) {
      if (t.includes('*/')) block = false
      return { text: t.replace(/\*\/.*$/, '').replace(/^\*\s?/, '') }
    }
    if (t.startsWith('//')) return { text: t.replace(/^\/\/+\s?/, '') }
    if (t.startsWith('/*')) {
      block = !t.includes('*/')
      return { text: t.replace(/^\/\*+\s?/, '').replace(/\s?\*\/.*$/, '') }
    }
    return null
  })
  return units.map((u) => ({ kind: 'comment', ...u }))
}

function stringUnits(lines) {
  const out = []
  lines.forEach((raw, i) => {
    const t = raw.trim()
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return
    for (const m of raw.matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/g)) {
      if (wordCount(m[2]) >= MIN_STRING_WORDS) out.push({ kind: 'string', start: i + 1, parts: [{ line: i + 1, text: m[2] }] })
    }
  })
  return out
}

export function proseUnits(path, text) {
  const ext = path.split('.').pop().toLowerCase()
  const family = EXT_KIND[ext]
  if (!family) return []
  const lines = text.split('\n')
  if (family === 'markdown') return markdownUnits(lines)
  if (family === 'hash') return commentUnits(lines, 'hash')
  return [...commentUnits(lines, 'js'), ...(TEST_PATH.test(path) ? [] : stringUnits(lines))]
}

const ABBREV = /\b(e\.g|i\.e|vs|etc|cf)\./gi

export function sentences(unit) {
  const offsets = []
  let joined = ''
  for (const p of unit.parts) {
    if (joined) joined += ' '
    offsets.push({ at: joined.length, line: p.line })
    joined += p.text.trim()
  }
  const lineAt = (pos) => {
    let hit = offsets[0].line
    for (const o of offsets) if (o.at <= pos) hit = o.line
    return hit
  }
  const guarded = joined.replace(ABBREV, (m) => m.replace(/\./g, '\u0000'))
  const out = []
  let from = 0
  for (const piece of guarded.split(/(?<=[.!?])["')\]]?\s+(?=[A-Z0-9`(*"])/)) {
    const start = guarded.indexOf(piece, from)
    from = start + piece.length
    const text = piece.replace(/\u0000/g, '.').trim()
    if (wordCount(text) < MIN_WORDS) continue
    out.push({ text, startLine: lineAt(start), endLine: lineAt(Math.max(start, from - 1)) })
  }
  return out
}

export function audit(path, text, addedLines) {
  const found = []
  for (const unit of proseUnits(path, text)) {
    for (const s of sentences(unit)) {
      let touched = false
      for (let l = s.startLine; l <= s.endLine; l++) if (addedLines.has(l)) touched = true
      if (!touched) continue
      const markers = MARKERS.filter(([, re]) => re.test(s.text)).map(([id]) => id)
      found.push({ file: path, line: s.startLine, kind: unit.kind, text: s.text, markers, sourced: SOURCE.test(s.text) })
    }
  }
  return found
}

export function summarize(findings) {
  const kinds = { comment: 0, docs: 0, string: 0 }
  for (const f of findings) kinds[f.kind]++
  const flagged = findings.filter((f) => f.markers.length)
  return {
    total: findings.length,
    files: new Set(findings.map((f) => f.file)).size,
    kinds,
    flagged: flagged.length,
    unsourced: flagged.filter((f) => !f.sourced).length,
  }
}

export function report(findings, { all = false, skipped = 0 } = {}) {
  const s = summarize(findings)
  const lines = []
  for (const file of [...new Set(findings.map((f) => f.file))]) {
    // `proseUnits` returns every comment before any string, so file order alone would not read
    // top-to-bottom; sort by line so the printed order matches the file the reader has open.
    const own = findings.filter((f) => f.file === file).sort((a, b) => a.line - b.line)
    const shown = all ? own : own.filter((f) => f.markers.length)
    if (shown.length === 0 && own.length === 0) continue
    lines.push(file)
    for (const f of shown) {
      const tags = f.markers.length ? `[${f.markers.join(', ')}]${f.sourced ? ' [src]' : ''} ` : ''
      lines.push(`  L${f.line} (${f.kind}) ${tags}${f.text}`)
    }
    if (!all && own.length > shown.length) lines.push(`  … +${own.length - shown.length} other new sentences (--all lists them)`)
  }
  lines.push(
    `${s.total} new prose sentences in ${s.files} files (comments ${s.kinds.comment}, docs ${s.kinds.docs}, strings ${s.kinds.string}); ${s.flagged} flagged, ${s.unsourced} flagged without a source.`,
    'A listed sentence needs a checkable source or a deletion. An unlisted sentence is not verified either.',
  )
  if (skipped > 0) lines.push(`${skipped} file${skipped === 1 ? '' : 's'} not scanned.`)
  return lines.join('\n')
}

export function parseArgs(argv) {
  const opts = { all: false, json: false, strict: false }
  for (const arg of argv) {
    const m = /^--(base|head)=(.+)$/.exec(arg)
    if (m) opts[m[1]] = m[2]
    else if (arg === '--all' || arg === '--json' || arg === '--strict') opts[arg.slice(2)] = true
    else throw new Error(`audit-new-prose: unrecognised argument ${arg}`)
  }
  return opts
}

const scannable = (file) => !SKIP_PATH.test(file) && Boolean(EXT_KIND[file.split('.').pop().toLowerCase()])

// Assumes the standard `a/`/`b/` diff prefixes: a `diff.mnemonicPrefix` or `diff.noprefix` config
// changes the `+++ ` label's prefix, which `parseDiff`'s `^b\/` strip does not account for. Not
// forced off here, since overriding a config this tool doesn't own is its own kind of surprise;
// this repo sets no such config as of writing.
const git = (args, cwd) => execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })

// The default base is the merge-base of the ref actually being audited, not of the checkout's HEAD:
// with `--head=` naming a branch other than the current one, comparing against HEAD's own history
// would list that OTHER branch's sentences relative to the wrong point, or the checkout's own
// unrelated changes as if they belonged to `head`.
function defaultBase(cwd, ref) {
  for (const against of ['origin/main', 'main']) {
    try { return git(['merge-base', ref, against], cwd).trim() } catch { /* next */ }
  }
  throw new Error('audit-new-prose: no origin/main or main to compare against; pass --base=')
}

export function collect({ base, head = WORKTREE, cwd }) {
  const root = git(['rev-parse', '--show-toplevel'], cwd).trim()
  // Resolved up front so a bad `--head=` fails with git's own reason, rather than falling through
  // into defaultBase()'s unrelated "no origin/main or main" message and its useless `--base=` remedy.
  if (head !== WORKTREE) {
    try { git(['rev-parse', '--verify', `${head}^{commit}`], root) } catch { throw new Error(`audit-new-prose: --head=${head} does not resolve to a commit`) }
  }
  const from = base ?? defaultBase(root, head === WORKTREE ? 'HEAD' : head)
  const diffArgs = ['diff', '--unified=0', '--no-color', '--no-ext-diff', '--no-renames', from, ...(head === WORKTREE ? [] : [head]), '--']
  const added = parseDiff(git(diffArgs, root))
  let skipped = 0
  if (head === WORKTREE) {
    for (const f of git(['ls-files', '--others', '--exclude-standard', '-z'], root).split('\0').filter(Boolean)) {
      if (!scannable(f)) { skipped++; continue }
      const n = readFileSync(`${root}/${f}`, 'utf8').split('\n').length
      added.set(f, new Set(Array.from({ length: n }, (_, i) => i + 1)))
    }
  }
  const findings = []
  for (const [file, lines] of added) {
    if (!scannable(file)) { skipped++; continue }
    const text = head === WORKTREE ? readFileSync(`${root}/${file}`, 'utf8') : git(['show', `${head}:${file}`], root)
    findings.push(...audit(file, text, lines))
  }
  return { findings, skipped }
}

function isMain() {
  try { return fileURLToPath(import.meta.url) === realpathSync(process.argv[1] ?? '') } catch { return false }
}

if (isMain()) {
  let findings, skipped, opts
  try {
    opts = parseArgs(process.argv.slice(2))
    ;({ findings, skipped } = collect({ base: opts.base, head: opts.head, cwd: process.cwd() }))
  } catch (err) {
    console.error(`❌ ${err.message}`)
    process.exit(1)
  }
  console.log(opts.json ? JSON.stringify({ summary: summarize(findings), skipped, findings }, null, 2) : report(findings, { all: opts.all, skipped }))
  process.exit(opts.strict && summarize(findings).unsourced > 0 ? 1 : 0)
}
