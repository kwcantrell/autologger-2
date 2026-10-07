import { Tabs as TabsPrimitive } from 'radix-ui';
import type * as React from 'react';
import { cn } from '@/shared/lib/utils';

// shadcn-port-workspace D1 (restyled by redesign-show-ignition): base strings replaced with the feed-tab "lid" vocabulary that
// the retired `feedTabButtonClassName` helper expressed with a boolean;
// here the active/inactive branches key on Radix's `data-state`. The list is a non-wrapping row
// (mobile: the caller's wrapper scrolls it horizontally).
function Tabs({
  className,
  orientation = 'horizontal',
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      orientation={orientation}
      className={cn('flex flex-col', className)}
      {...props}
    />
  );
}

function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn('flex min-w-0 flex-1 flex-nowrap items-end gap-[0.12rem]', className)}
      {...props}
    />
  );
}

// Lid chrome in the Show Ignition vocabulary (redesign-show-ignition D1): tab names stay
// uppercase tracked labels in the label face; flat surfaces, the control radius on the top
// corners, and a solid accent top line (no gradient, no glow) on the active tab. `leading-[inherit]`:
// inheriting the line-height keeps the tabs from growing ~3px. whitespace-nowrap + shrink-0 keep
// labels on one line in the horizontally scrolling mobile tablist.
const TRIGGER_BASE =
  'relative shrink-0 whitespace-nowrap px-[1.05rem] pt-[0.5rem] font-label leading-[inherit] text-[0.8rem] font-semibold tracking-[0.08em] uppercase border border-b-0 rounded-t-ctl cursor-pointer transition-[color,background-color,border-color] duration-[0.18s] ease focus-visible:outline-2 focus-visible:outline focus-visible:[outline-color:var(--si-accent)] focus-visible:outline-offset-2 focus-visible:z-[4] disabled:cursor-not-allowed disabled:opacity-45';
// Active: the sheet's own flat surface (bg-card), no bottom seam, a 2px accent top line.
const TRIGGER_ACTIVE =
  'data-[state=active]:z-[3] data-[state=active]:-mb-px data-[state=active]:pb-[0.72rem] data-[state=active]:text-foreground data-[state=active]:border-border data-[state=active]:bg-card data-[state=active]:before:content-[""] data-[state=active]:before:absolute data-[state=active]:before:inset-x-[0.55rem] data-[state=active]:before:inset-y-auto data-[state=active]:before:top-0 data-[state=active]:before:h-0.5 data-[state=active]:before:rounded-[2px] data-[state=active]:before:bg-primary';
// Inactive: transparent and flush, muted label (AA on the page surface).
const TRIGGER_INACTIVE =
  'data-[state=inactive]:z-[1] data-[state=inactive]:pb-[0.62rem] data-[state=inactive]:text-muted-foreground data-[state=inactive]:border-transparent data-[state=inactive]:bg-transparent data-[state=inactive]:hover-always:text-foreground data-[state=inactive]:hover-always:border-border';

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(TRIGGER_BASE, TRIGGER_ACTIVE, TRIGGER_INACTIVE, className)}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn(
        'outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:[outline-color:var(--si-accent)]',
        className,
      )}
      {...props}
    />
  );
}

export { Tabs, TabsContent, TabsList, TabsTrigger };
