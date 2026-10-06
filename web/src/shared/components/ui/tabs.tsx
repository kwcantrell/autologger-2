import { Tabs as TabsPrimitive } from 'radix-ui';
import type * as React from 'react';
import { cn } from '@/shared/lib/utils';

// V5 (shadcn-port-workspace D1): base strings replaced with the feed-tab "lid" vocabulary that
// `feedTabButtonClassName` (pages/index/components/feedTabStyles.ts) expresses with a boolean;
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

// Lid chrome. `font-[inherit]` + `leading-[inherit]`: `font: inherit` also inherited the
// line-height, without which the tabs grow ~3px. whitespace-nowrap + shrink-0 keep labels on one
// line in the horizontally scrolling mobile tablist.
const TRIGGER_BASE =
  'relative shrink-0 whitespace-nowrap px-[1.05rem] pt-[0.5rem] font-[inherit] leading-[inherit] text-[0.74rem] font-semibold tracking-[0.07em] uppercase border border-b-0 rounded-t-[0.7rem] cursor-pointer transition-[color,background,border-color,box-shadow] duration-[0.18s] ease focus-visible:outline-2 focus-visible:outline focus-visible:[outline-color:rgba(56,189,248,0.55)] focus-visible:outline-offset-2 focus-visible:z-[4] disabled:cursor-not-allowed disabled:opacity-45';
// Active: the exact sheet-top surface, no bottom seam, cyan top stripe.
const TRIGGER_ACTIVE =
  'data-[state=active]:z-[3] data-[state=active]:-mb-px data-[state=active]:pb-[0.72rem] data-[state=active]:text-v5-text data-[state=active]:border-t-v5-border data-[state=active]:border-x-v5-border data-[state=active]:[background:var(--v5-glass-feed-surface-top)] data-[state=active]:shadow-none data-[state=active]:before:content-[""] data-[state=active]:before:absolute data-[state=active]:before:inset-x-[0.55rem] data-[state=active]:before:inset-y-auto data-[state=active]:before:top-0 data-[state=active]:before:h-0.5 data-[state=active]:before:rounded-[2px] data-[state=active]:before:[background:linear-gradient(90deg,rgba(34,211,238,0)_0%,var(--v5-primary2,#22d3ee)_18%,var(--v5-primary,#38bdf8)_82%,rgba(56,189,248,0)_100%)] data-[state=active]:before:[box-shadow:0_0_10px_rgba(56,189,248,0.45)]';
// Inactive: a quieter feed-glass sibling, still flush (not a floating chip).
const TRIGGER_INACTIVE =
  'data-[state=inactive]:z-[1] data-[state=inactive]:pb-[0.62rem] data-[state=inactive]:text-[rgba(229,238,252,0.62)] data-[state=inactive]:border-[rgba(255,255,255,0.06)] data-[state=inactive]:[background:color-mix(in_srgb,var(--v5-glass-feed-top)_55%,transparent)] data-[state=inactive]:[box-shadow:inset_0_1px_0_rgba(255,255,255,0.04)] data-[state=inactive]:hover-always:text-[rgba(229,238,252,0.9)] data-[state=inactive]:hover-always:border-v5-border data-[state=inactive]:hover-always:[background:color-mix(in_srgb,var(--v5-glass-feed-top)_78%,transparent)]';

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
        'outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:[outline-color:rgba(56,189,248,0.55)]',
        className,
      )}
      {...props}
    />
  );
}

export { Tabs, TabsContent, TabsList, TabsTrigger };
