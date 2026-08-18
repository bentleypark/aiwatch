#!/bin/sh
# AIWatch outage monitor (Claude Code plugin #920).
#
# Runs for the session lifetime and, on every poll, emits one explicit line per transition:
#   🔴 <name> is <status> (AIWatch)   — a service that just became affected, in the wire's own word
#   ✅ <name> has recovered (AIWatch)  — an announced outage that is over
# Every printed line becomes a Claude notification, so we emit only real transitions (never the
# unchanged set) — no spam, and each service is named explicitly. Fail-silent: a poll we cannot
# fetch OR cannot fully parse is skipped, keeping the last known state, so a blip never fabricates a
# recovery. NOTE: transitions are by service NAME, so a severity shift within "affected"
# (degraded→down) is not re-alerted — run /aiwatch for current severity.
#
# #1238 — the state kept between polls is `owed`: the services we have announced 🔴 for and still
# owe a ✅. It is NOT "the last poll's list", because leaving that list means two different things —
# the service recovered, or AIWatch stopped being able to READ its status source (`unknown`, #1233).
# Announcing the second as the first tells a developer whose requests are still failing that it is
# over, at the moment a provider's status page falls over mid-outage. So `unknown` keeps the debt
# open and says nothing: 🔴 and ✅ are both claims about a service, and an unread source supports
# neither. /aiwatch reports unreadable sources explicitly.
#
# Data source: /api/statusline/down — a parseable, UNCAPPED `status<TAB>name` list. Config (env):
# AIWATCH_BASE, AIWATCH_POLL_SECONDS (default 60). Behaviour is pinned by
# scripts/plugin-monitor.test.mjs, which drives this file.

BASE="${AIWATCH_BASE:-https://aiwatch-worker.p2c2kbf.workers.dev}"
INTERVAL="${AIWATCH_POLL_SECONDS:-60}"
URL="$BASE/api/statusline/down"

# A poll interval `sleep` rejects makes `wait` return instantly and the loop spin at full speed,
# with the diagnostic invisible because the plugin host shows only stdout. This is a documented,
# user-settable variable, so a typo has to fall back to the documented default.
case "$INTERVAL" in
  '' | '.' | *[!0-9.]* | *.*.*) INTERVAL=60 ;;
esac
# Zero is the worse half of the same failure and it does NOT announce itself: `sleep sixty` at least
# complains on stderr, while `sleep 0` SUCCEEDS and returns instantly, spinning with no trace at all.
case "$INTERVAL" in
  *[!0.]*) ;;
  *) INTERVAL=60 ;;
esac
# `sort` and `comm` both read the ambient locale, so pinning it makes their agreement about what
# "sorted" means a property of this script rather than of the user's environment.
LC_ALL=C
export LC_ALL

sleeppid=
cleanup() {
  # The backgrounded `sleep` would otherwise outlive us as an orphan for the rest of the interval.
  [ -n "$sleeppid" ] && kill "$sleeppid" 2>/dev/null
  rm -f "$owed" "$body" "$aff" "$unk" "$listed" "$carry" "$newly" "$gone" "$commit"
}
# Installed BEFORE the temp files exist: the names expand when it fires, so a failure of the
# 2nd/3rd/… `mktemp` still cleans up the ones already created.
trap cleanup EXIT
# A trap handler that RETURNS resumes the loop in POSIX sh — with the state files already gone. This
# is a session-lifetime process, so being terminated is its normal exit path, not an exception:
# these must exit rather than fall back into the `while`. HUP and PIPE are here because an untrapped
# fatal signal skips the EXIT trap entirely (dash does not paper over this the way bash does),
# leaking every temp file — and PIPE is reachable whenever the host stops reading our stdout.
trap 'exit 143' TERM
trap 'exit 130' INT
trap 'exit 129' HUP
trap 'exit 141' PIPE

