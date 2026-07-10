import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import '@/shared/theme/tailwind.css';
// Vendored third-party lib (animate.css v4.1.1, stage 0a) — kept out of the
// Tailwind migration and out of cascade layers permanently: it's purely
// additive animation utility classes (animate__animated/animate__pulse)
// that compete with nothing in the app's own styles.
import '@/shared/theme/vendor/animate.min.css';
import { ThemeProvider } from '@/shared/theme/ThemeProvider';
import { TooltipProvider } from '@/shared/ui/Tooltip';
import { AppShell } from './AppShell';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 0 },
  },
});

createRoot(document.getElementById('root') as HTMLElement).render(
  <QueryClientProvider client={queryClient}>
    <ThemeProvider>
      <TooltipProvider delayDuration={400}>
        <AppShell />
      </TooltipProvider>
    </ThemeProvider>
  </QueryClientProvider>,
);
