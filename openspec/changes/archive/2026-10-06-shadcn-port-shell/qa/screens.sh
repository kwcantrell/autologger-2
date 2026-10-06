#!/usr/bin/env bash
# screens.sh <out-dir>: the fixed QA walk (shadcn migration). Same walk for baseline and every gate.
# Opens dialogs/menus only to look at them; always leaves via Escape/Close, never Save/Delete/Confirm.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd); out=$1; mkdir -p "$out"
export AGENT_BROWSER_SESSION=${AGENT_BROWSER_SESSION:-shadcn-qa}
B=${QA_BASE:-http://localhost:8787}; SID=${QA_SESSION:-05b37db7-d426-4d6e-8994-3b666ca42e87}
ab(){ agent-browser "$@" >/dev/null 2>&1; }
# QA_VP: the viewport this pass runs at. Run once per width (see README): dialogs keep the
# card/sheet mode they opened in, so mobile sheets must be opened at 390, not resized into.
VP=${QA_VP:-1440 900}; export QA_WIDTHS="${QA_WIDTHS:-$VP}"
go(){ ab set viewport $VP; ab open "$1"; ab wait 2200; }
# On mobile the rail is an off-canvas drawer: open it before using a rail control.
rail(){ case "$VP" in 390*) ab find role button click --name "Open navigation"; ab wait 700;; esac; }
click(){ ab find role "$1" click --name "$2"; ab wait 900; }
cap(){ "$here/cap.sh" "$out" "$1"; }
esc(){ ab press Escape; ab wait 500; }

go "$B/";                         cap home
# The row's ⋮ is hover-revealed; hover it first, and retry once if the click opened the session.
for _try in 1 2; do
  rail; ab hover 'button[aria-label="Session options"]'; ab wait 300; click button "Session options"
  case "$(agent-browser get url 2>/dev/null)" in */sessions/*) go "$B/";; *) break;; esac
done
cap session-menu; esc
go "$B/"   # re-anchor: each home-based step starts from a fresh home page
rail; click button "Settings";          cap settings-general
# Select listbox (shadcn-shared-wrappers). LazySelect upgrades on the first activation and can
# swallow a click; retry once, and only press Escape while a listbox is open (an Escape with no
# listbox would close Settings and derail every later Settings step).
lb(){ agent-browser eval "!!document.querySelector('[role=listbox]')" 2>/dev/null | grep -q true; }
click combobox "Suffix"; lb || click combobox "Suffix"; cap suffix-select; lb && esc
click tab "EVENT BUTTONS";        cap settings-event-buttons
click button "AI Rules";          cap event-instruction-modal; esc
click button "Edit dropdown options"; cap event-options-modal; esc
click button "Pick button color"; cap color-popover; esc
click tab "AUTO SYNC";            cap settings-auto-sync
click tab "DEBUG";                cap settings-debug; esc
go "$B/"
rail; click button "New Session";       cap new-session
click button "Import audio from YouTube"; click button "Timecode settings"; cap new-session-expanded; esc
go "$B/"
rail; click button "Batch Import";      cap batch-import; esc
go "$B/sessions/$SID"
for t in "EVENT FEED:ws-event-feed" "TRANSCRIPT:ws-transcript" "TOPICS:ws-topics" "ASSISTANT:ws-assistant" "DASHBOARDS:ws-dashboards" "EXPORT:ws-export"; do
  ab set viewport 1440 900; click tab "${t%%:*}"; cap "${t##*:}"
done
click tab "EVENT FEED"; ab hover 'button[aria-label="Roll timecode"]'; ab wait 900; cap roll-tooltip   # shadcn-shared-wrappers: Tooltip
click tab "EVENT FEED"; click button "TIME DISPLAY"; cap time-display-menu; esc
click button "FILTER";            cap filter-menu; esc
click tab "TRANSCRIPT"; click button "AUTO GENERATE"; cap transcribe-modal; esc
click tab "EVENT FEED"; ab press "?"; ab wait 700; cap shortcuts; esc
go "$B/teams";                    cap teams
ab click '[data-testid^="team-toggle-"]'; ab wait 1500; cap teams-expanded   # shadcn-port-shell: Teams card
go "$B/sessions/does-not-exist";  cap session-not-found   # shadcn-port-shell: RouteState not-found
go "$B/admin/users";              cap admin-users
go "$B/nope-404";                 cap not-found
go "${QA_LOGGED_OUT_BASE:-http://127.0.0.1:8787}/"; cap login
go "${QA_LOGGED_OUT_BASE:-http://127.0.0.1:8787}/?login_error=state_invalid"; cap login-error   # shadcn-port-shell: login Alert
