import { useEffect, useRef, useState } from 'react';
import type { ShowDropdownOption } from '../../../api/types';
import { Dialog } from '../../../shared/ui/Dialog';

interface Props {
  type: 'DROPDOWN' | 'ON_OFF';
  options: ShowDropdownOption[];
  onLabel: string;
  offLabel: string;
  /** Whole-button generation instruction draft value (`''` = absent). */
  autoInstruction: string;
  onConfirm: (result: {
    options: ShowDropdownOption[];
    onLabel: string;
    offLabel: string;
    autoInstruction: string;
  }) => void;
  onClose: () => void;
}

interface OptRow extends ShowDropdownOption {
  uid: string;
}

function withUids(opts: ShowDropdownOption[]): OptRow[] {
  return opts.map((o) => ({ ...o, uid: crypto.randomUUID() }));
}

// Multi-line instruction entry (auto-generate-event-logs) — same chrome family as the
// AI-chat composer textarea; `field` supplies the label layout around it.
const INSTRUCTION_TEXTAREA =
  'w-full resize-y rounded-v5-sm border border-v5-border bg-[rgba(255,255,255,0.05)] px-2 py-1.5 text-[0.85rem] leading-[1.4] text-v5-text [font-family:inherit] focus:border-[rgba(56,189,248,0.5)] focus:outline-none';

export function EventOptionsModal({
  type,
  options,
  onLabel,
  offLabel,
  autoInstruction,
  onConfirm,
  onClose,
}: Props) {
  const [localOpts, setLocalOpts] = useState<OptRow[]>(() =>
    withUids(
      options.length >= 2
        ? options
        : [
            { label: 'Option 1', needs_context: false },
            { label: 'Option 2', needs_context: false },
          ],
    ),
  );
  const [localOn, setLocalOn] = useState(onLabel);
  const [localOff, setLocalOff] = useState(offLabel);
  const [localInstruction, setLocalInstruction] = useState(autoInstruction);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  function handleConfirm() {
    if (type === 'DROPDOWN') {
      const opts: ShowDropdownOption[] = localOpts
        .filter((o) => o.label.trim())
        .map(({ label, needs_context, auto_instruction }) => ({
          label,
          needs_context,
          // Wire rule: empty means absent — emit the `auto_instruction` key only
          // when non-empty, matching server normalization (empty ⇒ omitted) so an
          // untouched round-trip stays snapshot-clean.
          ...(auto_instruction?.trim() ? { auto_instruction } : {}),
        }));
      onConfirm({ options: opts, onLabel: '', offLabel: '', autoInstruction: localInstruction });
    } else {
      // ON_OFF buttons never carry generation instructions (auto-event-generation
      // definition) — always confirm the instruction away.
      onConfirm({
        options: [],
        onLabel: localOn.trim(),
        offLabel: localOff.trim(),
        autoInstruction: '',
      });
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      // Desktop widen. `md:!` beats Dialog's base w-[min(100%,32rem)] within the utilities layer;
      // md-scoped so the ≤767px bottom-sheet stays full-width. (The old .dialogWide base width
      // was identical and is now gone — this utility is the sole desktop width control.)
      className="md:!w-[min(36rem,96vw)]"
      title={type === 'DROPDOWN' ? 'Dropdown options' : 'ON / OFF labels'}
    >
      {type === 'DROPDOWN' && (
        <>
          <p className="modal-hint">
            Each row is one menu choice. Check &ldquo;Needs context&rdquo; to ask for extra text
            after the user picks it (logged as <span className="mono">Option || context</span>).
            Instruction fields tell AUTO GENERATE when to log this button — leave them blank to opt
            out.
          </p>
          {/* Whole-button generation instruction (auto-generate-event-logs): stays
              editable for DROPDOWN buttons alongside the per-option fields. */}
          <label className="field">
            <span>Generation instruction</span>
            <textarea
              className={INSTRUCTION_TEXTAREA}
              rows={3}
              maxLength={2000}
              value={localInstruction}
              placeholder="e.g. Log an event whenever any camera cut is discussed"
              onChange={(e) => setLocalInstruction(e.target.value)}
            />
          </label>
          {/* .v6-event-options-list */}
          <div className="flex flex-col gap-[0.55rem] my-3 max-h-[50vh] overflow-y-auto">
            {localOpts.map((opt, idx) => (
              // .v6-event-option-row (orphan v6-* literal classes dropped — no e2e/server/Companion hooks)
              <div
                key={opt.uid}
                className="grid grid-cols-[1fr_auto_auto] gap-x-[0.65rem] gap-y-2 items-end"
              >
                <label className="field">
                  <span>Option</span>
                  <input
                    ref={idx === 0 ? firstRef : undefined}
                    type="text"
                    className="profile-select"
                    maxLength={200}
                    value={opt.label}
                    onChange={(e) =>
                      setLocalOpts((prev) =>
                        prev.map((o) => (o.uid === opt.uid ? { ...o, label: e.target.value } : o)),
                      )
                    }
                  />
                </label>
                {/* .v6-event-option-nc: overrides chrome .field (flex-column) to a nowrap row;
                    the flex-row utility beats legacy chrome by layer order. */}
                <label className="field flex-row items-center gap-[0.35rem] whitespace-nowrap">
                  <input
                    type="checkbox"
                    checked={opt.needs_context}
                    onChange={(e) =>
                      setLocalOpts((prev) =>
                        prev.map((o) =>
                          o.uid === opt.uid ? { ...o, needs_context: e.target.checked } : o,
                        ),
                      )
                    }
                  />
                  <span>Needs context</span>
                </label>
                <button
                  type="button"
                  className="btn danger"
                  onClick={() => setLocalOpts((prev) => prev.filter((o) => o.uid !== opt.uid))}
                >
                  Remove
                </button>
                {/* Per-option generation instruction, full-width under the option row. */}
                <label className="field col-span-3">
                  <span>Option instruction</span>
                  <textarea
                    className={INSTRUCTION_TEXTAREA}
                    rows={2}
                    maxLength={2000}
                    value={opt.auto_instruction ?? ''}
                    onChange={(e) =>
                      setLocalOpts((prev) =>
                        prev.map((o) =>
                          o.uid === opt.uid ? { ...o, auto_instruction: e.target.value } : o,
                        ),
                      )
                    }
                  />
                </label>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="btn"
            onClick={() =>
              setLocalOpts((prev) => [
                ...prev,
                { label: '', needs_context: false, uid: crypto.randomUUID() },
              ])
            }
          >
            Add option
          </button>
        </>
      )}

      {type === 'ON_OFF' && (
        // Orphan v6-* literal classes dropped (no CSS ever, no e2e/server/Companion hooks).
        <div>
          <label className="field">
            <span>ON label</span>
            <input
              ref={firstRef}
              type="text"
              className="profile-select"
              maxLength={200}
              value={localOn}
              onChange={(e) => setLocalOn(e.target.value)}
            />
          </label>
          <label className="field">
            <span>OFF label</span>
            <input
              type="text"
              className="profile-select"
              maxLength={200}
              value={localOff}
              onChange={(e) => setLocalOff(e.target.value)}
            />
          </label>
        </div>
      )}

      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
        <button type="button" className="btn primary" onClick={handleConfirm}>
          Done
        </button>
      </div>
    </Dialog>
  );
}
