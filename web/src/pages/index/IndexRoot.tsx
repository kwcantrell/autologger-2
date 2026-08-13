import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@/shared/theme/ThemeProvider';
import { TooltipProvider } from '@/shared/ui/Tooltip';
import { RootGate } from './RootGate';

// --- IndexRoot (nextjs-frontend-migration, task 1.1) ---
// Provider tree extracted verbatim from `main.tsx` (design D4) so it can be
// mounted by both the Vite entry shim (today) and, in a later phase, a Next
// client-island wrapper. Not StrictMode-wrapped -- load-bearing for the
// departure watcher and coordination registry (design D4).

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 0 },
  },
});

export function IndexRoot() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider delayDuration={400}>
          <RootGate />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
