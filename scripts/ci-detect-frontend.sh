#!/usr/bin/env bash
# Decide whether a CI job's real work must run, from the files a push or PR changed.
#
# #1254 — this logic used to be copy-pasted into both gating jobs of test.yml, and its previous form
# answered "nothing changed" because its own command had failed:
#
#     DIFF=$(git diff --name-only HEAD~1 HEAD 2>/dev/null || echo "")
#
# `actions/checkout` defaults to fetch-depth 1, so `HEAD~1` did not exist on the push path. git
# failed, `2>/dev/null` discarded the message, `|| echo ""` turned the failure into an empty file
# list, nothing matched, and E2E and Build skipped on EVERY push to main while reporting green
# (12/12 sampled; commit 00e03c0 changed 11 files under src/).
#
# The rule: ONLY a diff we actually read may answer "false". Every other outcome — base unreachable,
# command failed, empty result, grep itself erroring — resolves to TRUE and annotates. Running the
# suite when we cannot tell costs minutes; skipping it is the defect.
#
# Usage: ci-detect-frontend.sh '<extended-regex>'
# Env: GITHUB_EVENT_NAME + GITHUB_OUTPUT (both set by the runner), PUSH_BASE (github.event.before).
set -euo pipefail

PATTERN=${1:?usage: ci-detect-frontend.sh <extended-regex>}

unknown() {
  echo "::error::$1 — running the full gate instead of guessing"
  echo "frontend=true" >> "$GITHUB_OUTPUT"
  exit 0   # 0, not 1: a failed step SKIPS the steps it gates, so failing here would answer the
}          # opposite of what this branch decided. Must stay the last thing this script does.

# One diff for both events. `actions/checkout` leaves HEAD at the pushed tip on a push, and at
# `refs/pull/N/merge` on a PR — whose first parent IS the base branch tip, so the same two-commit
# diff describes both. The push base comes from the event instead, because a push can carry more
# than one commit and `HEAD~1` would then read only the last of them while succeeding.
case "${GITHUB_EVENT_NAME:-}" in
  push)         BASE=${PUSH_BASE:-} ;;
  pull_request) BASE=$(git rev-parse HEAD^1) || unknown "the PR checkout has no first parent" ;;
  *)            unknown "unexpected event '${GITHUB_EVENT_NAME:-}'" ;;
esac

git cat-file -e "$BASE^{commit}" || unknown "base '$BASE' is not in this checkout"

# `-c core.quotePath=false`: git C-quotes a non-ASCII path by default, so `src/한글.js` arrives as
#   `"src/\355\225\234…"` and the leading quote defeats a `^src/` anchor — a diff we DID read
#   answering "no frontend change" about one. Zero such paths are tracked today; this is a
#   Korean-language repo and a public/ asset is how one lands.
# `--no-renames`: rename detection reports only the destination, so moving `src/Foo.jsx` to
#   `worker/src/Foo.ts` would hide that a source file was deleted.
DIFF=$(git -c core.quotePath=false diff --name-only --no-renames "$BASE" HEAD) \
  || unknown "git diff $BASE..HEAD failed"

# A successful command returning nothing is the same ambiguity one level down: an empty list tells
# us nothing either way, so it takes the conservative branch rather than reading as "idle".
[ -n "$DIFF" ] || unknown "the diff came back empty"

echo "$DIFF"

# No pipe into grep: `grep -q` exits on the first match, the upstream would die of SIGPIPE, and the
# `pipefail` above promotes that to the pipeline's status — so a MATCH would read as a failure and
# take the no-match branch, which is this very bug. A herestring has no upstream process to kill.
rc=0
grep -qE "$PATTERN" <<<"$DIFF" || rc=$?
# grep: 0 matched, 1 no match, anything else means grep FAILED. Only 1 may skip the gate —
# collapsing 2 into the no-match branch is how a broken pattern would read as "no frontend".
case $rc in
  0) echo "frontend=true"  >> "$GITHUB_OUTPUT" ;;
  1) echo "frontend=false" >> "$GITHUB_OUTPUT" ;;
  *) unknown "grep exited $rc" ;;
esac
