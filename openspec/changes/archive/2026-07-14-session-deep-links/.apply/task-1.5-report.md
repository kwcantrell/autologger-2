# Task 1.5 Report: README endpoint table updates

## Summary

Added both session deep-link routes to the frozen endpoint table in README.md:
- `GET /sessions/:id` HTML page route (SPA shell)
- `GET /api/sessions/:id` JSON detail endpoint

## Changes

### Endpoint table modifications (lines 130–145)

1. **Sessions row (line 134)**: Modified to include GET for detail endpoint
   - Before: `PUT\|DELETE /api/sessions/{id}`
   - After: `GET\|PUT\|DELETE /api/sessions/{id}`
   
2. **New HTML page route row (line 144)**: Added after admin row
   - `GET /sessions/:id` (SPA shell) | (app.ts page route)

### Stale prose fix (line 227)

Updated frontend section to list `/sessions/:id` alongside other page routes:
- Before: `` `GET /` and `GET /admin/users` return the built page HTML``
- After: `` `GET /`, `GET /sessions/:id`, and `GET /admin/users` return the built page HTML``

## Verification

- `npm run typecheck`: ✓ passed
- `npm test`: ✓ 252 server tests + 20 companion tests passed
- Commit: `84dc5af` — docs(readme): add session deep-link routes to endpoint table
