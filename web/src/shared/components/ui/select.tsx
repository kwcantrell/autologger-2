'use client';

import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from 'lucide-react';
import { Select as SelectPrimitive } from 'radix-ui';
import type * as React from 'react';
import { cn } from '@/shared/lib/utils';

function Select({ ...props }: React.ComponentProps<typeof SelectPrimitive.Root>) {
  return <SelectPrimitive.Root data-slot="select" {...props} />;
}

function SelectGroup({ ...props }: React.ComponentProps<typeof SelectPrimitive.Group>) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />;
}

function SelectValue({ ...props }: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />;
}

// V5 trigger chrome (shadcn-shared-wrappers D1/D5) — the SINGLE source for both the mounted
// trigger and LazySelect's inert stand-in (web-ui-system "Event-button rows defer their type
// control": the two must be indistinguishable). Re-exported by pages/index/components/Select.tsx.
export const SELECT_TRIGGER_CLASSNAME = [
  'inline-flex w-full min-h-(--h-ctl) cursor-pointer items-center justify-between gap-2 rounded-ctl border border-input bg-(--si-bg) px-3 py-2 text-left text-[0.85rem] leading-[1.2] text-v5-text outline-none transition-[border-color,box-shadow] duration-[0.12s] ease-[ease] [font-family:inherit]',
  'hover-always:not-data-disabled:border-v5-primary',
  'focus-visible:outline-2 focus-visible:outline-v5-primary focus-visible:outline-offset-2',
  'data-[state=open]:border-v5-primary',
  'data-disabled:cursor-not-allowed data-disabled:opacity-50',
  'data-[placeholder]:text-v5-muted',
].join(' ');

export const SELECT_ICON_CLASSNAME =
  'inline-flex flex-[0_0_auto] items-center justify-center text-v5-muted transition-[transform,color] duration-[0.12s] ease-[ease] [button[data-state=open]_&]:[transform:rotate(180deg)] [button[data-state=open]_&]:text-v5-primary';

/** The trigger's chevron (the only icon in a trigger). Decorative: the trigger is named by its
 * label / aria-label. */
export function SelectTriggerIcon() {
  return <ChevronDownIcon className="size-3.5" aria-hidden="true" />;
}

function SelectTrigger({
  className,
  size = 'default',
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & {
  size?: 'sm' | 'default';
}) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(SELECT_TRIGGER_CLASSNAME, className)}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon className={SELECT_ICON_CLASSNAME}>
        <SelectTriggerIcon />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({
  className,
  children,
  position = 'item-aligned',
  align = 'center',
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        className={cn(
          'glass-panel z-(--z-top-float) min-w-[var(--radix-select-trigger-width)] max-h-[var(--radix-select-content-available-height)] overflow-hidden rounded-v5-md p-[0.35rem]',
          className,
        )}
        position={position}
        align={align}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport className="p-0">{children}</SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

function SelectLabel({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      data-slot="select-label"
      className={cn('px-2 py-1.5 text-xs text-muted-foreground', className)}
      {...props}
    />
  );
}

function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        'relative flex cursor-pointer items-center gap-2 rounded-[calc(var(--v5-radius-md)-6px)] py-[0.45rem] pr-7 pl-[0.6rem] text-[0.85rem] text-v5-text outline-none select-none [font-family:inherit] data-highlighted:bg-accent data-highlighted:text-foreground data-[state=checked]:bg-(--sel-bg) data-[state=checked]:shadow-[inset_0_0_0_1px_var(--sel-line)] data-[state=checked]:text-foreground data-disabled:cursor-not-allowed data-disabled:opacity-45',
        className,
      )}
      {...props}
    >
      <span
        data-slot="select-item-indicator"
        className="absolute top-1/2 right-[0.55rem] inline-flex -translate-y-1/2 items-center justify-center text-v5-primary"
        aria-hidden="true"
      >
        <SelectPrimitive.ItemIndicator>
          <CheckIcon className="size-3" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn('pointer-events-none -mx-1 my-1 h-px bg-border', className)}
      {...props}
    />
  );
}

function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpButton>) {
  return (
    <SelectPrimitive.ScrollUpButton
      data-slot="select-scroll-up-button"
      className={cn(
        'flex h-[1.4rem] cursor-default items-center justify-center bg-transparent text-v5-muted',
        className,
      )}
      {...props}
    >
      <ChevronUpIcon className="size-3" />
    </SelectPrimitive.ScrollUpButton>
  );
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownButton>) {
  return (
    <SelectPrimitive.ScrollDownButton
      data-slot="select-scroll-down-button"
      className={cn(
        'flex h-[1.4rem] cursor-default items-center justify-center bg-transparent text-v5-muted',
        className,
      )}
      {...props}
    >
      <ChevronDownIcon className="size-3" />
    </SelectPrimitive.ScrollDownButton>
  );
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
