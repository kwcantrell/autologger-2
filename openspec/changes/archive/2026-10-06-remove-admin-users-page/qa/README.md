# remove-admin-users-page QA (task 5.1)

The walk is copied from the archived `shadcn-port-modals/qa`. One step was added: `admin-users-status.<w>.txt` records `fetch('/admin/users').status`. A fresh **`before-admin`** baseline was captured on HEAD before the change, and **`after-admin`** was diffed against it, one pass per width.

## Results

| Check | 1440 | 390 |
| --- | --- | --- |
| `fetch('/admin/users').status` | 200 → **404** | 200 → **404** |
| `admin-users` screen | 99.72% (admin page → the app's not-found document) | 98.87% |
| `not-found` (`/nope-404`) | 0% | 0% |
| All other 36 screens (home, rail, workspace, menus, Settings, modals, teams, login, route states) | 0% (three at ≤ 0.03% noise) | 0% |

**Contrast:** 82 captures, with 0 failures apart from the out-of-scope user-data "Audio issue" (3.64, `filter-menu`). None of the deleted chrome CSS was rendering anything outside the admin page: every other screen is pixel-identical.

`/admin/users` now renders the root `app/not-found.page.tsx` document ("404 — Not Found / This page doesn't exist."), the same page `/nope-404` gets. It is its own `<html>`/`<body>`, outside the `(index)` layout (design D1).

**Dev-stack HTTP check** (task 2.3): `GET` and `HEAD /admin/users` → `404 text/html`, with the same status, type and `Cache-Control` as `/admin/logs`. The stage-router run of `docker/scripts/test_router.sh` needs a stage stack and is part of the owner pass.

## Owner review (task 5.2)

The owner reviewed the change and the branch (2026-10-06): "looks good". This covers `/admin/users` showing not-found, the README admin curl recipes, and the router expectations. The PR carries the tier-2 review and the whole-branch audit.
