import * as RadixDialog from '@radix-ui/react-dialog';
import clsx from 'clsx';
import { type ReactNode, type PointerEvent as ReactPointerEvent, useRef } from 'react';
import { useIsMobile } from './breakpoints';

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  /**
   * Hide the visual title heading (keeps a SR-only `VisuallyHidden` for a11y).
   * Use when the caller renders its own heading inside `children`.
   */
  hideTitle?: boolean;
  /** Set to false to suppress the close-on-overlay-click default. */
  closeOnOverlayClick?: boolean;
}

/** Drag past this many px (or flick faster than this px/ms) to dismiss the sheet. */
const DISMISS_PX = 100;
const DISMISS_VELOCITY = 0.6;

/**
 * Touch/pointer drag-to-dismiss for the mobile bottom sheet. Translates the
 * Radix Content node on vertical drag and closes past a distance or velocity
 * threshold, otherwise springs back. No-op when `enabled` is false (desktop).
 */
function useSheetDrag(enabled: boolean, onClose: () => void) {
  const contentRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startY: number; lastY: number; lastT: number; vy: number } | null>(null);

  const place = (y: number, animated: boolean) => {
    const el = contentRef.current;
    if (!el) return;
    el.style.transition = animated ? 'transform 0.22s cubic-bezier(0.22, 1, 0.32, 1)' : 'none';
    el.style.transform = `translateY(${Math.max(0, y)}px)`;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!enabled) return;
    // Pointer capture keeps move/up events flowing if the finger leaves the
    // handle; it can throw for non-active/synthetic pointers, so guard it.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* no-op: capture is best-effort */
    }
    drag.current = { startY: e.clientY, lastY: e.clientY, lastT: e.timeStamp, vy: 0 };
    place(0, false);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    // Sample velocity only across a real frame gap (≥8ms); sampling on every
    // sub-frame event divides by a near-zero dt and spikes the estimate.
    const dt = e.timeStamp - d.lastT;
    if (dt >= 8) {
      d.vy = (e.clientY - d.lastY) / dt;
      d.lastY = e.clientY;
      d.lastT = e.timeStamp;
    }
    place(e.clientY - d.startY, false);
  };

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      /* no-op: capture release is best-effort */
    }
    // Dismiss on a long drag, or a fast downward flick that still travelled a
    // little (the distance floor stops a stray fast micro-move from closing).
    const dy = Math.max(0, e.clientY - d.startY);
    if (dy > DISMISS_PX || (dy > 48 && d.vy > DISMISS_VELOCITY)) {
      onClose();
    } else {
      place(0, true);
    }
  };

  return {
    contentRef,
    handleProps: { onPointerDown, onPointerMove, onPointerUp: endDrag, onPointerCancel: endDrag },
  };
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
  hideTitle = false,
  closeOnOverlayClick = true,
}: DialogProps) {
  const isMobile = useIsMobile();
  const { contentRef, handleProps } = useSheetDrag(isMobile, () => onOpenChange(false));

  // Overlay is identical for both variants (.overlay / .sheetOverlay were byte-equal).
  const overlayClass =
    'fixed inset-0 z-(--z-dialog-overlay) bg-[rgba(8,10,14,0.72)] animate-overlay-fade-in';

  // Desktop: centered card. Sets top/left/transform/width/max-height/padding — the
  // consumer positioning modules (NewSessionModal/HomeSettingsModal/EventOptionsModal)
  // override these via `!`-important utilities on their own className so they beat this
  // base within the utilities layer (legacy-layer overrides would lose to utilities).
  // NB: centering uses the `transform` property (arbitrary utility), NOT Tailwind's
  // `translate` utilities — the content-fade-in keyframe and the consumer positioning
  // overrides (NewSessionModal/HomeSettingsModal) both animate/set `transform`; using
  // the separate `translate` property here would STACK with those and double-translate.
  const desktopContentClass =
    'glass-panel fixed top-1/2 left-1/2 z-(--z-dialog-content) w-[min(100%,32rem)] max-h-[90vh] [transform:translate(-50%,-50%)] overflow-y-auto rounded-v5-md pt-6 px-[1.6rem] pb-[1.6rem] outline-none animate-content-fade-in focus-visible:outline-2 focus-visible:outline-v5-primary focus-visible:-outline-offset-4';

  // Mobile bottom-sheet: pinned to viewport bottom, full-width. As utilities it beats any
  // legacy consumer positioning by layer order — that is what the old `.sheetContent.sheetContent`
  // double-class specificity hack did within the legacy layer. `[transform:none]` is the same
  // rest-state reset that double-class rule applied to defeat consumer `transform`/`inset`/`width`
  // (NewSessionModal's rail-offset translate has no media query, so it would otherwise leak onto
  // the sheet); the slide-up @keyframes still animates the entrance (animations outrank author
  // rules) and the drag handler's inline transform still owns the gesture (inline outranks).
  const sheetContentClass =
    'glass-face-strong fixed inset-x-0 top-auto bottom-0 z-(--z-dialog-content) w-full max-w-none m-0 max-h-[88dvh] [transform:none] overflow-y-auto rounded-t-v5-md panel-elevate border border-v5-border-strong border-b-0 px-[1.15rem] pt-2 pb-[calc(1.4rem+env(safe-area-inset-bottom))] text-v5-text outline-none will-change-transform animate-sheet-slide-up focus-visible:outline-2 focus-visible:outline-v5-primary focus-visible:-outline-offset-4';

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={overlayClass} />
        <RadixDialog.Content
          ref={isMobile ? contentRef : undefined}
          className={clsx(isMobile ? sheetContentClass : desktopContentClass, className)}
          // Radix warns on every render when no Description is rendered; opt out explicitly
          // (only when there is no description — otherwise keep Radix's generated link).
          {...(description === undefined ? { 'aria-describedby': undefined } : {})}
          onPointerDownOutside={(e) => {
            if (!closeOnOverlayClick) e.preventDefault();
          }}
          onInteractOutside={(e) => {
            if (!closeOnOverlayClick) e.preventDefault();
          }}
        >
          {isMobile && (
            <div
              className="mx-0 mt-[-0.5rem] mb-[0.35rem] flex h-6 w-full shrink-0 cursor-grab touch-none items-center justify-center before:h-1 before:w-9 before:rounded-full before:bg-v5-border-strong before:content-['']"
              aria-hidden="true"
              {...handleProps}
            />
          )}
          <RadixDialog.Title
            className={clsx(
              hideTitle ? 'sr-only' : 'mx-0 mt-0 mb-3 text-[1.05rem] font-semibold text-v5-text',
            )}
          >
            {title}
          </RadixDialog.Title>
          {description !== undefined && (
            <RadixDialog.Description className="mx-0 mt-0 mb-[0.85rem] text-[0.85rem] leading-[1.45] text-v5-muted">
              {description}
            </RadixDialog.Description>
          )}
          <div className="block">{children}</div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export const DialogClose = RadixDialog.Close;
