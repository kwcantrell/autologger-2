# Panel: supabase-services
Tier: 2 · Reviewers: assumption tester, failure and abuse, scope and simplicity · Date: 2026-09-30

Three fresh subagents reviewed v1, which had six services and Studio at `/`. The owner then
decided three things on 2026-09-30:
- defer Studio and meta;
- make the `supabase` network internal and host-isolated, with a gateway-only `edge` network;
- re-initialise by removing only the two Postgres volumes.

The resolutions below point to the v2 artifacts. Findings raised by two or more reviewers are
merged.

## Assumption tester

- [x] [critical] The non-internal `supabase` network lets any host process reach the services directly, bypassing every gateway check. That includes meta's `/query` (SQL as `postgres`, no key) and Studio. Evidence: `curl -X POST http://<meta-ip>:8080/query -d '{"query":"select current_user"}'` -> `[{"current_user":"postgres",...}]`. Also raised by scope. Resolved: (owner decision, 2026-09-30) `supabase` is internal and host-isolated, with a gateway-only `edge` network (D1, A11), and Studio and meta are deferred. The spec scenario "The host cannot bypass the gateway", invariant 16, and the `test_gateway.sh` host-reachability case cover it.
- [x] [major] `DASHBOARD_USERNAME=supabase` would make the wrapper's leak rule refuse every stack, because the value appears in image, role and network names. Also raised by failure and abuse. Resolved: the dashboard keys are gone with Studio. Every remaining confined value is high-entropy.
- [x] [major] A flat Caddyfile sorts `handle_path` before `respond`, so no check fires. Evidence: flat -> no key `200`, evil Host `200`; `route {}` -> `401`/`403`. Also raised by failure and abuse. Resolved: D3 requires one `route {}` block (A15), and `test_gateway.sh` fails if the ordering regresses.
- [x] [major] The `caddy hash-password` entrypoint fails without a trailing newline, and A5 wrongly named argon2id as the default. Also raised by failure and abuse. Resolved: no basic auth now that Studio is deferred. A5 is dropped.
- [x] [major] `cap_drop: ALL` without `NET_BIND_SERVICE` stops Caddy from exec'ing. Resolved: D3 adds `NET_BIND_SERVICE`, as the router does (A13).
- [x] [major] `/realtime/v1/api` lacked the tenant Host, so REST broadcast failed. Evidence: `Tenant not found in database` 401 -> with Host 202. Resolved: both realtime routes rewrite Host (D3, A17). Covered by the spec scenario and the test.
- [x] [major] Caddy's error log writes `apikey` (the service-role key) verbatim on upstream errors. Evidence: 502 -> log `"Apikey":["<SERVICE_ROLE_KEY>"]`. Resolved: the gateway's log excludes `http.log.error` and access logs (D3, A14). A spec bullet, a scenario, and a `test_gateway.sh` 502 log-count case cover it.
- [x] [major] A partial `auth` service in `compose.yaml` makes `compose.yaml` invalid on its own, which breaks `e2e:container`. Resolved: `GOTRUE_SITE_URL` is a literal in the shared file, and the base files declare only networks (D1).
- [x] [major] Realtime under `cap_drop: ALL` dies on `run.sh`'s `sudo`. Resolved: realtime runs as uid 65534 with no capabilities and a custom entrypoint (D2, A19).
- [x] [minor] "Healthy" storage may not be writable (uid 1000 `EACCES`). Resolved: storage runs as root with `cap_drop: ALL`, which upload tested (A7), and `test_gateway.sh` uploads a file.
- [x] [minor] An empty `{$SERVICE_ROLE_KEY}` opens the key check. Also raised by failure and abuse. Resolved: a non-empty guard in the CEL comparison (D3), on top of `:?` and the format check.
- [x] [minor] Password checks over loopback or the socket are trust-authenticated, so they give false results. Resolved: task 3.2 checks over the `db` network.
- [x] [minor] The key count was wrong ("nine" vs ten listed). Resolved: v2 has seven new keys, consistent throughout.
- [x] [minor] Task 3.4 expected the wrong PostgREST error. Resolved: it now expects `PGRST205`.
- [x] [minor] pg_graphql is off in this image. Resolved: the `/graphql/v1` route is dropped (non-goal).
- [x] [minor] A2: later files win in a merge. Resolved: no per-environment service partials are used (D1).
- [x] [minor] `webhooks.sql` was dropped without being recorded. Resolved: recorded as a non-goal (no Studio webhooks or functions). `roles.sql` drops the `supabase_functions_admin` line (D6).
- [x] [minor] The Studio password would be in `Config.Env`. Resolved: Studio is deferred.
- [x] [minor] `supabase-gw` had no healthcheck. Resolved: `wget 127.0.0.1:2019/config/`, as the router (D3).

