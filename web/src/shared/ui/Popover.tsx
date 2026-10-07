import clsx from 'clsx';
import type { ReactNode } from 'react';
import {
  PopoverContent,
  Popover as PopoverRoot,
  PopoverTrigger,
} from '@/shared/components/ui/popover';

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
  // shadcn-shared-wrappers D5: the V5 surface lives in the shadcn primitive (D1); this wrapper
  // only maps its props. Content keeps Radix's role="dialog", so an open popover menu still makes
  // the global shortcuts yield (isOverlayOpen).
  return (
    <PopoverRoot open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild={triggerAsChild}>{trigger}</PopoverTrigger>
      <PopoverContent
        side={side}
        align={align}
        sideOffset={sideOffset}
        aria-label={ariaLabel}
        className={className}
        collisionPadding={8}
      >
        {children}
      </PopoverContent>
    </PopoverRoot>
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
        'focus-visible:bg-[rgba(255,255,255,0.06)] focus-visible:outline-1 focus-visible:outline-v5-primary focus-visible:-outline-offset-1',
        // Disabled.
        'disabled:cursor-not-allowed disabled:opacity-45',
        // aria-checked/aria-selected true → selected tint (mirrors .item[aria-*="true"]; wins on specificity).
        'aria-checked:bg-(--sel-bg) aria-checked:shadow-[inset_0_0_0_1px_var(--sel-line)] aria-selected:bg-(--sel-bg) aria-selected:shadow-[inset_0_0_0_1px_var(--sel-line)]',
        // Base text colour — danger replaces it; selected keeps the text colour (the selected state is the tint + inset line).
        danger ? 'text-danger' : 'text-v5-text',
        // Selected static background (.itemSelected).
        selected && 'bg-(--sel-bg) shadow-[inset_0_0_0_1px_var(--sel-line)]',
        className,
      )}
    >
      {children}
    </button>
  );
}
