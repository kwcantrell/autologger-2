import path from 'path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Deliberately NOT `mergeConfig(viteConfig, ...)`: vite.config.ts carries the MPA
// `build.rollupOptions` (multiple HTML entries), the tailwind plugin, and a dev-only
// proxy, none of which the test tier needs. The react plugin (JSX transform) and the
// alias block are small enough to duplicate verbatim instead — see web/vite.config.ts
// for the source of truth.
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
