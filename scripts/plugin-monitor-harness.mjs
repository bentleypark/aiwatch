// #1238 — test harness for `plugin/aiwatch/bin/aiwatch-monitor.sh`.
//
// The monitor is a session-lifetime `sh` loop that, until this harness, had no automated test of any
// kind: `test:scripts` covers `scripts/*.mjs`, nothing covered `plugin/**/*.sh`, and `sh -n` only
// parses.
//
// Shape: stub `curl` on PATH serving one fixture body per poll, run the REAL script, assert stdout.
// Nothing inside the script is mocked, so what runs is what ships.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
export const MONITOR_SH = join(HERE, '..', 'plugin', 'aiwatch', 'bin', 'aiwatch-monitor.sh')

// Long enough to absorb a contended CI runner, short enough that a script broken into never polling
// still reports rather than hanging.
const POLL_DEADLINE_MS = 20_000

// Serves fixture N on the Nth invocation, and records the argv it was called with so a test can pin
// the flags the monitor's correctness depends on. It emulates the curl surface the monitor actually
// uses — `-o <file>` writes the body there, `-w '%{http_code}'` prints the status to stdout, and
// `-f` turns a >=400 into a failure with NO body, which is what makes #1227's 503 take the
// fail-silent path. Fixture kinds:
//   <body>            — a 200 carrying that body
//   httpStatus(c, b)  — status `c` carrying body `b` (the >=400 ones are what `-f` must reject)
//   (missing)         — the poll list is exhausted, or the test asked for a network failure; exit 22
const CURL_STUB = `#!/bin/sh
root=$(dirname "$0")/..
out=
wants_code=
prev=
for a in "$@"; do
  printf '%s\\n' "$a" >> "$root/argv"
  [ "$prev" = "-o" ] && out=$a
  case "$a" in -w) wants_code=1 ;; esac
  prev=$a
done
printf -- '--\\n' >> "$root/argv"
n=$(cat "$root/count")
n=$((n + 1))
# Reap the SCRIPT's state (see runMonitor's reapState) from inside the poll it names, so the test
# never has to race a wall clock against the poll body.
[ -n "$REAP_AT" ] && [ "$n" = "$REAP_AT" ] && rm -f "$TMPDIR"/aiwatch-monitor.*
# via a rename: a plain redirect truncates first, and a reader catching that window sees 0 polls —
# which reads as "timed out" in one place and satisfies a "stopped early" assertion in another.
printf '%s' "$n" > "$root/count.tmp"
mv "$root/count.tmp" "$root/count"
bodyf="$root/polls/$n"
[ -f "$bodyf" ] || exit 22
code=200
[ -f "$bodyf.status" ] && code=$(cat "$bodyf.status")
case "$code" in
  4*|5*) case " $* " in *\\ -sf\\ *|*\\ -f\\ *) exit 22 ;; esac ;;
esac
if [ -n "$out" ]; then cat "$bodyf" > "$out"; else cat "$bodyf"; fi
[ -n "$wants_code" ] && printf '%s' "$code"
exit 0
`

/** Build a down-list body: rows of `[status, name]` → the `status<TAB>name` lines the endpoint
 *  serves (`renderStatuslineDownList`). `[]` is the all-clear (an empty 200 body). */
export function downList(rows) {
  return rows.map(([status, name]) => `${status}\t${name}`).join('\n')
}

/** A poll answering with an explicit HTTP status and body. See CURL_STUB. */
export const httpStatus = (status, body) => ({ status, body })
/** The #1227 shape: a 503 carrying `no status snapshot available`. */
export const httpError = (body) => httpStatus(503, body)

/** Shells to run the script under: `/bin/sh` is bash-in-POSIX-mode on macOS and dash on CI, and the
 *  two disagree about plenty (`local`, `echo`, arithmetic, `read` semantics). Running each shell
 *  installed here makes that divergence a failure on the author's machine rather than on someone
 *  else's.
 *
 *  It does NOT vary the UTILITIES the script calls (awk, sort, comm, curl): all three shells here
 *  reach the same binaries, so a BSD-only or GNU-only assumption is caught only by the suite running
 *  on macOS locally AND on Linux in CI, not by this matrix.
 *
 *  This looks for exactly `/bin/sh`, `dash` and `bash` — not "every shell on the machine". */
