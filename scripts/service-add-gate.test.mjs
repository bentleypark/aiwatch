import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { addedIds, branchIssue, step0Blocks, decide, denyMessage, SERVICES_FILE_RE, GH_TIMEOUT_MS, GIT_TIMEOUT_MS, GIT_CALLS } from '../.claude/hooks/service-add-gate.mjs'
import { parseStep0, checkStep0 } from './service-step0.mjs'

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', '.claude', 'hooks', 'service-add-gate.mjs')
const step0 = { parseStep0, checkStep0 }

const GOOD = `## Step-0 audit
generated: 2026-11-12 by scripts/service-step0.mjs
source: atlassian
- uptime: present | scope=card(1 ids) | evidence=placeholder keyed abc | status=measured
- history: n=12 | scope=card(1 ids) | window=2026-05-01..2026-11-10 | exhausted=yes | status=measured
- probe: representative | control=yes | evidence=/v1/models 401/80ms differs from the garbage path 404/20ms | status=measured
- gap: no other speech-to-text card on the page | status=measured
- boundary: the card is the speech API only | status=measured
verdict: add
`
const UNMEASURED = GOOD.replace(/- probe: .*\n/, '- probe: unmeasured | status=unmeasured\n')
const HOLD = GOOD.replace('verdict: add', 'verdict: hold')

describe('the fixtures themselves', () => {
  test('GOOD passes check and says add; the others fail for the reason they were built for', () => {
    assert.deepEqual(checkStep0(GOOD), { ok: true, errors: [] })
    assert.equal(parseStep0(GOOD).verdict, 'add')
    assert.equal(checkStep0(UNMEASURED).ok, false)
    assert.equal(checkStep0(HOLD).ok, true)
    assert.equal(parseStep0(HOLD).verdict, 'hold')
  })
})

describe('addedIds (an id is new when the file as it stands does not have it)', () => {
  const line = (id) => `  { id: '${id}', name: 'X', provider: 'P', category: 'api' },`
  const FILE = `${line('a')}\n${line('claude')}\n${line('gemini')}\n  // anchor\n`
  test('an Edit that adds an entry names the new id', () => {
    assert.deepEqual(addedIds('Edit', { old_string: line('a'), new_string: `${line('a')}\n${line('b')}` }, FILE), ['b'])
  })
  test('an Edit that only changes another field of an existing entry adds nothing', () => {
    assert.deepEqual(addedIds('Edit', { old_string: line('a'), new_string: line('a').replace("'X'", "'Y'") }, FILE), [])
  })
  test('a renamed id counts as new', () => {
    assert.deepEqual(addedIds('Edit', { old_string: line('a'), new_string: line('c') }, FILE), ['c'])
  })
  test('pasting an entry that an earlier Edit cut is not new when the baseline file has it', () => {
    const afterCut = FILE.replace(`${line('gemini')}\n`, '')
    const paste = { old_string: '  // anchor\n', new_string: `  // anchor\n${line('gemini')}\n` }
    assert.deepEqual(addedIds('Edit', paste, afterCut), ['gemini'])
    assert.deepEqual(addedIds('Edit', paste, afterCut, FILE), [])
    assert.deepEqual(addedIds('Edit', { old_string: 'x', new_string: line('brandnew') }, afterCut, FILE), ['brandnew'])
  })
  test('moving an existing entry (delete here, insert there) adds nothing', () => {
    const edits = [{ old_string: `${line('gemini')}\n`, new_string: '' }, { old_string: '  // anchor\n', new_string: `  // anchor\n${line('gemini')}\n` }]
    assert.deepEqual(addedIds('MultiEdit', { edits }, FILE), [])
  })
  test('an id-shaped example inside a comment is not an entry, whether or not the file has it', () => {
    assert.deepEqual(addedIds('Edit', { old_string: 'a', new_string: "// e.g. { id: 'claude' }\na" }, FILE), [])
    assert.deepEqual(addedIds('Edit', { old_string: 'a', new_string: "// e.g. { id: 'zzz' }\na" }, FILE), [])
  })
  test('an entry that starts the replacement text mid-line still counts', () => {
    assert.deepEqual(addedIds('Edit', { old_string: "{ id: 'a', name: 'X' }", new_string: "{ id: 'q', name: 'X' }" }, FILE), ['q'])
  })
  test('MultiEdit collects the ids of every edit', () => {
    assert.deepEqual(addedIds('MultiEdit', { edits: [{ old_string: 'x', new_string: line('b') }, { old_string: line('a'), new_string: line('a') }, { old_string: 'y', new_string: line('d') }] }, FILE).sort(), ['b', 'd'])
  })
  test('a Write is compared with the file as it stands', () => {
    assert.deepEqual(addedIds('Write', { content: `${line('a')}\n${line('b')}` }, line('a')), ['b'])
    assert.deepEqual(addedIds('Write', { content: `${line('a')}\n${line('b')}` }, ''), ['a', 'b'])
  })
  test('an id key that is not a service entry shape is not read', () => {
    assert.deepEqual(addedIds('Edit', { old_string: '', new_string: "const x = { name: 'id: z' }" }, FILE), [])
  })
})

