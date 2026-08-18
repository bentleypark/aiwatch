// #1238 — behaviour tests for the real `plugin/aiwatch/bin/aiwatch-monitor.sh`, driven through the
// stub-curl harness. This is the first automated coverage this script has ever had.
//
// Everything is asserted on stdout, because stdout IS the product: every line the monitor prints
// becomes a Claude notification, and a line it does not print is a transition the developer never
// hears about.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { availableShells, downList, httpError, httpStatus, runMonitor } from './plugin-monitor-harness.mjs'

/** Guards that make an "emits nothing" assertion mean something:
 *  - `timedOut` — otherwise a monitor that never started satisfies every one of them.
 *  - `stderr` — production discards it and the plugin host shows only stdout, so this suite is the
 *    ONLY place a `comm: file 1 is not in sorted order`, a failed write or an awk error is
 *    reachable at all. Several of them would not change stdout in the covered cases. */
function expectQuiet(res) {
  assert.equal(res.stderr, '', 'the monitor wrote to stderr, which nothing in production would ever show')
}

async function run(polls, opts) {
  const res = await runMonitor(polls, opts)
  assert.ok(
    !res.timedOut,
    `harness timed out after ${res.polls}/${polls.length} polls (stdout: ${JSON.stringify(res.stdout)}, stderr: ${JSON.stringify(res.stderr)})`,
  )
  expectQuiet(res)
  return res
}

const CLAUDE_DOWN = downList([['down', 'Claude API']])
// AIWatch could not read Anthropic's status source. NOT an outage and NOT an all-clear (#1233's
// `statusVerdict`), and — the whole point of #1238 — NOT the same thing as the service being absent
// from the list, which is how the endpoint says "operational".
const CLAUDE_UNKNOWN = downList([['unknown', 'Claude API']])
const ALL_CLEAR = downList([])

const shells = availableShells()

// A guard whose default is passing has to be mutated against itself: if this ever returns [], the
// whole per-shell suite below registers ZERO tests and `node --test` still exits 0, which is
// indistinguishable from a healthy run at a glance.
test('the shell matrix is non-empty — an empty one would make every test below vanish silently', () => {
  assert.ok(shells.length > 0, 'no shell found to run the monitor under')
})

