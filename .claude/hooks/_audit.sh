#!/usr/bin/env bash
# Shared audit-log helper for the workflow-gate hooks (#415 Phase 2).
#
# Usage:  bash "${HOOK_DIR}/_audit.sh" <hook-name> <decision> <note>
# Appends one JSON line to .claude/hook-audit.jsonl (gitignored):
#   {"ts":"<ISO>","hook":"<name>","decision":"<warn|block|skip|clean|inject|pass>","note":"<text>"}
# Decisions in use: git-mutation-gate → warn (pass is legacy, pre-#415-gap-fix);
# stop-nag-gate → clean | block | skip; workflow-gates-reminder → inject.
#
# Why a file, not memory: the point of #415 is to *measure* whether the gates
# change behavior — how often each fires, by which decision, trending over time.
# `scripts/hook-audit-summary.mjs` reads this log. Failure here is non-fatal:
# the hooks must never break a turn because logging failed.

set -u
HOOK="${1:-unknown}"
DECISION="${2:-unknown}"
NOTE="${3:-}"

# .claude/hook-audit.jsonl, resolved relative to this script (.claude/hooks/_audit.sh -> ../hook-audit.jsonl)
AUDIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." 2>/dev/null && pwd)" || exit 0
AUDIT_FILE="${AUDIT_DIR}/hook-audit.jsonl"

TS="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)" || TS=""

# JSON-escape the note (minimal: backslash, double-quote, control chars -> space).
esc_note="$(printf '%s' "$NOTE" | LC_ALL=C tr -d '\000-\010\013\014\016-\037' | sed 's/\\/\\\\/g; s/"/\\"/g')"

printf '{"ts":"%s","hook":"%s","decision":"%s","note":"%s"}\n' \
  "$TS" "$HOOK" "$DECISION" "$esc_note" >> "$AUDIT_FILE" 2>/dev/null || true
exit 0
