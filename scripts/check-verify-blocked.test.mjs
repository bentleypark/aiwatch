// #2011 — verify-blocked eligibility: the label the triage/ship-issue skills apply must be one the
// body-drift guard accepts. Run with `npm run test:scripts`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyBlockedEligibility } from './verify-reminders.mjs'
import { renderEligibility } from './check-verify-blocked.mjs'

// The #2005 shape: step 1 shipped and ticked, design boxes still open, a dated verify-after line.
const PHASED = [
  '## Verify before designing',
  '- [ ] Which status pages expose full history with update timelines.',
  '- [ ] Past-p80 coverage re-measured on the larger set.',
  '- [x] Step 1 sets the source in `parseAnalysisResponse` before range normalisation.',
  '',
  '## Production-gated verification',
  '- [ ] **verify-after 2026-12-16** — read `estimateSource` on the ledger snapshots. PR #2008.',
  '      durable: incident:ledger:{YYYY-MM}:{svcId} (no TTL)',
].join('\n')

const SHIPPED = [
  '- [x] Parser change',
  '- [x] Tests',
  '',
  '## Production-gated verification',
  '- [ ] **verify-after 2026-12-02** — the November draft shows the lines.',
  '      durable: _data/2026-11.json (committed snapshot)',
].join('\n')

test('a phased issue with open design boxes is not eligible, and names the boxes', () => {
  const r = verifyBlockedEligibility(PHASED)
  assert.equal(r.eligible, false)
  assert.equal(r.openBoxes.length, 2)
  assert.match(r.openBoxes[0], /^Which status pages/)
})

test('a shipped issue with only verify-after lines open is eligible', () => {
  assert.deepEqual(verifyBlockedEligibility(SHIPPED), { eligible: true, reason: 'only verify-after lines are open', openBoxes: [] })
})

test('no live, unchecked verify-after line → not eligible, whatever the boxes say', () => {
  for (const body of [
    '- [x] done\n- [x] also done',
    '- [x] done\n- [x] **verify-after 2026-10-28** — checked already',
    '- [x] done\n> - [ ] **verify-after 2026-10-28** — quoted in a status note',
    '- [x] done\n- [ ] cites `verify-after 2026-10-28` in backticks',
    '',
    null,
  ]) {
    const r = verifyBlockedEligibility(body)
    assert.equal(r.eligible, false, String(body))
    assert.equal(r.reason, 'no unchecked verify-after line')
  }
})

test('renderEligibility lists each open box under the verdict', () => {
  assert.equal(
    renderEligibility(verifyBlockedEligibility(PHASED)),
    [
      'verify-blocked: not eligible — 2 open box(es) other than verify-after',
      '  - [ ] Which status pages expose full history with update timelines.',
      '  - [ ] Past-p80 coverage re-measured on the larger set.',
    ].join('\n'),
  )
})

const script = fileURLToPath(new URL('./check-verify-blocked.mjs', import.meta.url))

// A stub `gh` first on PATH: logs its args, fails for issue 999, otherwise prints body.md.
function withStubGh(body) {
  const dir = mkdtempSync(join(tmpdir(), 'cvb-gh-'))
  const log = join(dir, 'args.log')
  writeFileSync(join(dir, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n[ "$3" = "999" ] && exit 1\ncat "${join(dir, 'body.md')}"\n`)
  chmodSync(join(dir, 'gh'), 0o755)
  writeFileSync(join(dir, 'body.md'), body)
  const run = (args) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } }) }
    } catch (e) {
      return { code: e.status, out: e.stdout }
    }
  }
  return { run, args: () => readFileSync(log, 'utf8').trim() }
}

test('the CLI exits 0 on an eligible issue and 1 on a phased one', () => {
  const ok = withStubGh(SHIPPED).run(['165'])
  assert.equal(ok.code, 0)
  assert.match(ok.out, /^verify-blocked: eligible/)
  const no = withStubGh(PHASED).run(['2005'])
  assert.equal(no.code, 1)
  assert.match(no.out, /^verify-blocked: not eligible — 2 open box/)
})

test('the CLI passes --repo to gh, and exits 2 when gh fails', () => {
  const gh = withStubGh(PHASED)
  gh.run(['165', '--repo', 'bentleypark/aiwatch-reports'])
  assert.equal(gh.args(), 'issue view 165 --json body --jq .body --repo bentleypark/aiwatch-reports')
  assert.equal(gh.run(['999']).code, 2)
})

test('the CLI exits 2 on a call it cannot read, without calling gh', () => {
  const gh = withStubGh(SHIPPED)
  for (const args of [[], ['#2005'], ['--repo', 'bentleypark/aiwatch', '2005'], ['--body-file', 'x.md']]) {
    assert.equal(gh.run(args).code, 2, args.join(' '))
  }
  assert.throws(() => gh.args(), /ENOENT/)
})