# `owed` starts empty, so at startup every currently-affected service is reported as newly-down (and
# a healthy start emits nothing) — no separate "first run" flag needed. A recovery can't be
# fabricated at startup either (nothing is owed yet). The rest is per-poll scratch, allocated once
# so the trap has a fixed set to clean up:
#   body   — this poll's raw response      aff   — affected names this poll
#   unk    — unreadable-source names       listed — aff ∪ unk (everything the endpoint spoke about)
#   carry  — owed ∩ unk (debts we cannot settle yet)
#   newly  — the 🔴 set this poll        gone  — the ✅ set this poll
#   commit — allocated INSIDE `poll` (see there), never held across polls
# An explicit template, not a bare `mktemp`: BSD `mktemp` ignores TMPDIR without one (it uses the
# Darwin per-user temp dir), so the test harness could not contain these files. The name also makes
# a leaked file attributable to this script rather than an anonymous `tmp.XXXX`.
owed=$(mktemp "${TMPDIR:-/tmp}/aiwatch-monitor.XXXXXX") || exit 1
body=$(mktemp "${TMPDIR:-/tmp}/aiwatch-monitor.XXXXXX") || exit 1
aff=$(mktemp "${TMPDIR:-/tmp}/aiwatch-monitor.XXXXXX") || exit 1
unk=$(mktemp "${TMPDIR:-/tmp}/aiwatch-monitor.XXXXXX") || exit 1
listed=$(mktemp "${TMPDIR:-/tmp}/aiwatch-monitor.XXXXXX") || exit 1
carry=$(mktemp "${TMPDIR:-/tmp}/aiwatch-monitor.XXXXXX") || exit 1
newly=$(mktemp "${TMPDIR:-/tmp}/aiwatch-monitor.XXXXXX") || exit 1
gone=$(mktemp "${TMPDIR:-/tmp}/aiwatch-monitor.XXXXXX") || exit 1
: > "$owed"

