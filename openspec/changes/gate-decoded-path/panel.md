# Panel: gate-decoded-path
Tier: 2 · Reviewers: assumption tester, failure and abuse, scope and simplicity · Date: 2026-10-02

The reviewers found no remaining bypass once the fix is in. They probed the installed Hono 4.13.11 and @hono/node-server 1.19.17 with encoded prefixes, double encoding, invalid UTF-8, case variants, dot-segments, `%2F`, absolute-form targets, HEAD/OPTIONS and WebSocket upgrades. In every case, either the request reaches an `/api` handler and the new gate judges it as `/api`, or it reaches no `/api` handler.

- [x] [major] The proposal understated the exposure. The bypass opened every non-admin `/api/*` route to anonymous callers, across studios, because `requireSession` skips membership when `user === null`. The proposal named only Companion presence. Evidence: `sed -n 26,42p server/src/routers/_helpers.ts` -> `if (user !== null) { ...authUserHasStudio... }`; harness probe -> `HEAD /%61pi/sessions 200`. Resolved: proposal Impact "Exposure" lists the whole surface and the exposure window; task 3.3 adds the incident review.
- [x] [major] The proposal didn't say that no request log exists to search. Evidence: `grep -rn "hono/logger\|accessLog" server/src; grep -n "^\s*log" docker/Caddyfile` -> no output. Resolved: proposal Impact "Forensics" says the review is done on the data, and front-proxy logs are the only place a `%61pi` request line could appear.
- [x] [major] The change is observable but didn't amend `api-contract-freeze`, as AGENTS.md and "Change proposal states contract impact" require. Changes: encoded spellings go from 200 to 401, unmatched encoded paths from 404 to 401, and a token on `/api/%63ompanion/*` from 401 to 200. Evidence: `sed -n 1234,1237p openspec/specs/api-contract-freeze/spec.md` -> "request path is under `/api/companion/`" (raw versus decoded unspecified). Resolved: added an `api-contract-freeze` delta defining "the request path" as the decoded routed path, with a scenario, and a "Contract impact" section in the proposal.
- [x] [major] Task 3.2 called `docker/scripts/test_router.sh`, which exists only on the `supabase-*` branches. Evidence: `git ls-tree -r --name-only origin/supabase-migration | grep test_router` -> found; not on `main`. Resolved: 3.2 now lists explicit curl checks through the stage router.
- [x] [minor] D2 didn't pin the token-scope direction the fix opens (`/api/%63ompanion/state` with a token goes from 401 to 200), or the exemptions on encoded later segments (`/api/pro%66ile`, `/api/%61dmin/users`). Evidence: probe -> `/api/%61dmin/users ... "oldGate":true,"newGate":false`. Resolved: D2 cases added.
- [x] [minor] D2 covered only an encoded first segment. Evidence: route grep -> about 85 literal routes. Resolved: added `/api/s%65ssions` and a table case comparing `/%61pi<rest>` with `/api<rest>` over `app.routes`.
- [x] [minor] Two D2 guard cases can't go red (the token on `/%61pi/companion/state`, and admin). Evidence: `sed -n 122,126p server/src/auth/identity.ts`. Resolved: D2 and task 1.1 say which cases are red and which are guards.
- [x] [minor] The authz D2 case was worded wrong, and it needs a real session id (a made-up id gives 404 and hides the gate). Evidence: harness -> `GET /%61pi/sessions/x/status tok 404`. Resolved: D2 now uses a seeded session and states today's bypassed answer.
- [x] [minor] design.md said `%5C` stays encoded, but decodeURI decodes it. Evidence: `node -e "decodeURI('%5C')"` -> `"\\"`. Resolved: design Context corrected. There is no security effect: the gate and the router share the value, and Caddy rule 1 rejects `%5C` under `/api`.
- [x] [minor] The non-goal overstated the upgrade dispatcher ("destroys everything else"); in dev a non-literal upgrade goes to Next. Evidence: `sed -n 79,88p server/src/upgradeDispatch.ts`. Resolved: the proposal wording is corrected.
- [ ] [minor] `HEAD /api/profile` gets 401 under strict login while GET is exempt. This is pre-existing and out of scope. Evidence: harness -> `HEAD /api/profile 401`. Recorded for 5b (its panel already has it).
- [ ] [minor] Drift: a future middleware deciding on the raw `.pathname` would reintroduce the bug. A CI grep ban would enforce it (AGENTS.md rule 8). Evidence: design A4 grep. Recorded in design Risks as a 5b follow-up.
- [x] [minor] Rollout gap: prod stays exploitable until the redeploy. A Caddyfile stopgap is possible but is a non-goal. Evidence: `docker/Caddyfile` `@apiPrefix` forwards `^/(a|%61)(p|%70)(i|%69)`. Resolved: moot. Prod is not deployed (owner, 2026-10-02); its first deploy is built from a commit with the fix (see consistency read).
- [x] [minor] The freeze exception was recorded only in this proposal; ADR 0021 lives on `supabase-migration`. Evidence: `ls docs/decisions | grep 0021` -> none on `main`. Resolved: task 3.4 adds the ADR line when `main` is merged in.
- [ ] [minor] Merging into `supabase-migration` may conflict in `gate.int.test.ts`/`authz.int.test.ts` (the async rewrite there), and new cases may need `await`. Evidence: `git diff main origin/supabase-migration --stat -- server/src/routers/gate.int.test.ts` -> `22 +-`. Covered by task 3.4.

