---
name: AutoLogger
description: Session-logging workspace whose shell ignites in one accent while the session is live.
colors:
  accent: "#5b7cff"
  accent-text: "color-mix(in oklab, #5b7cff 72%, #ffffff)"
  primary-tint: "color-mix(in oklab, #5b7cff 26%, #1c1f25)"
  primary-line: "color-mix(in oklab, #5b7cff 55%, #272b33)"
  selected-tint: "color-mix(in oklab, #5b7cff 18%, transparent)"
  selected-line: "color-mix(in oklab, #5b7cff 48%, transparent)"
  ignition-stopped: "color-mix(in oklab, #5b7cff 10%, #0c0d10)"
  ignition-live: "color-mix(in oklab, #5b7cff 25%, #0a0b0e)"
  ignition-playback: "color-mix(in oklab, #5b7cff 18%, #0c0d10)"
  live-accent: "color-mix(in oklab, #5b7cff 88%, #000000)"
  playback-accent: "color-mix(in oklab, #5b7cff 65%, #ffffff)"
  live-glow: "color-mix(in oklab, #5b7cff 46%, transparent)"
  ink: "#0b0c0f"
  ground: "#101216"
  panel: "#16181d"
  panel-raised: "#1c1f25"
  line: "#272b33"
  line-strong: "#343944"
  fg: "#eceef2"
  muted: "#a6acb7"
  dim: "#858c98"
  danger: "#ff9b9b"
  danger-line: "#5a2e33"
  rec-glyph: "#ff6464"
  hover-wash: "rgba(255, 255, 255, 0.06)"
typography:
  timecode-hero:
    fontFamily: "JetBrains Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "2.125rem"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "-0.01em"
    fontFeature: "tnum"
  headline:
    fontFamily: "Barlow, Segoe UI, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.25
  title:
    fontFamily: "Barlow, Segoe UI, system-ui, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 600
    lineHeight: 1.25
  body:
    fontFamily: "Barlow, Segoe UI, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.45
  control:
    fontFamily: "Barlow, Segoe UI, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 600
    lineHeight: 1
  tab:
    fontFamily: "Barlow Condensed, Arial Narrow, Barlow, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 600
    letterSpacing: "0.1em"
  label:
    fontFamily: "Barlow Condensed, Arial Narrow, Barlow, system-ui, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "0.12em"
  status:
    fontFamily: "Barlow Condensed, Arial Narrow, Barlow, system-ui, sans-serif"
    fontSize: "0.7rem"
    fontWeight: 600
    letterSpacing: "0.14em"
  measure:
    fontFamily: "JetBrains Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "0.6875rem"
    fontWeight: 500
    lineHeight: 1
    fontFeature: "tnum"
  wordmark:
    fontFamily: "League Gothic, sans-serif"
    fontSize: "2.75rem"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "0.02em"
rounded:
  swatch: "2px"
  keycap: "4px"
  badge: "5px"
  ctl: "8px"
  card: "12px"
  full: "999px"
spacing:
  tight: "6px"
  strip: "12px"
  panel: "16px"
  card: "24px"
  page: "32px"
  ctl-height: "36px"
  ctl-height-sm: "30px"
  topbar-height: "52px"
  rail: "272px"
  rail-collapsed: "68px"
