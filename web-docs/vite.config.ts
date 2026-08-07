import { copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Copies the git-ignored `web-docs/atlas.json` into `dist/atlas.json`
 * (spec "the SPA fetches ./atlas.json at runtime" — the build must serve it
 * too, not just the dev server). `atlas.json` is written by the `prebuild`
 * npm hook (`tsx scripts/writeAtlas.ts --strict`, which npm runs before
 * `build` automatically) into the workspace root (design.md D1/task 6.3 —
 * NOT under `public/`), so it exists on disk by the time this plugin's
 * `closeBundle` hook runs. Vite's own `publicDir` mechanism only copies
 * `public/`'s contents into `dist/` verbatim, which is why this one file
 * needs its own copy step rather than relying on that mechanism. The dev
 * server needs no equivalent: Vite's static-file middleware already serves
 * any file under `root` (not just `public/`) at its root-relative path, so
 * a relative `fetch('./atlas.json')` resolves directly against the
 * already-written `web-docs/atlas.json` with zero extra config.
 */
function copyAtlasJsonPlugin(): Plugin {
  return {
    name: 'copy-atlas-json',
    apply: 'build',
    closeBundle() {
      const source = path.join(__dirname, 'atlas.json');
      const dest = path.join(__dirname, 'dist', 'atlas.json');
      if (!existsSync(source)) {
        throw new Error(
          'web-docs: atlas.json not found at build time — the `prebuild` npm hook ' +
            '(tsx scripts/writeAtlas.ts --strict) should have written it before `vite build` ran.',
        );
      }
      copyFileSync(source, dest);
    },
  };
}

export default defineConfig({
  plugins: [react(), copyAtlasJsonPlugin()],
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
