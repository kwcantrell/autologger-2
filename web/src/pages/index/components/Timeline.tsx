// Slice 5: session.js deleted; all timeline state is React-owned.

import clsx from 'clsx';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { LogEvent, SessionStatus } from '../../../api/types';
import {
  eventTimelineSec,
  parseSmpteToSec,
  safeTimelineSec,
  sessionFrameRate,
} from '../../../shared/utils/audioClips';
import { fmtHmsFromSec } from '../../../shared/utils/timecode';
import type { AudioClipLite } from '../../../shared/utils/waveformMerge';
import { clipIndexContainingTimelineSec } from '../../../shared/utils/waveformSvg';
import { useZoomRail } from '../hooks/useZoomRail';
import { groupTimelineMarkers } from '../utils/markerGrouping';
import { revealEventInFeed } from '../utils/revealEventInFeed';
import { MarkerNav } from './MarkerNav';
import { TimelineClips } from './timeline/TimelineClips';
import { TimelineMarkers } from './timeline/TimelineMarkers';
import { TimelineTicks } from './timeline/TimelineTicks';
import { TimelineWaveform } from './timeline/TimelineWaveform';

// --- converted class strings (were Timeline.module.css) ---
//
// TWO-MODE CONVERSION. Timeline renders both standalone and (in this app, always)
// inside #v4-log-session. The former ~50-rule `:global(#v4-log-session)` block was
// pure specificity armor over the module's own hashed locals; the base rule = the
// standalone look, the armored rule = the session-context look. Both are preserved:
// base utilities give the standalone look, `[#v4-log-session_&]:` ancestor variants
// give the session-context overrides. #v4-log-session is emitted by SessionWorkspace
// (retention rule).
//
// RETAINED LITERAL CLASS STRINGS. A handful of elements keep their legacy class name
// (timelineMarker, timelineMarkerSelected, timelineMarkerPlayheadGlow, timelinePlayhead,
// timelineClipActive, timelineWaveforms, timelineWaveformFill, timelineWaveformProgress,
// timelineShell, timelineTrack, v4TlTrackLive) so the perf-debug toggles and the
// hide-internal marker rule — both parked as @layer components rules in tailwind.css —
// can still target them. Those class families are dropped in Task 11 with perfDebug.
//
// LOCAL CUSTOM PROPERTIES stay local (--timeline-clip-strip-h, --v5-timeline-r, --mcol,
// --marker-glow-col, --nav-cat-col, --tooltip-cat-col, --v4-ext-row-pad-y,
// --v4-zoom-rail-below-extra); utilities reference them via (--name). Dynamic inline
// styles (playhead/marker/waveform geometry, zoom rail) are untouched.

// ---- Deck / meta rules (were :global(#v4-log-session ...) in SessionWorkspace.module.css) ----
// These style Timeline-emitted DOM and move here with their target (contextual overrides
// travel with the element that renders them). All were #v4-log-session-scoped; Timeline is
// always inside it, so they convert as plain utilities.

const TL_STACK =
  'v5-session-timeline-stack flex flex-col flex-[1_1_auto] min-h-0 w-full gap-0 box-border';

// The v5-panel-head / -head__main / -head__actions / -eyebrow group is a MULTI-EMITTER
// class family (Timeline + SessionWorkspace + FeedShell all emit it); its rules live in a
// commented @layer components block in tailwind.css (slice 5b) so all three emitters
// resolve from one place. Timeline keeps emitting the bare legacy class strings.
const PANEL_HEAD = 'v5-panel-head v5-panel-head--timeline';
const PANEL_HEAD_MAIN = 'v5-panel-head__main';
const PANEL_EYEBROW = 'v5-panel-eyebrow';

const DECK_HEADER =
  'v4-playback-deck-header flex flex-row items-center justify-start gap-[0.75rem] w-full min-w-0 flex-[0_0_auto]';
const DECK_TITLE_CLUSTER =
  'v5-deck-title-cluster flex flex-row flex-wrap items-baseline justify-start gap-[0.45rem_0.65rem] min-w-0 flex-[1_1_auto]';
// .v4-playback-deck-title base is unstyled locally; the #v4-log-session rule is the
// only styling and applies always here. `flex-[0_1_auto]` from the cluster child rule.
const DECK_TITLE =
  'v4-playback-deck-title flex-[0_1_auto] m-0 min-w-0 [font-family:"Inter",var(--font-poppins),system-ui,sans-serif] text-[1.35rem] font-semibold tracking-[-0.02em] leading-[1.2] text-v5-text normal-case overflow-hidden text-ellipsis whitespace-nowrap';
const DECK_SESSION_META =
  'v5-deck-session-meta inline-flex flex-row flex-wrap items-baseline justify-start gap-[0.35rem_0.45rem] min-w-0 flex-[0_1_auto]';
const DECK_META_SEP = 'v5-deck-meta-sep text-white/[0.32] font-medium select-none';
// .v4-episode.v5-studio-name-inline — the #v4-log-session .v5-studio-name-inline rule sets
// weight 600, but the higher-specificity `#v4-log-session #studio-name.v4-episode` rule
// overrode it to weight 400 (+ capitalize, font-variation-settings:normal). Both those source
// rules were deleted here, so the resolved cascade (font-weight 400) is written directly.
const STUDIO_NAME =
  'v4-episode v5-studio-name-inline flex-[0_1_auto] [font-family:"Inter",var(--font-poppins),system-ui,sans-serif] text-[0.9rem] font-normal [font-variation-settings:normal] capitalize text-v5-primary whitespace-nowrap';
// .v4-session-date.v5-session-date-inline — the #v4-log-session .v5-session-date-inline rule.
const SESSION_DATE =
  'v4-session-date v5-session-date-inline flex-[0_1_auto] text-[0.72rem] font-medium tracking-[0.1em] uppercase text-v5-muted whitespace-nowrap';
// ---- v4-scratch ext row / nav ----
// .v4ExtRow base + #v4-log-session override (padding + flex-basis with --v4-ext-row-pad-y,
// background transparent, border-bottom none). --v4-ext-row-pad-y is a local prop set here.
// Height hugs the nav-area row (--v4-nav-area-h) instead of the taller legacy
// --v4-ext-row-h (= 2× nav-area), which left ~20px of empty vertical padding and made
// the timeline panel taller than Session Controls.
const V4_EXT_ROW =
  '[--v4-ext-row-pad-y:0.15rem] flex flex-row items-center gap-[0.5rem] w-full min-w-0 overflow-visible box-border py-(--v4-ext-row-pad-y) pl-(--v4-nav-edge-m) pr-(--v4-nav-edge-m) flex-[0_0_calc(var(--v4-nav-area-h)+2*var(--v4-ext-row-pad-y))] h-[calc(var(--v4-nav-area-h)+2*var(--v4-ext-row-pad-y))] min-h-[calc(var(--v4-nav-area-h)+2*var(--v4-ext-row-pad-y))] max-h-[calc(var(--v4-nav-area-h)+2*var(--v4-ext-row-pad-y))] bg-transparent border-b-0';

// Single marker caption chip (cat accent + label + marquee) — replaces the old
// dual floating cat-pill + message bar above the track.
// Always full timeline width; message marquees when it overflows the chip.
// BG: solid 20% category accent + 80% base navy (via --nav-cat-col on the chip).
// Body carries the full chrome border; the accent is absolutely painted over the
// left/top/bottom strokes so ONLY its right hairline remains visible.
const MARKER_CHIP =
  'relative flex h-[1.7rem] min-h-[1.7rem] max-h-[1.7rem] w-full min-w-0 items-stretch overflow-hidden rounded-t-[0.45rem] rounded-b-none border-0 [--marker-chip-border:var(--v5-border)] [--marker-chip-accent-w:0.28rem] [background:color-mix(in_srgb,var(--nav-cat-col,#6b7280)_20%,rgba(11,16,30,0.82)_80%)] [transition:opacity_0.45s_ease,background_0.3s_ease]';
