import clsx from 'clsx';
import { useCallback, useState } from 'react';
import { useLogEvent } from '../../../api/hooks/useEvents';
import { useShowCategories } from '../../../api/hooks/useShowCategories';
import type { Category, DropdownOption } from '../../../api/types';
import { showToast } from '../../../shared/components/Toast';
import { Dialog } from '../../../shared/ui/Dialog';
import { AUTOLOGGER_LOADING_VIDEO_SRC } from '../../../shared/utils/loadingVideo';

// --- converted class strings (were CategoryButtonStrip.module.css) ---
// Two live ancestor contexts drive layout via arbitrary ancestor variants (the
// ancestor DOM is rendered by SessionWorkspace, class/id strings retained):
//   [.v4-cat-buttons__scroll_&]:  the horizontal scroll-strip
//   [#cat-strip-live-slot_&]:     the live-log grid (always inside #v4-log-session)
// cat-strip-scrollbar is the named ::-webkit-scrollbar utility (tailwind.css).

const CAT_STRIP =
  'cat-strip-scrollbar flex w-full flex-row flex-nowrap justify-center gap-[0.32rem] overflow-x-auto overflow-y-hidden px-0 pt-[0.12rem] pb-[0.22rem] mt-2 font-medium [font-variation-settings:"wght"_500,"wdth"_50] [-webkit-overflow-scrolling:touch] [.v4-cat-buttons__scroll_&]:m-0 [.v4-cat-buttons__scroll_&]:min-h-(--v4-cat-btn-h) [.v4-cat-buttons__scroll_&]:items-center [.v4-cat-buttons__scroll_&]:justify-start [.v4-cat-buttons__scroll_&]:gap-3 [.v4-cat-buttons__scroll_&]:px-1 [.v4-cat-buttons__scroll_&]:py-0 [#cat-strip-live-slot_&]:grid [#cat-strip-live-slot_&]:min-w-0 [#cat-strip-live-slot_&]:grid-cols-[repeat(auto-fill,minmax(6.6rem,1fr))] [#cat-strip-live-slot_&]:items-stretch [#cat-strip-live-slot_&]:justify-items-stretch [#cat-strip-live-slot_&]:gap-x-[0.6rem] [#cat-strip-live-slot_&]:gap-y-[0.54rem]';

