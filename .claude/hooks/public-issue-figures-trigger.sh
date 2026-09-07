#!/usr/bin/env bash
# PreToolUse(Bash) public-issue figures trigger — #1354.
#
# This repo is PUBLIC. Absolute adoption numbers — subscriber / browser / install counts, and any value
# a reader can divide into one — are operator-only and belong in the private `aiwatch-wiki` bundle. The
# leak path is not the two strategy trackers: it is ordinary measurement work, where the figure IS the
# acceptance criterion, so it arrives in an issue body or a verify-after comment as a matter of course.
#
# SOFT by construction, and it does NOT read the text it is firing about. Deciding from an issue body
# whether a number is an adoption figure means parsing unbounded, externally-shaped input to reach a
# verdict — the failure mode #1348 recorded, where every round patches one more hole. This fires on the
# COMMAND NAME alone and hands the judgement back, exactly as korean-copy-trigger.sh does with a path.
#
# Cost of that choice, stated plainly: most of what it fires on carries no figure at all. It is a nudge
# at the decision moment, not a filter — see docs/reference/workflow-hooks.md.
# Never blocks; any hook failure (missing jq, no command) exits 0.

set -u
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)" || exit 0
audit() { bash "${HOOK_DIR}/_audit.sh" "public-issue-figures" "$1" "$2" 2>/dev/null || true; }

command -v jq >/dev/null 2>&1 || exit 0
INPUT="$(cat 2>/dev/null)" || exit 0
CMD="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)" || exit 0
[ -z "$CMD" ] && exit 0

# The subcommands live in `public-issue-write-commands.txt` beside this script, read by both this hook
# and its test so neither restates the other. That file carries the caveats: the list is not complete,
# and matching is by name, never by flag — reading a flag out of the command is the same act as reading
# the body. The cost is a reminder on a bare `close`, which is the noise this set already accepts.
#
# A `--repo` pointing at another repository still fires: this reminds, it does not adjudicate.
LIST="${HOOK_DIR}/public-issue-write-commands.txt"
[ -r "$LIST" ] || exit 0
matched=""
while IFS= read -r sub || [ -n "$sub" ]; do
  case "$sub" in ''|'#'*) continue ;; esac
  case "$CMD" in *"$sub"*) matched=1; break ;; esac
done < "$LIST"
[ -z "$matched" ] && exit 0

msg="🔓 공개 이슈/PR에 씁니다 — 절대 채택 수치(구독자·브라우저·설치 수, 그리고 나눠서 그 수가 나오는 값)는 private \`aiwatch-wiki\`에 두고 여기엔 판정·필드명·비율만 남겨라 (#1354). 폴 카운트는 주기가 같은 이슈에 공개돼 있으면 그 자체가 채택 수치다."

audit "warn" "public-write"
# The audit line goes BEFORE the emission, and the emission degrades rather than going silent: a jq
# failure inside a command substitution yields an empty string that printf prints successfully, which
# would leave a `warn` in the log for a reminder nobody ever saw (korean-copy-trigger.sh's note).
esc="$(printf '%s' "$msg" | jq -Rs . 2>/dev/null)"
if [ -n "$esc" ] && [ "$esc" != "null" ]; then
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":%s}}\n' "$esc"
else
  safe="$(printf '%s' "$msg" | tr '\n"' '  ')"
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"%s"}}\n' "$safe"
fi
exit 0
