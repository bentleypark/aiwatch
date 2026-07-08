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
#   • Docs drift (git commit only) — when the staged diff changes doc-load-bearing
#     code (services.ts / index.ts / parsers / wrangler.toml / vercel.json /
#     constants.js, or adds a new worker module) but touches no docs/reference/* or
#     CLAUDE.md, surface the change→doc map. Docs is the recurring miss because it's
#     the late, no-feedback, no-gate step (memory: feedback_docs_update_not_skipped).
#   • Methodology drift (git commit only, #937) — when the staged diff changes
#     docs/reference/status-determination.md but NOT api/_methodology/html-template.ts,
#     nudge to sync the public /methodology §2 cards that mirror those rules. The
#     docs_reminder above goes silent once ANY docs file is touched, so this specific
#     rules-doc↔mirror-page coupling needs its own check (the #934 drift).
#
# The step-3.5 reminder fires on EVERY matched git mutation — it is NOT silenced
# by a running dev server. Rationale (#415, 2026-05-19 gap): a port probe cannot
# distinguish "the assistant started a server and curl-checked it itself" from
# "the user confirmed in the browser". So the port (5173 Vite / 8788 wrangler /
# 3333 vercel / 4000 jekyll) is only an INFORMATIONAL hint here, never a silence
# condition. This hook stays SOFT (a nudge for ALL commits incl. non-UI).
#
# #657: the HARD enforcement now lives in the sibling `step35-verify-gate.mjs`
# (PreToolUse Bash + Edit|Write) — it DENIES a `git commit` of a UI/Edge staged
# diff unless the transcript shows a genuine post-edit USER confirmation. (The old
# claim here that "the user's in-browser confirmation is a message the hook never
# sees" was WRONG: PreToolUse hooks receive `transcript_path` and can read the
# conversation JSONL — that's how #657 keys the gate on an unfabricable
# `role:user` turn instead of a forgeable port probe.)
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

# Docs-drift reminder (git commit only). Inspect the STAGED diff: doc-load-bearing code changed
# (or a new worker module added) but no docs/reference/* / CLAUDE.md edit in the same commit.
# Soft nudge with the change→doc map. Robust: any git/parse failure leaves docs_reminder=0 (no fire).
docs_reminder=0
# #937 — status-determination ↔ /methodology page coupling. The docs_reminder above is silenced by
# ANY docs/ or CLAUDE.md edit, so editing docs/reference/status-determination.md alone (the canonical
# rules) does NOT flag the public /methodology §2 cards (api/_methodology/html-template.ts) that mirror
# those rules — the recurring drift surfaced in #934. This high-precision reminder fires when the
# rules doc is staged but the mirror page is not.
methodology_reminder=0
if [ "$op" = "git-commit" ]; then
  HCWD="$(printf '%s' "$INPUT" | jq -r '.cwd // ""' 2>/dev/null)"
  [ -n "$HCWD" ] && cd "$HCWD" 2>/dev/null || true
  if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    staged="$(git diff --cached --name-status 2>/dev/null)"
    names="$(printf '%s\n' "$staged" | awk '{print $NF}')"
    code_changed=0
    printf '%s\n' "$names" | grep -vE '(__tests__|\.test\.)' | grep -qE \
      '^worker/src/(services|index)\.ts$|^worker/src/parsers/.*\.ts$|^worker/wrangler\.toml$|^vercel\.json$|^src/utils/constants\.js$' \
      && code_changed=1
    new_module=0
    printf '%s\n' "$staged" | grep -E '^A' | grep -vE '(__tests__|\.test\.)' | grep -qE 'worker/src/.*\.ts$' && new_module=1
    docs_changed=0
    printf '%s\n' "$names" | grep -qE '^docs/|^CLAUDE\.md$|README' && docs_changed=1
    if { [ "$code_changed" = 1 ] || [ "$new_module" = 1 ]; } && [ "$docs_changed" = 0 ]; then
      docs_reminder=1
    fi
    # #937 coupling: rules doc staged, mirror page NOT staged → nudge to sync the §2 cards.
    statusdet_changed=0
    printf '%s\n' "$names" | grep -qE '^docs/reference/status-determination\.md$' && statusdet_changed=1
    methodology_changed=0
    printf '%s\n' "$names" | grep -qE '^api/_methodology/html-template\.ts$' && methodology_changed=1
    if [ "$statusdet_changed" = 1 ] && [ "$methodology_changed" = 0 ]; then
      methodology_reminder=1
    fi
  fi
fi

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
if [ "$docs_reminder" -eq 1 ]; then
  warnings+=("📝 ${op}: doc-load-bearing code changed but no docs/reference/* or CLAUDE.md in this commit. Change→doc map: KV key → kv-schema.md · feed/cron/data-flow → data-flow.md · new endpoint → api-endpoints.md · new file/service-count/architecture → CLAUDE.md · fallback/tier → fallback-tiers.md · status determination → status-determination.md. Update docs in THIS commit, not \"later\".")
fi
if [ "$methodology_reminder" -eq 1 ]; then
  warnings+=("🔗 ${op}: docs/reference/status-determination.md changed but api/_methodology/html-template.ts is NOT in this commit. The public /methodology §2 \"STATUS DETERMINATION\" cards mirror these rules and are a recurring sync miss (#934/#937). Verify the §2 cards still match — update them in THIS commit if the rule changed user-visibly.")
fi

# Soft warning: surface a systemMessage, allow the tool to proceed.
msg="$(printf '%s\n' "${warnings[@]}")"
note="${op}; dev_server=$([ "$dev_running" -eq 1 ] && echo up || echo down); no_verify=${noverify}; docs_reminder=${docs_reminder}; methodology_reminder=${methodology_reminder}"
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
