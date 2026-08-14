import clsx from 'clsx';
import { useRef, useState } from 'react';
import {
  SELECT_ICON_CLASSNAME,
  SELECT_TRIGGER_CLASSNAME,
  Select,
  SelectChevronIcon,
  type SelectOption,
} from './Select';

interface LazySelectProps {
  ariaLabel: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  id?: string;
  className?: string;
  disabled?: boolean;
}

/**
 * Deferred stand-in for a `Select` (settings-modal-mount-cost, D3). Rendering this
 * mounts only an inert trigger — no `RadixSelect.Root`, so no listbox item tree is
 * created (a closed real `Select` still mounts its whole item subtree into a detached
 * `DocumentFragment`; that mount cost is what this exists to remove). The real `Select`
 * mounts on the user's first sign of intent (hover, keyboard focus, or activation).
 *
 * Originally `EventButtonsTable`'s per-row `LazyTypeSelect`, lifted here unchanged in
 * behaviour so the always-mounted settings-modal selects can share it — the modal's
 * open cost was dominated by the four closed selects' option subtrees (measured: 27
 * `SelectItem` mounts, ~5 fibers each, on a modal that shows no open dropdown).
 *
 * An activation (click/tap/assistive-technology synthesized click) mounts the real
 * control already open via `defaultOpen`, because the gesture that triggered the swap
 * is already consumed — the freshly-mounted trigger cannot receive it. A focus-only
 * upgrade (keyboard Tab) mounts closed and moves DOM focus onto the new trigger via a
 * ref, since removing the focused inert node would otherwise blur to `document.body`.
 *
 * `pointerActiveRef` distinguishes a pointer-driven focus from a keyboard one: a real
 * mouse click focuses its target as part of mousedown's default action, before the
 * click event that this component treats as the actual activation. Without the guard,
 * that focus would upgrade-and-mount closed a beat before the click could reopen it —
 * and because `defaultOpen` is read only once, at mount, the click would then have no
 * way left to open the now-already-mounted control.
 *
 * The ref must clear on every path off the element, not only the successful ones:
 * `pointerup`/`blur`/`click` cover a completed press, but a press-and-drag-off-and-
 * release-elsewhere fires none of them on browsers that do not focus a `<button>` on
 * mousedown (Safari/Firefox on macOS) — no pointer capture is set for mouse, so the
 * release lands off-element, and the button was never focused so no `blur` fires
 * either. `onPointerCancel`/`onPointerLeave` close that gap so a later, unrelated
 * keyboard focus is not mistaken for the tail of that earlier gesture and left inert
 * (settings-modal-mount-cost audit finding M4).
 *
 * `id` rides on the stand-in as well as the upgraded trigger so `<label htmlFor>`
 * association and id-addressed e2e selectors resolve in both states.
 */
export function LazySelect({
  ariaLabel,
  value,
  className,
  options,
  onChange,
  id,
  disabled,
}: LazySelectProps) {
  const [upgrade, setUpgrade] = useState<{ open: boolean } | null>(null);
  const focusOnMountRef = useRef(false);
  const pointerActiveRef = useRef(false);

  const triggerRef = (node: HTMLButtonElement | null) => {
    if (node && focusOnMountRef.current) {
      node.focus();
      focusOnMountRef.current = false;
    }
  };

  if (upgrade) {
    return (
      <Select
        ref={triggerRef}
        id={id}
        ariaLabel={ariaLabel}
        value={value}
        onChange={onChange}
        className={className}
        options={options}
        disabled={disabled}
        defaultOpen={upgrade.open}
      />
    );
  }

  const selectedLabel = options.find((o) => o.value === value)?.label ?? '';

  return (
    <button
      type="button"
      id={id}
      role="combobox"
      aria-label={ariaLabel}
      aria-expanded={false}
      aria-autocomplete="none"
      data-state="closed"
      disabled={disabled}
      // Radix's trigger marks its disabled state with `data-disabled` rather than the
      // attribute alone; mirror it so SELECT_TRIGGER_CLASSNAME's `data-disabled:` rules
      // apply identically before and after the upgrade.
      data-disabled={disabled ? '' : undefined}
      className={clsx(SELECT_TRIGGER_CLASSNAME, className)}
      onPointerDown={() => {
        pointerActiveRef.current = true;
      }}
      onPointerUp={() => {
        pointerActiveRef.current = false;
      }}
      onPointerCancel={() => {
        pointerActiveRef.current = false;
      }}
      onPointerLeave={() => {
        pointerActiveRef.current = false;
      }}
      onBlur={() => {
        pointerActiveRef.current = false;
      }}
      onPointerEnter={(e) => {
        // Desktop-only pre-warm; touch delivers no pointerenter.
        if (e.pointerType !== 'mouse') return;
        setUpgrade((prev) => prev ?? { open: false });
      }}
      onFocus={() => {
        // A pointer-driven focus is about to be followed by its own click, which
        // already performs the (correct, already-open) upgrade — don't pre-empt it
        // with a closed one.
        if (pointerActiveRef.current) return;
        focusOnMountRef.current = true;
        setUpgrade((prev) => prev ?? { open: false });
      }}
      onClick={() => {
        pointerActiveRef.current = false;
        setUpgrade({ open: true });
      }}
    >
      <span>{selectedLabel}</span>
      <span aria-hidden="true" className={SELECT_ICON_CLASSNAME}>
        <SelectChevronIcon />
      </span>
    </button>
  );
}
