import { createRoot } from 'react-dom/client';
import '@/shared/theme/tailwind.css';
import { IndexRoot } from './IndexRoot';

createRoot(document.getElementById('root') as HTMLElement).render(<IndexRoot />);
