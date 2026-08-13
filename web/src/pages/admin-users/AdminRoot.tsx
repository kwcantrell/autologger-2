import { StrictMode } from 'react';
import { ThemeProvider } from '@/shared/theme/ThemeProvider';
import { TooltipProvider } from '@/shared/ui/Tooltip';
import { AdminUsersPage } from './AdminUsersPage';

// --- AdminRoot (nextjs-frontend-migration, task 1.1) ---
// Provider tree extracted verbatim from `main.tsx` (design D4). StrictMode
// moves from the render call into an explicit subtree wrapper here --
// supported React semantics, net-identical behavior to today.

export function AdminRoot() {
  return (
    <StrictMode>
      <ThemeProvider>
        <TooltipProvider delayDuration={400}>
          <AdminUsersPage />
        </TooltipProvider>
      </ThemeProvider>
    </StrictMode>
  );
}
