import { type RenderOptions, type RenderResult, render } from '@testing-library/react';
import { StrictMode } from 'react';

/**
 * Shared render helper for the web vitest tier (design D8): every component test
 * renders under `<StrictMode>` so double-invoked effects/renders are caught in the
 * test tier rather than surfacing later as a StrictMode-only bug (see design.md's
 * "StrictMode double-mount" risk — D4's departure-stop subscription design exists
 * specifically to survive this).
 */
export function renderStrict(ui: React.ReactElement, options?: RenderOptions): RenderResult {
  return render(<StrictMode>{ui}</StrictMode>, options);
}