Not verified by the reviewers: A1 (the live stage curl) was denied to them. The author ran it during the 5b panel: `/api/sessions -> 401`, `/%61pi/sessions -> 200`, `/%61pi/companion/state -> 200`.

## Consistency read 2026-10-02
Edits since approval (8e74b53):
- proposal.md: Why and Impact now say prod is not deployed (owner, 2026-10-02) and stage is loopback-only; Deploy, Exposure and Forensics are folded into one Exposure note with no incident review;
- tasks.md: 1.1, 2.1 and 3.1 ticked with evidence; 3.3 is now merge, with the 401 check done at prod's first deploy and no redeploy or incident review.

Scope change: no. The code, spec deltas, tests and contract impact are unchanged. The edits correct deployment facts only, which lowers urgency and removes the incident-review step.
- Every spec-delta requirement has a task and a test:
  - core-ports-architecture "Percent-encoded API prefix is gated like the literal one" -> `gate.int.test.ts` encoded no-credential cases (task 1.1);
  - api-contract-freeze "Encoded spellings get the literal path's answer" -> `gate.int.test.ts` `/%61pi/companion/state` and `/api/%63ompanion/state` cases (task 1.1);
  - the unchanged scenarios are covered by the existing `gate`/`authz` tests, which are green in 2.1.
- No task does something a non-goal excludes: there is no Caddyfile edit and no upgrade dispatcher change.
- No contradiction between design and specs: D1 (`c.req.path`) matches both deltas.
- [x] [minor] Panel majors 1 and 2 cite "task 3.3 adds the incident review" and "Forensics", which the edit removed. Resolved: these are historical panel records. The current proposal records that there is no deployed exposure, and that without request logs only a data inspection could reveal access on old code.

## Consistency read 2026-10-02 (2)
Edits since the first read: tasks.md (3.2 is now a real-HTTP test instead of a stage rebuild; 3.3 and 3.4 are removed), proposal.md (+ "After merge" with the former 3.3 and 3.4). CI's `tasks` gate failed on #32 with `3 unticked task(s)`: 3.3 and 3.4 can only happen after merge, and 3.2 would have torn down the integration stage.
Scope change: no. The fix, the spec deltas and the contract impact are unchanged; one test is added (`apiToken.int.test.ts`, real socket).
- Every spec-delta requirement still has a task and a test. The real-HTTP test also covers both new scenarios over a socket.
- No task does something a non-goal excludes: no Caddyfile or upgrade-dispatcher change.
- No design/spec contradiction.
- [x] [minor] The stage router hop isn't re-run against the fixed server. Resolved: the router's forwarding is unchanged and was observed during the panel; the server-side decision is now tested over a real socket.