export function availableShells() {
  const shells = []
  const seen = new Set()
  for (const name of ['/bin/sh', 'dash', 'bash']) {
    const found = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' })
    if (found.status !== 0) continue
    // Deduped by RESOLVED binary, so CI (where `/bin/sh` is dash) runs two shells instead of three.
    // Safe on macOS in the other direction: `/bin/sh` there is its own binary that runs bash in
    // POSIX mode, so it does not collide with `bash` and the sh-mode coverage is kept.
    let real = found.stdout.trim()
    try { real = realpathSync(real) } catch { /* keep the unresolved path — worst case, no dedupe */ }
    if (seen.has(real)) continue
    seen.add(real)
    shells.push([name])
  }
  return shells
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Drive the monitor through a fixed sequence of polls and return everything it said.
 *
 * @param polls  one entry per poll, in order: a string body (curl succeeds and serves it),
 *               `httpError(body)` (a non-2xx carrying a body), or `null` (curl fails outright).
 * @param opts.shell        argv of the shell to run it under (default: execute the file directly,
 *                          via its shebang — which also pins the exec bit the plugin runner needs).
 * @param opts.pollSeconds  `AIWATCH_POLL_SECONDS` for the run.
 * @param opts.stopSignal   signal used to stop the run (default SIGKILL). SIGTERM is the monitor's
 *                          REAL exit path — this is a session-lifetime process the host terminates.
 * @param opts.midRunSignal `{ afterPolls, signal, delayMs }` — deliver a signal partway through and KEEP
 *                          WATCHING, so a test can assert what the monitor does AFTER it. A
 *                          stop-then-inspect run cannot answer that: a `trap` handler that returns
 *                          resumes the loop rather than ending the process, and the difference is
 *                          only visible in what happens next. `timedOut` is true for such a run by
 *                          construction (the process is gone before the fixtures are), so read
 *                          `polls`/`lines` instead of asserting on it.
 *                          `delayMs` waits that long AFTER the poll count is reached before
 *                          signalling — necessary to land the signal inside the `sleep` rather than
 *                          inside the poll body, which is the only state where a foreground `sleep`
 *                          would defer the handler.
 * @param opts.reapState  `{ atPoll }` — delete the script's temp files as the stub serves that poll,
 *                          reproducing a tmp reaper collecting them out from under a long-lived
 *                          session (the monitor's only cross-poll state lives there). The stub does
 *                          the deletion so it lands at a fixed point in the poll body, rather than
 *                          racing the poll body from here.
 * @param opts.closeStdoutAfter  destroy the read end of the child's stdout once that many polls have
 *                          been served, reproducing the plugin host going away while the monitor is
 *                          still running. The next `printf` then raises SIGPIPE. Nothing after this
 *                          point can be read from `stdout`/`lines`; read `leakedTempFiles` instead.
 * @param opts.backslashTmp  put a literal `\\` in the TMPDIR handed to the script. The script's temp
 *                          paths derive from it, so this is what makes an `awk -v path=…` mangle the
 *                          value — the reason those paths go through `ENVIRON` instead.
 * @param opts.truncateSortAt 1-based index of a `sort` call, across the whole run, that should
 *                          truncate its `-o` target and THEN fail. Four `sort` calls per poll, in
 *                          order: `$aff`, `$unk`, `$listed`, and the `owed` commit.
 * @param opts.failCommAt   1-based index of a `comm` call that should fail (silently, exit 1) across
 *                          the whole run. Poll 1 calls `comm` three times in order: `-12` (carry),
 *                          `-13` (the 🔴 set), `-23` (the ✅ set).
 */
export async function runMonitor(polls, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aiwatch-monitor-'))
  try {
    mkdirSync(join(dir, 'bin'))
    mkdirSync(join(dir, 'polls'))
    // The script's own `mktemp` files land here rather than in the real TMPDIR, so (a) a SIGKILLed
    // run cannot leak them — the EXIT trap never runs — and (b) "a clean exit leaves no state
    // behind" becomes assertable.
    const scriptTmp = join(dir, opts.backslashTmp ? 'script\\tmp' : 'scripttmp')
    mkdirSync(scriptTmp)
    writeFileSync(join(dir, 'count'), '0')
    writeFileSync(join(dir, 'argv'), '')
    polls.forEach((entry, i) => {
      const at = join(dir, 'polls', String(i + 1))
      if (typeof entry === 'string') writeFileSync(at, entry)
      else if (entry && typeof entry.status === 'number' && typeof entry.body === 'string') {
        writeFileSync(at, entry.body)
        writeFileSync(`${at}.status`, String(entry.status))
      } else if (entry !== null && entry !== undefined) {
        throw new TypeError(`poll ${i + 1}: expected a body string, httpStatus(...), or null — got ${JSON.stringify(entry)}`)
      }
    })
    const curl = join(dir, 'bin', 'curl')
    writeFileSync(curl, CURL_STUB)
    chmodSync(curl, 0o755)
    // `failCommAt` shadows `comm` the same way `curl` is shadowed — the script calls both
    // unqualified and this dir is first on PATH. It is the only way to reach the `|| return 0` on
    // either `comm`, and those two branches decide whether a failure loses a debt or just skips a
    // poll. The stub exits SILENTLY so `expectQuiet` still means something.
    // `truncateSortAt` models a partial write: `sort -o` opens with O_TRUNC, so a failure PARTWAY
    // leaves the target empty AND reports non-zero. A clean failure is harmless; only this shape
    // can destroy state the script is committing.
    if (opts.truncateSortAt) {
      const sort = join(dir, 'bin', 'sort')
      writeFileSync(sort, `#!/bin/sh
c="$(dirname "$0")/../sortcount"
n=$(cat "$c" 2>/dev/null || echo 0)
n=$((n + 1))
printf '%s' "$n" > "$c"
if [ "$n" = "${opts.truncateSortAt}" ]; then
  prev=
  for a in "$@"; do [ "$prev" = "-o" ] && : > "$a"; prev=$a; done
  exit 1
fi
exec /usr/bin/sort "$@"
`)
      chmodSync(sort, 0o755)
    }
    if (opts.failCommAt) {
      const comm = join(dir, 'bin', 'comm')
      writeFileSync(comm, `#!/bin/sh
c="$(dirname "$0")/../commcount"
n=$(cat "$c" 2>/dev/null || echo 0)
n=$((n + 1))
printf '%s' "$n" > "$c"
[ "$n" = "${opts.failCommAt}" ] && exit 1
exec /usr/bin/comm "$@"
`)
      chmodSync(comm, 0o755)
    }

    const argv = opts.shell ? [...opts.shell.slice(1), MONITOR_SH] : []
    const child = spawn(opts.shell ? opts.shell[0] : MONITOR_SH, argv, {
      env: {
        ...process.env,
        PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
        TMPDIR: scriptTmp,
        // Fractional so a multi-poll case costs milliseconds, not seconds.
        AIWATCH_POLL_SECONDS: opts.pollSeconds ?? '0.02',
        AIWATCH_BASE: 'http://aiwatch-monitor-harness.invalid',
        REAP_AT: opts.reapState ? String(opts.reapState.atPoll) : '',
        // A HOSTILE ambient locale, so the script's own `export LC_ALL=C` is the thing deciding the
        // ordering rather than the runner's environment agreeing with it by luck. `LANG`, never
        // `LC_ALL` — the script's export must win, and that is exactly what is under test.
        // Honest limitation: on an image carrying only `C.UTF-8` this collates identically to `C`,
        // and the case-crossing test in plugin-monitor.test.mjs is then vacuous rather than red.
        LANG: 'en_US.UTF-8',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d) => { stderr += d })
    // `close` rather than `exit`: `exit` can fire before the pipes drain, and every #1238 assertion
    // is about ABSENCE — a dropped tail would turn a regression that emits a bogus ✅ into a pass.
    const closed = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })))

    // Wait for the poll AFTER the last fixture to be requested. That request can only happen once
    // poll N's transition lines have been printed and flushed, so it is the completion signal —
    // no output-quiescence guessing.
    // A process that is already gone will never serve another poll, so stop waiting for it — that
    // turns a 20s deadline into an immediate result both for a mid-run signal and for a crash.
    let dead = false
    closed.then(() => { dead = true })

    const count = () => Number(readFileSync(join(dir, 'count'), 'utf8') || 0)
    const deadline = Date.now() + POLL_DEADLINE_MS
    let pending = opts.midRunSignal ?? null
    let closeAt = opts.closeStdoutAfter ?? null
    while (!dead && count() < polls.length + 1 && Date.now() < deadline) {
      if (closeAt !== null && count() >= closeAt) {
        closeAt = null
        child.stdout.destroy()
      }
      if (pending && count() >= pending.afterPolls) {
        const { signal, delayMs } = pending
        pending = null
        if (delayMs) await sleep(delayMs)
        child.kill(signal)
      }
      await sleep(5)
    }
    const served = count()

    child.kill(opts.stopSignal ?? 'SIGKILL')
    const exit = await Promise.race([closed, sleep(400).then(() => null)])
    if (!exit) {
      child.kill('SIGKILL')
      await closed
    }
    return {
      stdout,
      stderr,
      lines: stdout.split('\n').filter((l) => l !== ''),
      polls: Math.max(0, served - 1),
      // The run ended on the deadline, not on the fixture list. Every assertion below is then
      // meaningless in the SAME direction — a monitor that never started emits no lines, which is
      // what most of these tests expect — so callers must check this before reading `lines`.
      timedOut: served < polls.length + 1,
      // false = the process was still alive a grace period after `stopSignal` and had to be
      // SIGKILLed. `exitCode`/`exitSignal` say HOW it went, which is what pins the trap's own codes.
      stoppedCleanly: exit !== null,
      exitCode: exit?.code ?? null,
      exitSignal: exit?.signal ?? null,
      // Temp files the SCRIPT created and did not clean up. Non-empty after a signalled stop means
      // the EXIT trap did not run.
      leakedTempFiles: readdirSync(scriptTmp),
      // One entry per curl invocation, each the argv it received.
      requests: readFileSync(join(dir, 'argv'), 'utf8')
        .split('--\n')
        .filter((b) => b !== '')
        .map((b) => b.split('\n').filter((a) => a !== '')),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
