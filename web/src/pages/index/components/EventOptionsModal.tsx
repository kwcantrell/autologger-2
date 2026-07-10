import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import type { DropdownOption } from '../../../api/types';
import { Dialog } from '../../../shared/ui/Dialog';

import styles from './EventOptionsModal.module.css';

interface Props {
  type: 'DROPDOWN' | 'ON_OFF';
  options: DropdownOption[];
  onLabel: string;
  offLabel: string;
  onConfirm: (result: { options: DropdownOption[]; onLabel: string; offLabel: string }) => void;
  onClose: () => void;
}

interface OptRow extends DropdownOption {
  uid: string;
}

function withUids(opts: DropdownOption[]): OptRow[] {
  return opts.map((o) => ({ ...o, uid: crypto.randomUUID() }));
}

export function EventOptionsModal({ type, options, onLabel, offLabel, onConfirm, onClose }: Props) {
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
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  function handleConfirm() {
    if (type === 'DROPDOWN') {
      const opts = localOpts
        .filter((o) => o.label.trim())
        .map(({ label, needs_context }) => ({ label, needs_context }));
      onConfirm({ options: opts, onLabel: '', offLabel: '' });
    } else {
      onConfirm({ options: [], onLabel: localOn.trim(), offLabel: localOff.trim() });
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      className={styles.dialogWide}
      title={type === 'DROPDOWN' ? 'Dropdown options' : 'ON / OFF labels'}
    >
      {type === 'DROPDOWN' && (
        <>
          <p className="modal-hint">
            Each row is one menu choice. Check &ldquo;Needs context&rdquo; to ask for extra text
            after the user picks it (logged as <span className="mono">Option || context</span>).
          </p>
          <div className={styles.v6EventOptionsList}>
            {localOpts.map((opt, idx) => (
              <div key={opt.uid} className={styles.v6EventOptionRow}>
                <label className="field v6-event-option-label">
                  <span>Option</span>
                  <input
                    ref={idx === 0 ? firstRef : undefined}
                    type="text"
                    className="profile-select v6-opt-label"
                    maxLength={200}
                    value={opt.label}
                    onChange={(e) =>
                      setLocalOpts((prev) =>
                        prev.map((o) => (o.uid === opt.uid ? { ...o, label: e.target.value } : o)),
                      )
                    }
                  />
                </label>
                <label className={clsx('field', styles.v6EventOptionNc)}>
                  <input
                    type="checkbox"
                    className="v6-opt-nc"
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
                  className="btn danger v6-opt-remove"
                  onClick={() => setLocalOpts((prev) => prev.filter((o) => o.uid !== opt.uid))}
                >
                  Remove
                </button>
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
        <div className="v6-event-onoff-fields">
          <label className="field">
            <span>ON label</span>
            <input
              ref={firstRef}
              type="text"
              className="profile-select v6-onoff-on"
              maxLength={200}
              value={localOn}
              onChange={(e) => setLocalOn(e.target.value)}
            />
          </label>
          <label className="field">
            <span>OFF label</span>
            <input
              type="text"
              className="profile-select v6-onoff-off"
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