components:
  button-primary:
    backgroundColor: "{colors.primary-tint}"
    textColor: "{colors.fg}"
    typography: "{typography.control}"
    rounded: "{rounded.ctl}"
    padding: "0 14.4px"
    height: "{spacing.ctl-height}"
  button-neutral:
    backgroundColor: "{colors.panel-raised}"
    textColor: "{colors.fg}"
    typography: "{typography.control}"
    rounded: "{rounded.ctl}"
    padding: "0 14.4px"
    height: "{spacing.ctl-height}"
  button-ghost:
    textColor: "{colors.fg}"
    typography: "{typography.control}"
    rounded: "{rounded.ctl}"
    height: "{spacing.ctl-height}"
  button-ghost-hover:
    backgroundColor: "{colors.hover-wash}"
  button-destructive:
    backgroundColor: "color-mix(in oklab, #ff9b9b 8%, #1c1f25)"
    textColor: "{colors.danger}"
    typography: "{typography.control}"
    rounded: "{rounded.ctl}"
    height: "{spacing.ctl-height}"
  button-small:
    rounded: "{rounded.ctl}"
    padding: "0 12px"
    height: "{spacing.ctl-height-sm}"
  transport-button-live:
    backgroundColor: "{colors.live-accent}"
    textColor: "#ffffff"
    rounded: "{rounded.ctl}"
    height: "{spacing.ctl-height}"
  log-button:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.fg}"
    rounded: "{rounded.ctl}"
    padding: "6px 12px 6px 8px"
    height: "{spacing.ctl-height}"
  status-pill-stopped:
    backgroundColor: "{colors.ignition-stopped}"
    textColor: "{colors.muted}"
    typography: "{typography.status}"
    rounded: "{rounded.badge}"
    padding: "3.2px 7.2px"
  status-pill-live:
    backgroundColor: "{colors.live-accent}"
    textColor: "#ffffff"
    typography: "{typography.status}"
    rounded: "{rounded.badge}"
    padding: "3.2px 7.2px"
  status-pill-playback:
    backgroundColor: "{colors.playback-accent}"
    textColor: "{colors.ink}"
    typography: "{typography.status}"
    rounded: "{rounded.badge}"
    padding: "3.2px 7.2px"
  card:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.fg}"
    rounded: "{rounded.card}"
    padding: "24px"
  transport-card:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.card}"
    padding: "12px 14px"
  input:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.fg}"
    rounded: "{rounded.ctl}"
    padding: "8px 10.4px"
    height: "{spacing.ctl-height}"
  keycap:
    backgroundColor: "{colors.panel-raised}"
    textColor: "{colors.muted}"
    typography: "{typography.measure}"
    rounded: "{rounded.keycap}"
    height: "20px"
  nav-item-selected:
    backgroundColor: "{colors.selected-tint}"
    textColor: "{colors.fg}"
    rounded: "{rounded.ctl}"
    padding: "8px 10px"
  top-bar:
    backgroundColor: "{colors.ignition-stopped}"
    height: "{spacing.topbar-height}"
  rail:
    backgroundColor: "{colors.ignition-stopped}"
    width: "{spacing.rail}"
  table-header:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.dim}"
    typography: "{typography.label}"
    padding: "9px 10px"
---

# Design System: AutoLogger

## Overview

**Creative North Star: "Show Ignition"**

The shell itself says whether the session is live. AutoLogger is a dark, flat operating console where one cold blue accent does almost all the talking: it marks the primary action, the selected row, keyboard focus, and above all the transport state. When a session rolls or records, the top bar, the sidebar and the transport card take on that accent and get a soft glow. In playback the tint is softer. When the session stops, the frame dims to a near-black tint. Operators read live/not-live from the frame around their work, not from a lone red dot in a corner.

Density is a working console's: controls are compact (36px, 30px small), the type is a condensed-friendly grotesque, and timecode and measured values sit in a monospace with tabular figures. Surfaces are flat dark planes separated by 1px lines, with no glass, grain, sky grid or decorative gradient. Depth comes only from the ignition glow and from overlays. The system rejects the category default it was built against: a grey media tool with a lone red REC dot and its state hidden in a corner. It also replaces the retired V5 dark-glass look, which survives only as alias names (`--v5-*`, `glass-*`) that now resolve to the flat tokens.

Category colours are user data on their own channel: a number key cap plus a small swatch. They never colour labels, and they never compete with the accent.

