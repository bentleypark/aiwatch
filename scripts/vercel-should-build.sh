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
git diff --quiet "$PREV" HEAD -- src/ public/ index.html api/ vercel.json vite.config.js tests/ || diff_exit=$?

case $diff_exit in
  0) exit 0 ;;
  1) exit 1 ;;
  *) build "git diff against $PREV failed" ;;
esac
