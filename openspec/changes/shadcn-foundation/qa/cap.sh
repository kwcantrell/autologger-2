#!/usr/bin/env bash
# cap.sh <out-dir> <name>: screenshot + contrast JSON of the current page at 1440 and 390.
set -euo pipefail
out=$(realpath "$1"); name=$2; here=$(dirname "$0")
export AGENT_BROWSER_SESSION=${AGENT_BROWSER_SESSION:-shadcn-qa}
# QA_INJECT (optional): CSS injected before measuring, to evaluate a candidate fix in design.
if [ -n "${QA_INJECT:-}" ]; then
  agent-browser eval "{const s=document.getElementById('qa-inject')||document.head.appendChild(Object.assign(document.createElement('style'),{id:'qa-inject'})); s.textContent=$(python3 -c 'import json,os;print(json.dumps(os.environ["QA_INJECT"]))');} 1" >/dev/null
fi
for vp in "1440 900" "390 844"; do
  w=${vp% *}
  agent-browser set viewport $vp >/dev/null
  agent-browser mouse move 2 2 >/dev/null; agent-browser wait 700 >/dev/null
  agent-browser screenshot "$out/$name.$w.png" >/dev/null
  agent-browser eval "$(cat "$here/contrast.js")" | sed -n '2p' | python3 -c 'import sys,json; print(json.loads(sys.stdin.read()))' > "$out/$name.$w.contrast.json"
  python3 -c "import json;d=json.load(open('$out/$name.$w.contrast.json'));print('$name@$w', 'checked',d['checked'],'fails',d['fails'],'min',d['min'])"
done
agent-browser set viewport 1440 900 >/dev/null