const MARKER_CHIP_LIT =
  'opacity-100 [--marker-chip-border:rgba(148,163,184,0.28)] shadow-[0_0_18px_-6px_color-mix(in_srgb,var(--nav-cat-col,#38bdf8)_45%,transparent)]';
const MARKER_CHIP_IDLE = 'opacity-[0.52]';
// Overpaints the body's left + TL/BL corner strokes (borders paint under
// descendants). Right edge is the only hairline.
const MARKER_CHIP_ACCENT =
  'pointer-events-none absolute -inset-y-[2px] -left-[2px] z-[1] w-[calc(var(--marker-chip-accent-w)+2px)] rounded-tl-[0.45rem] rounded-tr-none rounded-b-none border-0 [box-shadow:1px_0_0_0_var(--marker-chip-border)]';
const MARKER_CHIP_BODY =
  'relative flex min-w-0 max-w-full flex-1 items-center gap-[0.4rem] overflow-visible rounded-t-[0.45rem] rounded-b-none border border-solid [border-color:var(--marker-chip-border)] py-0 pl-[calc(var(--marker-chip-accent-w)+0.45rem)] pr-[0.45rem] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]';
const MARKER_CHIP_CAT =
  '[font-family:"Inter",var(--font-poppins),system-ui,sans-serif] relative z-[2] shrink-0 text-[0.62rem] font-bold leading-none tracking-[0.12em] uppercase text-white';
const MARKER_CHIP_SEP =
  'relative z-[2] shrink-0 self-center text-white/40 leading-none select-none';
// Marquee cell/track/value — same overflow dance as before (imperative class toggle).
// leading-snug keeps descenders (g/y) inside the line box so overflow-x clip doesn't
// bite the glyph tails.
const NAV_MSG_CELL =
  'relative z-[2] flex min-w-0 flex-1 items-center justify-start overflow-hidden whitespace-nowrap text-left';
const NAV_MSG_TRACK =
  'inline-flex min-w-[max-content] items-center translate-x-0 motion-reduce:animate-none!';
const NAV_MSG_VALUE =
  '[font-family:"Inter",var(--font-poppins),system-ui,sans-serif] text-[0.78rem] font-medium leading-snug tracking-[0.02em] normal-case text-white whitespace-nowrap';
// `[display:inline]` NOT `inline` — bare `inline` collides with chrome.css `.inline`.
const NAV_MSG_GAP = '[display:inline]';
// Hang = chip height exactly — chip sits flush on the track (one joined element).
const MARKER_CHIP_HANG = 'h-[1.7rem]';

// ---- timeline row / track / shell (v4 base + #v4-log-session v5 overrides) ----
// .v4TimelineRow base + #v4-log-session (min-height with lane-delta, height auto).
const V4_TIMELINE_ROW =
  'flex flex-row items-center w-full min-w-0 box-border gap-0 flex-[1_1_auto] h-auto max-h-none min-h-[calc(var(--v4-tl-row-h)+2*var(--v4-nav-grid-my,0.5rem)+var(--v5-timeline-lane-delta))]';
// Strip scrub column: track (~80% lane) + zoom rail under it. Sized to content so
// the transport aside cannot squeeze the zoom row under the feed.
const V4_TIMELINE_ROW_STRIP =
  'flex h-auto w-full min-w-0 flex-[0_0_auto] flex-row items-stretch box-border gap-0 overflow-visible';
// Mobile ~88% lane. Desktop subtracts the chip hang so the strip band stays put.
const TIMELINE_TRACK_STRIP_H =
  'h-[calc(var(--v5-timeline-lane-h)*0.88)] max-h-[calc(var(--v5-timeline-lane-h)*0.88)] min-h-[calc(var(--v5-timeline-lane-h)*0.88)] md:h-[calc(var(--v5-timeline-lane-h)*0.88-1.7rem)] md:max-h-[calc(var(--v5-timeline-lane-h)*0.88-1.7rem)] md:min-h-[calc(var(--v5-timeline-lane-h)*0.88-1.7rem)]';
// Compact zoom rail — sits under the scrubber at full width.
const ZOOM_RAIL_STRIP =
  'flex flex-row flex-nowrap items-center gap-[0.3rem] w-full min-w-0 relative box-border px-0 pt-0 pb-0 flex-[0_0_auto]';
// .v4TlTrack + .v4TlTrackLive (both classes on the row child). Resolved cascade under
// #v4-log-session: the higher-specificity `.v4TimelineRow > .v4TlTrack` v5 rule (id+2class)
// wins for flex (100 1 0 — fills the row width) and min-height; `.v4TlTrackLive` (id+1class)
// supplies the column stack, items-stretch, overflow-visible, and the v5 gap 0.45rem. The
// literal `v4TlTrackLive` is retained for the perf-debug @layer rules that target it.
const V4_TL_TRACK_LIVE =
  'v4TlTrackLive flex flex-[100_1_0] flex-col items-stretch self-center justify-center p-0 bg-transparent min-w-0 h-auto max-h-none overflow-visible gap-[0.3rem] min-h-[calc(var(--v4-tl-bar-h)+2*var(--v4-nav-grid-my,0.5rem)+var(--v5-timeline-lane-delta))]';
// Tight gap under ticks so zoom sits closer to the border-centered labels.
const V4_TL_TRACK_LIVE_STRIP =
  'v4TlTrackLive flex h-auto w-full min-w-0 flex-[0_0_auto] flex-col items-stretch justify-start gap-[0.1rem] overflow-visible bg-transparent p-0';
// .timelineShell base + `.v4TlTrackLive .timelineShell` base + #v4-log-session override
// (radius/no-border/transparent/no-shadow, padding 0.35rem 0.45rem 0.3rem).
// NOTE on padding: the source had two identical-specificity #v4-log-session shell rules —
// an earlier one with `padding-top:0` and a later one with `padding:0.35rem 0.45rem 0.3rem`.
// Empirically (measured against the frozen baseline) the shell renders with ZERO padding and
// full width, i.e. the shorthand rule does NOT win in the shipped bundle. Matching the
// baseline (the pixel gate is ground truth), the converted shell carries no padding.
const TIMELINE_SHELL =
  'timelineShell relative w-full box-border flex flex-col items-stretch gap-[0.3rem] flex-[0_1_auto] min-w-0 max-w-full min-h-0 h-auto max-h-none rounded-v5-md border-0 bg-transparent shadow-none p-0 mt-0';
// overflow-y must stay non-visible when overflow-x is auto (CSS forces y→auto);
// tick hang-space is reserved by an in-flow spacer under the track instead.
const TIMELINE_VIEWPORT_STRIP =
  'timeline-hide-scrollbar h-auto min-h-0 w-full max-w-full flex-[0_0_auto] overflow-x-auto overflow-y-hidden rounded-t-none rounded-b-[0.65rem] pb-0';
