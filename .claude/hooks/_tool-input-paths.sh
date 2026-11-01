#!/usr/bin/env bash

hook_input_paths() {
  local input="$1" direct command
  emit_path() {
    case "$1" in
      /*) printf '%s\n' "$1" ;;
      *) printf '/%s\n' "$1" ;;
    esac
  }
  direct="$(printf '%s' "$input" | jq -r '.tool_input.file_path // ""' 2>/dev/null)" || return 0
  if [ -n "$direct" ]; then
    emit_path "$direct"
    return 0
  fi

  command="$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null)" || return 0
  [ -n "$command" ] || return 0
  printf '%s\n' "$command" | awk '
    /^\*\*\* (Add|Update|Delete) File: / { print substr($0, index($0, ":") + 2); next }
    /^\+\+\+ b\// { print substr($0, 7) }
  ' | awk '!seen[$0]++' | while IFS= read -r path; do emit_path "$path"; done
}
