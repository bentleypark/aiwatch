import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classify, auditNote } from '../.claude/hooks/evidence-line-gate.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOOK = join(REPO, '.claude', 'hooks', 'evidence-line-gate.mjs')

function runHook(input) {
  const log = join(mkdtempSync(join(tmpdir(), 'evidence-gate-')), 'hook-audit.jsonl')
  const r = spawnSync('node', [HOOK], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, HOOK_AUDIT_LOG: log },
  })
  const audit = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []
  return { status: r.status, stdout: r.stdout, audit }
}

const PROPOSAL = '후속 이슈 제안: 공유 장애 알림에서 첫 서비스가 대체 추천을 정하는 문제입니다.'
const DECISION = '두 방식 중 어느 쪽으로 갈지 정해 주세요.'
const REMAINING = '남은 일:\n1. 11-02 verify-after 확인'
const REPORT = '빌드와 테스트가 모두 통과했습니다. 커밋 `9c9cafc`.'

test('a proposal, a decision request and a remaining-work list each trigger; a plain report does not', () => {
  for (const t of [PROPOSAL, DECISION, REMAINING, '저는 A를 권합니다.', 'This should be a follow-up issue.']) {
    assert.equal(classify(t).trigger, true, t)
  }
  assert.equal(classify(REPORT).trigger, false)
  assert.equal(classify(REPORT).missing, false)
})

test('a triggered message is missing evidence only when it has no 근거: line', () => {
  assert.equal(classify(PROPOSAL).missing, true)
  assert.equal(classify(`${PROPOSAL}\n근거: 미확인 — 발생 기록을 조회하지 않음`).missing, false)
  assert.equal(classify(`${PROPOSAL}\n- **근거:** 운영 데이터 — discord-sent: 303건 중 11건`).missing, false)
  assert.equal(classify(`${PROPOSAL} 근거가 없습니다.`).missing, true)
})

test('each 근거: line is counted by the kind it starts with', () => {
  const c = classify(
    [
      DECISION,
      '근거: 운영 데이터 — KV 303건',
      '- 근거: 공식 기록 — incidents.json',
      '  근거: 코드 읽기만 — alerts.ts:689',
      '근거: 미확인',
      '근거: alerts.ts를 읽음',
    ].join('\n'),
  )
  assert.deepEqual(c.counts, { '운영 데이터': 1, '공식 기록': 1, '코드 읽기만': 1, '미확인': 1 })
  assert.equal(c.lines, 5)
  assert.equal(c.untyped, 1)
  assert.equal(auditNote(c), 'trigger=1 lines=5 ops=1 official=1 code=1 unverified=1 untyped=1')
})

test('the hook re-prompts through Stop additionalContext, never decision:block', () => {
  const r = runHook({ last_assistant_message: PROPOSAL })
  assert.equal(r.status, 0)
  const out = JSON.parse(r.stdout)
  assert.deepEqual(Object.keys(out), ['hookSpecificOutput'])
  assert.equal(out.hookSpecificOutput.hookEventName, 'Stop')
  assert.match(out.hookSpecificOutput.additionalContext, /근거:/)
  assert.deepEqual(r.audit.map((e) => [e.hook, e.decision]), [['evidence-line-gate', 'warn']])
})

test('the hook is silent when the line is present, when nothing triggers, and on the re-fire', () => {
  for (const input of [
    { last_assistant_message: `${PROPOSAL}\n근거: 코드 읽기만 — alerts.ts:689` },
    { last_assistant_message: REPORT },
  ]) {
    const r = runHook(input)
    assert.equal(r.status, 0)
    assert.equal(r.stdout, '')
    assert.equal(r.audit[0].decision, 'clean')
  }
  const refire = runHook({ stop_hook_active: true, last_assistant_message: PROPOSAL })
  assert.equal(refire.stdout, '')
  assert.equal(refire.audit.length, 0)
})

test('a malformed or empty input never breaks the stop', () => {
  for (const input of ['not json', {}, { last_assistant_message: 42 }]) {
    const r = runHook(input)
    assert.equal(r.status, 0)
    assert.equal(r.stdout, '')
  }
})

test('npm run hook-audit sums the evidence-line notes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'evidence-summary-'))
  const log = join(dir, 'hook-audit.jsonl')
  const ts = new Date(Date.now() - 3_600_000).toISOString()
  const line = (decision, note) => JSON.stringify({ ts, hook: 'evidence-line-gate', decision, note })
  writeFileSync(
    log,
    [
      line('warn', 'trigger=1 lines=0 ops=0 official=0 code=0 unverified=0 untyped=0'),
      line('clean', 'trigger=1 lines=3 ops=1 official=0 code=1 unverified=1 untyped=0'),
      line('clean', 'trigger=0 lines=0 ops=0 official=0 code=0 unverified=0 untyped=0'),
      line('skip', 'no last_assistant_message'),
    ].join('\n') + '\n',
  )
  const out = execFileSync('node', ['scripts/hook-audit-summary.mjs', '--days', '30'], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, HOOK_AUDIT_LOG: log },
  })
  assert.match(out, /3 final message\(s\) checked · 2 had a proposal\/decision\/remaining-work cue · 1 re-prompted for a missing 근거: line/)
  assert.match(out, /근거: lines=3 — 운영 데이터 1 · 공식 기록 0 · 코드 읽기만 1 · 미확인 1 · untyped 0/)
})
