import { cn } from '@/shared/lib/utils';

function Kbd({ className, ...props }: React.ComponentProps<'kbd'>) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        // Show Ignition key cap (preview `.keycap`): the timecode face, a hairline edge with a
        // heavier bottom, the 4px cap radius.
        'pointer-events-none inline-flex h-5 w-fit min-w-5 items-center justify-center gap-1 rounded-[4px] border border-b-2 border-border bg-muted px-1 font-tc text-[0.6875rem] leading-none font-semibold text-muted-foreground select-none',
        "[&_svg:not([class*='size-'])]:size-3",
        '[[data-slot=tooltip-content]_&]:bg-background/10 [[data-slot=tooltip-content]_&]:text-background',
        className,
      )}
      {...props}
    />
  );
}

function KbdGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <kbd
      data-slot="kbd-group"
      className={cn('inline-flex items-center gap-1', className)}
      {...props}
    />
  );
}

export { Kbd, KbdGroup };
