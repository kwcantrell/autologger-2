#!/usr/bin/env bash
# PreToolUse: the human writes `Approved-by:`; an agent edit that adds one is blocked.
set -euo pipefail
python3 -c '
import json, re, sys
data = json.load(sys.stdin)
ti = data.get("tool_input") or {}
text = "\n".join(str(ti.get(k) or "") for k in ("content", "new_string"))
text += "\n".join(str(e.get("new_string") or "") for e in ti.get("edits") or [])
if re.search(r"^\s*Approved-by:", text, re.M):
    sys.stderr.write("Blocked: `Approved-by:` lines are written by the human approver, never by an agent. "
                     "Ask the human to approve the change.\n")
    sys.exit(2)
'
