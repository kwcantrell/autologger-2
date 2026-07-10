import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: __dirname,
  base: '/',

  css: {
    modules: { localsConvention: 'camelCaseOnly' },
  },

  resolve: {
    alias: {
      '@/api': path.resolve(__dirname, 'src/api'),
      '@/shared': path.resolve(__dirname, 'src/shared'),
      '@/pages': path.resolve(__dirname, 'src/pages'),
    },
  },

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        'admin-users': path.resolve(__dirname, 'src/pages/admin-users/index.html'),
        index: path.resolve(__dirname, 'src/pages/index/index.html'),
      },
    },
  },

  server: {
    // Loopback only — the proxy would otherwise let LAN peers reach the API
    // *as* 127.0.0.1, bypassing IP_ALLOWLIST. LAN device testing goes through
    // the production serve path at :8787.
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8787', ws: true },
      '/auth': 'http://localhost:8787',
    },
  },
});
