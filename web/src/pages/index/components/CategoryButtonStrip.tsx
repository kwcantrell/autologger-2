import clsx from 'clsx';
import { useCallback, useState } from 'react';
import { useLogEvent } from '../../../api/hooks/useEvents';
import { useShowCategories } from '../../../api/hooks/useShowCategories';
import type { Category, DropdownOption } from '../../../api/types';
import { showToast } from '../../../shared/components/Toast';
import { Dialog } from '../../../shared/ui/Dialog';
import { AUTOLOGGER_LOADING_VIDEO_SRC } from '../../../shared/utils/loadingVideo';

import styles from './CategoryButtonStrip.module.css';

interface TextModalProps {
  category: Category;
  onLog: (message: string) => void;
  onClose: () => void;
}

function TextModal({ category, onLog, onClose }: TextModalProps) {
  const [text, setText] = useState('');

  const handleSubmit = () => {
    const note = text.trim();
    if (!note) return;
    onLog(note);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Log note">
      <p className="modal-lead">
        Add a note for &ldquo;{category.label}&rdquo;. Press Enter or Log.
      </p>
      <label className="field">
        <span>Note</span>
        <input
          type="text"
          className="profile-select"
          maxLength={8000}
          autoComplete="off"
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleSubmit();
            }
          }}
        />
      </label>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn primary"
          onClick={handleSubmit}
          disabled={!text.trim()}
        >
          Log
        </button>
      </div>
    </Dialog>
  );
}

interface DropdownModalProps {
  category: Category;
  markedAt: string;
  onLog: (message: string) => void;
  onClose: () => void;
}

function DropdownModal({ category, markedAt: _markedAt, onLog, onClose }: DropdownModalProps) {
  const [contextOpt, setContextOpt] = useState<DropdownOption | null>(null);
  const [contextText, setContextText] = useState('');

  const handleOption = (opt: DropdownOption) => {
    if (opt.needs_context) {
      setContextOpt(opt);
    } else {
      onLog(opt.label);
    }
  };

  const handleContextSubmit = () => {
    if (!contextOpt) return;
    const msg = contextText.trim()
      ? `${contextOpt.label} || ${contextText.trim()}`
      : contextOpt.label;
    onLog(msg);
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (o) return;
        // Escape behavior: in the context sub-step, back-out instead of closing the modal.
        if (contextOpt) {
          setContextOpt(null);
        } else {
          onClose();
        }
      }}
      title={contextOpt ? 'Add context' : 'Choose option'}
    >
      {contextOpt ? (
        <>
          <p className="modal-lead">{contextOpt.label}</p>
          <label className="field">
            <span>Context</span>
            <input
              type="text"
              className="profile-select"
              maxLength={4000}
              autoComplete="off"
              autoFocus
              value={contextText}
              onChange={(e) => setContextText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleContextSubmit();
              }}
            />
          </label>
          <div className="modal-actions">
            <button type="button" className="btn" onClick={() => setContextOpt(null)}>
              Back
            </button>
            <button type="button" className="btn primary" onClick={handleContextSubmit}>
              Log
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="modal-lead">{category.label}</p>
          <div className="modal-dropdown-actions">
            {category.dropdown_options.map((opt) => (
              <button
                key={opt.label}
                type="button"
                className="btn"
                onClick={() => handleOption(opt)}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <div className="modal-actions">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      )}
    </Dialog>
  );
}

interface Props {
  sessionId: string;
  isRolling: boolean;
  onOffState: Map<string, 'on' | 'off'>;
  onToggle: (categoryId: string) => void;
}

function momentaryPress(el: HTMLElement | null) {
  if (!el) return;
  el.classList.add('cat-btn-press');
  setTimeout(() => el.classList.remove('cat-btn-press'), 120);
}

