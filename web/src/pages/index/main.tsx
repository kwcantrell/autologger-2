import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import '@/shared/theme/tokens.css';
import '@/shared/theme/baseline.css';
import '@/shared/theme/chrome.css';
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
