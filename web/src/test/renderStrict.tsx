import { type RenderOptions, type RenderResult, render } from '@testing-library/react';
import { StrictMode } from 'react';
import { TooltipProvider } from '../shared/ui/Tooltip';

/**
 * Shared render helper for the web vitest tier (design D8): every component test
 * renders under `<StrictMode>` so double-invoked effects/renders are caught in the
 * test tier rather than surfacing later as a StrictMode-only bug (see design.md's
 * "StrictMode double-mount" risk — D4's departure-stop subscription design exists
 * specifically to survive this).
 *
 * Also wraps `TooltipProvider`, mirroring main.tsx's app-level provider — Radix
 * `Tooltip` throws without it, and the shared Tooltip is now used deep in the
 * workspace tree (transport tiles, session-id chip — ui-refresh).
 */
export function StrictWrapper({ children }: { children: React.ReactNode }) {
  return (
    <StrictMode>
      <TooltipProvider delayDuration={400}>{children}</TooltipProvider>
    </StrictMode>
  );
}

export function renderStrict(ui: React.ReactElement, options?: RenderOptions): RenderResult {
  return render(<StrictWrapper>{ui}</StrictWrapper>, options);
}
