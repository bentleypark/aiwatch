#!/usr/bin/env bash
# PreToolUse(Edit|Write|MultiEdit) Korean-copy trigger — #1094/#1097.
#
# The Korean copy lint (`npm run lint:korean`) is CI-gated (via the `test:scripts` real-copy test), but
# CI fires only at PR time — after a multi-round edit has already gone sideways. The #1094 defect class
# (dev-token leak, term drift) and the #1097 loop (editing the pointed-at sentence instead of re-reading
# the whole card) both happen DURING the edit. This hook fires deterministically before a copy edit and
# emits a SOFT reminder (systemMessage, exit 0 — never blocks) so the check is present at the moment the
# copy is being written, not just at the PR gate.
#
# Target surfaces = the reader-facing Korean copy the lint scans (ko.js, the methodology/intro Edge
# templates, the two JSX prose components). Never blocks on a hook bug: missing jq / no path → exit 0.

set -u
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)" || exit 0
audit() { bash "${HOOK_DIR}/_audit.sh" "korean-copy-trigger" "$1" "$2" 2>/dev/null || true; }

command -v jq >/dev/null 2>&1 || exit 0
INPUT="$(cat 2>/dev/null)" || exit 0
FP="$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // ""' 2>/dev/null)" || exit 0
[ -z "$FP" ] && exit 0

# Only the copy surfaces the lint actually scans (keep in sync with SURFACES in lint-korean-copy.mjs).
case "$FP" in
  */src/locales/ko.js|*/api/_methodology/html-template.ts|*/api/_intro/html-template.ts|*/src/components/LegalContent.jsx|*/src/components/AnalysisModal.jsx) ;;
  *) exit 0 ;;
esac

msg="🇰🇷 한국어 카피 편집 — 커밋 전 \`npm run lint:korean\` (내부-어휘 유출은 hard-fail, 용어 드리프트는 warn). 용어는 글로서리(Atlassian 근거: incident=인시던트, outage=중단, degraded=성능 저하) 대조. 문장 하나만 고치지 말고 편집 후 카드/블록 전체를 다시 읽어라 (#1094/#1097)."

audit "warn" "copy:${FP##*/}"
printf '%s\n' "$(jq -n --arg m "$msg" '{systemMessage:$m}')" 2>/dev/null || true
exit 0
