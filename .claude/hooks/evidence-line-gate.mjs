#!/usr/bin/env node
// Stop hook, soft — a final message that proposes an issue, asks for a decision, recommends an option
// or lists remaining work must carry a `근거:` line naming the kind of record behind it. The check is
// mechanical: it never judges whether the evidence is good, only whether the line is there.
//
// Never blocks: a missing line returns Stop `hookSpecificOutput.additionalContext`, so the model gets one
// continuation to add it, and `stop_hook_active` keeps that to one. Hook bugs exit 0 silently.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const AUDIT_FILE = process.env.HOOK_AUDIT_LOG
  ? path.resolve(process.env.HOOK_AUDIT_LOG)
  : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hook-audit.jsonl')

export const TRIGGER_RE = /이슈\s*(후보|제안|생성|로\s*(분리|다루|넘기))|후속\s*이슈|별도\s*이슈|새\s*이슈|정해\s*주세요|정하셔야|결정이?\s*(필요|대기)|권합니다|권장|권고|남은\s*(일|작업|것)|남아\s*있|할\s*일|follow-up issue|separate issue|remaining work/i

export const EVIDENCE_KINDS = ['운영 데이터', '공식 기록', '코드 읽기만', '미확인']

const EVIDENCE_LINE_RE = /^\s*(?:[-*]\s*)?\**근거\**\s*:\s*\**\s*(.*)$/gm

export function classify(text) {
  const trigger = TRIGGER_RE.test(text)
  const counts = Object.fromEntries(EVIDENCE_KINDS.map((k) => [k, 0]))
  let lines = 0
  let untyped = 0
  for (const m of text.matchAll(EVIDENCE_LINE_RE)) {
    lines++
    const kind = EVIDENCE_KINDS.find((k) => m[1].startsWith(k))
    if (kind) counts[kind]++
    else untyped++
  }
  return { trigger, lines, untyped, counts, missing: trigger && lines === 0 }
}

export function auditNote(c) {
  const [ops, official, code, unverified] = EVIDENCE_KINDS.map((k) => c.counts[k])
  return `trigger=${c.trigger ? 1 : 0} lines=${c.lines} ops=${ops} official=${official} code=${code} unverified=${unverified} untyped=${c.untyped}`
}

export const FEEDBACK =
  'Your final message proposes an issue, asks for a decision, recommends an option or lists remaining work, ' +
  'but carries no `근거:` line. Re-send it with one `근거:` line under each such item, starting with the kind of ' +
  `record it rests on — ${EVIDENCE_KINDS.map((k) => `\`${k}\``).join(' / ')} — then the count, quote or command. ` +
  'If the only basis is reading code or issue text, write `코드 읽기만`; if nothing was checked, write `미확인` and do not propose it. ' +
  'If the message has no such item, re-send it unchanged.'

function audit(decision, note) {
  try {
    fs.appendFileSync(
      AUDIT_FILE,
      JSON.stringify({ ts: new Date().toISOString(), hook: 'evidence-line-gate', decision, note }) + '\n',
    )
  } catch {}
}

function main() {
  let input
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'))
  } catch {
    return
  }
  if (input.stop_hook_active) return
  const text = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : ''
  if (!text) {
    audit('skip', 'no last_assistant_message')
    return
  }
  const c = classify(text)
  audit(c.missing ? 'warn' : 'clean', auditNote(c))
  if (c.missing) {
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: FEEDBACK } }),
    )
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main()
  } catch {}
}
