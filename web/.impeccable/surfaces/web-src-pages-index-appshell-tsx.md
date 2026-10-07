---
version: 1
slug: "web-src-pages-index-appshell-tsx"
primary_target: "web/src/pages/index/AppShell.tsx"
related_targets: []
---

# Surface brief: AutoLogger app shell (console, sidebar, Settings)

**Mode:** Operate.

**Who uses it**
- Loggers in a live session.
- Producers and admins moving across a production company's teams and shows.

**Jobs**
- Log against running timecode without misreading state.
- Know whose session this is.
- Manage team members, shows and event buttons without hunting.

**Reference:** the approved interactive preview, https://claude.ai/artifact/AsDEXErbeEtQm2EyYKzab2 (version 22). It is the critique reference, not a pixel contract.

**Change:** `redesign-show-ignition`, tier 1.

## Direction contract

**THESIS:** The shell itself says whether the session is live. One accent colour ignites the top bar, sidebar and transport when the session rolls or records, and dims to a muted tint when stopped. The design refuses the category default: a grey media tool with a lone red REC dot and state hidden in a corner.

**OWN-WORLD**
- Flat dark surfaces: bg #101216, panel #16181d, line #272b33. No glass and no gradients.
- One accent, #5b7cff, used for primary actions, selection, focus and ignition.
  - Recording or rolling: the rail mixes the accent about 25% into near-black, the transport panel about 13%, with a soft glow of about 46%.
  - Playback: a softer mix.
  - Stopped: about 10%.
- Type:
  - Barlow for the UI;
  - Barlow Condensed, uppercase and tracked, for labels, tabs, column headers and status;
  - JetBrains Mono only for timecode and measured values.
- Shape: controls have an 8px radius and a 36px height (30px small); cards have a 12px radius.
- One selected state: an accent tint plus a 1px inset accent line.
- Category colours are a separate channel: a number key plus a swatch.

**STORY**
- The visitor sees the team, the show and the transport state before anything else.
- They log with keys 1–9 and trust the colour plus the label (REC, ROLLING, PLAY, STOPPED).
- They configure everything from one Settings view. Each setting is a labelled row; members, shows and event buttons edit in a right-side panel with Cancel and Save.

**FIRST VIEWPORT**
- **Top bar,** full width, about 52px: sidebar trigger, then "Team ▾", then "›", then "Show ▾", then "›", then the status pill with the session name. No wordmark and no labels.
- **Left sidebar,** 272px (68px collapsed): New session and Import, search for this show, the show's sessions with the active one selected, and Settings in the footer.
- **Main area:**
  - the transport card: large mono timecode with the status pill, transport buttons, and a waveform timeline with a glowing playhead when live;
  - the logging strip of category buttons with key caps;
  - tabs;
  - the event feed table with a count heading.
- The primary action is the logging strip and the transport.

**FORM:** the assigned direction from the owner's three dark rolling-state options, "Show Ignition", position 2 on the list. The seed key is 14594a92 (the direction roll, superseded by the owner's pinned dark rolling-state brief). It was refined over about 20 owner-reviewed preview iterations: one colour, flat, top-bar selectors, a Settings view with side panels, and the darkened recording mix.

**FINISH:** unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.
