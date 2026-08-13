import { AdminIsland } from '../../AdminIsland';

// Admin users shell route (nextjs-frontend-migration, task 2.3; design D3).
//
// Named `page.page.tsx` -- see `web/next.config.ts`'s `pageExtensions`
// comment and `../../../(index)/layout.page.tsx`'s header for why every App
// Router special file under `web/src/app/**` carries the `.page.` suffix.
//
// Concrete route -- static segments (`/admin/users`) win over the index
// group's catch-all by construction (the two groups are separate root
// layouts, so there is no ambiguity to resolve). Static client-island
// shell: reads no cookies, sets none, embeds no session- or
// catalog-derived data.
export default function AdminUsersShellPage() {
  return <AdminIsland />;
}