export function CategoryButtonStrip({ sessionId, isRolling, onOffState, onToggle }: Props) {
  const { data, isLoading } = useShowCategories(sessionId);
  const logEvent = useLogEvent(sessionId);

  const [dropdownCat, setDropdownCat] = useState<Category | null>(null);
  const [dropdownMarkedAt, setDropdownMarkedAt] = useState('');
  const [textCat, setTextCat] = useState<Category | null>(null);
  const [textMarkedAt, setTextMarkedAt] = useState('');

  const handleLog = useCallback(
    async (categoryId: string, message: string, markedAt?: string) => {
      try {
        await logEvent.mutateAsync({
          category: categoryId,
          message,
          ...(markedAt ? { marked_at_utc: markedAt } : {}),
        });
        showToast('Logged.');
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Log failed';
        showToast(msg, true);
      }
    },
    [logEvent],
  );

  const handleButtonClick = useCallback(
    async (e: React.MouseEvent<HTMLButtonElement>, cat: Category) => {
      if (!isRolling) return;
      const btn = e.currentTarget;
      const typ = (cat.type || 'BUTTON').toUpperCase();

      if (typ === 'BUTTON') {
        momentaryPress(btn);
        await handleLog(cat.id, cat.label);
        return;
      }

      if (typ === 'ON_OFF') {
        const phase = onOffState.get(cat.id) ?? 'off';
        const onLab = cat.on_label?.trim() || cat.label;
        const offLab = cat.off_label?.trim() || cat.label;
        const msg = phase === 'on' ? onLab : offLab;
        await handleLog(cat.id, msg);
        onToggle(cat.id);
        return;
      }

      if (typ === 'DROPDOWN') {
        momentaryPress(btn);
        setDropdownMarkedAt(new Date().toISOString());
        setDropdownCat(cat);
        return;
      }

      if (typ === 'TEXT') {
        momentaryPress(btn);
        setTextMarkedAt(new Date().toISOString());
        setTextCat(cat);
        return;
      }
    },
    [isRolling, handleLog, onOffState, onToggle],
  );

  const handleDropdownLog = useCallback(
    async (message: string) => {
      if (!dropdownCat) return;
      setDropdownCat(null);
      await handleLog(dropdownCat.id, message, dropdownMarkedAt);
    },
    [dropdownCat, dropdownMarkedAt, handleLog],
  );

  const handleTextLog = useCallback(
    async (message: string) => {
      if (!textCat) return;
      const cat = textCat;
      const markedAt = textMarkedAt;
      setTextCat(null);
      await handleLog(cat.id, message, markedAt);
    },
    [textCat, textMarkedAt, handleLog],
  );

  if (isLoading || !data) {
    return (
      <div
        className={clsx(styles.catStripHint, 'v4-cat-hint')}
        role="status"
        aria-busy="true"
        aria-label="Loading"
      >
        <div className="autologger-loading-video">
          <video
            className="autologger-loading-video__media"
            src={AUTOLOGGER_LOADING_VIDEO_SRC}
            preload="auto"
            muted
            playsInline
            disablePictureInPicture
          />
        </div>
      </div>
    );
  }

  const categories = data.categories ?? [];

  return (
    <>
      <div className={styles.catStrip} role="toolbar" aria-label="Log category">
        {categories.map((cat) => {
          const typ = (cat.type || 'BUTTON').toUpperCase();
          const phase = onOffState.get(cat.id) ?? 'off';
          const isOn = typ === 'ON_OFF' && phase === 'on';
          const isArmed = typ === 'ON_OFF' && phase === 'off';
          const label =
            typ === 'ON_OFF'
              ? isOn
                ? cat.on_label?.trim() || cat.label
                : cat.off_label?.trim() || cat.label
              : cat.label;

          return (
            <button
              key={cat.id}
              type="button"
              className={clsx(
                styles.catBtn,
                isOn && styles.catBtnToggleOn,
                isArmed && styles.catBtnToggleArmed,
              )}
              style={{ '--cat': cat.color } as React.CSSProperties}
              data-category-id={cat.id}
              disabled={!isRolling}
              onClick={(e) => handleButtonClick(e, cat)}
            >
              {label}
            </button>
          );
        })}
      </div>
      <p className={clsx(styles.catStripHint, 'v4-cat-hint')}>Tap a category to log.</p>
      {dropdownCat && (
        <DropdownModal
          category={dropdownCat}
          markedAt={dropdownMarkedAt}
          onLog={handleDropdownLog}
          onClose={() => setDropdownCat(null)}
        />
      )}
      {textCat && (
        <TextModal category={textCat} onLog={handleTextLog} onClose={() => setTextCat(null)} />
      )}
    </>
  );
}