// Base .catBtn — --cat fallback (recipe 3b arbitrary property; runtime inline
// --cat: cat.color overrides). Unguarded :hover → hover-always:; :focus-visible;
// :disabled locks. Ancestor variants re-shape the button per context.
const CAT_BTN =
  '[--cat:#7cb7ff] box-border flex-[0_0_auto] cursor-pointer whitespace-nowrap rounded-[5px] border-[5px] border-[var(--cat)] bg-[#25272e] px-[0.62rem] py-[0.32rem] text-[0.76rem] font-medium tracking-[0rem] uppercase text-text [font-variation-settings:"wght"_500,"wdth"_50] [transition:filter_0.12s_ease,box-shadow_0.12s_ease] hover-always:[filter:brightness(1.3)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-dim disabled:cursor-not-allowed disabled:border-border disabled:bg-surface-btn disabled:text-muted disabled:opacity-45 disabled:[filter:none] disabled:shadow-none [.v4-cat-buttons__scroll_&]:m-0 [.v4-cat-buttons__scroll_&]:flex [.v4-cat-buttons__scroll_&]:h-(--v4-cat-btn-h) [.v4-cat-buttons__scroll_&]:max-h-(--v4-cat-btn-h) [.v4-cat-buttons__scroll_&]:min-h-(--v4-cat-btn-h) [.v4-cat-buttons__scroll_&]:w-(--v4-cat-btn-w) [.v4-cat-buttons__scroll_&]:flex-[0_0_var(--v4-cat-btn-w)] [.v4-cat-buttons__scroll_&]:items-center [.v4-cat-buttons__scroll_&]:justify-center [.v4-cat-buttons__scroll_&]:whitespace-normal [.v4-cat-buttons__scroll_&]:rounded-[5px] [.v4-cat-buttons__scroll_&]:border-[5px] [.v4-cat-buttons__scroll_&]:border-[var(--cat)] [.v4-cat-buttons__scroll_&]:bg-[#25272e] [.v4-cat-buttons__scroll_&]:p-1 [.v4-cat-buttons__scroll_&]:text-center [.v4-cat-buttons__scroll_&]:text-[1.5rem] [.v4-cat-buttons__scroll_&]:font-normal [.v4-cat-buttons__scroll_&]:tracking-[0em] [.v4-cat-buttons__scroll_&]:leading-[1.15] [.v4-cat-buttons__scroll_&]:font-league-gothic [.v4-cat-buttons__scroll_&]:disabled:border-border [.v4-cat-buttons__scroll_&]:disabled:bg-surface-btn [.v4-cat-buttons__scroll_&]:disabled:[filter:none] [.v4-cat-buttons__scroll_&]:disabled:shadow-none [#v4-log-session_&]:inline-flex [#v4-log-session_&]:flex-col [#v4-log-session_&]:items-center [#v4-log-session_&]:justify-center [#v4-log-session_&]:whitespace-normal [#cat-strip-live-slot_&]:[--cat:var(--v5-primary)] [#cat-strip-live-slot_&]:aspect-square [#cat-strip-live-slot_&]:w-full [#cat-strip-live-slot_&]:min-w-0 [#cat-strip-live-slot_&]:overflow-hidden [#cat-strip-live-slot_&]:rounded-v5-md [#cat-strip-live-slot_&]:border [#cat-strip-live-slot_&]:border-[color-mix(in_srgb,var(--cat)_55%,rgba(148,163,184,0.35))] [#cat-strip-live-slot_&]:bg-[linear-gradient(165deg,color-mix(in_srgb,var(--cat)_80%,rgba(15,23,42,0.5)),rgba(7,11,20,0.55))] [#cat-strip-live-slot_&]:p-0 [#cat-strip-live-slot_&]:text-[0.8rem] [#cat-strip-live-slot_&]:font-medium [#cat-strip-live-slot_&]:tracking-[0rem] [#cat-strip-live-slot_&]:leading-[1.15] [#cat-strip-live-slot_&]:text-[color:rgba(248,250,252,0.95)] [#cat-strip-live-slot_&]:[font-family:"Inter",var(--font-poppins),system-ui,sans-serif] [#cat-strip-live-slot_&]:[font-variation-settings:normal] [#cat-strip-live-slot_&]:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] [#cat-strip-live-slot_&]:[transition:border-color_0.15s_ease,box-shadow_0.15s_ease,filter_0.15s_ease] [#cat-strip-live-slot_&]:hover-always:not-disabled:[filter:brightness(1.08)] [#cat-strip-live-slot_&]:hover-always:not-disabled:shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_0_0_1px_color-mix(in_srgb,var(--cat)_35%,transparent)] [#cat-strip-live-slot_&]:active:not-disabled:[transform:translateY(2px)_scale(0.99)] [#cat-strip-live-slot_&]:active:not-disabled:[filter:brightness(0.94)] [#cat-strip-live-slot_&]:active:not-disabled:shadow-[inset_0_4px_12px_rgba(0,0,0,0.42)]';

// ON/OFF latched OFF ("armed" — raised out). Base + live-slot variant.
const CAT_BTN_ARMED =
  '[transform:translateY(-1px)] [filter:brightness(1.12)_saturate(1.02)] border-[color-mix(in_srgb,var(--cat)_55%,#25272e)] shadow-[0_5px_0_rgba(0,0,0,0.22),inset_0_1px_0_rgba(255,255,255,0.1)] hover-always:[filter:brightness(1.18)_saturate(1.04)] [#cat-strip-live-slot_&]:[transform:translateY(-1px)] [#cat-strip-live-slot_&]:[filter:brightness(1.06)_saturate(1.02)] [#cat-strip-live-slot_&]:border-[color-mix(in_srgb,var(--cat)_52%,rgba(148,163,184,0.4))] [#cat-strip-live-slot_&]:shadow-[0_6px_0_rgba(0,0,0,0.2),inset_0_1px_0_rgba(255,255,255,0.12)]';

// ON/OFF latched ON ("on" — pressed in). Base + live-slot variant.
const CAT_BTN_ON =
  '[transform:translateY(2px)] [filter:brightness(0.72)_saturate(0.98)] border-[color-mix(in_srgb,var(--cat)_42%,#1a1b20)] shadow-[inset_0_5px_14px_rgba(0,0,0,0.55)] hover-always:[filter:brightness(0.78)_saturate(1)] [#cat-strip-live-slot_&]:[transform:translateY(2px)] [#cat-strip-live-slot_&]:[filter:brightness(0.82)_saturate(0.98)] [#cat-strip-live-slot_&]:border-[color-mix(in_srgb,var(--cat)_38%,rgba(15,23,42,0.95))] [#cat-strip-live-slot_&]:shadow-[inset_0_5px_16px_rgba(0,0,0,0.5)]';

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
              className={clsx(CAT_BTN, isOn && CAT_BTN_ON, isArmed && CAT_BTN_ARMED)}
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