// .timelineInner base + `.v4TlTrackLive .timelineInner` (min-h 0) + #v4-log-session (gap 0.32rem).
const TIMELINE_INNER = 'flex flex-col min-w-full box-border min-h-0 gap-[0.25rem]';
// Shared track chrome (lane fill + shimmer) + strip height token.
// Square top joins flush with the marker chip; no left border (would frame the
// accent swatch above); bottom/right keep the lane pillow.
const TIMELINE_TRACK_CHROME =
  'timelineTrack relative w-full overflow-hidden cursor-ew-resize flex-shrink-0 isolate [--v5-timeline-r:0.65rem] rounded-t-none rounded-b-[var(--v5-timeline-r)] border border-t-0 border-l-0 border-white/[0.055] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] [background:linear-gradient(180deg,rgba(10,14,24,0.9),rgba(4,6,12,0.82))] before:content-[""] before:absolute before:inset-0 before:rounded-[inherit] before:pointer-events-none before:z-0 before:opacity-60 before:[background-image:linear-gradient(100deg,rgba(34,138,179,0.2)_0%,rgba(29,49,61,0.3)_17%,rgba(49,94,143,0.3)_36%,rgba(29,49,61,0.3)_56%,rgba(49,94,143,0.3)_75%,rgba(34,138,179,0.2)_94%)] before:[background-size:200%_100%] before:[background-repeat:repeat-x] before:animate-v5-timeline-mock-shimmer motion-reduce:before:animate-none motion-reduce:before:[background-position:0_0]';
const TIMELINE_TRACK_STRIP = `${TIMELINE_TRACK_CHROME} ${TIMELINE_TRACK_STRIP_H}`;
// .timelineTrackLayers base + #v4-log-session (z-1) + ::before divider (z-3, v5 color).
const TIMELINE_TRACK_LAYERS =
  'absolute inset-0 z-[1] rounded-[inherit] before:content-[""] before:absolute before:left-[0.4rem] before:right-[0.4rem] before:top-1/2 before:h-px before:-translate-y-1/2 before:rounded-none before:bg-[rgba(148,163,184,0.38)] before:pointer-events-none before:z-[3]';
// (.timelineTicks styling lives on TimelineTicks.tsx's own div.)

// ---- playheads (waveform/clip classes live on their sub-components) ----

// .timelineHoverPlayhead + #v4-log-session visible color. Visible modifier via clsx.
const TIMELINE_HOVER_PLAYHEAD =
  'absolute top-1/2 bottom-auto left-0 w-px h-[calc(100%-0.85rem)] m-0 rounded-[999px] [background:color-mix(in_srgb,var(--color-muted)_72%,transparent)] -translate-x-1/2 -translate-y-1/2 z-[3] pointer-events-none opacity-0 [transition:opacity_0.1s_ease]';
const TIMELINE_HOVER_PLAYHEAD_VISIBLE = 'opacity-55 bg-[rgba(229,238,252,0.28)]';
// .timelineMarkerPlayheadGlow base (big glow shadow) + #v4-log-session (smaller v5 shadow).
// --marker-glow-col is runtime-set. base opacity/transform driven by JS inline styles.
const TIMELINE_MARKER_PLAYHEAD_GLOW =
  'timelineMarkerPlayheadGlow absolute top-1/2 left-0 w-[0.32rem] h-[0.32rem] m-0 rounded-full pointer-events-none z-[1] opacity-0 [will-change:opacity,transform] [transition:opacity_0.16s_ease-out,transform_0.16s_ease-out,left_0.05s_linear] bg-transparent [box-shadow:0_0_14px_color-mix(in_srgb,var(--marker-glow-col,var(--v5-primary))_16%,transparent)]';
// .timelinePlayhead base (white) + #v4-log-session (v5 color, no shadow).
const TIMELINE_PLAYHEAD =
  'timelinePlayhead absolute top-1/2 bottom-auto left-0 w-0.5 h-[calc(100%-0.85rem)] m-0 rounded-[999px] -translate-x-1/2 -translate-y-1/2 z-[6] pointer-events-none bg-[rgba(229,238,252,0.82)] shadow-none';

// .timelineMarkerTooltip (fixed, v5 glass-face-aside — the second .timelineMarkerTooltip
// block wins in source order). Visible modifier toggles opacity/visibility.
const MARKER_TOOLTIP =
  'timelineMarkerTooltip fixed z-[10060] max-w-[min(72vw,440px)] px-[0.55rem] py-[0.4rem] rounded-lg border border-v5-border glass-face-aside text-v5-text text-[0.76rem] leading-[1.35] pointer-events-none panel-elevate [white-space:pre-line] [overflow-wrap:anywhere] opacity-0 invisible [transition:opacity_0.16s_ease]';
const MARKER_TOOLTIP_VISIBLE = 'opacity-100 visible';
const MARKER_TOOLTIP_CAT = 'block text-v5-muted font-semibold mb-[0.12rem]';
const MARKER_TOOLTIP_MSG = 'block text-v5-text';

// :global(.timeline-hover-tooltip) — base + v5 override (glass-face-aside). Timeline-emitted.
const HOVER_TOOLTIP =
  'timeline-hover-tooltip fixed z-[10055] max-w-[min(72vw,280px)] px-[0.5rem] py-[0.35rem] rounded-lg border border-v5-border glass-face-aside text-v5-text text-[0.78rem] font-mono [font-variant-numeric:tabular-nums] leading-[1.35] pointer-events-none panel-elevate';

// ---- zoom rail ----
// .timelineZoomTooltip (v4 variant) + #v4-log-session (v5 glass). Positioned above rail.
const ZOOM_TOOLTIP =
  'absolute left-1/2 bottom-[calc(100%+6px)] top-auto -translate-x-1/2 px-[0.5em] py-[0.2em] [font-family:var(--font-poppins)] text-[0.65rem] font-extrabold leading-[1.2] whitespace-nowrap z-[5] pointer-events-none rounded-[0.45rem] glass-face-strong border border-v5-border text-v5-text panel-elevate';
// .timelineZoomValue + .v4TimelineZoomPct + #v4-log-session (v5 bg/border/color).
// NOTE: the source `input.timelineZoomValue` started from `font: inherit` then re-set
// line-height/size/family in later rules. Expressing `font:inherit` as an arbitrary
// property here would (by generated-stylesheet order) reset the explicit line-height back
// to the inherited value and inflate the box height, so the final resolved metrics are
// written directly instead (family Inter, size 0.62rem, weight 600, line-height 1.2).
const ZOOM_VALUE =
  'appearance-none leading-[1.2] box-border m-0 flex-[0_0_3.65rem] w-[3.65rem] min-w-[3.65rem] max-w-[3.65rem] [direction:ltr] [text-indent:0] text-center rounded-[0.45rem] border border-v5-border-strong bg-[rgba(7,11,20,0.72)] text-v5-primary [font-family:"Inter",var(--font-poppins),system-ui,sans-serif] text-[0.62rem] font-semibold [font-variant-numeric:tabular-nums] px-[0.2rem] py-[0.1rem] focus:outline focus:outline-1 focus:outline-accent focus:outline-offset-1';
// .v4ZoomRange + .timelineZoomRange + `.v4TimelineZoomRail .timelineZoomRange` +
// #v4-log-session (v5 bg/border, radius). --v4-zoom-handle-h drives min-height.
const ZOOM_RANGE =
  'relative flex-[1_1_0] min-w-0 min-h-(--v4-zoom-handle-h) h-(--v4-zoom-handle-h) isolate rounded-[0.55rem] bg-white/[0.08] border border-white/[0.06]';
