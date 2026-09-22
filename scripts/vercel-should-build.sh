#!/usr/bin/env bash
# Vercel's ignoreCommand is inverted: 0 skips, 1 continues the build.
set -u

build() {
  echo "[vercel-ignore] $1 — continuing the build" >&2
  exit 1
}

if [ "${VERCEL_ENV:-}" = "production" ]; then
  exit 1
fi

if [ "${VERCEL_ENV:-}" != "preview" ]; then
  build "unexpected VERCEL_ENV '${VERCEL_ENV:-unset}'"
fi

BASE=$(git merge-base HEAD origin/main) || build "origin/main is unavailable"

diff_exit=0
git diff --quiet "$BASE" HEAD -- src/ public/ index.html api/ vercel.json vite.config.js tests/ || diff_exit=$?

case $diff_exit in
  0) exit 0 ;;
  1) exit 1 ;;
  *) build "git diff failed" ;;
esac
