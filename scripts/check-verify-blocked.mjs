#!/usr/bin/env node
// #2011 — whether `verify-blocked` may be applied to an issue.
// Usage: node scripts/check-verify-blocked.mjs <issue-number> [--repo OWNER/REPO]
// Exit 0 = eligible, 1 = not eligible, 2 = usage or gh error.

import { execFileSync } from 'node:child_process'
import { verifyBlockedEligibility } from './verify-reminders.mjs'
import { isMain } from './is-main.mjs'

export function renderEligibility(result) {
  const head = `verify-blocked: ${result.eligible ? 'eligible' : 'not eligible'} — ${result.reason}`
  return [head, ...result.openBoxes.map((b) => `  - [ ] ${b}`)].join('\n')
}

function main(argv) {
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
  let body
  if (/^\d+$/.test(argv[0] ?? '')) {
    const repo = arg('--repo')
    const args = ['issue', 'view', argv[0], '--json', 'body', '--jq', '.body', ...(repo ? ['--repo', repo] : [])]
    try {
      body = execFileSync('gh', args, { encoding: 'utf8' })
    } catch (e) {
      process.stderr.write(`gh issue view failed: ${e.message.split('\n')[0]}\n`)
      return 2
    }
  } else {
    process.stderr.write('usage: check-verify-blocked.mjs <issue-number> [--repo OWNER/REPO]\n')
    return 2
  }
  const result = verifyBlockedEligibility(body)
  process.stdout.write(`${renderEligibility(result)}\n`)
  return result.eligible ? 0 : 1
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)))