// .v4ZoomBar + .timelineZoomBar + #v4-log-session (v5 gradient + glow). base 2.75rem×120%.
const ZOOM_BAR =
  'absolute top-1/2 left-0 w-[2.75rem] h-[120%] -translate-y-1/2 z-[1] box-border pointer-events-auto cursor-grab [touch-action:none] select-none active:cursor-grabbing [background:linear-gradient(90deg,var(--v5-primary),var(--v5-primary2))] shadow-[0_0_12px_rgba(56,189,248,0.25)]';
// .v4ZoomHandle + button.v4ZoomHandle + .timelineZoomHandle + #v4-log-session (v5 bg/border).
// base handle is round 1.2× the token size; button variant sets transparent text + display block.
// NOTE: the base rule set `background-clip: padding-box`, but the later #v4-log-session
// `background: rgba(...)` SHORTHAND reset background-clip to its `border-box` initial — so the
// converted handle omits background-clip (border-box default), matching the baseline (the dark
// bg fills under the 45%-cyan border, keeping the ring dim instead of letting the bar show).
const ZOOM_HANDLE =
  'absolute top-1/2 left-0 [transform:translate3d(-50%,-50%,0)] w-[calc(var(--v4-zoom-handle-w)*1.2)] h-[calc(var(--v4-zoom-handle-h)*1.2)] min-w-[calc(var(--v4-zoom-handle-w)*1.2)] min-h-[calc(var(--v4-zoom-handle-h)*1.2)] p-0 m-0 rounded-full box-border z-[2] flex-shrink-0 [touch-action:none] cursor-grab appearance-none block text-transparent text-[0px] leading-none active:cursor-grabbing bg-[rgba(15,23,42,0.95)] border-2 border-[rgba(56,189,248,0.45)] hover-always:border-[#11141b] hover-always:bg-white active:border-[#11141b] active:bg-white [&::-moz-focus-inner]:border-0 [&::-moz-focus-inner]:p-0';

declare global {
  interface Window {
    AutoLogger_setManualScrubSec?: (sec: number | null) => void;
  }
}

function fmtSessionDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}/${d.getUTCFullYear()}`;
}

/** Marker tooltip placement matches session.js's showTimelineMarkerTooltip math. */
function placeTooltip(
  el: HTMLElement,
  clientX: number,
  clientY: number,
  defaultW = 180,
  defaultH = 30,
): void {
  const pad = 10;
  const tw = el.offsetWidth || defaultW;
  const th = el.offsetHeight || defaultH;
  let left = clientX + 12;
  let top = clientY - th - 12;
  const maxLeft = window.innerWidth - tw - pad;
  if (left > maxLeft) left = Math.max(pad, clientX - tw - 12);
  if (top < pad) top = Math.min(window.innerHeight - th - pad, clientY + 14);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function placeHoverTooltip(el: HTMLElement, clientX: number, clientY: number): void {
  const pad = 10;
  const tw = el.offsetWidth || 160;
  const th = el.offsetHeight || 28;
  let left = clientX + 14;
  let top = clientY - th - 12;
  const maxLeft = window.innerWidth - tw - pad;
  if (left > maxLeft) left = Math.max(pad, clientX - tw - 14);
  if (top < pad) top = Math.min(window.innerHeight - th - pad, clientY + 16);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

const TIMELINE_MARKER_GLOW_FADE_MIN_SEC = 0.6;
const TIMELINE_MARKER_GLOW_FADE_PX = 28;
const TIMELINE_MARKER_GLOW_FADE_CAP_SEC = 4;

function smoothstep01(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

// Marker hit-test selector — the retained literal `timelineMarker` class (module scope:
// a stable constant, so it is not a hook dependency).
const markerSel = '.timelineMarker';

interface Props {
  sessionId: string;
  status: SessionStatus | null;
  events: LogEvent[];
  audioClips: AudioClipLite[];
  totalSec: number;
  mergedPeaks: Float32Array | null;
  isWaveformDecoding?: boolean;
  audioPlaybackSec: number | null;
  onSeekAudio: (sec: number) => void;
  hidden?: boolean;
  /**
   * Session strip: timeline column with marker readout overlay; aside (via
   * stripTrailing) holds session meta + transport to the left.
   */
  stripOnly?: boolean;
  /** Leading aside (session meta / status / transport / marker buttons). */
  stripTrailing?: ReactNode;
  /** When set (rolling/recording), replaces the scrub lane at the same height. */
  stripLaneSlot?: ReactNode;
  /** Disable scrub / zoom (e.g. YouTube import in progress). */
  controlsLocked?: boolean;
}

export function Timeline({
  sessionId,
  status,
  events,
  audioClips,
  totalSec,
  mergedPeaks,
  isWaveformDecoding,
  audioPlaybackSec,
  onSeekAudio,
  hidden,
  stripOnly,
  stripTrailing,
  stripLaneSlot,
  controlsLocked = false,
}: Props) {
  const code = (status?.show_code ?? '').trim();
  const showName = (status?.show_name ?? '').trim();
  // Session name = stored title (not episode). Episode was removed from the
  // naming workflow; never surface "Episode N" in the session deck meta.
  const sessionTitle = (status?.title ?? '').trim() || (status?.deck_title ?? '').trim();

  const titleText = code ? showName || code : sessionTitle || '—';
  const titleAttr = code || '';
  const studioLine = code && sessionTitle && sessionTitle !== titleText ? sessionTitle : '';
  const dateText = fmtSessionDate(status?.session_created_at_utc ?? status?.now_utc);

  // Start at 0 so a freshly opened session does not jump to last session_timecode.
  const [manualScrubSec, setManualScrubSec] = useState<number | null>(0);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [markerTip, setMarkerTip] = useState<{
    eventId: string;
    clientX: number;
    clientY: number;
  } | null>(null);
  const [hoverSec, setHoverSec] = useState<{
    sec: number;
    clientX: number;
    clientY: number;
  } | null>(null);

  // Refs mirror state for handlers + window getters.
  const manualScrubSecRef = useRef(manualScrubSec);
  manualScrubSecRef.current = manualScrubSec;
  const selectedEventIdRef = useRef(selectedEventId);
  selectedEventIdRef.current = selectedEventId;
  const totalSecRef = useRef(totalSec);
  totalSecRef.current = totalSec;
  const isScrubbingRef = useRef(false);
  const lastTrackPointerRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const lastDocPointerRef = useRef<{ clientX: number; clientY: number } | null>(null);

  // Zoom rail DOM refs
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const zoomRangeRef = useRef<HTMLDivElement | null>(null);
  const zoomBarRef = useRef<HTMLDivElement | null>(null);
  const zoomOutRef = useRef<HTMLButtonElement | null>(null);
  const zoomInRef = useRef<HTMLButtonElement | null>(null);
  const zoomValueRef = useRef<HTMLInputElement | null>(null);
  const zoomTooltipRef = useRef<HTMLDivElement | null>(null);

  const glowRef = useRef<HTMLDivElement | null>(null);
  const navCatRef = useRef<HTMLSpanElement | null>(null);
  const navMsgCellRef = useRef<HTMLSpanElement | null>(null);
  const navMsgTrackRef = useRef<HTMLSpanElement | null>(null);
  const navMsgBRef = useRef<HTMLSpanElement | null>(null);
  const navMsgGap2Ref = useRef<HTMLSpanElement | null>(null);
  const prevAudioPlaybackSecRef = useRef(audioPlaybackSec);

  // activeSecRef for zoom scroll centering (set below after activeSec is computed)
  const activeSecRef = useRef(0);

  // Sync writer: updates the ref synchronously for immediate reads, then queues
  // the React state update for reactivity (re-renders, deps).
  const writeManualScrubSec = useCallback((sec: number | null) => {
    manualScrubSecRef.current = sec;
    setManualScrubSec(sec);
  }, []);
  const writeSelectedEventId = useCallback((id: string | null) => {
    selectedEventIdRef.current = id;
    setSelectedEventId(id);
  }, []);

  // Reset interaction state on session switch — playhead always opens at 00:00:00.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset on sessionId change
  useEffect(() => {
    writeManualScrubSec(0);
    setSelectedEventId(null);
    setMarkerTip(null);
    setHoverSec(null);
    isScrubbingRef.current = false;
    lastTrackPointerRef.current = null;
    onSeekAudio(0);
  }, [sessionId]);

  // Drop selectedEventId when its event vanishes from the cache.
  useEffect(() => {
    if (selectedEventId && !events.some((e) => e.event_id === selectedEventId)) {
      writeSelectedEventId(null);
    }
  }, [events, selectedEventId, writeSelectedEventId]);

  // Live timecode seconds derived from server status.
  const nowSec = useMemo(() => {
    const raw = status?.session_timecode ?? status?.timecode ?? '00:00:00';
    return Math.max(0, parseSmpteToSec(raw, sessionFrameRate(status)));
  }, [status]);

  // While rolling/recording, follow live TC (clear the load/scrub pin).
  useEffect(() => {
    if (!(status?.is_rolling || status?.audio_recording_lease_alive)) return;
    if (manualScrubSecRef.current == null) return;
    writeManualScrubSec(null);
  }, [status?.is_rolling, status?.audio_recording_lease_alive, writeManualScrubSec]);

  // Master playhead position. Priority: live audio playback > manual scrub > rolling timecode.
  const activeSec = useMemo(() => {
    const raw =
      audioPlaybackSec != null
        ? audioPlaybackSec
        : manualScrubSec == null
          ? nowSec
          : manualScrubSec;
    return safeTimelineSec(raw, 0);
  }, [audioPlaybackSec, manualScrubSec, nowSec]);

  // Keep activeSecRef current for zoom rail (must be before useZoomRail call).
  activeSecRef.current = activeSec;

  // Zoom rail — owns zoom state, handle/wheel/keyboard listeners, resize observers.
  useZoomRail(
    {
      viewportRef,
      innerRef,
      zoomRangeRef,
      zoomBarRef,
      zoomOutRef,
      zoomInRef,
      zoomValueRef,
      zoomTooltipRef,
    },
    activeSecRef,
    totalSecRef,
    sessionId,
  );

  const activeClipIdx = useMemo(
    () => clipIndexContainingTimelineSec(activeSec, audioClips),
    [activeSec, audioClips],
  );

  // Current sidebar nav marker: last marker at or before the playhead.
  // Grouping is the shared groupTimelineMarkers util (same buckets/preference as
  // MarkerNav's jump targets — finding 2.6); only the display derivation is local.
  const currentNavMarker = useMemo(() => {
    const marks = groupTimelineMarkers(events, status).map(({ sec, event: e, isInternal }) => ({
      sec,
      cat: String(e.category_label || e.category || '—'),
      msg: String(e.message || '—'),
      col: String(e.category_color || '').trim() || '#6b7280',
      isInternal,
    }));
    if (!marks.length) return null;
    let chosen = marks[0];
    for (const m of marks) {
      if (m.sec <= activeSec + 1e-6) chosen = m;
      else break;
    }
    return chosen;
  }, [events, activeSec, status]);

  // Brighten chip on marker jump / playhead cross; fade when idle.
  const markerChipKey = currentNavMarker
    ? `${currentNavMarker.sec}\0${currentNavMarker.cat}\0${currentNavMarker.msg}`
    : '';
  const [markerChipLit, setMarkerChipLit] = useState(Boolean(currentNavMarker));
  useEffect(() => {
    if (!markerChipKey) {
      setMarkerChipLit(false);
      return;
    }
    setMarkerChipLit(true);
    const t = window.setTimeout(() => setMarkerChipLit(false), 2400);
    return () => window.clearTimeout(t);
  }, [markerChipKey]);

  // Cumulative session-roll seconds for the right-side readout (e.g. "/ 00:12:34").
  const rollingSec = useMemo(() => {
    const raw = status?.session_timecode;
    if (raw == null || String(raw).trim() === '') return 0;
    return Math.max(0, parseSmpteToSec(raw, sessionFrameRate(status)));
  }, [status]);

  const playheadPct = totalSec > 0 ? Math.max(0, Math.min(100, (activeSec / totalSec) * 100)) : 0;

  // Notify MarkerNav (and any other listener) about playhead changes.
  useEffect(() => {
    document.body.dispatchEvent(
      new CustomEvent('autologger:timeline-sec', { detail: { sec: activeSec } }),
    );
  }, [activeSec]);

  // Expose the scrub writer as a window global so timelineJump/useTimelineSeek
  // can drive the playhead without prop threading.
  useEffect(() => {
    window.AutoLogger_setManualScrubSec = writeManualScrubSec;
    return () => {
      window.AutoLogger_setManualScrubSec = undefined;
    };
  }, [writeManualScrubSec]);

  const secFromClientX = useCallback((clientX: number): number | null => {
    const vp = viewportRef.current;
    const inner = innerRef.current;
    const totSec = totalSecRef.current;
    if (!vp || !inner || totSec <= 0) return null;
    const vr = vp.getBoundingClientRect();
    const x = clientX - vr.left + vp.scrollLeft;
    const w = inner.offsetWidth;
    if (w <= 0) return null;
    const pct = Math.max(0, Math.min(1, x / w));
    return Math.round(pct * totSec);
  }, []);

  const scrubAtClientX = useCallback(
    (clientX: number) => {
      const sec = secFromClientX(clientX);
      if (sec == null) return;
      writeManualScrubSec(sec);
      onSeekAudio(sec);
    },
    [secFromClientX, onSeekAudio, writeManualScrubSec],
  );

  // Keyboard scrub for the slider role: ←/→ ±1s, Shift+←/→ ±10s.
  const onTrackKeyDown = useCallback(
    (ev: ReactKeyboardEvent<HTMLDivElement>) => {
      if (controlsLocked) return;
      if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
      ev.preventDefault();
      const step = (ev.shiftKey ? 10 : 1) * (ev.key === 'ArrowLeft' ? -1 : 1);
      const next = Math.max(0, Math.min(totalSec, activeSecRef.current + step));
      writeManualScrubSec(next);
      onSeekAudio(next);
    },
    [controlsLocked, totalSec, onSeekAudio, writeManualScrubSec],
  );

  const onTrackPointerDown = useCallback(
    (ev: ReactPointerEvent<HTMLDivElement>) => {
      if (controlsLocked) return;
      if (!ev.isPrimary || ev.button !== 0) return;
      // Markers handle their own click; skip starting a scrub from a marker hit.
      if ((ev.target as Element).closest?.(markerSel)) return;
      setHoverSec(null);
      isScrubbingRef.current = true;
      try {
        ev.currentTarget.setPointerCapture(ev.pointerId);
      } catch {
        /* capture may fail on some pointers; safe to ignore */
      }
      scrubAtClientX(ev.clientX);
    },
    [controlsLocked, scrubAtClientX],
  );

  const onTrackPointerMove = useCallback(
    (ev: ReactPointerEvent<HTMLDivElement>) => {
      if (isScrubbingRef.current) {
        scrubAtClientX(ev.clientX);
        return;
      }
      lastTrackPointerRef.current = { clientX: ev.clientX, clientY: ev.clientY };
      if ((ev.target as Element).closest?.(markerSel)) {
        setHoverSec(null);
        return;
      }
      const sec = secFromClientX(ev.clientX);
      if (sec == null) {
        setHoverSec(null);
        return;
      }
      setHoverSec({ sec, clientX: ev.clientX, clientY: ev.clientY });
    },
    [secFromClientX, scrubAtClientX],
  );

  const onTrackPointerUp = useCallback((ev: ReactPointerEvent<HTMLDivElement>) => {
    if (!isScrubbingRef.current) return;
    isScrubbingRef.current = false;
    try {
      ev.currentTarget.releasePointerCapture(ev.pointerId);
    } catch {
      /* release may have already happened; ignore */
    }
  }, []);

  const onTrackPointerLeave = useCallback(() => {
    lastTrackPointerRef.current = null;
    setHoverSec(null);
  }, []);

  const onTrackDoubleClick = useCallback(
    (ev: ReactMouseEvent<HTMLDivElement>) => {
      if (controlsLocked) return;
      // Marker dots own selection/reveal — a second click must not clear the scrub
      // (which falls back to live TC, often 00:00:00 when stopped).
      if ((ev.target as Element).closest?.(markerSel)) return;
      writeManualScrubSec(null);
    },
    [controlsLocked, writeManualScrubSec],
  );

  const onMarkersMouseOver = useCallback((ev: ReactMouseEvent<HTMLDivElement>) => {
    const el = (ev.target as Element).closest?.(markerSel) as HTMLElement | null;
    if (!el) return;
    const eventId = el.dataset.eventId || '';
    if (!eventId) return;
    setMarkerTip({ eventId, clientX: ev.clientX, clientY: ev.clientY });
  }, []);

  const onMarkersMouseMove = useCallback((ev: ReactMouseEvent<HTMLDivElement>) => {
    const el = (ev.target as Element).closest?.(markerSel) as HTMLElement | null;
    if (!el) {
      setMarkerTip(null);
      return;
    }
    const eventId = el.dataset.eventId || '';
    if (!eventId) {
      setMarkerTip(null);
      return;
    }
    setMarkerTip({ eventId, clientX: ev.clientX, clientY: ev.clientY });
  }, []);

  const onMarkersMouseOut = useCallback(() => {
    setMarkerTip(null);
  }, []);

  const onMarkersClick = useCallback(
    (ev: ReactMouseEvent<HTMLDivElement>) => {
      const el = (ev.target as Element).closest?.(markerSel) as HTMLElement | null;
      if (!el) return;
      const eventId = el.dataset.eventId;
      if (!eventId) return;
      ev.stopPropagation();
      writeSelectedEventId(eventId);
      revealEventInFeed(eventId);
    },
    [writeSelectedEventId],
  );

  // Track the pointer inside the timeline viewport for marker-tooltip refresh after
  // scroll (scoped to the viewport — positions outside it can't hit a marker anyway).
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const onMove = (ev: MouseEvent) => {
      lastDocPointerRef.current = { clientX: ev.clientX, clientY: ev.clientY };
    };
    const onLeave = () => {
      lastDocPointerRef.current = null;
    };
    vp.addEventListener('mousemove', onMove);
    vp.addEventListener('mouseleave', onLeave);
    return () => {
      vp.removeEventListener('mousemove', onMove);
      vp.removeEventListener('mouseleave', onLeave);
    };
  }, []);

  // After timeline viewport scroll, re-evaluate hover preview + marker tooltip from last pointer.
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const onScroll = () => {
      // Hover preview from last track pointer.
      const tp = lastTrackPointerRef.current;
      if (tp && !isScrubbingRef.current) {
        const elUnder = document.elementFromPoint(tp.clientX, tp.clientY);
        const track = document.getElementById('timeline-track');
        if (!track?.contains(elUnder as Node) || (elUnder as Element)?.closest?.(markerSel)) {
          setHoverSec(null);
        } else {
          const sec = secFromClientX(tp.clientX);
          if (sec == null) setHoverSec(null);
          else setHoverSec({ sec, clientX: tp.clientX, clientY: tp.clientY });
        }
      }
      // Marker tooltip from last document pointer.
      const dp = lastDocPointerRef.current;
      const markersHost = document.getElementById('timeline-markers');
      if (!dp || !markersHost) {
        setMarkerTip(null);
      } else {
        const el = document
          .elementFromPoint(dp.clientX, dp.clientY)
          ?.closest?.(markerSel) as HTMLElement | null;
        if (!el || !markersHost.contains(el)) {
          setMarkerTip(null);
        } else {
          const eventId = el.dataset.eventId || '';
          if (eventId) setMarkerTip({ eventId, clientX: dp.clientX, clientY: dp.clientY });
        }
      }
    };
    vp.addEventListener('scroll', onScroll);
    return () => vp.removeEventListener('scroll', onScroll);
  }, [secFromClientX]);

  // Look up the event for the active marker tooltip (cat/msg/color).
  const markerTipEvent = useMemo(() => {
    if (!markerTip) return null;
    return events.find((e) => e.event_id === markerTip.eventId) ?? null;
  }, [markerTip, events]);

  const markerTipRef = useRef<HTMLDivElement | null>(null);
  const hoverTipRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const el = markerTipRef.current;
    if (!el || !markerTip || !markerTipEvent) return;
    placeTooltip(el, markerTip.clientX, markerTip.clientY);
  }, [markerTip, markerTipEvent]);

  useLayoutEffect(() => {
    const el = hoverTipRef.current;
    if (!el || !hoverSec) return;
    placeHoverTooltip(el, hoverSec.clientX, hoverSec.clientY);
  }, [hoverSec]);

  // Marker-playhead glow: position + opacity fade toward nearest marker.
  useLayoutEffect(() => {
    const el = glowRef.current;
    const inner = innerRef.current;
    if (!el) return;
    if (totalSec <= 0 || !events.length) {
      el.style.opacity = '0';
      return;
    }
    const w = Math.max(1, inner?.offsetWidth ?? 1);
    const secPerPx = totalSec / w;
    const maxFadeDistSec = Math.min(
      TIMELINE_MARKER_GLOW_FADE_CAP_SEC,
      Math.max(TIMELINE_MARKER_GLOW_FADE_MIN_SEC, secPerPx * TIMELINE_MARKER_GLOW_FADE_PX),
      totalSec * 0.4,
    );
    let best: { sec: number; col: string } | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const e of events) {
      const sec = eventTimelineSec(e, status);
      if (!Number.isFinite(sec)) continue;
      const d = Math.abs(sec - activeSec);
      if (d < bestDist) {
        bestDist = d;
        best = { sec, col: String(e.category_color || '').trim() || 'var(--color-accent)' };
      }
    }
    if (!best) {
      el.style.opacity = '0';
      return;
    }
    const pct = Math.max(0, Math.min(100, (best.sec / totalSec) * 100));
    el.style.setProperty('--marker-glow-col', best.col);
    el.style.left = `${pct}%`;
    const linear = maxFadeDistSec > 0 ? Math.max(0, Math.min(1, 1 - bestDist / maxFadeDistSec)) : 0;
    const strength = smoothstep01(linear);
    el.style.opacity = String(strength);
    el.style.transform = `translate(-50%, -50%) scale(${1.08 + 0.08 * strength})`;
  }, [activeSec, totalSec, events, status]);

  // When audio playback stops, freeze the playhead at the last played position.
  useEffect(() => {
    const prev = prevAudioPlaybackSecRef.current;
    prevAudioPlaybackSecRef.current = audioPlaybackSec;
    if (prev != null && audioPlaybackSec == null) {
      writeManualScrubSec(prev);
    }
  }, [audioPlaybackSec, writeManualScrubSec]);

  // Toggle marquee scroll after nav label content changes (was a toggled hashed class;
  // still imperative DOM class toggling — NOT React state — so it never re-renders the
  // timeline mid-interaction (a state bump here would rebuild the marker <button>s and drop
  // in-flight marker clicks). Toggles the marquee animation on the track and reveals the
  // duplicate message segment (B) + its gap when the label overflows.
  // biome-ignore lint/correctness/useExhaustiveDependencies: navMsgCellRef is a stable DOM ref
  useEffect(() => {
    const cell = navMsgCellRef.current;
    if (!cell) return;
    requestAnimationFrame(() => {
      const track = navMsgTrackRef.current;
      const msgB = navMsgBRef.current;
      const gap2 = navMsgGap2Ref.current;
      const msgA = cell.querySelector<HTMLElement>('#marker-current-msg-a');
      if (!msgA || !track) return;
      const overflow = msgA.scrollWidth > cell.clientWidth;
      track.classList.toggle('animate-marker-msg-marquee', overflow);
      // `[display:inline]` NOT `inline` — see NAV_MSG_GAP comment above: the bare
      // `inline` utility collides with chrome.css's legacy `.inline` class.
      msgB?.classList.toggle('[display:inline]', overflow);
      msgB?.classList.toggle('hidden', !overflow);
      gap2?.classList.toggle('[display:inline]', overflow);
      gap2?.classList.toggle('hidden', !overflow);
    });
  }, [currentNavMarker]);

  const hoverPct =
    hoverSec && totalSec > 0
      ? Math.max(0, Math.min(100, (Math.max(0, Math.min(totalSec, hoverSec.sec)) / totalSec) * 100))
      : null;

  const markerTipCat = markerTipEvent
    ? String(markerTipEvent.category_label || markerTipEvent.category || '—').trim() || '—'
    : '';
  const markerTipMsg = markerTipEvent ? markerTipEvent.message || '—' : '';
  const markerTipCol = markerTipEvent
    ? String(markerTipEvent.category_color || '').trim() || '#bfc5cd'
    : '#bfc5cd';

  const markerReadout = (
    <div
      className={clsx(
        MARKER_CHIP,
        markerChipLit ? MARKER_CHIP_LIT : MARKER_CHIP_IDLE,
        !currentNavMarker && 'opacity-[0.35]',
      )}
      id="marker-current-cat-pill"
      aria-label="Current marker"
      style={
        currentNavMarker ? { ['--nav-cat-col' as string]: currentNavMarker.col } : undefined
      }
      title={
        currentNavMarker
          ? `Current marker: ${currentNavMarker.cat} — ${currentNavMarker.msg}`
          : 'No markers'
      }
    >
      <span ref={navCatRef} id="marker-current-cat" className={MARKER_CHIP_BODY}>
        <span
          className={MARKER_CHIP_ACCENT}
          aria-hidden={true}
          style={
            currentNavMarker
              ? { backgroundColor: currentNavMarker.col }
              : { backgroundColor: 'rgba(148,163,184,0.35)' }
          }
        />
        <span className={MARKER_CHIP_CAT} id="marker-current-cat-cell">
          {currentNavMarker?.cat ?? '—'}
        </span>
        <span className={MARKER_CHIP_SEP} aria-hidden={true}>
          ·
        </span>
        <span ref={navMsgCellRef} className={NAV_MSG_CELL} id="marker-current-msg-cell">
          <span ref={navMsgTrackRef} className={NAV_MSG_TRACK} id="marker-current-msg-track">
            <span className={NAV_MSG_VALUE} id="marker-current-msg-a">
              {currentNavMarker?.msg ?? '—'}
            </span>
            <span className={NAV_MSG_GAP} aria-hidden={true}>
              {'    '}
            </span>
            <span
              ref={navMsgBRef}
              className={clsx(NAV_MSG_VALUE, 'hidden')}
              id="marker-current-msg-b"
            >
              {currentNavMarker?.msg ?? '—'}
            </span>
            <span ref={navMsgGap2Ref} className="hidden" aria-hidden={true}>
              {'    '}
            </span>
          </span>
        </span>
      </span>
    </div>
  );

  return (
    <div
      className={clsx(
        TL_STACK,
        stripOnly && 'h-auto min-h-0 flex-[0_0_auto] gap-1 overflow-visible',
      )}
      id="v5-session-timeline-stack"
      hidden={hidden}
    >
      {!stripOnly && (
      <div className={PANEL_HEAD}>
        <div className={PANEL_HEAD_MAIN}>
          <p className={PANEL_EYEBROW}>Session Timeline</p>
          <header className={DECK_HEADER}>
            <div className={DECK_TITLE_CLUSTER}>
              <h1
                className={DECK_TITLE}
                id="session-deck-title"
                aria-label="Session show and name"
              >
                <span id="session-title-code" className="session-title-code" title={titleAttr}>
                  {titleText}
                </span>
                <span className="session-title-sep" aria-hidden={true} hidden={true}>
                  {' - '}
                </span>
                <span id="session-title-ep" className="session-title-ep" hidden={true} />
              </h1>
              <div className={DECK_SESSION_META}>
                <span className={STUDIO_NAME} id="studio-name" hidden={!studioLine}>
                  {studioLine}
                </span>
                <span className={DECK_META_SEP} aria-hidden={true}>
                  &middot;
                </span>
                <span className={SESSION_DATE} id="session-aside-date">
                  {dateText}
                </span>
              </div>
            </div>
          </header>
        </div>
      </div>
      )}

      {!stripOnly && (
      <div className={clsx(V4_EXT_ROW, 'justify-between gap-[0.65rem]')}>
        <div className="min-w-0 flex-1">{markerReadout}</div>
        {sessionId ? <MarkerNav sessionId={sessionId} /> : null}
      </div>
      )}

      <div
        className={clsx(
          // Mobile: controls row on top, timeline full-width underneath.
          // Desktop: controls | timeline side by side.
          stripOnly &&
            'flex h-auto w-full min-w-0 flex-col items-stretch gap-2 md:flex-row md:items-end md:gap-2.5',
        )}
      >
      {stripOnly ? stripTrailing : null}
      {stripOnly ? (
        <div
          className={clsx(
            'relative flex w-full min-w-0 flex-col gap-0 md:flex-[1_1_0]',
            controlsLocked && 'pointer-events-none opacity-[0.48]',
          )}
          aria-disabled={controlsLocked || undefined}
        >
          {stripLaneSlot}
          <div
            className={clsx(V4_TIMELINE_ROW_STRIP, stripLaneSlot != null && 'hidden')}
            aria-hidden={stripLaneSlot != null || undefined}
          >
            <div className={V4_TL_TRACK_LIVE_STRIP} role="presentation">
              <div
                className={clsx(TIMELINE_SHELL, 'h-auto min-h-0 justify-start')}
                id="timeline-shell"
              >
                {/* Marker caption chip — flush on the track (joined one element). */}
                <div className="relative w-full min-w-0 overflow-visible">
                  {stripLaneSlot == null ? (
                    <div className={clsx(MARKER_CHIP_HANG, 'w-full shrink-0')} aria-hidden="true" />
                  ) : null}
                  {stripLaneSlot == null ? (
                    <div
                      className={clsx(
                        'pointer-events-none absolute inset-x-0 top-0 z-[8] flex w-full items-stretch',
                        MARKER_CHIP_HANG,
                      )}
                    >
                      <div
                        className={clsx(
                          'w-full min-w-0',
                          !controlsLocked && 'pointer-events-auto',
                        )}
                      >
                        {markerReadout}
                      </div>
                    </div>
                  ) : null}
                  <div
                    ref={viewportRef}
                    className={TIMELINE_VIEWPORT_STRIP}
                    id="timeline-viewport"
                  >
                    <div
                      ref={innerRef}
                      className={clsx(TIMELINE_INNER, 'relative min-h-0 gap-0 overflow-visible')}
                      id="timeline-inner"
                    >
                      {/* Track + border-centered ticks. Spacer below keeps the hanging
                          half of the labels inside the scrollport — overflow-x:auto
                          forces y-clip, so absolute overflow alone gets cut off. */}
                      <div className="relative w-full overflow-visible">
                        <div
                          className={clsx(
                            TIMELINE_TRACK_STRIP,
                            controlsLocked && 'cursor-not-allowed',
                          )}
                          id="timeline-track"
                          role="slider"
                          aria-label="Timeline scrubber"
                          aria-disabled={controlsLocked || undefined}
                          aria-valuemin={0}
                          aria-valuemax={Math.round(totalSec)}
                          aria-valuenow={Math.round(activeSec)}
                          tabIndex={stripLaneSlot != null || controlsLocked ? -1 : 0}
                          onPointerDown={onTrackPointerDown}
                          onPointerMove={onTrackPointerMove}
                          onPointerUp={onTrackPointerUp}
                          onPointerCancel={onTrackPointerUp}
                          onPointerLeave={onTrackPointerLeave}
                          onDoubleClick={onTrackDoubleClick}
                          onKeyDown={onTrackKeyDown}
                        >
                          <div className={TIMELINE_TRACK_LAYERS}>
                            <TimelineClips
                              clips={audioClips}
                              totalSec={totalSec}
                              activeClipIdx={activeClipIdx}
                            />
                            <TimelineWaveform
                              mergedPeaks={mergedPeaks}
                              isDecoding={isWaveformDecoding ?? false}
                              activeSec={activeSec}
                              totalSec={totalSec}
                              clips={audioClips}
                            />
                            <div
                              className={clsx(
                                TIMELINE_HOVER_PLAYHEAD,
                                hoverPct != null && TIMELINE_HOVER_PLAYHEAD_VISIBLE,
                              )}
                              id="timeline-hover-playhead"
                              aria-hidden={true}
                              style={hoverPct != null ? { left: `${hoverPct}%` } : undefined}
                            />
                            <div
                              ref={glowRef}
                              className={TIMELINE_MARKER_PLAYHEAD_GLOW}
                              id="timeline-marker-playhead-glow"
                              aria-hidden={true}
                            />
                            <TimelineMarkers
                              events={events}
                              status={status}
                              totalSec={totalSec}
                              selectedEventId={selectedEventId}
                              onMouseOver={onMarkersMouseOver}
                              onMouseMove={onMarkersMouseMove}
                              onMouseOut={onMarkersMouseOut}
                              onClick={onMarkersClick}
                            />
                            <div
                              className={TIMELINE_PLAYHEAD}
                              id="timeline-playhead"
                              style={{ left: `${playheadPct}%` }}
                            />
                          </div>
                        </div>
                        <TimelineTicks totalSec={totalSec} />
                      </div>
                      {/* Half-label hang only — keeps ticks clear of overflow clip
                          without extra air above the zoom rail. */}
                      <div
                        className="h-[0.32rem] w-full shrink-0"
                        aria-hidden="true"
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Zoom rail visible in strip mode; scrubber keeps ~80% lane height above. */}
              <div
                className={clsx(ZOOM_RAIL_STRIP, stripLaneSlot != null && 'hidden')}
                role="toolbar"
                aria-label="Timeline zoom"
                aria-hidden={stripLaneSlot != null || undefined}
              >
                <div
                  ref={zoomTooltipRef}
                  className={clsx(ZOOM_TOOLTIP, 'hidden')}
                  id="timeline-zoom-tooltip"
                  role="status"
                  aria-live="polite"
                />
                <input
                  ref={zoomValueRef}
                  type="text"
                  className={clsx(ZOOM_VALUE, 'mono', 'faint')}
                  id="timeline-zoom-value"
                  inputMode="decimal"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="Timeline zoom percent"
                  defaultValue="100%"
                  disabled={controlsLocked}
                  tabIndex={stripLaneSlot != null || controlsLocked ? -1 : undefined}
                />
                <div ref={zoomRangeRef} className={ZOOM_RANGE} id="timeline-zoom-range">
                  <div ref={zoomBarRef} className={ZOOM_BAR} id="timeline-zoom-bar" />
                  <button
                    ref={zoomOutRef}
                    type="button"
                    className={ZOOM_HANDLE}
                    id="timeline-zoom-out"
                    aria-label="Reduce timeline zoom"
                    disabled={controlsLocked}
                    tabIndex={stripLaneSlot != null || controlsLocked ? -1 : undefined}
                  />
                  <button
                    ref={zoomInRef}
                    type="button"
                    className={ZOOM_HANDLE}
                    id="timeline-zoom-in"
                    aria-label="Increase timeline zoom"
                    disabled={controlsLocked}
                    tabIndex={stripLaneSlot != null || controlsLocked ? -1 : undefined}
                  />
                </div>
                {/* Position readout only — full session TC lives in the transport aside. */}
                <div className="flex shrink-0 flex-row items-baseline gap-[0.15rem] whitespace-nowrap [font-variant-numeric:tabular-nums]">
                  <span
                    className="text-[0.85rem] font-semibold tracking-[0.02em] text-v5-text"
                    id="timeline-readout-pos"
                  >
                    {fmtHmsFromSec(activeSec)}
                  </span>
                  <span
                    className="text-[0.65rem] font-medium tracking-[0.04em] text-v5-muted opacity-[0.82]"
                    id="timeline-readout-total"
                  >
                    {` / ${fmtHmsFromSec(rollingSec)}`}
                  </span>
                </div>
              </div>
            </div>
          </div>
          </div>
        ) : (
          <div className={V4_TIMELINE_ROW}>
            <div className={V4_TL_TRACK_LIVE} role="presentation">
              <div className={TIMELINE_SHELL} id="timeline-shell-legacy">
                <p className="m-0 text-v5-muted text-sm">Legacy twin-panel timeline removed.</p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Marker tooltip — React-owned, positioned in useLayoutEffect. */}
      {markerTip && markerTipEvent && (
        <div
          ref={markerTipRef}
          id="timeline-marker-tooltip"
          className={clsx(MARKER_TOOLTIP, MARKER_TOOLTIP_VISIBLE)}
          role="tooltip"
          style={{ ['--tooltip-cat-col' as string]: markerTipCol }}
        >
          <span className={MARKER_TOOLTIP_CAT}>{markerTipCat}</span>
          <span className={MARKER_TOOLTIP_MSG}>{markerTipMsg}</span>
        </div>
      )}

      {/* Track hover tooltip — formatted HH:MM:SS. */}
      {hoverSec && (
        <div ref={hoverTipRef} id="timeline-hover-tooltip" className={HOVER_TOOLTIP} role="tooltip">
          {fmtHmsFromSec(hoverSec.sec)}
        </div>
      )}
    </div>
  );
}
