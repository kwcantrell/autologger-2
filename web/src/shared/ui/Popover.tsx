import * as RadixPopover from '@radix-ui/react-popover';
import clsx from 'clsx';
import type { ReactNode } from 'react';

interface PopoverProps {
  trigger: ReactNode;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  className?: string;
  /** When true (default), wraps `trigger` in `asChild` so the consumer's button is used directly. */
  triggerAsChild?: boolean;
  /** Optional aria-label for the content surface. */
  ariaLabel?: string;
}

export function Popover({
  trigger,
  children,
  open,
  onOpenChange,
  side = 'bottom',
  align = 'end',
  sideOffset = 6,
  className,
  triggerAsChild = true,
  ariaLabel,
}: PopoverProps) {
  return (
    <RadixPopover.Root open={open} onOpenChange={onOpenChange}>
      <RadixPopover.Trigger asChild={triggerAsChild}>{trigger}</RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content
          side={side}
          align={align}
          sideOffset={sideOffset}
          aria-label={ariaLabel}
          className={clsx(
            'glass-panel z-(--z-popover) min-w-[11.5rem] rounded-v5-md p-[0.35rem] outline-none animate-popover-fade-in focus-visible:outline-2 focus-visible:outline-v5-primary focus-visible:outline-offset-2',
            className,
          )}
          collisionPadding={8}
        >
          {children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}

/** Convenience item button for use inside Popover content. */
interface PopoverItemProps {
  children: ReactNode;
  selected?: boolean;
  onClick?: () => void;
  role?: 'menuitem' | 'menuitemcheckbox' | 'menuitemradio' | 'option';
  ariaChecked?: boolean;
  ariaSelected?: boolean;
  disabled?: boolean;
  /** Renders the item in the destructive (red) style — e.g. Delete. */
  danger?: boolean;
  className?: string;
}

export function PopoverItem({
  children,
  selected,
  onClick,
  role = 'menuitem',
  ariaChecked,
  ariaSelected,
  disabled,
  danger,
  className,
}: PopoverItemProps) {
  const ariaState: { 'aria-checked'?: boolean; 'aria-selected'?: boolean } =
    role === 'menuitemcheckbox' || role === 'menuitemradio'
      ? { 'aria-checked': ariaChecked }
      : role === 'option'
        ? { 'aria-selected': ariaSelected ?? selected }
        : {};

  return (
    <button
      type="button"
      role={role}
      {...ariaState}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        // Base item chrome.
        'm-0 block w-full cursor-pointer rounded-[calc(var(--v5-radius-md)-6px)] border-none bg-transparent px-[0.55rem] py-[0.45rem] text-left text-[0.78rem] leading-[1.45] font-medium tracking-[0.03em] outline-none transition-[background] duration-[0.12s] ease-[ease] [font-family:inherit]',
        // Hover (unguarded → hover-always): danger swaps the base tint. :not(:disabled) guard preserved.
        danger
          ? 'hover-always:not-disabled:bg-[color-mix(in_srgb,var(--danger)_14%,transparent)]'
          : 'hover-always:not-disabled:bg-[rgba(255,255,255,0.06)]',
        // Focus-visible ring + tint.
        'focus-visible:bg-[rgba(56,189,248,0.16)] focus-visible:outline-1 focus-visible:outline-v5-primary focus-visible:-outline-offset-1',
        // Disabled.
        'disabled:cursor-not-allowed disabled:opacity-45',
        // aria-checked/aria-selected true → selected tint (mirrors .item[aria-*="true"]; wins on specificity).
        'aria-checked:bg-[rgba(56,189,248,0.14)] aria-checked:text-v5-primary aria-selected:bg-[rgba(56,189,248,0.14)] aria-selected:text-v5-primary',
        // Base text colour — danger / selected replace it (exclusive; danger wins over selected, matching source order).
        danger ? 'text-danger' : selected ? 'text-v5-primary' : 'text-[rgba(248,250,252,0.92)]',
        // Selected static background (.itemSelected).
        selected && 'bg-[rgba(56,189,248,0.14)]',
        className,
      )}
    >
      {children}
    </button>
  );
}
