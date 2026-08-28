#!/usr/bin/env node
// Instruction-budget ratchet (#1285) — a committed cap on the always-loaded agent context.
//
// CLAUDE.md's step 7 asks it to stay "lean, ~40k-char guideline"; nothing enforced that, and the
// excess never showed up in a diff. Moving BUDGET_CHARS is what puts it there.
//
// The cap is the CURRENT size, not 40k: a cap that is red on day one gets disabled. Reducing toward
// 40k is separate work, and each reduction ratchets the cap down with it (MAX_SLACK).
// Rationale and the CI wiring: docs/reference/workflow-hooks.md.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The files in context before any turn does anything: CLAUDE.md, and the gate text
 *  `workflow-gates-reminder.sh` injects on every UserPromptSubmit. A floor on always-loaded cost,
 *  not the whole bill — other always-present context (the harness memory index, every listed skill's
 *  description) is unmeasured. */
export const ALWAYS_LOADED = ['CLAUDE.md', '.claude/hooks/workflow-gates.txt']

/** The ratchet. Raise it only with a reason stated in the PR that raises it.
 *
 *  46_301 → 46_670 (#1285): this guard's own entry in CLAUDE.md's Commands block, +369. The guard
 *  fired on its own introduction — that is the mechanism working, and this constant is the line it
 *  forces into the diff.
 *
 *  46_670 → 46_793 (#1224): the KV read-census entry in the Directory Layout block, +123. First raise
 *  by a PR other than the guard's own. */
export const BUDGET_CHARS = 46_793

/** A ratchet only ratchets if it is tight. Left with headroom it permits exactly the drift it exists
 *  to stop, so a REDUCTION that opens more than this much slack fails too, and the same PR lowers the
 *  cap behind it. Checked by the CLI, not only by the test suite: a CLAUDE.md-only PR starts no job
 *  that runs the tests (test.yml paths-ignores it), so a test-only slack check would red an unrelated
 *  later PR instead of the one that opened the slack. */
export const MAX_SLACK = 500

/** Unicode code points, not bytes: the guideline is written in chars, and a byte cap would tighten
 *  every time Korean prose replaced English, which has nothing to do with instruction density. */
export function charCount(text) {
  return typeof text === 'string' ? [...text].length : 0
}

/** `{file, chars}` for each always-loaded file. A MISSING or EMPTY file is an error, not a zero:
 *  scoring 0 would let a rename or a truncation shrink the measured total while the context is
 *  unchanged. */
export function measure(files = ALWAYS_LOADED, root = REPO_ROOT) {
  return files.map((file) => {
    const abs = path.join(root, file)
    if (!fs.existsSync(abs)) throw new Error(`instruction-budget: ${file} not found — update ALWAYS_LOADED`)
    const chars = charCount(fs.readFileSync(abs, 'utf8'))
    if (chars === 0) throw new Error(`instruction-budget: ${file} is empty — that is not a measurement`)
    return { file, chars }
  })
}

/** `status` is `over` (grew past the cap), `loose` (shrank far enough that the cap stopped binding),
 *  or `ok`. Both non-ok states are failures with different remedies, which is why this is a status
 *  and not a boolean. */
export function verdict(parts, budget = BUDGET_CHARS, maxSlack = MAX_SLACK) {
  // Fail closed rather than coerce: `NaN` loses every comparison below, so an unusable budget would
  // otherwise fall through to `ok` and print ✅ over a set of any size.
  if (!Number.isFinite(budget) || budget <= 0) throw new Error(`instruction-budget: budget ${budget} is not a positive number`)
  const total = parts.reduce((sum, p) => sum + p.chars, 0)
  const over = total - budget
  const status = over > 0 ? 'over' : -over > maxSlack ? 'loose' : 'ok'
  return { total, budget, over, slack: -over, status, ok: status === 'ok' }
}

export function report({ total, budget, over, slack, status }, parts) {
  const lines = parts.map((p) => `    ${p.file.padEnd(38)} ${String(p.chars).padStart(7)}`)
  if (status === 'ok') {
    return [`✅ instruction budget: ${total} / ${budget} chars (${slack} left)`, ...lines].join('\n')
  }
  if (status === 'loose') {
    return [
      `❌ instruction budget: ${total} / ${budget} chars — ${slack} of SLACK, cap no longer binds`,
      ...lines,
      '',
      `  A reduction this size must ratchet the cap down with it, in this PR:`,
      `    set BUDGET_CHARS = ${total} in scripts/check-instruction-budget.mjs`,
    ].join('\n')
  }
  return [
    `❌ instruction budget: ${total} / ${budget} chars — OVER by ${over}`,
    ...lines,
    '',
    '  The always-loaded context grew. Two honest options:',
    '    1. Cut the same amount elsewhere — detail belongs in `docs/reference/*`, which loads on demand.',
    '    2. Raise BUDGET_CHARS in scripts/check-instruction-budget.mjs, and say in the PR why.',
  ].join('\n')
}

function isMain() {
  try { return fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1] ?? '') } catch { return false }
}
/** `--root=` / `--budget=` let the tests drive THIS file — the one CI runs — over and under the cap
 *  without editing the repo's own CLAUDE.md. Unusable input throws rather than coercing. */
export function parseArgs(argv) {
  const opts = {}
  for (const arg of argv) {
    const m = /^--(root|budget)=(.*)$/.exec(arg)
    if (!m) throw new Error(`instruction-budget: unrecognised argument ${arg}`)
    opts[m[1]] = m[2]
  }
  if (opts.root === '') throw new Error('instruction-budget: --root= is empty')
  if (opts.budget !== undefined) {
    const n = Number(opts.budget)
    if (!Number.isFinite(n) || n <= 0) throw new Error(`instruction-budget: --budget=${opts.budget} is not a positive number`)
    opts.budget = n
  }
  return opts
}

if (isMain()) {
  let v, parts
  try {
    const { root, budget } = parseArgs(process.argv.slice(2))
    parts = measure(ALWAYS_LOADED, root ?? REPO_ROOT)
    v = verdict(parts, budget ?? BUDGET_CHARS)
  } catch (err) {
    // Loud, not a stack trace — and never exit 0: an input we cannot measure is a failure, not a pass.
    console.error(`❌ ${err.message}`)
    process.exit(1)
  }
  console.log(report(v, parts))
  process.exit(v.ok ? 0 : 1)
}
