# Tasks

The first commit on `hotfix-encoded-path-gate` holds only `openspec/changes/gate-decoded-path/`.
The PR targets `main` (owner-approved exception to the migration freeze). Logs go to the session
scratchpad as `hf-<task>-<red|green>.log`.

## 1. Regression tests first (design D2)

- [ ] 1.1 Add the D2 cases to `server/src/routers/gate.int.test.ts` and `authz.int.test.ts`.
  Verify: the cases D2 names as red fail before 2.1 (for example, no-credential `/%61pi/sessions`
  gets 200; record the failure lines). The guard cases pass both before and after.

## 2. Fix (design D1)

- [ ] 2.1 In `server/src/middleware/auth.ts`, use `c.req.path` for both the `API_TOKEN` scope and
  the login decision, and update the comment.
  Verify: 1.1 green, and the full server suite is green.

## 3. Verification

- [ ] 3.1 Run `scripts/check-change.sh --stage hook`; it is green.
- [ ] 3.2 Stage live check, with owner permission for `make stage-up` (stage is built from this
  branch). `docker/scripts/test_router.sh` doesn't exist on `main`, so the check is curl through
  the stage router. Verify:
  - `/%61pi/sessions` and `/%61pi/companion/state` without credentials give 401;
  - `/api/sessions` gives 401;
  - `/api/profile` and `/%61pi/profile` give 200;
  - `/api/companion/state` with the stage token gives 200.
- [ ] 3.3 Owner: merge, then rebuild and redeploy prod `api`, then confirm
  `curl https://<prod>/%61pi/sessions` gives 401. Then run the incident review on prod data
  (proposal Impact: Exposure, Forensics).
- [ ] 3.4 Merge `main` into `supabase-migration` before 5b's first commit. Add a line to ADR 0021
  on that branch recording this freeze exception. Verify: `git merge-base --is-ancestor`
  shows the fix commit in `supabase-migration`, and the server suite there is green.
