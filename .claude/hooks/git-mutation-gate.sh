#!/usr/bin/env bash
# PreToolUse(Bash) gate for git mutations — #415 Phase 1.
#
# Fires before every Bash command; bails immediately unless the command is a
# git mutation we care about (git commit / git push / gh pr create / gh pr merge).
# When it does match it emits a SOFT reminder (systemMessage, exit 0 — does NOT
# block) covering:
#   • CLAUDE.md step 3.5 — start the right dev server AND get the user's
#     in-browser confirmation before code lands. "tests pass" ≠ "feature verified".
#   • `--no-verify` / `--no-gpg-sign` — CLAUDE.md forbids these unless the user
#     explicitly asked.
#
# The step-3.5 reminder fires on EVERY matched git mutation — it is NOT silenced
# by a running dev server. Rationale (#415, 2026-05-19 gap): a port probe cannot
# distinguish "the assistant started a server and curl-checked it itself" from
# "the user confirmed in the browser" — and the latter (a user message) is the
# thing step 3.5 actually requires, which a PreToolUse(Bash) hook cannot observe.
# Treating an up port as a "pass" produced a false silence in the #430 violation.
# So the port (5173 Vite / 8788 wrangler / 3333 vercel / 4000 jekyll) is now only
# an INFORMATIONAL hint inside the reminder, never a silence condition. Still soft
# on purpose; if the audit log shows it's ignored, escalate to a hard block
# (permissionDecision "deny", exit 0 with that JSON) — see #415.
#
# Every fire is logged via _audit.sh for monitoring. Never blocks on a hook bug:
# missing jq / parse failure -> exit 0.

set -u
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)" || exit 0
audit() { bash "${HOOK_DIR}/_audit.sh" "git-mutation-gate" "$1" "$2" 2>/dev/null || true; }

command -v jq >/dev/null 2>&1 || exit 0
INPUT="$(cat 2>/dev/null)" || exit 0
CMD="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)" || exit 0

# Only care about branch-affecting / shared-visibility git mutations.
case "$CMD" in
  *"git commit"*|*"git push"*|*"gh pr create"*|*"gh pr merge"*) : ;;
  *) exit 0 ;;
esac

# Which mutation (for the audit note).
op="git"
case "$CMD" in
  *"gh pr merge"*) op="gh-pr-merge" ;;
  *"gh pr create"*) op="gh-pr-create" ;;
  *"git push"*) op="git-push" ;;
  *"git commit"*) op="git-commit" ;;
esac

# Detect a running dev server on a usual port.
dev_running=0
if command -v lsof >/dev/null 2>&1; then
  for p in 5173 8788 3333 4000; do
    if lsof -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then dev_running=1; break; fi
  done
fi

# `--no-verify` / `--no-gpg-sign` present?
noverify=0
case "$CMD" in
  *"--no-verify"*|*"--no-gpg-sign"*|*"-c commit.gpgsign=false"*) noverify=1 ;;
esac

# Step 3.5 is ALWAYS surfaced on a matched git mutation — a running dev server is
# an informational hint, NOT a silence condition (see header). Port status is
# included so the reminder is honest about what was/wasn't observable.
if [ "$dev_running" -eq 1 ]; then
  dev_hint="a dev server IS listening on :5173/:8788/:3333/:4000 — but that is NOT proof the user confirmed (it could be a server you started + curl-checked yourself)"
else
  dev_hint="no dev server detected on :5173/:8788/:3333/:4000 — step 3.5 was very likely skipped entirely"
fi

warnings=()
warnings+=("🚦 ${op}: CLAUDE.md step 3.5 — did the USER confirm this change in-browser? Your own curl / Playwright checks do NOT count, and \"tests pass\" ≠ \"feature verified\". (${dev_hint}.)")
if [ "$noverify" -eq 1 ]; then
  warnings+=("⛔ ${op}: \`--no-verify\` / \`--no-gpg-sign\` detected — CLAUDE.md forbids these unless the user explicitly asked. If they didn't, drop the flag and let the hook run.")
fi

# Soft warning: surface a systemMessage, allow the tool to proceed.
msg="$(printf '%s\n' "${warnings[@]}")"
note="${op}; dev_server=$([ "$dev_running" -eq 1 ] && echo up || echo down); no_verify=${noverify}"
audit "warn" "$note"
# jq -Rs . turns raw stdin into a properly-escaped JSON string literal.
esc="$(printf '%s' "$msg" | jq -Rs . 2>/dev/null)"
if [ -n "$esc" ] && [ "$esc" != "null" ]; then
  printf '{"systemMessage":%s}\n' "$esc"
else
  # Defensive fallback (jq should always be present — checked above).
  safe="$(printf '%s' "$msg" | tr '\n"' '  ')"
  printf '{"systemMessage":"%s"}\n' "$safe"
fi
exit 0
