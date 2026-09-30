#!/usr/bin/env bash
# Runs the lifecycle gates. CI, pre-commit and the agent's Stop hook all call this.
#   scripts/check-change.sh                 # everything (what CI runs on a PR)
#   scripts/check-change.sh --stage commit  # fast file checks
#   scripts/check-change.sh --stage hook    # what an agent must pass before it stops
#   scripts/check-change.sh --only size,tasks
set -euo pipefail
exec python3 "$(dirname "$0")/lib/check_change.py" "$@"
