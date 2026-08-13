// Root not-found document (nextjs-frontend-migration, task 2.3; design D3/
// D6/D9.1).
//
// Named `not-found.page.tsx` -- see `web/next.config.ts`'s `pageExtensions`
// comment and `(index)/layout.page.tsx`'s header for why every App Router
// special file under `web/src/app/**` carries the `.page.` suffix.
//
// This file lives at the TOP of `app/` (outside both `(index)`/`(admin)`
// route groups), so it is Next's global not-found boundary -- it answers
// any request that matches neither group's routes (a genuinely unmatched
// path, e.g. `/sessions/a/b` or `/does-not-exist`), matching pre-change
// behavior: status stays `404`, only the body changes to Next's not-found
// HTML (`api-contract-freeze` delta). Because it sits OUTSIDE both root
// layouts, it has no parent `<html>`/`<body>` to inherit and must supply
// its own -- Next.js requires this for a root not-found file when the app
// has no single root layout (this app deliberately has two, via route
// groups; see `(index)/layout.page.tsx`'s comment for why there is no root
// `app/layout.page.tsx`).
//
// Statically rendered (design D9.1 -- no dynamic export, no data
// dependency), and contains no user- or session-derived data.
export default function RootNotFound() {
  return (
    <html lang="en">
      <body>
        <div
          style={{
            display: 'flex',
            minHeight: '100vh',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: 'sans-serif',
            textAlign: 'center',
          }}
        >
          <div>
            <h1>404 — Not Found</h1>
            <p>This page doesn&apos;t exist.</p>
          </div>
        </div>
      </body>
    </html>
  );
}
