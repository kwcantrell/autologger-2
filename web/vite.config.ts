import { readFile } from 'node:fs/promises';
import path from 'path';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Mirrors `isSessionRoutePathname` in web/src/shared/utils/loginReturnPath.ts —
// same "exactly one non-empty segment after /sessions/" rule, kept as a
// second regex here (rather than importing the app source) because this file
// runs under Vite/Node config-loading, not the app's module graph.
const SESSIONS_ROUTE_RE = /^\/sessions\/([^/]+)$/;
const INDEX_HTML_DIR = '/src/pages/index/';
const INDEX_HTML_PATH = path.resolve(__dirname, 'src/pages/index/index.html');

// Dev-only SPA-shell middleware (session-deep-links, design D7): serves the
// index entry's transformed HTML for exactly `/` and `/sessions/<id>` so the
// client-side router's deep links work at :5173 with HMR, matching the
// production serve block in server/src/app.ts (`app.get('/sessions/:id', …)`).
// PRECISE matcher — anything else (the `/admin/users` MPA entry, `/api` +
// `/auth` proxies, `/@vite/*`, `/src/*`, `/assets`, real files) falls through
// to `next()` untouched. `apply: 'serve'` plus registering only a
// `configureServer` hook means this has zero effect on `vite build`/`dist/`.
function sessionDeepLinkDevShell(): Plugin {
  return {
    name: 'session-deep-link-dev-shell',
    apply: 'serve',
    configureServer(server) {
      // Installed inline (a "pre" hook, NOT a returned post-hook function):
      // this workspace's root has no `index.html` (the real entry lives at
      // `src/pages/index/index.html`), so Vite's own built-in index-fallback
      // middleware 404s on `/` before a post-hook would ever run — verified
      // empirically. A pre-hook runs first in the chain instead, which is
      // safe here specifically because the matcher below is exact (`/` or
      // `/sessions/<single-segment>` only): every other path — `/@vite/*`,
      // `/src/*`, `/assets`, the `/api`+`/auth` proxies, `/admin/users`, real
      // files — falls through to `next()` and reaches Vite's internals
      // completely untouched.
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? '/';
        const pathname = url.split('?')[0].split('#')[0];
        const isSessionRoute = SESSIONS_ROUTE_RE.test(pathname);
        if (pathname !== '/' && !isSessionRoute) {
          next();
          return;
        }
        try {
          const rawHtml = await readFile(INDEX_HTML_PATH, 'utf-8');
          // `transformIndexHtml` injects the HMR/React-refresh preamble but
          // does NOT rewrite the source HTML's document-relative
          // `src="./main.tsx"` into an absolute path — the browser resolves
          // that relative reference against the ACTUAL request URL. Serving
          // the raw relative src at `/sessions/abc` would resolve to
          // `/sessions/main.tsx` (404, dead app — design D7's panel
          // finding), same failure mode as serving raw file bytes. Rewrite
          // same-directory relative refs to the entry's real root-absolute
          // dev path (the same path `/src/pages/index/index.html` resolves
          // them to) before transforming, so the shell works identically
          // regardless of which precise-matched URL served it.
          const rootAbsoluteHtml = rawHtml.replace(
            /((?:src|href)=")\.\//g,
            `$1${INDEX_HTML_DIR}`,
          );
          const html = await server.transformIndexHtml(url, rootAbsoluteHtml);
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/html');
          res.end(html);
        } catch (err) {
          next(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), sessionDeepLinkDevShell()],
  root: __dirname,
  base: '/',

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
