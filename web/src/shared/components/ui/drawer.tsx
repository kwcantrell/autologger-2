import type * as React from 'react';
import { Drawer as DrawerPrimitive } from 'vaul';
import { cn } from '@/shared/lib/utils';

function Drawer({ ...props }: React.ComponentProps<typeof DrawerPrimitive.Root>) {
  return <DrawerPrimitive.Root data-slot="drawer" {...props} />;
}

function DrawerTrigger({ ...props }: React.ComponentProps<typeof DrawerPrimitive.Trigger>) {
  return <DrawerPrimitive.Trigger data-slot="drawer-trigger" {...props} />;
}

function DrawerPortal({ ...props }: React.ComponentProps<typeof DrawerPrimitive.Portal>) {
  return <DrawerPrimitive.Portal data-slot="drawer-portal" {...props} />;
}

function DrawerClose({ ...props }: React.ComponentProps<typeof DrawerPrimitive.Close>) {
  return <DrawerPrimitive.Close data-slot="drawer-close" {...props} />;
}

// V5 (shadcn-shared-wrappers D1/D2): the app's mobile bottom sheet — legacy shared/ui/Dialog sheet
// classes; vaul owns the slide/drag transform, so no `[transform:none]` / slide keyframe here.
function DrawerOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Overlay>) {
  return (
    <DrawerPrimitive.Overlay
      data-slot="drawer-overlay"
      className={cn(
        'fixed inset-0 z-(--z-dialog-overlay) bg-[rgba(8,10,14,0.72)] animate-overlay-fade-in',
        className,
      )}
      {...props}
    />
  );
}

function DrawerContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Content>) {
  return (
    <DrawerPortal data-slot="drawer-portal">
      <DrawerOverlay />
      <DrawerPrimitive.Content
        data-slot="drawer-content"
        className={cn(
          'glass-face-strong fixed inset-x-0 top-auto bottom-0 z-(--z-dialog-content) flex h-auto w-full max-h-[88dvh] flex-col overflow-y-auto rounded-t-v5-md panel-elevate border border-v5-border-strong border-b-0 px-[1.15rem] pt-2 pb-[calc(1.4rem+env(safe-area-inset-bottom))] text-v5-text outline-none focus-visible:outline-2 focus-visible:outline-v5-primary focus-visible:-outline-offset-4',
          className,
        )}
        {...props}
      >
        {/* vaul's own handle (data-vaul-handle): the only drag surface when the root is
            `handleOnly` (shadcn-shared-wrappers D2). vaul injects its size/shape; the V5 colour
            and spacing come from here. */}
        <DrawerPrimitive.Handle className="mt-1 mb-3 bg-v5-border-strong" />
        {children}
      </DrawerPrimitive.Content>
    </DrawerPortal>
  );
}

function DrawerHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="drawer-header"
      className={cn(
        'flex flex-col gap-0.5 p-4 group-data-[vaul-drawer-direction=bottom]/drawer-content:text-center group-data-[vaul-drawer-direction=top]/drawer-content:text-center md:gap-1.5 md:text-left',
        className,
      )}
      {...props}
    />
  );
}

function DrawerFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="drawer-footer"
      className={cn('mt-auto flex flex-col gap-2 p-4', className)}
      {...props}
    />
  );
}

function DrawerTitle({ className, ...props }: React.ComponentProps<typeof DrawerPrimitive.Title>) {
  return (
    <DrawerPrimitive.Title
      data-slot="drawer-title"
      className={cn('mx-0 mt-0 mb-3 text-[1.05rem] font-semibold text-v5-text', className)}
      {...props}
    />
  );
}

function DrawerDescription({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Description>) {
  return (
    <DrawerPrimitive.Description
      data-slot="drawer-description"
      className={cn(
        'mx-0 mt-0 mb-[0.85rem] text-[0.85rem] leading-[1.45] text-v5-muted',
        className,
      )}
      {...props}
    />
  );
}

export {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerOverlay,
  DrawerPortal,
  DrawerTitle,
  DrawerTrigger,
};
