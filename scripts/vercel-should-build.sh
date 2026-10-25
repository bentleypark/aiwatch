#!/usr/bin/env bash
# Vercel's ignoreCommand is inverted: 0 skips, 1 continues the build.
set -u

build() {
  echo "[vercel-ignore] $1 — continuing the build" >&2
  exit 1
}

if [ "${VERCEL_ENV:-}" != "preview" ]; then
  build "VERCEL_ENV '${VERCEL_ENV:-unset}' is not preview"
fi

PREV="${VERCEL_GIT_PREVIOUS_SHA:-}"
[ -n "$PREV" ] || build "no previous successful deployment on this branch"

diff_exit=0
# The worker/ files src/ and api/ import; scripts/vercel-should-build.test.mjs fails when one is missing.
WORKER_IMPORTS=(
  worker/src/fallback.ts
  worker/src/probe.ts
  worker/src/recovery-baseline-text.ts
  worker/src/status-verdict.ts
  worker/src/utils.ts
)
git diff --quiet "$PREV" HEAD -- src/ public/ index.html api/ vercel.json vite.config.js tests/ "${WORKER_IMPORTS[@]}" || diff_exit=$?

case $diff_exit in
  0) exit 0 ;;
  1) exit 1 ;;
  *) build "git diff against $PREV failed" ;;
esac