// The suite runs under each shell installed here, not just this machine's `/bin/sh` — which is
// bash-in-POSIX-mode on macOS and dash on CI. See `availableShells` for what that covers and, just
// as importantly, what it does not (the BSD/GNU utility split is covered by macOS-local + Linux-CI
// runs, not by the shell loop).
for (const shell of shells) {
  const via = shell.join(' ')
  const opts = { shell }

  test(`[${via}] announces every already-affected service on the first poll`, async () => {
    // `comm` reads sorted input, so the emitted order is by name — deterministic, not incidental.
    const res = await run([downList([['down', 'Claude API'], ['degraded', 'OpenAI API']])], opts)
    assert.deepEqual(res.lines, [
      '🔴 Claude API is down (AIWatch)',
      '🔴 OpenAI API is degraded (AIWatch)',
    ])
  })

  test(`[${via}] a healthy start says nothing, and cannot fabricate a recovery`, async () => {
    const res = await run([ALL_CLEAR, ALL_CLEAR], opts)
    assert.deepEqual(res.lines, [])
  })

  test(`[${via}] an unchanged poll is silent — only transitions are emitted`, async () => {
    const res = await run([CLAUDE_DOWN, CLAUDE_DOWN, CLAUDE_DOWN], opts)
    assert.deepEqual(res.lines, ['🔴 Claude API is down (AIWatch)'])
  })

  test(`[${via}] operational → down → operational emits the outage then the recovery, in order`, async () => {
    const res = await run([ALL_CLEAR, CLAUDE_DOWN, CLAUDE_DOWN, ALL_CLEAR], opts)
    assert.deepEqual(res.lines, [
      '🔴 Claude API is down (AIWatch)',
      '✅ Claude API has recovered (AIWatch)',
    ])
  })

  test(`[${via}] only the service that changed is named`, async () => {
    const res = await run([
      downList([['down', 'Claude API'], ['degraded', 'OpenAI API']]),
      downList([['down', 'Claude API']]),
    ], opts)
    assert.deepEqual(res.lines, [
      '🔴 Claude API is down (AIWatch)',
      '🔴 OpenAI API is degraded (AIWatch)',
      '✅ OpenAI API has recovered (AIWatch)',
    ])
  })

  test(`[${via}] a severity shift inside "affected" is NOT re-announced`, async () => {
    // Documented limitation in the script header, pinned so a future change to it is a deliberate
    // one: degraded → down keeps the name in the set, so nothing is emitted.
    const res = await run([
      downList([['degraded', 'Claude API']]),
      downList([['down', 'Claude API']]),
    ], opts)
    assert.deepEqual(res.lines, ['🔴 Claude API is degraded (AIWatch)'])
  })

  test(`[${via}] a failed poll is skipped — no fabricated recovery, and the set survives it`, async () => {
    // `null` = curl exits non-zero: a network blip. Absence of a body must never read as all-clear.
    const res = await run([CLAUDE_DOWN, null, null, CLAUDE_DOWN], opts)
    assert.deepEqual(res.lines, ['🔴 Claude API is down (AIWatch)'])
  })

  test(`[${via}] a 503 carrying a body is a failed poll, not an all-clear`, async () => {
    // #1227 — with no snapshot the endpoint serves 503 + `no status snapshot available`. `curl -sf`
    // is what turns that into the fail-silent path; without `-f` the body would be parsed as a poll
    // RESULT and every owed outage would settle. The stub honours `-f` exactly as curl does.
    const res = await run([CLAUDE_DOWN, httpError('no status snapshot available\n'), CLAUDE_DOWN], opts)
    assert.deepEqual(res.lines, ['🔴 Claude API is down (AIWatch)'])
  })

  test(`[${via}] a 2xx that is not 200 is a failed poll — an empty body here means all-clear`, async () => {
    // `-f` only rejects >=400, so a 204 (or an unfollowed 3xx) arrives as SUCCESS with an empty
    // body — and on this wire an empty body is the encoding of "everything is operational", which
    // settles every owed outage at once.
    const res = await run([CLAUDE_DOWN, httpStatus(204, ''), CLAUDE_DOWN], opts)
    assert.deepEqual(res.lines, ['🔴 Claude API is down (AIWatch)'])
  })

  // ── #1238: the transitions an unreadable source introduces ──────────────────────────────────
  //
  // The monitor's whole vocabulary is a claim about a service: 🔴 asserts an outage, ✅ asserts it
  // ended. `unknown` supports NEITHER, so every case below is about staying quiet without losing
  // the debt owed to an outage that was already announced.

  test(`[${via}] an unreadable source is never announced as an outage`, async () => {
    const res = await run([CLAUDE_UNKNOWN, CLAUDE_UNKNOWN], opts)
    assert.deepEqual(res.lines, [])
  })

  test(`[${via}] down → unknown does NOT emit a recovery — the source went dark, the outage did not end`, async () => {
    // The #1238 defect. A developer whose requests are still failing must not be told it recovered,
    // A provider's status page can fall over mid-outage.
    const res = await run([CLAUDE_DOWN, CLAUDE_UNKNOWN, CLAUDE_UNKNOWN], opts)
    assert.deepEqual(res.lines, ['🔴 Claude API is down (AIWatch)'])
  })

  test(`[${via}] unknown → operational after an owed outage still emits the recovery`, async () => {
    // The debt survives the blind spell: once the source is readable again and the service is gone
    // from the list, the ✅ that was owed since the 🔴 is finally paid.
    const res = await run([CLAUDE_DOWN, CLAUDE_UNKNOWN, ALL_CLEAR], opts)
    assert.deepEqual(res.lines, [
      '🔴 Claude API is down (AIWatch)',
      '✅ Claude API has recovered (AIWatch)',
    ])
  })

  test(`[${via}] TWO owed services go unreadable together, in non-alphabetical wire order`, async () => {
    // The single-service cases above cannot see an unsorted `$unk`: `sort` on one line is a no-op.
    // With two, dropping it silently drops one name from `owed ∩ unk`, and that service's ✅ NEVER
    // fires — the developer is left believing it is still down, permanently. The wire order here is
    // deliberately reverse-alphabetical because `renderStatuslineDownList` emits in cache order,
    // which is not sorted.
    const res = await run([
      downList([['down', 'OpenAI API'], ['down', 'Claude API']]),
      downList([['unknown', 'OpenAI API'], ['unknown', 'Claude API']]),
      ALL_CLEAR,
    ], opts)
    assert.deepEqual(res.lines, [
      '🔴 Claude API is down (AIWatch)',
      '🔴 OpenAI API is down (AIWatch)',
      '✅ Claude API has recovered (AIWatch)',
      '✅ OpenAI API has recovered (AIWatch)',
    ])
  })

  test(`[${via}] operational → unknown → operational emits nothing at all`, async () => {
    // Nothing was ever owed, so there is no recovery to pay — the bogus ✅ this case used to fire.
    const res = await run([ALL_CLEAR, CLAUDE_UNKNOWN, ALL_CLEAR], opts)
    assert.deepEqual(res.lines, [])
  })

  test(`[${via}] down → unknown → down is not re-announced — "is down" stays the last word`, async () => {
    // #1233's third defect, from the other side: the run of lines a developer sees must never end
    // on a not-an-outage line while the outage is still confirmed and ongoing.
    const res = await run([CLAUDE_DOWN, CLAUDE_UNKNOWN, CLAUDE_DOWN], opts)
    assert.deepEqual(res.lines, ['🔴 Claude API is down (AIWatch)'])
  })

  test(`[${via}] one poll carrying both an outage and an unreadable source reports only the outage`, async () => {
    const res = await run([downList([['unknown', 'Claude API'], ['down', 'OpenAI API']])], opts)
    assert.deepEqual(res.lines, ['🔴 OpenAI API is down (AIWatch)'])
  })

  test(`[${via}] a name listed BOTH unreadable and affected is never announced as "is unknown"`, async () => {
    // The status lookup scans the raw body, so without repeating the `!= "unknown"` filter it takes
    // whichever row comes first and can print `🔴 Claude API is unknown` — the false-outage-off-an-
    // unread-source claim this issue exists to delete. Unreachable from today's renderer (names are
    // unique), which is exactly why nothing else would catch it.
    const res = await run([downList([['unknown', 'Claude API'], ['down', 'Claude API']])], opts)
    assert.deepEqual(res.lines, ['🔴 Claude API is down (AIWatch)'])
  })

  test(`[${via}] an unrecognised status word is announced, and never discards the poll`, async () => {
    // The failure mode a vocabulary whitelist produced during #1233: one unknown-to-the-script word
    // silenced every service. Only the literal `unknown` is special; anything else is an outage.
    // The wire order is reverse-alphabetical ON PURPOSE — it is what pins the `sort` on `$aff`.
    const res = await run([downList([['maintenance', 'Cohere API'], ['down', 'Claude API']])], opts)
    assert.deepEqual(res.lines, [
      '🔴 Claude API is down (AIWatch)',
      '🔴 Cohere API is maintenance (AIWatch)',
    ])
  })

  test(`[${via}] the emitted order is the script's own collation, not the environment's`, async () => {
    // `sort` and `comm` both read the locale, and the script pins it to C. Without that export the
    // run inherits the harness's deliberately hostile `LANG=en_US.UTF-8`, under which these two
    // names swap: C gives `Zeta API` first (uppercase sorts before lowercase by codepoint),
    // en_US.UTF-8 gives `alpha API` first. Every other fixture in this file is same-case ASCII and
    // therefore collates identically under both — deleting the export was free until this test.
    const res = await run([downList([['down', 'alpha API'], ['down', 'Zeta API']])], opts)
    assert.deepEqual(res.lines, [
      '🔴 Zeta API is down (AIWatch)',
      '🔴 alpha API is down (AIWatch)',
    ])
  })

  // ── Bodies that are not what they look like ─────────────────────────────────────────────────

  test(`[${via}] a row that lost its tab rejects the WHOLE poll — a dropped row reads as recovered`, async () => {
    // Filtering the malformed row out instead would settle OpenAI's debt off a truncated body.
    const res = await run([
      downList([['down', 'Claude API'], ['down', 'OpenAI API']]),
      'down\tClaude API\ndow',
      downList([['down', 'Claude API'], ['down', 'OpenAI API']]),
    ], opts)
    assert.deepEqual(res.lines, [
      '🔴 Claude API is down (AIWatch)',
      '🔴 OpenAI API is down (AIWatch)',
    ])
  })

  // A field-count check does not catch these: both rows HAVE two fields, one of which is empty.
  // Without `$1 == "" || $2 == ""` the row is accepted and a real service's debt is settled off a
  // body that lost it.
  // The leading-tab row names a service NOT already owed: were the row merely skipped instead of
  // rejecting the body, Claude would go absent (a ✅ off a truncated body) — but were it ACCEPTED,
  // the only visible difference is a second service appearing, so the fixture has to introduce one.
  for (const [label, row] of [['a leading tab', '\tOpenAI API'], ['a trailing tab', 'down\t']]) {
    test(`[${via}] ${label} empties a field and rejects the whole poll`, async () => {
      const res = await run([CLAUDE_DOWN, row, CLAUDE_DOWN], opts)
      assert.deepEqual(res.lines, ['🔴 Claude API is down (AIWatch)'])
    })
  }

  test(`[${via}] a TMPDIR containing a backslash does not silence the monitor`, async () => {
    // The splitter's OUTPUT PATHS go through `ENVIRON` for the same reason the name lookup does.
    // Through `awk -v`, BWK awk and gawk expand the escape, the output file cannot be opened, awk
    // exits 2 and the poll returns early — every poll, so the monitor never speaks again while
    // still polling. mawk keeps the backslash and works, which is why one awk cannot show this.
    const res = await run([CLAUDE_DOWN], { ...opts, backslashTmp: true })
    assert.deepEqual(res.lines, ['🔴 Claude API is down (AIWatch)'])
  })

  test(`[${via}] a name carrying a backslash keeps its severity`, async () => {
    // The severity lookup passes the name through `ENVIRON`, not `awk -v`: implementations disagree
    // about escape expansion in a `-v` value (verified — BWK awk and gawk eat the `\`, mawk keeps
    // it), so an assertion about that outcome is red on whichever awk the reader has. This suite
    // runs on ONE awk, so it cannot see that difference; `ENVIRON` is what removes it.
    const res = await run([downList([['down', 'Claude\\API']])], opts)
    assert.deepEqual(res.lines, ['🔴 Claude\\API is down (AIWatch)'])
  })

  test(`[${via}] a row with a THIRD field rejects the poll — a tab in a name truncates it`, async () => {
    // A field count that only rejects too FEW lets `down\tClaude\tAPI` through, announcing a
    // `🔴 Claude` that does not exist and settling `Claude API`'s debt with a ✅ while it is still
    // down. The producer folds this shape out of a name, but the monitor does not get to assume
    // the body came from it.
    const res = await run([CLAUDE_DOWN, 'down\tClaude\tAPI', CLAUDE_DOWN], opts)
    assert.deepEqual(res.lines, ['🔴 Claude API is down (AIWatch)'])
  })

  test(`[${via}] a whitespace-only body is unreadable, not an all-clear`, async () => {
    // A lone tab IS a two-field row with both fields empty. A blank-line rule that treats it as
    // whitespace skips it before the field guard can reject it, leaving zero rows — which on this
    // wire is the encoding of "everything is operational", settling every owed outage.
    const res = await run([CLAUDE_DOWN, '\t', '   ', CLAUDE_DOWN], opts)
    assert.deepEqual(res.lines, ['🔴 Claude API is down (AIWatch)'])
  })

  test(`[${via}] a CRLF body still names the service`, async () => {
    // With the `\r` left on, the notification renders as " is down (AIWatch)" — a line naming no
    // service at all, because the terminal returns the cursor mid-line.
    const res = await run(['down\tClaude API\r\ndegraded\tOpenAI API\r'], opts)
    assert.deepEqual(res.lines, [
      '🔴 Claude API is down (AIWatch)',
      '🔴 OpenAI API is degraded (AIWatch)',
    ])
  })

  test(`[${via}] a duplicated row is announced once, not once per poll forever`, async () => {
    const res = await run([
      'down\tClaude API\ndown\tClaude API',
      'down\tClaude API\ndown\tClaude API',
      'down\tClaude API\ndown\tClaude API',
    ], opts)
    assert.deepEqual(res.lines, ['🔴 Claude API is down (AIWatch)'])
  })

  // ── Termination ─────────────────────────────────────────────────────────────────────────────

  test(`[${via}] SIGTERM ends the process at a LONG poll interval, not just a fast one`, async () => {
    // Two separate bugs live here. (1) A `trap` handler that returns RESUMES the loop in POSIX sh.
    // (2) `sleep` as a FOREGROUND child defers the pending handler until it finishes, so a SIGTERM
    // would be answered up to a whole interval late. A fast interval hides (2) completely, so this
    // case uses one long enough that only a promptly-answered signal can pass it.
    // Signalled MID-RUN, during a 30s sleep. A deferred handler cannot answer inside the harness's
    // deadline, so the run would end on a SIGKILL — `exitCode` null, `exitSignal` SIGKILL, temp
    // files left behind. Only a promptly-answered TERM produces the trap's own 143.
    const res = await runMonitor([ALL_CLEAR], {
      ...opts,
      pollSeconds: '30',
      // The delay lands the signal inside the 30s `sleep`, which is the only state where a
      // foreground one would defer the handler. Without it the signal arrives during the poll body,
      // a fast command finishes, and the trap runs promptly even in the broken form.
      midRunSignal: { afterPolls: 1, signal: 'SIGTERM', delayMs: 400 },
    })
    expectQuiet(res)
    assert.equal(res.exitCode, 143, `expected the TERM trap's own exit code (signal: ${res.exitSignal})`)
    assert.deepEqual(res.leakedTempFiles, [], 'the EXIT trap did not run, so the state files leaked')
  })

  test(`[${via}] SIGINT ends the process the same way`, async () => {
    const res = await runMonitor([ALL_CLEAR], {
      ...opts,
      pollSeconds: '30',
      midRunSignal: { afterPolls: 1, signal: 'SIGINT', delayMs: 400 },
    })
    expectQuiet(res)
    assert.equal(res.exitCode, 130, `expected the INT trap's own exit code (signal: ${res.exitSignal})`)
    assert.deepEqual(res.leakedTempFiles, [])
  })

  test(`[${via}] SIGHUP ends the process too — an untrapped one skips the EXIT trap entirely`, async () => {
    const res = await runMonitor([ALL_CLEAR], {
      ...opts,
      pollSeconds: '30',
      midRunSignal: { afterPolls: 1, signal: 'SIGHUP', delayMs: 400 },
    })
    expectQuiet(res)
    assert.equal(res.exitCode, 129, `expected the HUP trap's own exit code (signal: ${res.exitSignal})`)
    assert.deepEqual(res.leakedTempFiles, [])
  })

  test(`[${via}] the host closing our stdout does not leak the temp files`, async () => {
    // stdout is a pipe to the plugin host. If the host goes away without signalling us first, the
    // next `printf` raises SIGPIPE — and an UNTRAPPED fatal signal skips the EXIT trap entirely on
    // dash, which is `/bin/sh` on Linux, orphaning all eight temp files per session.
    const res = await runMonitor([CLAUDE_DOWN, ALL_CLEAR, CLAUDE_DOWN, ALL_CLEAR], {
      ...opts,
      closeStdoutAfter: 1,
    })
    // Also the census: no name of ours may sit allocated-but-unlinked between polls, or another
    // user in a shared /tmp can occupy it with a symlink that `sort -o` then writes through.
    assert.deepEqual(res.leakedTempFiles, [])
    // The code as well as the cleanup: `trap cleanup PIPE` would also leave no files, and would not
    // stop the loop. 141 = 128 + SIGPIPE. (`expectQuiet` is deliberately not applied — the failing
    // `printf` legitimately writes one broken-pipe line to stderr.)
    assert.equal(res.exitCode, 141)
  })

  test(`[${via}] the script's temp files really are under the observed directory`, async () => {
    // The counterpart to the `leakedTempFiles: []` assertions, which are guards whose DEFAULT
    // is passing: an empty list also means "the script never wrote here", which is what a bare
    // `mktemp` produces on BSD (it ignores TMPDIR without a template). SIGKILL cannot run the EXIT
    // trap, so a correctly-contained run MUST leave files behind here.
    const res = await runMonitor([ALL_CLEAR], { ...opts, stopSignal: 'SIGKILL' })
    assert.ok(
      res.leakedTempFiles.length > 0,
      'a SIGKILLed run left nothing in the observed temp dir — the state files are landing somewhere else, ' +
        'which would make every "leaves nothing behind" assertion vacuous',
    )
    expectQuiet(res)
  })

  test(`[${via}] a tmp reaper taking the state file re-announces rather than going silent forever`, async () => {
    // `owed` is the only cross-poll state and it lives in TMPDIR, which the OS collects from on a
    // long-lived session. Without recreating it, every later `comm` fails, the poll returns early,
    // and the monitor never speaks again — a failure with no symptom at all. Re-announcing the
    // outage is the honest direction: noisy, but it tells the user something.
    const res = await run(Array(4).fill(CLAUDE_DOWN), { ...opts, reapState: { atPoll: 3 } })
    assert.deepEqual(res.lines, [
      '🔴 Claude API is down (AIWatch)',
      '🔴 Claude API is down (AIWatch)',
    ])
  })

  // ── A failing `comm` must cost at most one poll, never a debt ───────────────────────────────
  //
  // Both branches were unreachable until the harness could shadow `comm`, and both decide something
  // invisible in production: whether a failure skips the poll or half-commits it.
  test(`[${via}] a failing 🔴 comm skips the poll silently and re-announces on the next one`, async () => {
    // Call 2 of the run is poll 1's `comm -13`. Nothing has been printed or committed at that
    // point, so the whole poll is skipped and poll 2 announces normally — exactly once.
    const res = await run([CLAUDE_DOWN, CLAUDE_DOWN], { ...opts, failCommAt: 2 })
    assert.deepEqual(res.lines, ['🔴 Claude API is down (AIWatch)'])
  })

  test(`[${via}] a failing ✅ comm costs one poll, not the outage's record`, async () => {
    // Call 3 is poll 1's `comm -23` — the last fallible step before anything is printed. What this
    // pins is that BOTH sets are derived before the first `printf`: with the derives interleaved
    // with the printing, poll 1 announced its 🔴 and then returned without recording it, so poll 2
    // announced the same outage again.
    const res = await run([CLAUDE_DOWN, CLAUDE_DOWN, ALL_CLEAR], { ...opts, failCommAt: 3 })
    assert.deepEqual(res.lines, [
      '🔴 Claude API is down (AIWatch)',
      '✅ Claude API has recovered (AIWatch)',
    ])
  })

  test(`[${via}] a partial write of the owed set does not destroy the debt it holds`, async () => {
    // Call 8 is poll 2's `owed` commit. Written to a scratch file and renamed in, so a truncating
    // failure loses only the poll: `$owed` still holds Claude's debt and poll 3 pays it. Committed
    // in place, the same failure emptied `$owed` and the ✅ never came — the developer is left
    // believing the outage is ongoing, with no line ever contradicting it.
    // SIGTERM rather than the default SIGKILL, so the EXIT trap runs and `leakedTempFiles` means
    // something: a poll that fails at the commit must not leave its scratch file behind either.
    const res = await run([CLAUDE_DOWN, CLAUDE_DOWN, ALL_CLEAR], {
      ...opts,
      truncateSortAt: 8,
      stopSignal: 'SIGTERM',
    })
    assert.deepEqual(res.lines, [
      '🔴 Claude API is down (AIWatch)',
      '✅ Claude API has recovered (AIWatch)',
    ])
    assert.deepEqual(res.leakedTempFiles, [])
  })

  // An unusable AIWATCH_POLL_SECONDS makes `wait` return instantly and the loop poll as fast as the
  // machine allows. Two families, one member each: a non-numeric value, and zero — which the first
  // guard's `*[!0-9.]*` pattern lets through because `sleep 0` is a perfectly valid call. Six
  // fixtures and a signal 500ms in:
  // with the guard holding, poll 1 is followed by a 60s sleep, so at most one more poll is served.
  for (const bad of ['sixty', '0']) {
    test(`[${via}] AIWATCH_POLL_SECONDS=${JSON.stringify(bad)} falls back to the default instead of spinning`, async () => {
      const res = await runMonitor(Array(6).fill(CLAUDE_DOWN), {
        ...opts,
        pollSeconds: bad,
        midRunSignal: { afterPolls: 1, signal: 'SIGTERM', delayMs: 500 },
      })
      assert.ok(res.polls <= 2, `spun ${res.polls} polls in 500ms — the interval guard is not holding`)
      assert.deepEqual(res.lines, ['🔴 Claude API is down (AIWatch)'])
      expectQuiet(res)
    })
  }

  test(`[${via}] after SIGTERM the loop does not come back — no further polls, no further lines`, async () => {
    // The direct assertion that the handler did not simply return: give the run six fixtures, signal
    // after the second, and require that it never reached the rest. `stoppedCleanly` alone proves
    // the process died, not that it stopped WORKING at the signal.
    const res = await runMonitor(Array(6).fill(CLAUDE_DOWN), {
      ...opts,
      pollSeconds: '0.2',
      midRunSignal: { afterPolls: 2, signal: 'SIGTERM' },
    })
    expectQuiet(res)
    assert.ok(res.polls < 6, `kept polling after SIGTERM (served ${res.polls} of 6)`)
    assert.deepEqual(res.lines, ['🔴 Claude API is down (AIWatch)'])
    assert.deepEqual(res.leakedTempFiles, [])
  })
}

