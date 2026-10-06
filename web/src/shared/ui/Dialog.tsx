import { type ReactNode, useCallback, useEffect, useRef } from 'react';
import {
  DialogContent,
  DialogDescription,
  Dialog as DialogRoot,
  DialogTitle,
} from '@/shared/components/ui/dialog';
import {
  DrawerContent,
  DrawerDescription,
  Drawer as DrawerRoot,
  DrawerTitle,
} from '@/shared/components/ui/drawer';
import { useIsMobile } from './breakpoints';

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  /**
   * Hide the visual title heading (keeps an SR-only title for a11y).
   * Use when the caller renders its own heading inside `children`.
   */
  hideTitle?: boolean;
  /** Set to false to suppress the close-on-overlay-click default. */
  closeOnOverlayClick?: boolean;
}

/**
 * The app's shared dialog (shadcn-shared-wrappers D2): the shadcn Dialog (V5-styled primitive)
 * as a centered card on desktop, the vaul Drawer as a bottom sheet on mobile. `className`
 * passes through to the content, so consumers' `md:!` / `max-md:!` positioning overrides keep
 * applying. Radix renders no Description warning when `aria-describedby` is explicitly unset.
 */
export function Dialog(props: DialogProps) {
  const isMobile = useIsMobile();
  return isMobile ? <SheetDialog {...props} /> : <CardDialog {...props} />;
}

function describedBy(description: ReactNode) {
  return description === undefined ? { 'aria-describedby': undefined } : {};
}

function CardDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
  hideTitle = false,
  closeOnOverlayClick = true,
}: DialogProps) {
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={className}
        {...describedBy(description)}
        onPointerDownOutside={(e) => {
          if (!closeOnOverlayClick) e.preventDefault();
        }}
        onInteractOutside={(e) => {
          if (!closeOnOverlayClick) e.preventDefault();
        }}
      >
        <DialogTitle className={hideTitle ? 'sr-only' : undefined}>{title}</DialogTitle>
        {description !== undefined && <DialogDescription>{description}</DialogDescription>}
        <div className="block">{children}</div>
      </DialogContent>
    </DialogRoot>
  );
}

/** vaul's settle transition, used to put a vetoed sheet back at rest (its private resetDrawer). */
const SHEET_SETTLE = 'transform 0.5s cubic-bezier(0.32, 0.72, 0, 1)';

function SheetDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
  hideTitle = false,
  closeOnOverlayClick = true,
}: DialogProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  // Latest `open`, read after a close request to detect a consumer veto.
  const openRef = useRef(open);
  openRef.current = open;
  const vetoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (vetoTimer.current) clearTimeout(vetoTimer.current);
    },
    [],
  );

  const handleOpenChange = useCallback(
    (next: boolean) => {
      onOpenChange(next);
      if (next) return;
      // A consumer may veto the close (e.g. HomeSettingsModal's dirty → "Keep editing"): `open`
      // stays true. vaul's closeDrawer() then leaves the sheet at its dragged translate without
      // resetting it, so put it back at rest in place — no remount (child state, scroll, and
      // any confirm open inside the sheet must survive).
      if (vetoTimer.current) clearTimeout(vetoTimer.current);
      vetoTimer.current = setTimeout(() => {
        const el = contentRef.current;
        if (!openRef.current || !el) return;
        el.style.transition = SHEET_SETTLE;
        el.style.transform = 'translate3d(0, 0, 0)';
      }, 0);
    },
    [onOpenChange],
  );

  return (
    <DrawerRoot
      open={open}
      onOpenChange={handleOpenChange}
      direction="bottom"
      // Move focus into the sheet on open (vaul defaults to leaving it on the trigger behind it).
      autoFocus
      // Only the handle drags, as the legacy sheet did; content keeps scrolling.
      handleOnly
      dismissible={closeOnOverlayClick}
    >
      <DrawerContent ref={contentRef} className={className} {...describedBy(description)}>
        <DrawerTitle className={hideTitle ? 'sr-only' : undefined}>{title}</DrawerTitle>
        {description !== undefined && <DrawerDescription>{description}</DrawerDescription>}
        <div className="block">{children}</div>
      </DrawerContent>
    </DrawerRoot>
  );
}
