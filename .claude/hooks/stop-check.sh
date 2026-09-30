#!/usr/bin/env bash
# Stop: before the agent may finish, the hook-stage gates must pass on uncommitted work.
# Exit 2 sends the failures back to the agent. After 3 blocked stops in one session the
# agent may stop, so a broken environment can't trap it; CI still enforces the gates.
set -euo pipefail
cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"

input="$(cat)"
session="$(printf '%s' "$input" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("session_id","x"))')"
counter="${TMPDIR:-/tmp}/lifecycle-stop-${session}"

# Nothing edited since the last commit: nothing to verify.
if [[ -z "$(git status --porcelain)" ]]; then
  rm -f "$counter"; exit 0
fi

if out="$(scripts/check-change.sh --stage hook --quiet 2>&1)"; then
  rm -f "$counter"; exit 0
fi

n=$(( $(cat "$counter" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$counter"
if (( n > 3 )); then
  echo "Lifecycle checks still failing after 3 attempts; stopping. Tell the human which checks fail." >&2
  exit 0
fi
{
  echo "Lifecycle checks failed. Fix them, or explain to the human why you can't, before stopping:"
  echo "$out"
} >&2
exit 2
