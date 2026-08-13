import path from 'path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Standalone config, not derived from anything else: the retired `vite.config.ts`
// carried the MPA `build.rollupOptions` (multiple HTML entries), the tailwind
// plugin, and a dev-only proxy, none of which the test tier needs (nextjs-frontend-
// migration, task 3.4 — the Vite build path is gone; `next build` is now web's
// build). The react plugin (JSX transform) and the alias block are small enough to
// duplicate verbatim here instead.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@/api': path.resolve(__dirname, 'src/api'),
      '@/shared': path.resolve(__dirname, 'src/shared'),
      '@/pages': path.resolve(__dirname, 'src/pages'),
    },
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
  },
});
