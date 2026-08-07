import { type TextareaHTMLAttributes, useLayoutEffect, useRef, useState } from 'react';
import { Dialog } from '../../../shared/ui/Dialog';

interface Props {
  /** Event button name — used in the dialog title. */
  buttonName: string;
  /** Current draft value (`''` = absent). */
  initialInstruction: string;
  onSave: (instruction: string) => void;
  onClose: () => void;
}

/** Multi-line instruction field that grows to fit its content. */
function AutoGrowTextarea({
  value,
  className,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-fit when text changes; height is read from the DOM
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const fitHeight = () => {
      el.style.height = 'auto';
      const borderY = el.offsetHeight - el.clientHeight;
      el.style.height = `${el.scrollHeight + borderY}px`;
    };
    fitHeight();
    const ro = new ResizeObserver(fitHeight);
    ro.observe(el);
    return () => ro.disconnect();
  }, [value]);
  return <textarea ref={ref} value={value} className={className} {...rest} />;
}

const TEXTAREA_CLASS =
  'w-full resize-none overflow-hidden rounded-v5-sm border border-v5-border bg-[rgba(255,255,255,0.05)] px-2 py-1.5 text-[0.85rem] leading-[1.4] text-v5-text [font-family:inherit] focus:border-[rgba(56,189,248,0.5)] focus:outline-none box-border';

/**
 * Centered modal editor for a button's AUTO GENERATE instruction
 * (replaces the row popover so long rules stay on-screen).
 */
export function EventInstructionModal({ buttonName, initialInstruction, onSave, onClose }: Props) {
  const [draft, setDraft] = useState(initialInstruction);
  const title = buttonName.trim() ? `${buttonName.trim()} — Auto generate` : 'Auto generate';

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title={title}>
      <p className="modal-hint">
        Tell AUTO GENERATE when to log this event from the transcript. Leave blank to opt out for
        this button.
      </p>
      {/* Explicit htmlFor/id: the control is nested, but it's a custom
          component (AutoGrowTextarea), so the association must be stated
          rather than inferred (a11y pass). */}
      <label className="field" htmlFor="event-instruction-input">
        <span>Generation instruction</span>
        <AutoGrowTextarea
          id="event-instruction-input"
          className={TEXTAREA_CLASS}
          rows={1}
          maxLength={2000}
          value={draft}
          placeholder="e.g. Log an event each time a new slate is called"
          onChange={(e) => setDraft(e.target.value)}
        />
      </label>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn primary" onClick={() => onSave(draft)}>
          Save
        </button>
      </div>
    </Dialog>
  );
}
