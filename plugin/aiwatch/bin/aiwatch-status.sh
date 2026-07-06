#!/bin/sh
# AIWatch on-demand incident briefing (Claude Code plugin #920) — backs the /aiwatch command.
#
# The server renders a compact, multi-line briefing: which monitored AI services are
# degraded/down right now, each with its active official incident (title + impact), the
# AI summary of that incident when available, and a fallback suggestion — or a single
# "all operational" line when healthy. The plugin stays a thin curl (no jq); all the
# formatting/parsing lives in the worker (renderStatuslineBrief). Fail-silent on error.
#
# Config (env): AIWATCH_BASE (default prod Worker).

BASE="${AIWATCH_BASE:-https://aiwatch-worker.p2c2kbf.workers.dev}"

if out=$(curl -sf --max-time 4 "$BASE/api/statusline/brief" 2>/dev/null); then
  printf '%s\n' "$out"
else
  echo "AIWatch: status unavailable (network error) — https://ai-watch.dev"
fi