# One poll. Returns 0 in every case — a skipped poll is not an error, it is the fail-silent path.
poll() {
  # `-o`/`-w` rather than a captured body: it keeps awk's input a FILE (so its exit status is the
  # command's, not a pipeline's) and makes the status code checkable. `-f` alone is not enough —
  # it fails on ≥400 only, so a 204 from a proxy would arrive as a successful EMPTY body,
  # which on this wire means "everything is operational" and settles every owed outage. `-L` follows
  # a redirect.
  code=$(curl -sf -L --max-time 2 -o "$body" -w '%{http_code}' "$URL" 2>/dev/null) || return 0
  [ "$code" = 200 ] || return 0
  # A tmp reaper can delete state out from under a long-lived session. Recreating it re-announces the
  # outages currently on the wire; a debt held for an UNREADABLE source is lost with the file, so that
  # service gets neither the 🔴 again nor its ✅. Without this, every later poll fails at `comm` and
  # the monitor is silent forever.
  [ -f "$owed" ] || : > "$owed" || return 0

  # ONE pass validates and splits, so the two can never disagree about what a row is — a validator
  # that skipped a shape the extractor accepted is how a line naming no service at all got printed.
  # A row we cannot read rejects the WHOLE body (`exit 1`): filtering it out instead would silently
  # DROP a service, and a dropped service is indistinguishable from a recovered one. `sub(/\r$/,"")`
  # first — a proxy that rewrites the body to CRLF would otherwise leave the `\r` inside the name,
  # and the notification renders as " is down (AIWatch)" with no service in it. Pre-truncated
  # because awk only opens an output file when it first writes to it, and a poll with no affected
  # services must leave an EMPTY `$aff`, not the previous poll's.
  : > "$aff" || return 0
  : > "$unk" || return 0
  AIW_AFF="$aff" AIW_UNK="$unk" awk -F'\t' '
      { sub(/\r$/, "") }
      /^$/ { next }
      NF != 2 || $1 == "" || $2 == "" { exit 1 }
      $1 == "unknown" { print $2 > (ENVIRON["AIW_UNK"]); next }
      { print $2 > (ENVIRON["AIW_AFF"]) }
    ' "$body" || return 0

  # `comm` needs sorted input, and a duplicated name would otherwise look new on every single poll.
  # `-o` rather than `>` so the shell does not truncate the file before `sort` has read it.
  sort -u -o "$aff" "$aff" || return 0
  sort -u -o "$unk" "$unk" || return 0
  sort -u -o "$listed" "$aff" "$unk" || return 0
  comm -12 "$owed" "$unk" > "$carry" || return 0

  # BOTH sets are derived before anything is printed. Everything above can fail without having said
  # a word; once a line is on stdout it cannot be taken back, and a failure that skipped the commit
  # would re-announce it next poll. Neither `comm` is a `… | while` pipeline, because a pipeline
  # reports only its LAST command's status and would swallow the failure entirely.
  #
  # 🔴 Newly affected = affected now, not already owed a recovery.
  # ✅ Recovered      = owed, and no longer listed at ALL. Absence from the endpoint is the only
  #                     evidence of health it publishes; an unreadable source is listed, so it keeps
  #                     its debt.
  comm -13 "$owed" "$aff" > "$newly" || return 0
  comm -23 "$owed" "$listed" > "$gone" || return 0
  # owed := affected ∪ (still owed and still unreadable). Written elsewhere and renamed in: `sort -o`
  # opens its output with O_TRUNC, so a write that fails partway (ENOSPC, EIO on TMPDIR) would leave
  # `$owed` truncated AND return non-zero — and `|| return 0` would read that as a skipped poll while
  # the debt it destroyed is gone for the rest of the session.
  #
  # Allocated here rather than with the others, because `mv` UNLINKS it. A name held for the session
  # is a name `mktemp` created with O_EXCL and never released; a name freed every poll is one another
  # user can occupy with a symlink before the next `sort -o` — which does follow one — in a shared
  # /tmp. Fresh per poll, so no name of ours is ever observable and free. The trailing `rm -f` is the
  # no-op after a successful `mv`, and what keeps a failed poll from leaving the file behind.
  commit=$(mktemp "${TMPDIR:-/tmp}/aiwatch-monitor.XXXXXX") || return 0
  sort -u -o "$commit" "$carry" "$aff" && mv -f "$commit" "$owed"
  rm -f "$commit"

  # The severity lookup repeats the `!= "unknown"` filter that built `$aff`: without it, a body
  # carrying both an `unknown` and an affected row for one name could print "is unknown" — the
  # false-outage-off-an-unread-source claim this whole file exists to delete. The name is passed
  # through the environment, not `-v`: awk implementations disagree about escape expansion in a `-v`
  # value (verified — BWK awk and gawk eat a `\`, mawk keeps it), while `ENVIRON` expands nothing.
  while IFS= read -r name; do
    [ -z "$name" ] && continue
    st=$(AIW_NAME="$name" awk -F'\t' '{ sub(/\r$/, "") } $1 != "unknown" && $2 == ENVIRON["AIW_NAME"] { print $1; exit }' "$body")
    printf '🔴 %s is %s (AIWatch)\n' "$name" "${st:-affected}"
  done < "$newly"

  while IFS= read -r name; do
    [ -z "$name" ] && continue
    printf '✅ %s has recovered (AIWatch)\n' "$name"
  done < "$gone"
}

while true; do
  poll
  # Backgrounded so a pending signal is acted on immediately. A FOREGROUND `sleep` defers the
  # pending handler until it finishes, so at the shipped 60s default a SIGTERM would be answered up
  # to a minute late. `>/dev/null` because a background child inherits this process's stdout, which
  # the plugin host reads as a pipe.
  sleep "$INTERVAL" >/dev/null &
  sleeppid=$!
  wait "$sleeppid"
  # Cleared so a signal arriving during the next poll cannot make `cleanup` kill a reaped — and by
  # then possibly recycled — PID.
  sleeppid=
done
