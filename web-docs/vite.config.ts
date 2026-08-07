import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: __dirname,
  base: '/',

  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },

  server: {
    // Loopback only, matching web/vite.config.ts's guardrail — this is a local
    // documentation site, never meant to be reachable off-host. Port 5175 avoids
    // colliding with web's dev server (5173), the server (8787), or the e2e
    // hermetic server (8791).
    host: '127.0.0.1',
    port: 5175,
  },
});
