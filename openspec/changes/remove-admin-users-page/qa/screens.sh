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
rail; click button "Settings";          cap settings-general-member   # opens on the saved team (Youtube Studio: member view)
# shadcn-port-settings: switch the header Team picker to the owner's team (never saved; the walk
# leaves Settings by navigating away), so the owner-only controls below are present.
lbopen(){ agent-browser eval "!!document.querySelector('[role=listbox]')" 2>/dev/null | grep -q true; }
click combobox "Team"; lbopen || click combobox "Team"; ab find role option click --name "${QA_OWNER_TEAM:-Test Team}"; ab wait 1800
cap settings-general
# Settings tabs by keyboard (Radix roving focus after the port; the hand-built tablist before it).
ab focus '#v6-settings-tab-general'; ab press ArrowRight; ab wait 600; cap settings-tabs-keyboard
click tab "GENERAL"
# Add-Show dialog (owner only): open, capture, leave with Escape (nested dialog closes first).
click button "Add New Show";       cap add-show-dialog; esc
# Select listbox (shadcn-shared-wrappers). LazySelect upgrades on the first activation and can
# swallow a click; retry once, and only press Escape while a listbox is open (an Escape with no
# listbox would close Settings and derail every later Settings step).
lb(){ agent-browser eval "!!document.querySelector('[role=listbox]')" 2>/dev/null | grep -q true; }
click combobox "Suffix"; lb || click combobox "Suffix"; cap suffix-select; lb && esc
click tab "EVENT BUTTONS";        cap settings-event-buttons
# Touch-target floor (D2b): at 390, Save and a row "Remove event" button must be >= 44px tall.
agent-browser eval "JSON.stringify({save:Math.round(document.getElementById('profile-save')?.getBoundingClientRect().height||0),remove:Math.round(document.querySelector('[aria-label=\"Remove event\"]')?.getBoundingClientRect().height||0)})" 2>/dev/null | sed -n '2p' > "$out/touch-probe.$(echo $VP | cut -d' ' -f1).json"
click button "AI Rules";          cap event-instruction-modal; esc
click button "Edit dropdown options"; cap event-options-modal; esc
click button "Pick button color"; cap color-popover; esc
click tab "AUTO SYNC";            cap settings-auto-sync
click tab "DEBUG";                cap settings-debug
# shadcn-port-modals: the team switch left Settings dirty, so Close asks to discard (ConfirmDialog).
# Captured, then declined with Escape (never confirmed).
click button "Close"; ab wait 500; cap settings-discard-confirm
agent-browser eval "JSON.stringify({confirm:Math.round([...document.querySelectorAll('[role=alertdialog] button,[role=dialog][data-vaul-drawer] button')].pop()?.getBoundingClientRect().height||0)})" 2>/dev/null | sed -n '2p' > "$out/touch-confirm.$(echo $VP | cut -d' ' -f1).json"
esc
go "$B/"
rail; click button "New Session";       cap new-session
click button "Import audio from YouTube"; click button "Timecode settings"; cap new-session-expanded
# "Other…" frame rate reveals the custom fps field (shadcn-port-modals).
click combobox "Frame rate"; ab find role option click --name "Other…"; ab wait 600; cap new-session-other-fps
agent-browser eval "JSON.stringify({create:Math.round(document.getElementById('ns-submit')?.getBoundingClientRect().height||0)})" 2>/dev/null | sed -n '2p' > "$out/touch-new-session.$(echo $VP | cut -d' ' -f1).json"
esc
go "$B/"
rail; click button "Batch Import";      cap batch-import
agent-browser eval "JSON.stringify({start:Math.round(document.getElementById('bi-start-import')?.getBoundingClientRect().height||0)})" 2>/dev/null | sed -n '2p' > "$out/touch-batch.$(echo $VP | cut -d' ' -f1).json"
# Import Logs opens the themed PromptDialog (nested); Escape closes the prompt, then the modal.
click button "Import Logs";       cap import-logs-prompt; esc; esc
go "$B/sessions/$SID"
for t in "EVENT FEED:ws-event-feed" "TRANSCRIPT:ws-transcript" "TOPICS:ws-topics" "ASSISTANT:ws-assistant" "DASHBOARDS:ws-dashboards" "EXPORT:ws-export"; do
  ab set viewport 1440 900; click tab "${t%%:*}"; cap "${t##*:}"
