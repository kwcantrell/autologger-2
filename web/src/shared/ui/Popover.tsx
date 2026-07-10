import * as RadixPopover from '@radix-ui/react-popover';
import clsx from 'clsx';
import type { ReactNode } from 'react';
import styles from './Popover.module.css';

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
          className={clsx(styles.content, className)}
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
        styles.item,
        selected && styles.itemSelected,
        danger && styles.itemDanger,
        className,
      )}
    >
      {children}
    </button>
  );
}
