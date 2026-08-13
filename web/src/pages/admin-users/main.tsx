import '@/shared/theme/tailwind.css';
import { createRoot } from 'react-dom/client';
import { AdminRoot } from './AdminRoot';

const root = document.getElementById('root');
if (!root) throw new Error('#root element not found');

createRoot(root).render(<AdminRoot />);
