import type { ColumnDef } from './FeedTable';

// --- feed-row-seek: the shared jump control (design D2, D7) ---
//
// Mandated shared home for the per-row jump control the Event, Transcript, and
// Topics feeds all render (phases 6/7/8). This module owns two things:
//
//   1. JUMP_COLUMN — a dedicated leading column def, NOT a control folded into the
//      existing time cell. The time column in Transcript/Topics is `w-[6.5rem]`
//      (104px) and an 11-char `HH:MM:SS:FF` needs ~105px already — over capacity
//      before anything is added — so a sibling control there overflows into the
//      next column. A dedicated column costs the flexible message/summary column
//      instead, and leaves every existing cell — including its width and
//      containing block — untouched (spec: "Inline editing is untouched").
//
//   2. JumpToTimeButton — the per-row control. Two invariants are load-bearing and
//      encoded structurally, not just by convention:
//
//        - Rows with no resolvable position get NO control at all, not an inert
//          one. `resolvedSec === null` renders nothing, full stop — encoded here
//          (an early `return null`) so no caller can accidentally render an
//          aria-disabled stand-in for a positionless row.
//        - In the rolling state, EVERY row's control must reference the SAME
//          reason node. That's why this component takes a `reasonId` (a string
//          reference) rather than a `reasonText` — there is no prop shape here
//          that would let a caller render its own per-row reason node by
//          accident. The feed renders exactly one reason node (mirroring
//          TranscribeFeed/TopicsFeed's existing `genReasonId` + `aria-describedby`
//          "Auto Generate" pattern) and passes its id to every row.

export const JUMP_COLUMN: ColumnDef = {
  key: 'jump',
  // Never rendered — FeedTable renders nothing in the header cell whenever
  // ariaLabel is set (see FeedTable's <th>: `col.ariaLabel ? null : col.label`).
  // Present only because ColumnDef.label is required.
  label: 'Jump to time',
  ariaLabel: 'Jump to time',
  thClassName: 'w-8',
};

// Compact icon button, sized to sit inside the ~2rem JUMP_COLUMN without
// widening it. Mirrors EventLogRow's ROW_ICON_BTN icon-button shape (square,
// rounded, bordered, subtle default) but with the accent (sky) hover this app
// uses for non-destructive actions rather than that button's danger-red.
// `aria-disabled:` (not `disabled:`) drives the unavailable look, matching the
// TranscribeFeed/TopicsFeed "Auto Generate" precedent — `pointer-events-none`
// blocks hover/click while the element stays in the accessibility tree.
const JUMP_BTN =
  'inline-flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-[0.35rem] border border-transparent bg-transparent p-0 text-v5-muted [transition:border-color_0.15s_ease,color_0.15s_ease,background_0.15s_ease] hover-always:border-[rgba(56,189,248,0.35)] hover-always:bg-[rgba(56,189,248,0.1)] hover-always:text-v5-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[rgba(56,189,248,0.55)] aria-disabled:pointer-events-none aria-disabled:cursor-not-allowed aria-disabled:opacity-45';

export interface JumpToTimeButtonProps {
  /** This row's resolved position on the timeline, in seconds — the coordinate
   *  space markers and audio clips use (design D4). `null` means the row has no
   *  resolvable position, and the component renders NO control at all. */
  resolvedSec: number | null;
  /** The time exactly as this row displays it right now — e.g. "00:12:03:07", or
   *  a wall-clock UTC string in a feed whose display mode shows one. Becomes part
   *  of the button's accessible name. Taken as a prop rather than derived,
   *  because a feed's own display mode decides which time string is on-screen
   *  (design D2 — the Event Feed can show either). */
  displayTime: string;
  /** Called with `resolvedSec` on activation (pointer, Enter, or Space). Feeds
   *  pass one `useCallback`-stable function shared by every row (design D7) —
   *  this prop is intentionally `(sec) => void`, not a pre-bound `() => void`,
   *  so one function instance serves an entire (possibly virtualized) feed. */
  onJump: (sec: number) => void;
  /** True during the feed-wide unavailable window (not-rolling gate closed, e.g.
   *  session rolling / status unloaded / batch-edit mode). Renders
   *  `aria-disabled` — never the native `disabled` attribute, which would remove
   *  the control from the accessibility tree — and activation no-ops. */
  unavailable?: boolean;
  /** id of the ONE reason node the feed itself renders (e.g. mirroring
   *  TranscribeFeed's `genReasonId` span) explaining why controls are
   *  unavailable. Every row in a feed must pass the SAME id. Only read when
   *  `unavailable` is true; JumpToTimeButton never renders this node itself. */
  reasonId?: string;
}

export function JumpToTimeButton({
  resolvedSec,
  displayTime,
  onJump,
  unavailable,
  reasonId,
}: JumpToTimeButtonProps) {
  // Positionless rows carry no control at all (design D2 gate decision) — not an
  // aria-disabled stand-in. This early return is the enforcement point.
  if (resolvedSec == null) return null;

  const activate = () => {
    if (unavailable) return;
    onJump(resolvedSec);
  };

  // Whole-branch audit fix wave, finding M1: this used to hand-roll
  // Enter/Space handling (`handleKeyDown`/`handleKeyUp`) to make the keyboard
  // path deterministic under jsdom, which has no native <button>
  // key-to-click translation. Verified in real headless Chromium: a native
  // `<button type="button">` already activates on Enter/Space with no
  // double-fire against `onClick` — the hand-rolled handlers were redundant
  // there, AND their `preventDefault()` suppressed the native `click` a
  // keyboard activation would otherwise dispatch, so any future
  // ancestor-delegated click listener would silently miss keyboard
  // activations. `onClick` alone covers pointer AND keyboard activation.
  return (
    <button
      type="button"
      className={JUMP_BTN}
      aria-label={`Jump to ${displayTime}`}
      aria-disabled={unavailable || undefined}
      aria-describedby={unavailable ? reasonId : undefined}
      onClick={activate}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M6 4L20 12L6 20V4Z" />
      </svg>
    </button>
  );
}
