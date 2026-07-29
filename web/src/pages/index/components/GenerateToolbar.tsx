import type { ReactNode } from 'react';
import { FEED_GLASS_BTN } from './FeedTable';

interface Props {
  /** Non-503 inline error from `useGatedGenerate` (single error channel). */
  genError: string | null;
  /** 503 latch from `useGatedGenerate` — see that hook for the D9 rationale. */
  genUnavailable: boolean;
  onGenerate: () => void;
  generatePending: boolean;
  /** Stable per-feed id wiring the latched button to its reason span. */
  reasonId: string;
  /** Reason-span content while latched — a slot, because Transcribe's reason
   * carries an inline `<code>DEEPGRAM_API_KEY</code>` element. */
  reason: ReactNode;
  /** Optional inline success-outcome slot (auto-generate-event-logs D9: the
   * Event feed's created-count/cap note). Rendered as a `role="status"` span
   * in the same single inline channel as `genError` — the two are mutually
   * exclusive per run (an error resets the mutation's data, a fresh run
   * clears the error), and `genError` wins if both are ever passed. */
  outcome?: ReactNode;
  /** Insert is optional: the Event feed has no Insert affordance (manual
   * logging happens through the event-button pad), while Transcribe/Topics
   * keep theirs. Omitting `onInsert` omits the button. */
  onInsert?: () => void;
  insertPending?: boolean;
}

/**
 * Shared Auto Generate + Insert toolbar fragment for the Transcribe and Topics
 * feeds (code-health-tail task 4.4, consolidating finding 2.5's copies).
 *
 * A11y divergence from the ui-refresh spike (spec-mandated, D9): the spike
 * used `disabled` + a mouse `title` — invisible to keyboard/AT users since a
 * native-disabled control can't receive focus and has no accessible
 * description. Here the latched control stays a real, focusable button (no
 * `disabled` attribute) using `aria-disabled` instead, with the reason exposed
 * two ways: `aria-describedby` pointing at an always-visible reason span (not
 * sr-only — sighted keyboard users get it too), and the click handler no-ops
 * while latched. Visual "disabled" styling is reproduced via the
 * `aria-disabled:` variant since `disabled:` utilities key off the native
 * attribute.
 */
export function GenerateToolbar({
  genError,
  genUnavailable,
  onGenerate,
  generatePending,
  reasonId,
  reason,
  outcome,
  onInsert,
  insertPending,
}: Props) {
  return (
    <>
      {genError && (
        <span role="alert" className="ml-2 self-center text-[0.78rem] text-v5-danger">
          {genError}
        </span>
      )}
      {!genError && outcome != null && (
        <span role="status" className="ml-2 self-center text-[0.78rem] text-v5-muted">
          {outcome}
        </span>
      )}
      <button
        type="button"
        className={`${FEED_GLASS_BTN} aria-disabled:pointer-events-none aria-disabled:cursor-not-allowed aria-disabled:opacity-45`}
        disabled={generatePending}
        aria-disabled={genUnavailable || undefined}
        aria-describedby={genUnavailable ? reasonId : undefined}
        onClick={() => {
          if (genUnavailable) return;
          onGenerate();
        }}
      >
        {generatePending ? 'Generating…' : 'Auto Generate'}
      </button>
      {genUnavailable && (
        <span id={reasonId} className="ml-2 self-center text-[0.78rem] text-v5-muted">
          {reason}
        </span>
      )}
      {onInsert && (
        <button
          type="button"
          className={FEED_GLASS_BTN}
          disabled={insertPending}
          onClick={onInsert}
        >
          Insert
        </button>
      )}
    </>
  );
}
