import clsx from 'clsx';
import { useCallback, useEffect, useState } from 'react';
import { useLogEvent } from '../../../api/hooks/useEvents';
import { useShowCategories } from '../../../api/hooks/useShowCategories';
import type { Category, DropdownOption } from '../../../api/types';
import { showToast } from '../../../shared/components/Toast';
import { Button, TOUCH_TARGET } from '../../../shared/components/ui/button';
import { Field, FieldLabel } from '../../../shared/components/ui/field';
import { Input } from '../../../shared/components/ui/input';
import { Kbd } from '../../../shared/components/ui/kbd';
import { Dialog, DialogActions } from '../../../shared/ui/Dialog';
import { isOverlayOpen } from '../../../shared/ui/overlayOpen';
import { AUTOLOGGER_LOADING_VIDEO_SRC } from '../../../shared/utils/loadingVideo';
import { isTypingTarget } from './ShortcutsDialog';

// Modal lead text: the former `.modal-lead` values (shadcn-port-modals D6).
const LEAD = 'm-0 mb-4 text-[0.82rem] leading-[1.45] text-legacy-muted';

// Show Ignition logging strip (redesign-show-ignition task 5.2; preview `.strip` / `.cat`). Each
// category is a flat shadcn Button (`log` variant) holding a Kbd key cap, a small swatch of the
// category colour and the label. The colour is user data and stays its own channel (`--cat`,
// set inline): it tints the swatch, the hover edge and the latched/pressed state, never the
// label. The buttons are compact (one line at the control height, 11.3) and wrap; the strip
// fills the lane MaximizeLogStrip sizes to the category-button height token and centres the rows
// in it, so the lane keeps its height while a long list wraps into more rows.
const CAT_STRIP =
  'cat-strip-scrollbar flex w-full min-w-0 flex-wrap content-center items-center gap-1.5';

// Button layout only (the look is the Button `log` variant): key cap, swatch and label on one
// line; a long user label wraps inside the button rather than clipping.
const CAT_TILE =
  'min-h-(--h-ctl) min-w-0 max-w-full gap-2 whitespace-normal py-1.5 pr-3 pl-2 text-left';

// The category-colour swatch (preview `td.catc i`).
const CAT_SWATCH = 'size-2 shrink-0 rounded-[2px] bg-(--cat)';

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
      <p className={LEAD}>Add a note for &ldquo;{category.label}&rdquo;. Press Enter or Log.</p>
      <Field>
        <FieldLabel htmlFor="category-note-input">Note</FieldLabel>
        <Input
          type="text"
          id="category-note-input"
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
      </Field>
      <DialogActions>
        <Button variant="outline" className={TOUCH_TARGET} onClick={onClose}>
          Cancel
        </Button>
        <Button className={TOUCH_TARGET} onClick={handleSubmit} disabled={!text.trim()}>
          Log
        </Button>
      </DialogActions>
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
          <p className={LEAD}>{contextOpt.label}</p>
          <Field>
            <FieldLabel htmlFor="category-context-input">Context</FieldLabel>
            <Input
              type="text"
              id="category-context-input"
              maxLength={4000}
              autoComplete="off"
              autoFocus
              value={contextText}
              onChange={(e) => setContextText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleContextSubmit();
              }}
            />
          </Field>
          <DialogActions>
            <Button variant="outline" className={TOUCH_TARGET} onClick={() => setContextOpt(null)}>
              Back
            </Button>
            <Button className={TOUCH_TARGET} onClick={handleContextSubmit}>
              Log
            </Button>
          </DialogActions>
        </>
      ) : (
        <>
          <p className={LEAD}>{category.label}</p>
          {/* The option list (the former `.modal-dropdown-actions` column). */}
          <div className="mb-3 flex flex-col gap-[0.45rem]">
            {category.dropdown_options.map((opt) => (
              <Button
                key={opt.label}
                variant="outline"
                className={clsx('w-full', TOUCH_TARGET)}
                onClick={() => handleOption(opt)}
              >
                {opt.label}
              </Button>
            ))}
          </div>
          <DialogActions>
            <Button variant="outline" className={TOUCH_TARGET} onClick={onClose}>
              Cancel
            </Button>
          </DialogActions>
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

  // Shared trigger for pointer clicks AND the 1–9 hotkeys (ui-refresh): `btn`
  // is only used for the momentary press animation, so the hotkey path can pass
  // the tile it finds by data-category-id (or null).
  const triggerCategory = useCallback(
    async (cat: Category, btn: HTMLElement | null) => {
      if (!isRolling) return;
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

  const handleButtonClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>, cat: Category) =>
      triggerCategory(cat, e.currentTarget),
    [triggerCategory],
  );

  // 1–9 hotkeys while the live dock is shown (ui-refresh): the fastest input
  // path for the core loop. Full guard set per the spec: at most once per
  // physical keypress (`event.repeat` auto-repeat ignored); never while typing
  // (input/textarea/select/contenteditable); never while any dialog
  // (log-note/dropdown/settings/export) is open; Ctrl/Meta/Alt excluded but
  // Shift deliberately permitted (digits require Shift on some layouts).
  const categoriesForKeys = data?.categories ?? [];
  useEffect(() => {
    if (!isRolling) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      if (isOverlayOpen()) return;
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > 9) return;
      const cat = categoriesForKeys[n - 1];
      if (!cat) return;
      e.preventDefault();
      const btn = document.querySelector<HTMLElement>(
        `#cat-strip-live-slot [data-category-id="${cat.id}"]`,
      );
      void triggerCategory(cat, btn);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isRolling, categoriesForKeys, triggerCategory]);

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
      <div className="v4-cat-hint hidden" role="status" aria-busy="true" aria-label="Loading">
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
      <div className={CAT_STRIP} role="toolbar" aria-label="Log category">
        {categories.map((cat, idx) => {
          const typ = (cat.type || 'BUTTON').toUpperCase();
          const phase = onOffState.get(cat.id) ?? 'off';
          const isOn = typ === 'ON_OFF' && phase === 'on';
          const label =
            typ === 'ON_OFF'
              ? isOn
                ? cat.on_label?.trim() || cat.label
                : cat.off_label?.trim() || cat.label
              : cat.label;

          return (
            <Button
              key={cat.id}
              variant="log"
              // No size: CAT_TILE sets a minimum control height so a wrapped label can grow it.
              size={null}
              className={CAT_TILE}
              style={{ '--cat': cat.color } as React.CSSProperties}
              data-category-id={cat.id}
              data-latched={typ === 'ON_OFF' ? phase : undefined}
              disabled={!isRolling}
              onClick={(e) => handleButtonClick(e, cat)}
            >
              <span className="flex items-center gap-2" aria-hidden="true">
                {/* Hotkey key cap (ui-refresh: 1–9 log the first nine categories while the
                    live dock is shown). Only those nine advertise a key. */}
                {isRolling && idx < 9 && <Kbd>{idx + 1}</Kbd>}
                <span className={CAT_SWATCH} />
              </span>
              <span className="min-w-0 break-words leading-tight">{label}</span>
            </Button>
          );
        })}
      </div>
      <p className="v4-cat-hint hidden">Tap a category to log.</p>
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
