import * as RadixTooltip from '@radix-ui/react-tooltip';
import clsx from 'clsx';
import type { ReactNode } from 'react';
import styles from './Tooltip.module.css';

interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  delayDuration?: number;
  /** Skip wrapping the child in a Trigger asChild — used when child is already a primitive. */
  asChild?: boolean;
  disabled?: boolean;
  className?: string;
}

/** Wrap once at the page root. */
export const TooltipProvider = RadixTooltip.Provider;

export function Tooltip({
  content,
  children,
  side = 'top',
  align = 'center',
  sideOffset = 6,
  delayDuration,
  asChild = true,
  disabled = false,
  className,
}: TooltipProps) {
  if (disabled) return <>{children}</>;
  return (
    <RadixTooltip.Root delayDuration={delayDuration}>
      <RadixTooltip.Trigger asChild={asChild}>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          align={align}
          sideOffset={sideOffset}
          className={clsx(styles.content, className)}
        >
          {content}
          <RadixTooltip.Arrow className={styles.arrow} />
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
