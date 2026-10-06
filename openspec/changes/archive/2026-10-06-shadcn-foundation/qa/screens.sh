#!/usr/bin/env bash
# screens.sh <out-dir>: the fixed QA walk (shadcn migration). Same walk for baseline and every gate.
# Opens dialogs/menus only to look at them; always leaves via Escape/Close, never Save/Delete/Confirm.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd); out=$1; mkdir -p "$out"
export AGENT_BROWSER_SESSION=${AGENT_BROWSER_SESSION:-shadcn-qa}
B=${QA_BASE:-http://localhost:8787}; SID=${QA_SESSION:-05b37db7-d426-4d6e-8994-3b666ca42e87}
ab(){ agent-browser "$@" >/dev/null 2>&1; }
go(){ ab set viewport 1440 900; ab open "$1"; ab wait 2200; }
click(){ ab find role "$1" click --name "$2"; ab wait 900; }
cap(){ "$here/cap.sh" "$out" "$1"; }
esc(){ ab press Escape; ab wait 500; }

go "$B/";                         cap home
# The row's ⋮ is hover-revealed; hover it first, and retry once if the click opened the session.
for _try in 1 2; do
  ab hover 'button[aria-label="Session options"]'; ab wait 300; click button "Session options"
  case "$(agent-browser get url 2>/dev/null)" in */sessions/*) go "$B/";; *) break;; esac
done
cap session-menu; esc
go "$B/"   # re-anchor: each home-based step starts from a fresh home page
click button "Settings";          cap settings-general
click tab "EVENT BUTTONS";        cap settings-event-buttons
click button "AI Rules";          cap event-instruction-modal; esc
click button "Edit dropdown options"; cap event-options-modal; esc
click button "Pick button color"; cap color-popover; esc
click tab "AUTO SYNC";            cap settings-auto-sync
click tab "DEBUG";                cap settings-debug; esc
go "$B/"
click button "New Session";       cap new-session
click button "Import audio from YouTube"; click button "Timecode settings"; cap new-session-expanded; esc
go "$B/"
click button "Batch Import";      cap batch-import; esc
go "$B/sessions/$SID"
for t in "EVENT FEED:ws-event-feed" "TRANSCRIPT:ws-transcript" "TOPICS:ws-topics" "ASSISTANT:ws-assistant" "DASHBOARDS:ws-dashboards" "EXPORT:ws-export"; do
  ab set viewport 1440 900; click tab "${t%%:*}"; cap "${t##*:}"
done
click tab "EVENT FEED"; click button "TIME DISPLAY"; cap time-display-menu; esc
click button "FILTER";            cap filter-menu; esc
click tab "TRANSCRIPT"; click button "AUTO GENERATE"; cap transcribe-modal; esc
click tab "EVENT FEED"; ab press "?"; ab wait 700; cap shortcuts; esc
go "$B/teams";                    cap teams
go "$B/admin/users";              cap admin-users
go "$B/nope-404";                 cap not-found
go "${QA_LOGGED_OUT_BASE:-http://127.0.0.1:8787}/"; cap login
