# Spec Delta

## REMOVED Requirements

### Requirement: Admin users page renders team memberships from the frozen response shape

**Reason**: The owner retired the `/admin/users` browser page (shadcn-port change 3c-2b): it was the browser's only `ADMIN_TOKEN` surface and the last consumer of the legacy chrome CSS.
**Migration**: Use the unchanged `/api/admin/*` API with `ADMIN_TOKEN` (curl, or `server/scripts/bootstrapMemberships.example.ts`). `GET /admin/users` now renders the app's not-found page.

### Requirement: Membership chips are labelled with the team display name

**Reason**: The owner retired the `/admin/users` browser page (shadcn-port change 3c-2b): it was the browser's only `ADMIN_TOKEN` surface and the last consumer of the legacy chrome CSS.
**Migration**: Use the unchanged `/api/admin/*` API with `ADMIN_TOKEN` (curl, or `server/scripts/bootstrapMemberships.example.ts`). `GET /admin/users` now renders the app's not-found page.

### Requirement: Add-membership control offers only teams the user is not already in

**Reason**: The owner retired the `/admin/users` browser page (shadcn-port change 3c-2b): it was the browser's only `ADMIN_TOKEN` surface and the last consumer of the legacy chrome CSS.
**Migration**: Use the unchanged `/api/admin/*` API with `ADMIN_TOKEN` (curl, or `server/scripts/bootstrapMemberships.example.ts`). `GET /admin/users` now renders the app's not-found page.

### Requirement: Admin users page has regression coverage

**Reason**: The owner retired the `/admin/users` browser page (shadcn-port change 3c-2b): it was the browser's only `ADMIN_TOKEN` surface and the last consumer of the legacy chrome CSS.
**Migration**: Use the unchanged `/api/admin/*` API with `ADMIN_TOKEN` (curl, or `server/scripts/bootstrapMemberships.example.ts`). `GET /admin/users` now renders the app's not-found page.