describe('branchIssue and the file match', () => {
  test('the issue number is read off {type}/{N}-{desc}', () => {
    assert.equal(branchIssue('chore/1974-service-step0-gate'), '1974')
    assert.equal(branchIssue('feat/12-x'), '12')
    for (const b of ['main', 'fix-1974', 'feat/no-number', '', null]) assert.equal(branchIssue(b), null, String(b))
  })
  test('only worker/src/services.ts matches, in a worktree path too', () => {
    assert.ok(SERVICES_FILE_RE.test('/r/aiwatch-1974/worker/src/services.ts'))
    for (const p of ['/r/worker/src/services.test.ts', '/r/worker/src/__tests__/services.ts', '/r/src/services.ts', '/r/worker/src/service-groups.ts']) assert.equal(SERVICES_FILE_RE.test(p), false, p)
  })
})

describe('step0Blocks', () => {
  test('every block, in the order of the body then the comments', () => {
    assert.deepEqual(step0Blocks([UNMEASURED, 'chatter', GOOD]), [UNMEASURED, GOOD])
  })
  test('two blocks in one text are two blocks, each ending where the next begins', () => {
    const blocks = step0Blocks([`intro\n${UNMEASURED}\nmore\n${GOOD}`])
    assert.equal(blocks.length, 2)
    assert.equal(checkStep0(blocks[1]).ok, true)
    assert.equal(checkStep0(blocks[0]).ok, false)
  })
  test('a block quoted inside a code fence is not a block', () => {
    assert.deepEqual(step0Blocks([`Before, we had:\n\`\`\`\n${GOOD}\`\`\`\nnow nothing`]), [])
    assert.deepEqual(step0Blocks([`~~~\n${GOOD}~~~\n${HOLD}`]), [HOLD])
  })
  test('no block is an empty list', () => {
    assert.deepEqual(step0Blocks(['nothing', null, undefined]), [])
  })
})