test('the monitor is executable — the plugin runner invokes the file directly', async () => {
  // No `shell` option: the harness spawns the path itself, so this fails if the exec bit or the
  // shebang is ever lost. `monitors.json` runs `"${CLAUDE_PLUGIN_ROOT}"/bin/aiwatch-monitor.sh`.
  const res = await run([CLAUDE_DOWN])
  assert.deepEqual(res.lines, ['🔴 Claude API is down (AIWatch)'])
})

test('the poll is a fail-closed GET of the down-list, with a timeout', async () => {
  // The stub ignores argv when serving, so nothing else in this file would notice these flags
  // changing. `-f` is what makes a non-2xx take the fail-silent path (#1227); without `--max-time`
  // a hung connection stalls the loop indefinitely; and a typo in the path would make the monitor
  // permanently silent while every behavioural test above still passed on the stub.
  const res = await run([ALL_CLEAR])
  const [argv] = res.requests
  assert.ok(argv.includes('-sf'), `expected -sf, got ${JSON.stringify(argv)}`)
  assert.equal(argv[argv.indexOf('--max-time') + 1], '2', `expected --max-time 2, got ${JSON.stringify(argv)}`)
  assert.ok(argv.includes('-L'), `expected -L so a redirecting self-host base still reaches the list, got ${JSON.stringify(argv)}`)
  assert.ok(
    argv.includes('http://aiwatch-monitor-harness.invalid/api/statusline/down'),
    `expected the down-list URL built from AIWATCH_BASE, got ${JSON.stringify(argv)}`,
  )
})
