import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AtlasProvider } from './lib/AtlasProvider';
import './styles.css';

createRoot(document.getElementById('root') as HTMLElement).render(
  <AtlasProvider>
    <App />
  </AtlasProvider>,
);