done
click tab "EVENT FEED"; ab hover 'button[aria-label="Roll timecode"]'; ab wait 900; cap roll-tooltip   # shadcn-shared-wrappers: Tooltip
click tab "EVENT FEED"; click button "TIME DISPLAY"; cap time-display-menu; esc
# shadcn-port-workspace: Auto Generate DropdownMenu on the Event Feed (may be aria-disabled at rest).
click button "AUTO GENERATE";     cap auto-generate-menu; agent-browser eval "!!document.querySelector('[role=menu]')" 2>/dev/null | grep -q true && esc
click button "FILTER";            cap filter-menu; esc
click tab "TRANSCRIPT"; click button "AUTO GENERATE"; cap transcribe-modal; esc
click tab "EVENT FEED"; ab press "?"; ab wait 700; cap shortcuts; esc
# shadcn-port-workspace: feed tabs by keyboard (Radix roving focus): ArrowRight from Event Feed.
click tab "EVENT FEED"; ab focus 'button[role=tab][aria-selected=true]'; ab press ArrowRight; ab wait 600; cap ws-tabs-keyboard
click tab "EVENT FEED"
# Probes on a session with data (QA_PROBE_SESSION: ATS_youtube, 4 events + 2279 transcript words).
# Event Feed: rows measure <= 31px (A6) and a timeline-marker reveal mounts + flashes the row.
w=$(echo $VP | cut -d' ' -f1)
go "$B/sessions/${QA_PROBE_SESSION:-0c8aaf43-d37f-425c-a415-b10c28596c48}"
agent-browser eval "$(cat "$here/feedprobe.js")" 2>/dev/null | sed -n '2p' > "$out/feed-probe-events.$w.json"
agent-browser eval "(()=>{const b=[...document.querySelectorAll('button[data-event-id]')].pop();if(!b)return 'none';b.click();return b.dataset.eventId})()" 2>/dev/null | sed -n '2p' > "$out/reveal-id.$w.txt"
ab wait 400; agent-browser eval "(()=>{const id=$(cat "$out/reveal-id.$w.txt");const r=document.querySelector('#v4-log-sheet tr[data-event-id=\"'+id+'\"]');return JSON.stringify({id,mounted:!!r,flash:!!(r&&r.classList.contains('event-row-flash'))})})()" 2>/dev/null | sed -n '2p' > "$out/reveal-probe.$w.json"
cap reveal-in-feed
# Transcript (virtualized, 2279 rows): the viewport scrolls (mobile: 70dvh cap on the viewport),
# mounts a window not every row, the sticky header stays at the top, and a real mousedown on the
# scrollbar leaves focus where it was (D1).
click tab "TRANSCRIPT"; ab wait 1500
agent-browser eval "$(cat "$here/feedprobe.js")" 2>/dev/null | sed -n '2p' > "$out/feed-probe-transcript.$w.json"
cap ws-transcript-scrolled
"$here/focusprobe.sh" > "$out/focus-probe.$w.txt" 2>&1
go "$B/teams";                    cap teams
ab click '[data-testid^="team-toggle-"]'; ab wait 1500; cap teams-expanded   # shadcn-port-shell: Teams card
go "$B/sessions/does-not-exist";  cap session-not-found   # shadcn-port-shell: RouteState not-found
go "$B/admin/users";              cap admin-users
# remove-admin-users-page: record the document status of /admin/users (200 shell before, 404 after).
agent-browser eval "fetch('/admin/users').then(r=>String(r.status))" 2>/dev/null | sed -n '2p' > "$out/admin-users-status.$(echo $VP | cut -d' ' -f1).txt"
go "$B/nope-404";                 cap not-found
go "${QA_LOGGED_OUT_BASE:-http://127.0.0.1:8787}/"; cap login
go "${QA_LOGGED_OUT_BASE:-http://127.0.0.1:8787}/?login_error=state_invalid"; cap login-error   # shadcn-port-shell: login Alert
