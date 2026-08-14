import * as RadixSelect from '@radix-ui/react-select';
import clsx from 'clsx';
import { forwardRef } from 'react';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  id?: string;
  className?: string;
  ariaLabel?: string;
  placeholder?: string;
  disabled?: boolean;
  name?: string;
  /** Mounts the Radix root already open (settings-modal-mount-cost, D3). Additive and
   * optional — every existing call site omits it and keeps mounting closed, which is
   * `RadixSelect.Root`'s own default when the prop is undefined. It exists so a
   * lazily-upgraded control (`EventButtonsTable`'s inert trigger) can open on the same
   * activation that mounted it, since the freshly-mounted trigger cannot receive the
   * gesture that triggered the swap. */
  defaultOpen?: boolean;
}

// Shared trigger chrome, exported so a lazy stand-in (EventButtonsTable's inert
// per-row trigger, settings-modal-mount-cost D3) can reuse the identical classes and
// icon markup rather than re-deriving them.
export const SELECT_TRIGGER_CLASSNAME = clsx(
  'glass-face-strong inline-flex w-full min-h-9 cursor-pointer items-center justify-between gap-2 rounded-v5-md border border-v5-border-strong px-3 py-2 text-left text-[0.85rem] leading-[1.2] text-v5-text outline-none transition-[border-color,box-shadow] duration-[0.12s] ease-[ease] [font-family:inherit]',
  'hover-always:not-data-disabled:border-v5-primary',
  'focus-visible:outline-2 focus-visible:outline-v5-primary focus-visible:outline-offset-2',
  'data-[state=open]:border-v5-primary',
  'data-disabled:cursor-not-allowed data-disabled:opacity-50',
  'data-[placeholder]:text-v5-muted',
);

export const SELECT_ICON_CLASSNAME =
  'inline-flex flex-[0_0_auto] items-center justify-center text-v5-muted transition-[transform,color] duration-[0.12s] ease-[ease] [button[data-state=open]_&]:[transform:rotate(180deg)] [button[data-state=open]_&]:text-v5-primary';

export function SelectChevronIcon() {
  return (
    <svg width="10" height="6" viewBox="0 0 10 6" fill="none" role="img" aria-label="open">
      <title>Open</title>
      <path
        d="M1 1L5 5L9 1"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export const Select = forwardRef<HTMLButtonElement, SelectProps>(function Select(
  { value, onChange, options, id, className, ariaLabel, placeholder, disabled, name, defaultOpen },
  ref,
) {
  return (
    <RadixSelect.Root
      value={value}
      onValueChange={onChange}
      disabled={disabled}
      name={name}
      defaultOpen={defaultOpen}
    >
      <RadixSelect.Trigger
        ref={ref}
        id={id}
        aria-label={ariaLabel}
        className={clsx(SELECT_TRIGGER_CLASSNAME, className)}
      >
        <RadixSelect.Value placeholder={placeholder} />
        <RadixSelect.Icon className={SELECT_ICON_CLASSNAME}>
          <SelectChevronIcon />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content
          className="glass-panel z-(--z-top-float) min-w-[var(--radix-select-trigger-width)] max-h-[var(--radix-select-content-available-height)] overflow-hidden rounded-v5-md p-[0.35rem]"
          position="popper"
          sideOffset={4}
          collisionPadding={8}
        >
          <RadixSelect.ScrollUpButton
            className="flex h-[1.4rem] cursor-default items-center justify-center bg-transparent text-[0.65rem] text-v5-muted"
            aria-hidden
          >
            ▲
          </RadixSelect.ScrollUpButton>
          <RadixSelect.Viewport className="p-0">
            {options.map((opt) => (
              <RadixSelect.Item
                key={opt.value}
                value={opt.value}
                disabled={opt.disabled}
                className={clsx(
                  'relative flex cursor-pointer items-center gap-2 rounded-[calc(var(--v5-radius-md)-6px)] py-[0.45rem] pr-7 pl-[0.6rem] text-[0.85rem] text-v5-text outline-none select-none [font-family:inherit]',
                  'data-highlighted:bg-[rgba(56,189,248,0.14)] data-highlighted:text-v5-primary',
                  'data-[state=checked]:bg-[rgba(56,189,248,0.14)] data-[state=checked]:text-v5-primary',
                  'data-disabled:cursor-not-allowed data-disabled:opacity-45',
                )}
              >
                <RadixSelect.ItemText>{opt.label}</RadixSelect.ItemText>
                <RadixSelect.ItemIndicator
                  className="absolute top-1/2 right-[0.55rem] inline-flex -translate-y-1/2 items-center justify-center text-[0.7rem] text-v5-primary"
                  aria-hidden
                >
                  ✓
                </RadixSelect.ItemIndicator>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
          <RadixSelect.ScrollDownButton
            className="flex h-[1.4rem] cursor-default items-center justify-center bg-transparent text-[0.65rem] text-v5-muted"
            aria-hidden
          >
            ▼
          </RadixSelect.ScrollDownButton>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
});