## Failure and abuse

- [x] [critical] Cross-site request forgery into Studio gives superuser SQL. A page the operator visits posts a urlencoded form to Studio's pg-meta query API, and the browser attaches cached basic auth. Resolved: (owner decision, 2026-09-30) Studio and meta are deferred. The gateway also rejects any request or upgrade with a foreign `Origin`, and any bad Host (spec bullet and scenario "A rebound Host or a foreign Origin is refused", D3, test).
- [x] [major] CEL path tests are bypassable (`/PG/`, `//pg/`, `/REST/v1/`). Evidence: the CEL mock routed them to upstream (200). Resolved: routes and key checks share `path` matchers. CEL compares keys only (D3, A16). Covered by the spec "path tricks" scenarios and the test.
- [x] [major] There was no network separation in front of meta and Studio's credential-free SQL. Resolved: both are deferred. The remaining east-west exposure among auth, rest, realtime and storage is recorded as a residual risk to revisit before cutover (design Risks).
- [x] [major] Upstream `jwt.sql` would need `JWT_SECRET` in `db`. Resolved: the current upstream `jwt.sql` uses only `JWT_EXP`, verified by the assumption tester (A10). `db` gets no `JWT_SECRET`.
- [x] [major] The one-time reset would wipe app data and logins. Resolved: (owner decision, 2026-09-30) remove only the two Postgres volumes (D6). Tasks 3.2 and 3.5 check the app volumes are unchanged.
- [x] [major] The wrapper didn't check that the keys are consistent (swap, wrong secret, expiry). Resolved: the HS256 signature against `JWT_SECRET`, roles, distinctness, `exp` in the future, and a warning under 90 days (spec "Allowed names" and scenario, D4, tests 1.1.2-1.1.5).
- [x] [minor] A client `X-Forwarded-Path` reached storage. Resolved: the gateway strips it (spec, D3).
- [x] [minor] Empty-key and empty-`Authorization` edges. Resolved: a non-empty guard, and an empty `Authorization` treated as absent (spec, D3, test).
- [x] [minor] The log-leak check ran only at startup, and logs are an injection channel. Resolved: the counts are re-run after the gateway test and the supabase-js smoke test (task 3.4), and docs/security.md notes that logs are untrusted data.
- [x] [minor] `REALTIME_DB_ENC_KEY` as hex was 64 bits. Resolved: 16 base64url characters, 96 bits (spec format, D5).
- [x] [minor] Recovery for a partial write, rotation, and rollback order were missing. Resolved: the generator sends one all-or-nothing batch (A8). docs/supabase.md gains rotation and recovery (task 4.2). Rollback runs volumes, then revert, then keys (Migration Plan).
- [x] [minor] No disk bound on storage. Resolved: an explicit `FILE_SIZE_LIMIT`, and a docs note to watch `docker system df` (Risks).

## Scope and simplicity

