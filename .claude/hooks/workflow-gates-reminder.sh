#!/usr/bin/env bash
# UserPromptSubmit gate — re-injects the non-negotiable workflow gates at the top
# of EVERY turn (#415, 2026-05-19 coverage-gap fix).
#
# Why this exists: CLAUDE.md + the memory notes are PASSIVE context — loaded once
# at session start, but nothing re-surfaces them at the decision moment, and
# compaction drops methodology (only "what to do" survives the summary). Under
# execution momentum the gates get reasoned around. UserPromptSubmit is the only
# hook surface that fires every turn AND survives compaction, so it keeps the
# gates fresh. It canNOT enforce (UserPromptSubmit cannot block) — the step-3.5
# wait is ultimately behavioral; this just makes "wait for the user" un-forgettable.
#
# Soft by nature: emits additionalContext, never blocks. Logged as `inject` so the
# audit summary can show it firing. Never breaks a turn on a hook bug (exit 0).
set -u
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)" || exit 0
bash "${HOOK_DIR}/_audit.sh" "workflow-gates-reminder" "inject" "userprompt" 2>/dev/null || true

command -v jq >/dev/null 2>&1 || exit 0

# Gate text lives in a sibling .txt file (not inlined) so it's editable without
# touching shell quoting — and so an apostrophe in the prose can't break the script.
GATES_FILE="${HOOK_DIR}/workflow-gates.txt"
[ -r "$GATES_FILE" ] || exit 0

esc="$(jq -Rs . < "$GATES_FILE" 2>/dev/null)" || exit 0
[ -n "$esc" ] && [ "$esc" != "null" ] || exit 0
printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":%s}}\n' "$esc"
exit 0
