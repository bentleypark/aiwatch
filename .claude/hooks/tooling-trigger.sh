#!/usr/bin/env bash
# PreToolUse(Edit|Write|MultiEdit) reference-tooling trigger — #415-style backstop.
#
# The reference tools carry their own model-invoked trigger descriptions, but those are passive
# context = probabilistic compliance (the #415 failure mode). This hook fires DETERMINISTICALLY
# before a file edit and, only when the target path is a high-signal surface, emits a SOFT reminder
# (PreToolUse additionalContext, exit 0 — never blocks) pointing at the source of ground truth:
#   • Status pages / feeds (worker parsers / services / changelog / security & platform monitors /
#     reddit) → fetch the LIVE upstream response; no docs tool covers these sources.
#   • SDK / binding (ai-analysis / anthropic / package.json) → first-party skill, else context7 (#1410).
#   • Frontend HTML/CSS/client-JS (src components/pages, *.jsx, *.css, Edge SSR html templates)
#     → run the `modern-web-guidance` skill FIRST (a11y / Core Web Vitals / Baseline-safe APIs).
# Routing is pinned by scripts/tooling-trigger.test.mjs; trigger map in docs/reference/reference-tooling.md.
#
# Soft on purpose; every fire is logged via _audit.sh so `npm run hook-audit` can show whether it
# changes behavior. Never blocks on a hook bug: missing jq / parse failure / no path → exit 0.

set -u
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)" || exit 0
audit() { bash "${HOOK_DIR}/_audit.sh" "tooling-trigger" "$1" "$2" 2>/dev/null || true; }

command -v jq >/dev/null 2>&1 || exit 0
INPUT="$(cat 2>/dev/null)" || exit 0
FP="$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // ""' 2>/dev/null)" || exit 0
[ -z "$FP" ] && exit 0

# Test/spec files need neither API-currency nor web-platform guidance — stay silent there.
case "$FP" in
  *__tests__*|*.test.*|*.spec.*) exit 0 ;;
esac

msg=""
note=""
case "$FP" in
  */worker/src/parsers/*|*/worker/src/services.ts|*/worker/src/changelog.ts|*/worker/src/security-monitor.ts|*/worker/src/platform-monitor.ts|*/worker/src/reddit.ts)
    msg="🌐 External source touched (status page / feed) — fetch the LIVE upstream response and check its real shape BEFORE coding (curl or WebFetch; a 403/429 is a bot block, retry in the playwright MCP browser). No docs tool covers these sources."
    note="upstream:${FP##*/}"
    ;;
  */worker/src/ai-analysis.ts|*/worker/src/anthropic.ts|*/package.json)
    msg="📚 SDK / binding touched — get CURRENT docs BEFORE coding; training knowledge may be stale. First-party skill first (\`cloudflare\` / \`workers-best-practices\` for Worker runtime + bindings, \`claude-api\` for Anthropic), else context7 (resolve the library id, then one topic per query)."
    note="docs:${FP##*/}"
    ;;
  */src/components/*|*/src/pages/*|*.jsx|*.css|*html-template.ts|*/api/is-down.ts|*/api/intro.ts)
    msg="🎨 Frontend HTML/CSS/client-JS touched — run the \`modern-web-guidance\` skill FIRST (accessibility / Core Web Vitals / Baseline-safe modern platform features) before hand-writing patterns."
    note="modern-web:${FP##*/}"
    ;;
  *)
    exit 0
    ;;
esac

audit "inject" "$note"
# jq -Rs . turns the raw message into a properly-escaped JSON string literal.
esc="$(printf '%s' "$msg" | jq -Rs . 2>/dev/null)"
if [ -n "$esc" ] && [ "$esc" != "null" ]; then
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":%s}}\n' "$esc"
else
  safe="$(printf '%s' "$msg" | tr '\n"' '  ')"
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"%s"}}\n' "$safe"
fi
exit 0
