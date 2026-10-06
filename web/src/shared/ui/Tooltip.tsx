import type { ReactNode } from 'react';
import {
  TooltipContent,
  TooltipProvider as TooltipProviderPrimitive,
  Tooltip as TooltipRoot,
  TooltipTrigger,
} from '@/shared/components/ui/tooltip';

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

/** Wrap once at the page root (IndexRoot passes delayDuration={400}). */
export const TooltipProvider = TooltipProviderPrimitive;

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
  // shadcn-shared-wrappers D5: the V5 surface + arrow live in the shadcn primitive (D1).
  return (
    <TooltipRoot delayDuration={delayDuration}>
      <TooltipTrigger asChild={asChild}>{children}</TooltipTrigger>
      <TooltipContent side={side} align={align} sideOffset={sideOffset} className={className}>
        {content}
      </TooltipContent>
    </TooltipRoot>
  );
}