**Key Characteristics:**
- Dark-only, flat planes: ground, panel and raised panel, divided by 1px lines.
- One accent (#5b7cff) for primary, selection, focus and ignition, and for nothing decorative.
- The transport state (stopped, rolling, recording, playback) drives the tint of the top bar, the rail and the transport card through `data-transport` on the app root.
- Three faces with fixed jobs: Barlow for the UI, Barlow Condensed in uppercase with tracking for labels, tabs, column heads and status, and JetBrains Mono only for timecode and measured values.
- Two radii (8px controls, 12px cards) and two control heights (36px, 30px).
- One selected state everywhere: an accent tint plus a 1px inset accent line.

## Colors

A near-black blue-grey neutral ladder, lit by a single cold blue that rises and falls with the transport.

### Primary
- **Ignition Blue** (accent): the only accent. It's the primary action's edge on hover, the active tab's underline, the focus ring (2px outline, 2px offset), the caret, the scrollbar thumb on hover, the accent marker and playhead, and the source of every ignition mix. Text that must read as accent on a dark ground uses **Lifted Ignition** (accent-text, 72% accent toward white), which clears AA on the live transport card.
- **Primary Tint / Primary Line** (primary-tint, primary-line): the primary button's fill (26% accent into the raised panel) and its edge (55% accent into the line).
- **Live Accent** (live-accent, 88% accent toward black): the rolling/recording pill, the pressed transport button and the live playhead. White text on it.
- **Playback Accent** (playback-accent, 65% accent toward white): the playback pill and pressed control, with ink text on it.

### Neutral
- **Ink** (ink): text on the light playback pill and on the accent-filled default badge.
- **Show Floor** (ground): the page ground, the Settings view, input wells, and the scrollbar track.
- **Panel** (panel): cards, the transport card at rest, table header rows, the log buttons.
- **Raised Panel** (panel-raised): neutral and secondary buttons, popovers and menus, key caps, muted fills.
- **Hairline / Strong Hairline** (line, line-strong): every 1px divider and card edge, plus input borders and scrollbar thumbs.
- **Foreground / Muted / Dim** (fg, muted, dim): the three text tiers. Body and active labels use foreground; descriptions, inactive tabs and the stopped pill use muted; column heads, crumb separators and secondary timecodes use dim.
- **Hover Wash** (hover-wash, 6% white): the ghost hover and the sidebar hover. It's never a selected state.

### Tertiary (status, not decoration)
- **Danger Rose** (danger, with danger-line as its edge): destructive buttons (8% rose into the raised panel) and destructive text.
- **Record Red** (rec-glyph): only the idle roll/record glyph and the mic glyph while recording. It's never a surface.

### Ignition mixes
- **Stopped Frame** (ignition-stopped, 10%), **Live Frame** (ignition-live, 25%, shared by rolling and recording) and **Playback Frame** (ignition-playback, 18%) tint the top bar and the rail. The two always take the same mix, so they read as one lit frame. The transport card goes to 13% accent into #121419 when live and 8% into the panel in playback. The soft glow (live-glow, 46%, 30% in playback) shows only on lit elements.

### Named Rules
**The One Accent Rule.** #5b7cff and its mixes are the only hue in the chrome. Category colours, chart series (`--viz-*`) and the Google sign-in button are separate data and vendor channels; they never style chrome.

**The Ignition Rule.** The transport state is shown by the frame. A surface that needs to show live state reads the `--tx-*` variables that `data-transport` sets, and never hard-codes a state colour. Every pill fg/bg pair clears AA.

**The Category Channel Rule.** A category colour appears only as a 2px-radius swatch, a hover edge (55%), and a latched or pressed tint (22% into the panel). It never colours a label.

## Typography

**UI Font:** Barlow (with Segoe UI, system-ui)
**Label Font:** Barlow Condensed (with Arial Narrow, Barlow)
**Measure Font:** JetBrains Mono (with ui-monospace, SF Mono, Menlo)

**Character:** a plain, slightly condensed grotesque for the work, its condensed cut in uppercase with tracking for anything that names or classifies, and a monospace that appears only where a number is measured.

### Hierarchy
- **Timecode Hero** (JetBrains Mono 600, 2.125rem, 1.625rem in the compact transport card and 1.5rem on phones; tabular figures): the session timecode. It turns Lifted Ignition with the soft glow while the session rolls or records.
- **Headline** (Barlow 600, 1.5rem): Settings section headings.
- **Title** (Barlow 600, 1.375rem): the Settings view title. Sheet and card titles use Barlow 600 at their primitive size.
- **Body** (Barlow 400, 15px, line-height 1.45): the body baseline. Top-bar crumbs use 15px (14px on phones), tables 0.84rem, and descriptions 0.875rem in muted.
- **Control** (Barlow 600, 0.8125rem, line-height 1): every button label, in sentence case. Log buttons use 0.875rem.
- **Tab** (Barlow Condensed 600, 0.8125rem, 0.1em tracking, uppercase): the workspace line tabs.
- **Label** (Barlow Condensed 600, 0.6875rem, 0.12em tracking, uppercase): table column heads, sidebar group labels ("Recent sessions", "Archived") and timeline labels.
- **Status** (Barlow Condensed 600, 0.7rem, 0.1em tracking, 0.14em on the transport pill, uppercase): badges and the STOPPED / ROLLING / REC / PLAY pill.
- **Measure** (JetBrains Mono 500, 0.6875–0.75rem, tabular figures): feed timecodes, durations, the session timecode in the top bar, and key caps (600).
- **Wordmark** (League Gothic 400, 2.75rem, uppercase, 0.02em tracking): the "AutoLogger" name on the sign-in card only. It's a non-normative brand face, not a UI face.

### Named Rules
**The Measured-Only Mono Rule.** JetBrains Mono sets timecode, durations, levels and key caps, and nothing else. It's never used as a stylistic voice.

**The Condensed Caps Rule.** Uppercase with tracking belongs to Barlow Condensed on labels, tabs, column heads and status. Buttons, Settings rows, nav rows and headings stay sentence case in Barlow.

## Layout

The desktop shell is viewport-locked. A full-width top bar (52px) runs above a left sidebar (272px, collapsing to a 68px icon rail) and the main column, and the workspace scrolls internally. The top bar reads left to right: sidebar trigger, Team switcher, chevron, Show switcher, chevron, then the status pill with the session name. There is no wordmark and there are no field labels. The main column stacks the transport card (inset 12px, or 16px from md up, with 12px/14px inner padding), the logging strip of category buttons (6px gaps, wrapping rows), the line tabs, and the event feed card.

Settings is a full overlay view on the page ground. It has a 250px nav column with a hairline right edge and a content column capped at 860px (32px side padding, 18px between sections). Each setting is a labelled row whose control column is 260px wide. Members, shows and event buttons edit in a right-side sheet (420px max) with a hairline footer holding Cancel and Save. Section save bars stick to the bottom of their card above a hairline.

Below 768px the document unlocks and scrolls. The sidebar becomes a left sheet (18rem) opened from the top-bar trigger. The Settings nav folds into a horizontally scrolling row of bordered chips. The transport card stacks its meta, timecode and controls above the timeline. Phone controls keep a 44px touch floor.

## Elevation & Depth

The system is flat. Planes sit on the ground and are separated by tone (ground, panel, raised panel) and 1px hairlines, never by resting shadows. Shadow appears in exactly two roles: the accent glow, which is ignition (it marks live state and only appears while the transport is lit), and the playhead halo, which keeps a 2px line legible.

### Shadow Vocabulary
- **Frame glow** (`box-shadow: 12px 0 36px -18px <live-glow>` on the rail, `0 12px 36px -18px <live-glow>` under the top bar): rolling or recording only.
- **Transport card glow** (`box-shadow: 0 10px 34px -14px <live-glow>, 0 0 0 1px color-mix(in oklab, #5b7cff 28%, transparent)`): live. Playback uses `0 10px 30px -18px` at the softer glow.
- **Pill and pressed control glow** (`box-shadow: 0 0 18px -4px <glow>` on the pill, `-6px` on the control): follows the transport. It's transparent when stopped.
- **Playhead halo** (`box-shadow: 0 0 10px 1px color-mix(in oklab, #5b7cff 75%, transparent)`, 60% in playback): none when stopped.
- **Timecode glow** (`text-shadow: 0 0 20px <live-glow>`): the hero timecode while live.

### Named Rules
**The Glow Means Live Rule.** Glow is reserved for ignition. A stopped shell carries no glow anywhere, and no element uses glow for decoration or hover.

**The State Easing Rule.** Ignition tints, edges and glows ease over 0.6s `cubic-bezier(0.16, 1, 0.3, 1)`. Under reduced motion they change instantly, and the REC live dot (a 1.2s two-step blink) holds still.

## Shapes

There are two corners. Controls (buttons, inputs, nav rows, selects, sidebar items, tab lids) take 8px, and cards, the transport card and the feed sheet take 12px. Smaller radii belong to small objects: key caps at 4px (a hairline with a 2px bottom edge), badges and pills at 5px, and category swatches at 2px. The live dot, playhead and scrollbar thumbs are fully rounded. Every edge is a 1px line in the hairline tone. An accent-mixed edge appears only on the primary button, on selected and lit elements, and on the ignited frame.

## Components

### Buttons
Flat and compact. The default variant is the primary action.
- **Shape:** 8px corners, 36px tall (30px small, 24px extra-small), 1px border, label in the control type, 0.4rem icon gap, 16px icons.
- **Primary:** the primary tint fill with the primary line edge and foreground text. On hover the edge turns full accent.
- **Neutral (outline/secondary):** a raised-panel fill with a hairline edge. On hover the edge lifts to 25% foreground into the line.
- **Ghost:** transparent, with the hover wash on hover. **Destructive:** an 8% rose fill, the danger-line edge and rose text.
- **Focus:** a 3px ring at 50% accent. **Disabled:** 45% opacity, muted text, no hover.
- **Transport:** neutral at rest. While pressed (`data-active`) it fills with the transport's pill colours and glow, so a pressed Roll ignites with the shell.

### Log buttons (signature)
The logging strip's category buttons: panel fill, hairline edge, foreground label at 0.875rem. A leading key cap (1–9, only for the first nine while rolling) and a 2px-radius category swatch sit in front of the label, and long labels wrap rather than clip. The caller sets `--cat`: hover takes a 55% category edge, latched-on or pressed takes a full category edge and a 22% category tint, and a press nudges the button down 1px (not under reduced motion).

### Status pill
A badge in the status type at 0.14em tracking. It reads STOPPED (the stopped frame, muted text, hairline), ROLLING or REC (the live accent with white text), or PLAY (the playback accent with ink text). The same label and colours appear in the top bar and the transport card. The top-bar pill carries an 8px live dot that blinks while recording.

### Cards / Containers
- **Corner Style:** 12px.
- **Background:** panel.
- **Shadow Strategy:** none at rest (see Elevation & Depth). The transport card is the only card that ignites.
- **Border:** a 1px hairline.
- **Internal Padding:** 24px vertically and 24px at the sides by default. The transport card uses 12px/14px, and the sign-in card 32px/28px.

### Inputs / Fields
- **Style:** a well on the ground colour, a strong-hairline edge, 8px corners, 36px tall, muted placeholder.
- **Focus:** the edge turns accent.
- **Error / Disabled:** a danger edge when invalid; 50% opacity when disabled.

### Tabs
- **Line tabs (workspace):** tab type, muted until active, over a hairline. The active tab takes the foreground and a 2px accent underline that overlaps the hairline. The focus ring is keyboard-only.
- **Nav tabs (Settings):** a vertical list of sentence-case Barlow rows at 0.875rem, muted until hovered. The current row is in the selected state.

### Navigation
- **Top bar:** see Layout. Crumbs are ghost buttons. The bar takes the transport frame tint and a hairline edge mixed 22% with the accent, or 70% accent while live.
- **Sidebar:** New session and Import, a search for the current show, and the show's sessions grouped under labels, with Settings in the footer. The sidebar surface is the transport frame tint. Menu items are 8px rows with the hover wash on hover, and the active session is in the selected state.

### Selected state
Every selection uses the same pair: `background: selected-tint; box-shadow: inset 0 0 0 1px selected-line`. That covers sidebar items, Settings nav rows, menu, select and toggle items, and checked checkboxes. Selected rows add semibold weight. No second selection idiom exists.

### Key caps
JetBrains Mono 600 at 0.6875rem, 20px tall, a raised-panel fill, a hairline with a 2px bottom edge, 4px corners, muted text.

### Feed table
Column heads use the label type in dim on the panel, sticky, over a hairline. Timecode cells use measure type. A timeline-marker jump flashes the row with an 18% accent fill.

### Timeline
A slim lane with the waveform. The played portion of the waveform follows `--tx-wave-progress`: a 26% foreground when stopped, the accent at 72–80% otherwise. The playhead is a 2px fully rounded line in `--tx-playhead` (the foreground when stopped) with its halo.

### Browser surfaces
Text selection is 45% accent into the ground, the caret is the accent, and scrollbars are 8px with a ground track and a strong-hairline thumb that turns accent on hover.

## Do's and Don'ts

### Do:
- **Do** read surface, line and text colours from the `--si-*` tokens. Read state colours from the `--tx-*` variables under `data-transport`.
- **Do** build controls at `--h-ctl` (36px) or `--h-sm` (30px) with `--r-ctl` (8px), and containers with `--r-card` (12px).
- **Do** use the one selected state (`--sel-bg` plus a 1px inset `--sel-line`) for any current or chosen item.
- **Do** set labels, tabs, column heads and status in Barlow Condensed in uppercase with tracking, and timecode and measured values in JetBrains Mono with tabular figures.
- **Do** keep category colours to the swatch, the hover edge and the latched or pressed tint, paired with a 1–9 key cap.
- **Do** honour reduced motion: ignition changes instantly and the REC dot doesn't blink.

### Don't:
- **Don't** introduce a second accent hue, or colour chrome with category, chart or vendor colours.
- **Don't** add glass, backdrop blur, film grain, background glows or gradient fills to surfaces. The V5 dark-glass look is retired.
- **Don't** use glow at rest or on hover. Glow means the transport is lit.
- **Don't** show transport state only with a red dot. The frame, the pill colour and the pill word carry it together.
- **Don't** put an uppercase kicker or eyebrow above a heading or card title.
- **Don't** use JetBrains Mono for prose, headings or labels, or uppercase a button label.
