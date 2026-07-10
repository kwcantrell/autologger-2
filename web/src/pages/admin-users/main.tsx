import '@/shared/theme/tailwind.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from '@/shared/theme/ThemeProvider';
import { TooltipProvider } from '@/shared/ui/Tooltip';
import { AdminUsersPage } from './AdminUsersPage';

const root = document.getElementById('root');
if (!root) throw new Error('#root element not found');

createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <TooltipProvider delayDuration={400}>
        <AdminUsersPage />
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
);