- [x] [major] Two topology scenarios contradicted the new text. Resolved: "Only the router is reachable" now names the gateway, and the `db` membership scenario names the four services.
- [x] [major] Studio's port contradicted ADR 0021's text. Resolved: Studio is deferred, and task 4.2 rewrites the ADR slice text (four services; the gateway is the only Supabase port).
- [x] [major] Studio and meta weren't needed by any goal. Resolved: (owner decision, 2026-09-30) deferred.
- [x] [major] The "only way to reach" claim wasn't enforced. Resolved: see the assumption tester's critical.
- [x] [major] Slice 2 (Companion → Realtime) had no path. Resolved: recorded as out of scope. Slice 2 decides how Companion reaches Realtime (proposal Non-goals).
- [x] [major] Size was estimated at about 560 lines. Resolved: Studio, meta, the dashboard keys, CORS, GraphQL and the `SITE_URL` partials are cut, which brings it to roughly 420-450, under the owner's `size-override`.
- [x] [minor] Cut CORS. Resolved: cut (non-goal). Slice 5 adds it with the first browser client.
- [x] [minor] Cut `/graphql/v1`. Resolved: cut.
- [x] [minor] Simplify `GOTRUE_SITE_URL`. Resolved: a literal in the shared file. The Stage MODIFIED block is dropped.
- [x] [minor] Drop `DASHBOARD_USERNAME`. Resolved: dropped with Studio.
- [x] [minor] Drop the dashboard password letter rule. Resolved: dropped with Studio.
- [ ] [minor] Storage could wait for slice 10. Open for the owner: kept, because the owner chose these services and 1.3 backups expects the storage volume.
- [x] [minor] The healthcheck rule might be unmeetable. Resolved: each image has its tool (A6). The spec says "its own health endpoint".
- [x] [minor] Some scenarios had no check, and the matrix was undefined. Resolved: `test_gateway.sh` covers every route row and the cross-environment case (D7, task 3.5).
- [x] [minor] "README rows" was ambiguous. Resolved: task 4.1 names the make-target table, not the frozen endpoint table.
- [x] [minor] Implementation-heavy spec wording, and a tier reason mentioning prod. Resolved: the gateway requirement no longer names the image source. The tier reason says prod gets definitions only.

## Approval 2026-09-30
The owner approved v2 (four services, Studio/meta deferred, isolated `supabase` + `edge` networks, Postgres-volume-only re-init). Storage stays in scope.

## Consistency read 2026-09-30
Edits since approval: tasks.md (ticks and evidence only).
Scope change: no
- [x] [minor] Every spec requirement and scenario is covered: the gateway table, path tricks, Host/Origin, token passthrough, empty Authorization, realtime API and websocket, storage, host bypass and the 502 log case by `test_gateway.sh` (45 cases, dev and stage); confinement, membership, isolation, subnets and pins by `test_check_envs.sh` (27 cases); formats, JWT consistency, scope and port counts by `compose-run.test.mjs`; generator rules by `supabase-keys.test.mjs`; role-password split, re-init and rotation by live runs (3.2, 3.5, 4.2). Resolved: no gap found.
- [x] [minor] Implementation is slightly stricter than the design in three places: `/rest/v1` without the slash is treated as the REST root (service-role); the gateway log also excludes `http.handlers.reverse_proxy`; storage's healthcheck uses `127.0.0.1` because storage listens on IPv4 only. Resolved: recorded here; none widens scope.
- [x] [minor] "Each environment's SUPABASE_PORT SHALL differ from every other published port of every environment" can only be checked within one environment statically (the values live in Infisical). Resolved: the wrapper and invariant 2 enforce distinctness within an environment; cross-environment distinctness was verified live (dev 8790 and stage 8791 both up, 3.5).
- [x] [minor] Counted size is 561 lines, above the ~420-450 estimate (the services file and the Caddyfile came out longer). Resolved: within the owner's pre-approved `size-override`; the PR carries the label.
- [x] [minor] Non-goals hold: no Studio/meta, no CORS, no GraphQL, no provider, no prod keys, no app connection.
