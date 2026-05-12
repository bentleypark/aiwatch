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
# Heuristic to keep it from nagging on every legit commit: if a dev server is
# already listening on a usual port (5173 Vite / 8788 wrangler / 3333 vercel /
# 4000 jekyll) AND the command carries no `--no-verify`, stay silent (a running
# dev server is weak evidence step 3.5 was at least set up). If no dev server is
# up, warn — step 3.5 was very likely skipped. It's soft on purpose; if the
# audit log shows it's being ignored, escalate to a hard block (permissionDecision
# "deny", exit 0 with that JSON) — see #415.
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

warnings=()
if [ "$dev_running" -eq 0 ]; then
  warnings+=("🚧 ${op}: no dev server detected on :5173/:8788/:3333/:4000 — CLAUDE.md step 3.5 (start the right dev server + get the user's in-browser confirmation) was very likely skipped. Tests passing ≠ feature verified.")
fi
if [ "$noverify" -eq 1 ]; then
  warnings+=("⛔ ${op}: \`--no-verify\` / \`--no-gpg-sign\` detected — CLAUDE.md forbids these unless the user explicitly asked. If they didn't, drop the flag and let the hook run.")
fi

if [ "${#warnings[@]}" -eq 0 ]; then
  # Dev server up + no skipped-verification flags: looks fine. Stay silent, just log.
  audit "pass" "${op}; dev_server=up"
  exit 0
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
