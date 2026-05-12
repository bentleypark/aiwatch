#!/usr/bin/env bash
# Stop gate — re-prompts when the assistant's final message ends with an
# auto-proceed nag. #415 Phase 1.
#
# The user has repeatedly asked not to end turns with "shall I proceed?" /
# "진행할까요?" style prompts (memory: feedback_no_push_next_step,
# feedback_no_merge_nag). A written rule clearly hasn't been enough. This hook
# reads the just-finished assistant message from the transcript, checks its
# closing line against a set of nag patterns, and — on a match — BLOCKS the stop
# with a reason, which makes the model produce a corrected message before the
# turn actually ends. `stop_hook_active` prevents an infinite loop (the re-fire
# after a block exits 0 without re-checking).
#
# Scope is deliberately narrow — only auto-proceed offers ("shall I merge?",
# "다음 작업 진행할까요?"), not every question. A genuine clarifying question
# ("which approach do you want?") does not match. False negatives are fine; the
# audit log will show whether the pattern set needs widening.
#
# Never blocks on a hook bug: missing jq, missing/unreadable transcript, parse
# failure -> exit 0 (allow the stop).

set -u
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)" || exit 0
audit() { bash "${HOOK_DIR}/_audit.sh" "stop-nag-gate" "$1" "$2" 2>/dev/null || true; }

command -v jq >/dev/null 2>&1 || exit 0
INPUT="$(cat 2>/dev/null)" || exit 0

# Re-fire after a block: do not re-check, just let the stop through (loop guard).
if [ "$(printf '%s' "$INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null)" = "true" ]; then
  exit 0
fi

TRANSCRIPT="$(printf '%s' "$INPUT" | jq -r '.transcript_path // ""' 2>/dev/null)"
if [ -z "$TRANSCRIPT" ] || [ ! -f "$TRANSCRIPT" ]; then
  audit "skip" "no transcript_path"
  exit 0
fi

# Last text-bearing assistant message. tail a generous window (one turn's worth
# of messages), parse each line defensively (fromjson? skips malformed lines),
# flatten each assistant message's text blocks to one line, keep the last
# non-empty one. join(" ") (not "\n") so the per-line filtering below holds.
LAST="$(tail -n 400 "$TRANSCRIPT" 2>/dev/null \
  | jq -rR 'fromjson? | select(.type=="assistant") | (.message.content // []) | map(select(.type=="text") | .text) | join(" ")' 2>/dev/null \
  | grep -v '^[[:space:]]*$' | tail -n 1)"
if [ -z "$LAST" ]; then
  audit "skip" "no assistant text in transcript tail"
  exit 0
fi

# The closing fragment is where nags live — last ~200 chars.
TAIL_FRAG="$(printf '%s' "$LAST" | tail -c 200)"

# Nag patterns (case-insensitive). Korean auto-proceed offers + English ones.
# Anchored loosely to the end / to action verbs to avoid matching real questions.
nag=""
if printf '%s' "$TAIL_FRAG" | grep -Eiq '(진행|머지|배포|커밋|푸시|push)[^.?!]{0,25}(할까요|해도\s*될까요|하시겠어요|드릴까요|진행할지)' ; then
  nag="ko-auto-proceed"
elif printf '%s' "$TAIL_FRAG" | grep -Eiq '다음(으로|에)?\s*[^.?!]{0,20}(진행|작업)할까요' ; then
  nag="ko-next-step"
elif printf '%s' "$TAIL_FRAG" | grep -Eiq 'shall I (proceed|merge|continue|push|deploy|create the pr|go ahead)' ; then
  nag="en-shall-i"
elif printf '%s' "$TAIL_FRAG" | grep -Eiq 'should I (proceed|merge|go ahead|continue)' ; then
  nag="en-should-i"
elif printf '%s' "$TAIL_FRAG" | grep -Eiq '(want me to|ready to) (proceed|merge|continue|push|deploy)\??\s*$' ; then
  nag="en-want-me-to"
fi

if [ -z "$nag" ]; then
  audit "clean" ""
  exit 0
fi

# Matched fragment for the audit note (truncate hard).
frag_note="$(printf '%s' "$TAIL_FRAG" | tr '\n"\\' '   ' | tail -c 120)"
audit "block" "${nag}: …${frag_note}"

# Block the stop, re-prompt the model to revise. (Hard by design — a soft
# warning would be useless here: the nag has already been written; only a
# re-prompt removes it. The git-mutation gate is soft; this one is not.)
cat <<'JSON'
{"decision":"block","reason":"Your final message ends with an auto-proceed nag (a \"shall I proceed / merge / continue?\" — or 진행할까요? / 머지할까요? — style prompt). The user has asked repeatedly NOT to end turns this way (memory: feedback_no_push_next_step, feedback_no_merge_nag). Re-send your closing without the nag: state the result, note what changed and (only if genuinely needed) one self-contained next step, then stop — let the user drive the pace. Do not append a question that pushes the work forward."}
JSON
exit 0
