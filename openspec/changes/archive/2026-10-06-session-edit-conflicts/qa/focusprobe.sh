#!/usr/bin/env bash
# focusprobe.sh: real (trusted) mousedown on the visible feed's scrollbar must not move focus (D1).
export AGENT_BROWSER_SESSION=${AGENT_BROWSER_SESSION:-shadcn-qa}
ab(){ agent-browser "$@" 2>/dev/null | sed -n '2p'; }
# Hover the feed viewport so the hover-type scrollbar mounts.
agent-browser hover '[role=tabpanel]:not([hidden]) [data-slot=scroll-area-viewport]' >/dev/null 2>&1; agent-browser wait 400 >/dev/null
agent-browser eval "(()=>{let i=document.getElementById('qa-focus');if(!i){i=Object.assign(document.createElement('input'),{id:'qa-focus'});i.style.cssText='position:fixed;left:4px;top:4px;width:40px;z-index:99999';document.body.appendChild(i)}i.focus();return document.activeElement.id})()" >/dev/null 2>&1
xy=$(ab eval "(()=>{const b=document.querySelector('[role=tabpanel]:not([hidden]) [data-slot=scroll-area-thumb]')||document.querySelector('[role=tabpanel]:not([hidden]) [data-slot=scroll-area-scrollbar]');if(!b)return 'none';const r=b.getBoundingClientRect();return Math.round(r.left+r.width/2)+' '+Math.round(r.top+Math.min(10,r.height/2))})()")
xy=${xy//\"/}
echo "scrollbar point: $xy"
if [ "$xy" = "none" ]; then echo "RESULT: no scrollbar (content does not overflow)"; exit 0; fi
agent-browser mouse move $xy >/dev/null 2>&1; agent-browser mouse down >/dev/null 2>&1; agent-browser mouse move ${xy% *} $(( ${xy#* } + 40 )) >/dev/null 2>&1; agent-browser mouse up >/dev/null 2>&1
echo "activeElement after drag: $(ab eval 'document.activeElement && document.activeElement.id')"
echo "feed scrollTop after drag: $(ab eval "document.querySelector('[role=tabpanel]:not([hidden]) [data-slot=scroll-area-viewport]').scrollTop")"
agent-browser eval "document.getElementById('qa-focus')?.remove()" >/dev/null 2>&1
