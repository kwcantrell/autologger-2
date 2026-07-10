import * as RadixDialog from '@radix-ui/react-dialog';
import clsx from 'clsx';
import { type ReactNode, type PointerEvent as ReactPointerEvent, useRef } from 'react';
import { useIsMobile } from './breakpoints';
import styles from './Dialog.module.css';

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

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={isMobile ? styles.sheetOverlay : styles.overlay} />
        <RadixDialog.Content
          ref={isMobile ? contentRef : undefined}
          className={clsx(isMobile ? styles.sheetContent : styles.content, className)}
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
          {isMobile && <div className={styles.dragHandle} aria-hidden="true" {...handleProps} />}
          <RadixDialog.Title className={clsx(styles.title, hideTitle && styles.srOnly)}>
            {title}
          </RadixDialog.Title>
          {description !== undefined && (
            <RadixDialog.Description className={styles.description}>
              {description}
            </RadixDialog.Description>
          )}
          <div className={styles.body}>{children}</div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export const DialogClose = RadixDialog.Close;
