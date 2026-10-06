import { ScrollArea as ScrollAreaPrimitive } from 'radix-ui';
import type * as React from 'react';
import { cn } from '@/shared/lib/utils';

// V5 (shadcn-port-workspace D1): replaces OverlayScrollbars (`os-theme-light`, autoHide 'leave',
// 250ms). The scrollbar is revealed on hover and fades after 250ms; the thumb is a light rail.
// `viewportRef` publishes the real scroll element (virtualizers' `getScrollElement`).
// `viewportClassName` is merged LAST so callers can override the content wrapper's display:
// Radix wraps children in an inline `display:table; min-width:100%` div, which sizes to its
// content and defeats `w-full` tables and flex-column lists, so it is forced to `block` here.
// Height caps (`max-h-*`) belong on the viewport, not the root: the viewport is `size-full`, and
// a percentage height does not resolve against an auto-height root capped only by max-height.
function ScrollArea({
  className,
  children,
  viewportRef,
  viewportClassName,
  scrollbars = 'vertical',
  type = 'hover',
  scrollHideDelay = 250,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root> & {
  viewportRef?: React.Ref<HTMLDivElement>;
  viewportClassName?: string;
  /** `both` adds the horizontal bar. Radix sets `overflow-x: hidden` unless a horizontal bar is
   * mounted, so wide content (feed tables on phones) needs it to stay reachable. */
  scrollbars?: 'vertical' | 'both';
}) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      type={type}
      scrollHideDelay={scrollHideDelay}
      className={cn('relative', className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        ref={viewportRef}
        data-slot="scroll-area-viewport"
        className={cn(
          'size-full rounded-[inherit] outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:[outline-color:rgba(56,189,248,0.55)] [&>div]:!block',
          viewportClassName,
        )}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      {scrollbars === 'both' && <ScrollBar orientation="horizontal" />}
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}

// Focus parity with OverlayScrollbars: dragging the bar must not blur an inline-edit input
// (EventLogSheet's abandonment logic is written around a bar that keeps focus). Focus moves as
// the default action of `mousedown`, so it is prevented THERE — never on `pointerdown`: Radix
// composes `onPointerDown` consumer-first and skips its own drag handler when defaultPrevented.
function keepFocus(event: React.MouseEvent<HTMLDivElement>) {
  event.preventDefault();
}

function ScrollBar({
  className,
  orientation = 'vertical',
  onMouseDown,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      onMouseDown={(e) => {
        onMouseDown?.(e);
        keepFocus(e);
      }}
      className={cn(
        'z-[2] flex touch-none p-[2px] select-none transition-opacity duration-150 data-[state=hidden]:opacity-0',
        orientation === 'vertical' && 'h-full w-2.5',
        orientation === 'horizontal' && 'h-2.5 flex-col',
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-slot="scroll-area-thumb"
        className="relative flex-1 rounded-full bg-[rgba(255,255,255,0.44)] transition-colors hover:bg-[rgba(255,255,255,0.55)] active:bg-[rgba(255,255,255,0.66)]"
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  );
}

export { ScrollArea, ScrollBar };
