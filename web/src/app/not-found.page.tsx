// Root not-found document (nextjs-frontend-migration, task 2.3; design D3/
// D6/D9.1).
//
// Named `not-found.page.tsx` -- see `web/next.config.ts`'s `pageExtensions`
// comment and `(index)/layout.page.tsx`'s header for why every App Router
// special file under `web/src/app/**` carries the `.page.` suffix.
//
// This file lives at the TOP of `app/` (outside the `(index)` route group),
// so it is Next's global not-found boundary -- it answers any request the
// group's routes don't match (a genuinely unmatched path, e.g.
// `/sessions/a/b`, `/does-not-exist`, or the retired `/admin/users`),
// matching pre-change behavior: status stays `404`, only the body changes to
// Next's not-found HTML (`api-contract-freeze` delta). The second group,
// `(admin)`, was retired with the `/admin/users` page
// (remove-admin-users-page).
//
// No `<html>`/`<body>` of its own (Next 16 upgrade, job 014). Under Next 15
// this page rendered in the root not-found boundary, outside the `(index)`
// route group's root layout, so it had to supply its own document. Under
// Next 16 it renders in the `(index)` layout's own not-found boundary, inside
// that layout's `<body>` (which is also why it picks up the app's global
// stylesheet, accepted as job 014's decision 3). A second `<html>` there
// nested one document in another: in dev, React logged "In HTML, <html>
// cannot be a child of <body>" and three more errors per 404, and the dev
// overlay showed a red "4 Issues" badge. So the page renders only its
// content, and the layout supplies the document. Pinned by
// `server/src/node/nextFrontendDev.test.ts` (dev) and
// `web/src/shared/theme/tailwindBuild.test.ts` (production build).
//
// Statically rendered (design D9.1 -- no dynamic export, no data
// dependency), and contains no user- or session-derived data.
export default function RootNotFound() {
  return (
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
  );
}
