#!/bin/sh
# AIWatch outage monitor (Claude Code plugin #920).
#
# Runs for the session lifetime and, on every poll, DIFFS the set of non-operational
# services against the previous poll — emitting one explicit line per transition:
#   🔴 <name> is <down|degraded> (AIWatch)   — a service that just became affected
#   ✅ <name> has recovered (AIWatch)         — a service no longer affected
# Every printed line becomes a Claude notification, so we emit only real transitions
# (never the unchanged set) — no spam, and each service is named explicitly (Claude no
# longer has to infer which one changed from a snapshot). Fail-silent: a failed poll
# (network hiccup) is skipped, keeping the last known set, so a blip never fabricates
# a recovery. NOTE: diff is by service NAME, so a severity shift within "affected"
# (degraded→down) is not re-alerted — run /aiwatch for current severity.
#
# Data source: /api/statusline/down — a parseable, UNCAPPED `status<TAB>name` list (the
# emoji presets are capped at 3 and not diff-friendly). Config (env): AIWATCH_BASE,
# AIWATCH_POLL_SECONDS (default 60).

BASE="${AIWATCH_BASE:-https://aiwatch-worker.p2c2kbf.workers.dev}"
INTERVAL="${AIWATCH_POLL_SECONDS:-60}"
URL="$BASE/api/statusline/down"

# prevfile holds the previous poll's affected NAMES (sorted, one per line). It starts
# empty, so at startup every currently-affected service is reported as newly-down (and a
# healthy start emits nothing) — no separate "first run" flag needed. A recovery can't be
# fabricated at startup either (nothing in prev to remove).
prevfile=$(mktemp) || exit 1
trap 'rm -f "$prevfile"' EXIT INT TERM
: > "$prevfile"

while true; do
  if raw=$(curl -sf --max-time 2 "$URL" 2>/dev/null); then
    curfile=$(mktemp) || { sleep "$INTERVAL"; continue; }
    # Affected names this poll, sorted (drop blank lines). `raw` is "status<TAB>name" lines.
    printf '%s\n' "$raw" | sed '/^[[:space:]]*$/d' | cut -f2 | sort > "$curfile"

    # Newly affected = names in cur but not in prev; look up the status word from `raw`.
    comm -13 "$prevfile" "$curfile" | while IFS= read -r name; do
      [ -z "$name" ] && continue
      st=$(printf '%s\n' "$raw" | awk -F'\t' -v n="$name" '$2 == n { print $1; exit }')
      printf '🔴 %s is %s (AIWatch)\n' "$name" "${st:-affected}"
    done

    # Recovered = names in prev but not in cur.
    comm -23 "$prevfile" "$curfile" | while IFS= read -r name; do
      [ -z "$name" ] && continue
      printf '✅ %s has recovered (AIWatch)\n' "$name"
    done

    mv "$curfile" "$prevfile"
  fi
  sleep "$INTERVAL"
done