describe('decide', () => {
  const ids = ['x']
  test('no new id is allowed without looking at the issue', () => {
    assert.deepEqual(decide({ ids: [], issue: null, texts: [], step0 }), { allow: true, reason: 'no-new-id' })
  })
  test('a passing add block is allowed', () => {
    assert.deepEqual(decide({ ids, issue: '5', texts: ['body', GOOD], step0 }), { allow: true, reason: 'pass' })
  })
  test('each fact that is missing is a deny with its own reason', () => {
    assert.equal(decide({ ids, issue: null, texts: [], step0 }).reason, 'no-issue')
    assert.equal(decide({ ids, issue: '5', texts: ['no block here'], step0 }).reason, 'no-block')
    assert.match(decide({ ids, issue: '5', texts: [UNMEASURED], step0 }).reason, /^check-failed:.*row-unmeasured:probe/)
    assert.equal(decide({ ids, issue: '5', texts: [HOLD], step0 }).reason, 'verdict-not-add')
  })
  describe('the flip rule: each block is checked against the last block that was recorded', () => {
    const HOLD_THIN = HOLD.replace('n=12', 'n=3')
    const FLIPPED = GOOD.replace('verdict: add', 'verdict: add\nverdict-change: history')
    const BACK = HOLD_THIN.replace('verdict: hold', 'verdict: hold\nverdict-change: history')
    const DRAFT = GOOD.replace(/- probe: .*\n/, '- probe: unmeasured | status=unmeasured\n')
    const reason = (texts) => decide({ ids, issue: '5', texts, step0 }).reason
    test('the deny names what is wrong with the block, since a plain `check` of it passes', () => {
      const d = decide({ ids, issue: '5', texts: [HOLD_THIN, GOOD, GOOD], step0 })
      assert.equal(checkStep0(GOOD).ok, true)
      const m = denyMessage(d.reason, ['x'], '5', d.detail)
      assert.match(m, /the verdict changed: list the rows that moved/)
      assert.doesNotMatch(m, /passes `node scripts\/service-step0\.mjs check`/)
    })
    test('a flip that lists what moved passes, and an unlisted one is denied', () => {
      assert.equal(reason([HOLD_THIN, FLIPPED]), 'pass')
      assert.match(reason([HOLD_THIN, GOOD]), /verdict-change-missing/)
    })
    test('re-posting a refused block does not make it the predecessor', () => {
      assert.match(reason([HOLD_THIN, GOOD, GOOD]), /verdict-change-missing/)
      assert.match(reason([HOLD_THIN, DRAFT, GOOD]), /verdict-change-missing/)
    })
    test('a re-measurement after a recorded flip is add to add', () => {
      assert.equal(reason([HOLD_THIN, FLIPPED, GOOD.replace('n=12', 'n=13')]), 'pass')
    })
    test('flipping back and forth needs a listing at every flip', () => {
      assert.equal(reason([GOOD, BACK, FLIPPED]), 'pass')
      assert.match(reason([GOOD, BACK, GOOD]), /verdict-change-missing/)
      assert.match(reason([GOOD, HOLD_THIN]), /verdict-change-missing/)
    })
    test('a first block has no predecessor, and an earlier block with no verdict is never recorded', () => {
      assert.equal(reason([GOOD]), 'pass')
      assert.equal(reason([GOOD.replace('verdict: add\n', ''), GOOD]), 'pass')
    })
  })
  test('a block quoted in a later comment does not replace the block it quotes', () => {
    assert.deepEqual(decide({ ids, issue: '5', texts: [GOOD, `old record:\n\`\`\`\n${HOLD}\`\`\``], step0 }), { allow: true, reason: 'pass' })
    assert.equal(decide({ ids, issue: '5', texts: [HOLD, `old record:\n\`\`\`\n${GOOD}\`\`\``], step0 }).reason, 'verdict-not-add')
  })
  test('a later unmeasured block overrides an earlier passing one', () => {
    assert.equal(decide({ ids, issue: '5', texts: [GOOD, UNMEASURED], step0 }).allow, false)
  })
  test('no deny text states a condition that lifts the deny: the rule lives in one place and the message points to it', () => {
    const HOLD_THIN = HOLD.replace('n=12', 'n=3')
    const cases = [
      decide({ ids: ['x'], issue: '5', texts: [HOLD], step0 }),
      decide({ ids: ['x'], issue: '5', texts: [HOLD_THIN, GOOD], step0 }),
      decide({ ids: ['x'], issue: '5', texts: ['prose'], step0 }),
      decide({ ids: ['x'], issue: null, texts: [], step0 }),
    ]
    assert.deepEqual(cases.map((d) => d.reason.split(':')[0]), ['verdict-not-add', 'check-failed', 'no-block', 'no-issue'])
    for (const d of cases) {
      const m = denyMessage(d.reason, ['x'], '5', d.detail)
      assert.match(m, /workflow-hooks\.md/)
      assert.doesNotMatch(m, /passes `|then retry/)
    }
  })
  test('the deny message names the id and the issue', () => {
    const m = denyMessage('no-block', ['x'], '5')
    assert.match(m, /"x"/)
    assert.match(m, /issue #5 has no/)
    assert.match(m, /workflow-hooks\.md/)
    assert.match(m, /code fence/)
  })
})

describe('the hook as Claude Code runs it', () => {
  const root = mkdtempSync(join(tmpdir(), 'svc-gate-'))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\nif [ -n "$STUB_GH_FAIL" ]; then exit 1; fi\nprintf "%s" "$STUB_ISSUE_JSON"\n')
  chmodSync(join(bin, 'gh'), 0o755)

  const repo = (branch) => {
    const dir = mkdtempSync(join(root, 'repo-'))
    execFileSync('git', ['init', '-q', '-b', branch === null ? 'main' : branch, dir])
    execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'])
    if (branch === null) execFileSync('git', ['-C', dir, 'checkout', '-q', '--detach'])
    mkdirSync(join(dir, 'worker', 'src'), { recursive: true })
    writeFileSync(join(dir, 'worker/src/services.ts'), "  { id: 'a', name: 'A' },\n  { id: 'moved', name: 'M' },\n")
    return dir
  }
  const run = ({ dir, tool = 'Edit', file = 'worker/src/services.ts', input, issue, ghFail }) => {
    const audit = join(root, `audit-${Math.random().toString(36).slice(2)}.jsonl`)
    const r = spawnSync('node', [HOOK], {
      input: JSON.stringify({ tool_name: tool, cwd: dir, tool_input: { file_path: join(dir, file), ...input } }),
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOOK_AUDIT_LOG: audit, STUB_ISSUE_JSON: JSON.stringify(issue ?? { body: '', comments: [] }), ...(ghFail ? { STUB_GH_FAIL: '1' } : {}) },
    })
    const lines = existsSync(audit) ? readFileSync(audit, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []
    return { status: r.status, out: r.stdout, deny: r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null, audit: lines }
  }
  const ADD = { old_string: "  { id: 'a', name: 'A' },", new_string: "  { id: 'a', name: 'A' },\n  { id: 'newsvc', name: 'N' }," }

  test('a new id with a passing add block is allowed and logged as pass', () => {
    const r = run({ dir: repo('chore/9-add'), input: ADD, issue: { body: GOOD, comments: [] } })
    assert.equal(r.out, '')
    assert.deepEqual(r.audit.map((a) => [a.decision, a.note]), [['pass', 'pass:newsvc']])
  })

  test('a new id with no Step-0 block is denied with the issue named', () => {
    const r = run({ dir: repo('chore/9-add'), input: ADD, issue: { body: 'just prose', comments: [] } })
    assert.equal(r.deny.permissionDecision, 'deny')
    assert.match(r.deny.permissionDecisionReason, /issue #9 has no/)
    assert.deepEqual(r.audit.map((a) => a.decision), ['deny'])
  })

  test('an unmeasured block, or a hold verdict, is denied', () => {
    assert.match(run({ dir: repo('chore/9-add'), input: ADD, issue: { body: UNMEASURED, comments: [] } }).deny.permissionDecisionReason, /fails check/)
    assert.match(run({ dir: repo('chore/9-add'), input: ADD, issue: { body: HOLD, comments: [] } }).deny.permissionDecisionReason, /does not say `verdict: add`/)
  })

  test('the block can sit in a comment, and the latest one is the one read', () => {
    assert.equal(run({ dir: repo('chore/9-add'), input: ADD, issue: { body: UNMEASURED, comments: [{ body: GOOD }] } }).out, '')
    assert.ok(run({ dir: repo('chore/9-add'), input: ADD, issue: { body: GOOD, comments: [{ body: UNMEASURED }] } }).deny)
  })

  test('a refused flip is denied through the hook with the reason a plain check would not show', () => {
    const HOLD_THIN = HOLD.replace('n=12', 'n=3')
    const r = run({ dir: repo('chore/9-add'), input: ADD, issue: { body: HOLD_THIN, comments: [{ body: GOOD }, { body: GOOD }] } })
    assert.match(r.deny.permissionDecisionReason, /the verdict changed: list the rows that moved/)
  })

  test('a branch with no issue number is denied; a detached head is skipped, not denied', () => {
    assert.match(run({ dir: repo('scratch'), input: ADD }).deny.permissionDecisionReason, /no issue number/)
    const r = run({ dir: repo(null), input: ADD })
    assert.equal(r.out, '')
    assert.deepEqual(r.audit.map((a) => [a.decision, a.note]), [['skip', 'detached-head']])
  })

  test('gh failing fails open and says so in the audit log', () => {
    const r = run({ dir: repo('chore/9-add'), input: ADD, ghFail: true })
    assert.equal(r.out, '')
    assert.deepEqual(r.audit.map((a) => [a.decision, a.note]), [['skip', 'gh-failed:#9']])
  })

  test('an edit that adds no id, or a different file, is not this hook\'s business and writes nothing', () => {
    const same = run({ dir: repo('chore/9-add'), input: { old_string: "{ id: 'a', name: 'A' }", new_string: "{ id: 'a', name: 'B' }" } })
    assert.deepEqual([same.out, same.audit], ['', []])
    const other = run({ dir: repo('chore/9-add'), file: 'worker/src/services.test.ts', input: ADD })
    assert.deepEqual([other.out, other.audit], ['', []])
  })

  test('a services.ts that cannot be read fails open and says so, rather than reading every id as new', () => {
    const dir = repo('chore/9-add')
    execFileSync('rm', [join(dir, 'worker/src/services.ts')])
    mkdirSync(join(dir, 'worker/src/services.ts'))
    const r = run({ dir, input: { old_string: "{ id: 'a', name: 'A' }", new_string: "{ id: 'a', name: 'B' }" }, issue: { body: 'prose', comments: [] } })
    assert.equal(r.out, '')
    assert.deepEqual(r.audit.map((x) => [x.decision, x.note]), [['skip', 'cannot-read-edit']])
  })

  test('a Write that creates the file is judged with every id new', () => {
    const dir = repo('chore/9-add')
    execFileSync('rm', [join(dir, 'worker/src/services.ts')])
    const r = run({ dir, tool: 'Write', input: { content: "  { id: 'fresh', name: 'F' },\n" }, issue: { body: 'prose', comments: [] } })
    assert.match(r.deny.permissionDecisionReason, /"fresh"/)
  })

  const commitAll = (dir, msg) => {
    execFileSync('git', ['-C', dir, 'add', '-A'])
    execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', msg])
  }
  const PASTE = { old_string: "  { id: 'a', name: 'A' },\n", new_string: "  { id: 'a', name: 'A' },\n  { id: 'moved', name: 'M' },\n" }

  test('the second half of a cut-and-paste move is not a new service when HEAD has the entry', () => {
    const dir = repo('chore/9-add')
    commitAll(dir, 'services')
    writeFileSync(join(dir, 'worker/src/services.ts'), "  { id: 'a', name: 'A' },\n")
    const r = run({ dir, input: PASTE, issue: { body: 'prose', comments: [] } })
    assert.deepEqual([r.out, r.audit], ['', []])
  })

  test('origin/main is read before HEAD: an entry only main has is not new either', () => {
    const dir = repo('chore/9-add')
    const bare = mkdtempSync(join(root, 'origin-'))
    execFileSync('git', ['init', '-q', '--bare', bare])
    commitAll(dir, 'services')
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', bare])
    execFileSync('git', ['-C', dir, 'push', '-q', 'origin', 'HEAD:main'])
    execFileSync('git', ['-C', dir, 'fetch', '-q', 'origin'])
    writeFileSync(join(dir, 'worker/src/services.ts'), "  { id: 'a', name: 'A' },\n")
    commitAll(dir, 'drop moved on the branch')
    const r = run({ dir, input: PASTE, issue: { body: 'prose', comments: [] } })
    assert.deepEqual([r.out, r.audit], ['', []])
  })

  test('an entry neither the file nor the baseline has is still new', () => {
    const dir = repo('chore/9-add')
    commitAll(dir, 'services')
    const r = run({ dir, input: ADD, issue: { body: 'prose', comments: [] } })
    assert.match(r.deny.permissionDecisionReason, /"newsvc"/)
  })

  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  const withGitStub = (script) => {
    const stubBin = mkdtempSync(join(root, 'gitstub-'))
    writeFileSync(join(stubBin, 'git'), script)
    chmodSync(join(stubBin, 'git'), 0o755)
    return stubBin
  }
  const runWithGit = (stubBin, args) => {
    const prev = process.env.PATH
    process.env.PATH = `${stubBin}:${prev}`
    try { return run(args) } finally { process.env.PATH = prev }
  }

  test('the hook makes no more git calls than GIT_CALLS, even when neither baseline ref exists', () => {
    const dir = repo('chore/9-add')
    const log = join(root, `gitcalls-${Math.random().toString(36).slice(2)}`)
    const stub = withGitStub(`#!/bin/sh\necho x >> "${log}"\nexec ${realGit} "$@"\n`)
    const r = runWithGit(stub, { dir, input: ADD, issue: { body: 'prose', comments: [] } })
    assert.ok(r.deny)
    assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, GIT_CALLS)
  })

  test('a git call that hangs is cut at GIT_TIMEOUT_MS and the gate fails open', () => {
    const dir = repo('chore/9-add')
    const stub = withGitStub('#!/bin/sh\nsleep 8\n')
    const started = Date.now()
    const r = runWithGit(stub, { dir, input: ADD, issue: { body: 'prose', comments: [] } })
    assert.ok(Date.now() - started < GIT_CALLS * GIT_TIMEOUT_MS + 2500, 'the hook waited past its git limit')
    assert.deepEqual(r.audit.map((x) => [x.decision, x.note]), [['skip', 'git-failed']])
  })

  test('moving an existing entry in the file as it stands is not a new service, even on a branch with no block', () => {
    const dir = repo('chore/9-add')
    const edits = [{ old_string: "  { id: 'moved', name: 'M' },\n", new_string: '' }, { old_string: "  { id: 'a', name: 'A' },\n", new_string: "  { id: 'a', name: 'A' },\n  { id: 'moved', name: 'M' },\n" }]
    const r = run({ dir, tool: 'MultiEdit', input: { edits }, issue: { body: 'prose', comments: [] } })
    assert.deepEqual([r.out, r.audit], ['', []])
  })

  test('Write and MultiEdit reach the same decision', () => {
    const dir = repo('chore/9-add')
    writeFileSync(join(dir, 'worker/src/services.ts'), "  { id: 'a', name: 'A' },\n")
    const w = run({ dir, tool: 'Write', input: { content: "  { id: 'a', name: 'A' },\n  { id: 'newsvc', name: 'N' },\n" }, issue: { body: 'prose', comments: [] } })
    assert.ok(w.deny)
    const m = run({ dir, tool: 'MultiEdit', input: { edits: [ADD] }, issue: { body: 'prose', comments: [] } })
    assert.ok(m.deny)
  })
})

describe('wiring', () => {
  test('settings.json runs the hook on Edit, Write and MultiEdit, with a timeout longer than its gh and git calls', () => {
    const settings = JSON.parse(readFileSync(join(dirname(HOOK), '..', 'settings.json'), 'utf8'))
    const group = settings.hooks.PreToolUse.find((g) => g.matcher === 'Edit|Write|MultiEdit')
    const hook = group.hooks.find((h) => h.command.includes('service-add-gate.mjs'))
    assert.ok(hook)
    const worstCaseMs = GH_TIMEOUT_MS + GIT_CALLS * GIT_TIMEOUT_MS
    assert.ok(hook.timeout * 1000 > worstCaseMs, `timeout ${hook.timeout}s must exceed the hook's own worst case ${worstCaseMs}ms`)
  })
})
