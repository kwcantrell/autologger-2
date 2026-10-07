'use client';

import { CheckIcon, ChevronRightIcon, CircleIcon } from 'lucide-react';
import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui';
import type * as React from 'react';
import { cn } from '@/shared/lib/utils';

function DropdownMenu({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  return <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

function DropdownMenuPortal({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Portal>) {
  return <DropdownMenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />;
}

function DropdownMenuTrigger({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  return <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

// Shared V5 item base (legacy PopoverItem): glass row, highlight tint on hover/keyboard focus.
// Checkbox / radio items reuse it with a left indicator slot; their checked state is shown by the
// indicator (and aria-checked) only, never a tint (web-session-console "Event filter checkmarks").
const ITEM_BASE =
  "relative flex w-full cursor-pointer items-center gap-2 rounded-[calc(var(--v5-radius-md)-6px)] px-[0.55rem] py-[0.45rem] text-left text-[0.78rem] leading-[1.45] font-medium tracking-[0.03em] text-foreground outline-none select-none data-[highlighted]:bg-[rgba(255,255,255,0.06)] focus-visible:bg-[rgba(255,255,255,0.06)] data-[disabled]:pointer-events-none data-[disabled]:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";
// The one selected state (web-ui-system "Single V5 component vocabulary"): a checked radio item
// (the top bar's team and show menus) takes the accent tint and 1px inset line. Checkbox items
// keep the checkmark-only rule above.
const RADIO_CHECKED =
  'data-[state=checked]:bg-(--sel-bg) data-[state=checked]:shadow-[inset_0_0_0_1px_var(--sel-line)] data-[state=checked]:font-semibold';
const INDICATOR_SLOT =
  'pointer-events-none absolute left-[0.55rem] flex size-3.5 items-center justify-center text-v5-primary';

// V5 (shadcn-port-shell D3): content + item base strings replaced with the legacy Popover /
// PopoverItem classes (glass panel, z-popover, item tints; destructive = red text + tint).
function DropdownMenuContent({
  className,
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        className={cn(
          'glass-panel z-(--z-popover) max-h-(--radix-dropdown-menu-content-available-height) min-w-[11.5rem] overflow-x-hidden overflow-y-auto rounded-v5-md p-[0.35rem] outline-none animate-popover-fade-in',
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

function DropdownMenuGroup({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Group>) {
  return <DropdownMenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />;
}

function DropdownMenuItem({
  className,
  inset,
  variant = 'default',
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  inset?: boolean;
  variant?: 'default' | 'destructive';
}) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        ITEM_BASE,
        'data-[inset]:pl-8 data-[variant=destructive]:text-danger data-[variant=destructive]:data-[highlighted]:bg-[color-mix(in_srgb,var(--danger)_14%,transparent)]',
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  indicator,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem> & {
  /** Replaces the default check glyph (rendered only while checked). */
  indicator?: React.ReactNode;
}) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      className={cn(ITEM_BASE, 'pl-[1.85rem]', className)}
      checked={checked}
      {...props}
    >
      <span className={INDICATOR_SLOT}>
        <DropdownMenuPrimitive.ItemIndicator>
          {indicator ?? <CheckIcon className="size-3.5" />}
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

function DropdownMenuRadioGroup({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>) {
  return <DropdownMenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />;
}

function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn(ITEM_BASE, 'pl-[1.85rem]', RADIO_CHECKED, className)}
      {...props}
    >
      <span className={INDICATOR_SLOT}>
        <DropdownMenuPrimitive.ItemIndicator>
          <CircleIcon className="size-2 fill-current" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  );
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label> & {
  inset?: boolean;
}) {
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cn(
        'px-[0.55rem] pt-[0.45rem] pb-[0.3rem] text-[0.66rem] font-semibold uppercase tracking-[0.12em] text-v5-muted data-[inset]:pl-[1.85rem]',
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn('-mx-[0.35rem] my-[0.3rem] h-px bg-v5-border', className)}
      {...props}
    />
  );
}

function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn('ml-auto text-[0.68rem] tracking-[0.1em] text-v5-muted', className)}
      {...props}
    />
  );
}

function DropdownMenuSub({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Sub>) {
  return <DropdownMenuPrimitive.Sub data-slot="dropdown-menu-sub" {...props} />;
}

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger> & {
  inset?: boolean;
}) {
  return (
    <DropdownMenuPrimitive.SubTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={inset}
      className={cn(
        ITEM_BASE,
        'data-[inset]:pl-8 data-[state=open]:bg-[rgba(255,255,255,0.06)]',
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto size-4 text-v5-muted" />
    </DropdownMenuPrimitive.SubTrigger>
  );
}

function DropdownMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  return (
    <DropdownMenuPrimitive.SubContent
      data-slot="dropdown-menu-sub-content"
      className={cn(
        'glass-panel z-(--z-popover) min-w-[11.5rem] overflow-hidden rounded-v5-md p-[0.35rem] outline-none animate-popover-fade-in',
        className,
      )}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
};
