# Panel: catalog-concurrency-hazards
Tier: 2 · Reviewers: assumption tester, failure and abuse, scope and simplicity · Date: 2026-10-01

Each reviewer ran as a separate subagent with fresh context. Their probes used throwaway `supabase/postgres:17.6.1.136` containers with the real catalog schema; the containers were removed afterwards. Scripts are in the session scratchpad (`panel4d-at/`, `panel4d-fa/`).

## Assumption tester

- [x] [critical] The root deadline (D10) broke mirror ordering (D6). A bounded statement keeps running on its pooled connection, so an older projection can land after a newer one. Evidence: `pause.mjs` (pool 3, pause, bound 300 ms, 15 runs) -> `final=1: 7, final=2: 8`. Resolved: D10 sets `max_pipeline: 1` and withdraws unsent statements. `CatalogRootTimeoutError.settled` lets the D6 chain wait for a timed-out write before the next link. Specs: catalog-database and core-ports-architecture. Tests 4.1 and 5.1. (The failure-and-abuse and scope reviewers found the same thing; see their sections.)
- [x] [major] The plain in-transaction re-check doesn't abort rename, revoke or invite by a concurrently demoted admin, because there is no rw cycle. Evidence: `ssi.mjs` -> `rename-by-B vs demote-B: commit/commit`. Resolved: the re-check is `SELECT … FOR SHARE` (A13, `forshare.mjs` -> `40001` after a committed demotion). Task 2.1 tests rename as well as delete.
- [x] [major] D4 check-then-insert can recreate a deleted team's settings. Evidence: `ssi.mjs` -> `rows after: ["studio_config:acme"]`. Resolved: D2's create purge removes `studio_config:<id>` (both planes), and the spec now says a racing row never reaches a later team.
- [x] [major] D9 would hide operator-readable domain messages. Every log-import error is a plain `Error`. Resolved: a deny-list redacts only errors with a string `code` or a `Catalog*` name (A18). The spec is reworded, and task 4.5 checks that a domain message is kept.
- [x] [major] The D1 seam can't reach KV or the mirror, which hold the process adapter. Resolved: tests also override `ports.kv` / `ports.mirror` with gated instances (A19, D1). Task 4.2 uses a `projectSessionLive` spy. The spec wording "a catalog it builds itself" became "SHALL NOT use the request's catalog".
- [x] [minor] `guardedAgainstLastAdmin` calls the root facade, which the adapter refuses inside a transaction. Resolved: D2, it takes the bound `cat`.
- [x] [minor] `admin.ts:82-92` has no transaction. Resolved: D3 adds one.
- [x] [minor] Admin-plane membership removal and account disable are root writes that SSI can't see (`rootw.mjs` -> `enabled admins left=0`). Resolved: D2 moves them into the guard's transaction, and task 2.5 tests it.
- [x] [minor] The anonymous active-show repair is still a blind overwrite. Resolved: D8 adds `setSettingIf`; task 4.4 covers anonymous mode.
- [x] [minor] Implicit rules not stated (chain semantics, gates fired again on re-run, the D4 remap, the 30 s backstop). Resolved: D1 (one-shot gates that stay open), D4 (remap unchanged), D6 (a link starts after the call), D10 (the `statement_timeout` bound).

## Failure and abuse

- [x] [major] A timed-out root write lands late, a "zombie". Resolved: covered by the assumption tester's critical finding (D10, D6). The spec also states that an expired sent write may still apply.
- [x] [major] With no `studio_id` index, writes in unrelated teams abort each other, which is a DoS on other teams' admins (`ssi.mjs` -> `different ids: 40001`; `Seq Scan`). Resolved: owner (2026-10-01) chose to add the index. D12 migration indexes `user_studio_memberships (studio_id)` and `shows (studio_id)`. The spec has a "Cross-team independence" requirement and scenario; tasks 1.2 and 2.7.
- [x] [major] A reused id inherited orphan shows and settings. Resolved: the create refuses an id that has shows (`400`) and purges settings. Spec scenario, task 2.2.
- [x] [major] The admin plane's create kept #18 open. Resolved: `adminCreateStudio` uses the same refusal and purge (D2). Spec and task 2.2.
- [x] [major] The purge must never run for a built-in or invalid id. Resolved: D2 orders validation (including the built-in reservation) before the transaction. Spec scenario "A built-in id is never purged", task 2.2.
- [x] [major] D9 hides user-actionable errors. Resolved: the deny-list (see the assumption tester's finding).
- [x] [major] D4 check-then-insert. Resolved: see the assumption tester's finding.
- [x] [minor] Coalescing could drop a committed change. Resolved: no coalescing, and a call awaits a link that starts after it (D6, task 4.1).
- [x] [minor] A mirror after `close()` reopens hubs. Resolved: `SessionMirror.close()` runs before `registry.closeAll()`, and later calls are no-ops (D6, task 4.1).
- [x] [minor] The periodic purge reuses the boot warning and is never cleared. Resolved: D10 gives it its own text and clears it on shutdown (task 5.2).
- [x] [minor] A failed registry refresh after create would give a 500 for a created team. Resolved: D2 warns and returns 200.
- [x] [minor] A best-effort episode date can be lost silently. Resolved: the warning names the sid and the intended date (D6, the youtube-audio-import delta).
- [x] [minor] A stale `is_rolling` on an idle session. Resolved: accepted and documented in R4 (display only; the Companion toggle reads hub state).

## Scope and simplicity

- [x] [major] D9's allow-list conflicts with sheets-log-import. Resolved: the deny-list, see above.
- [x] [major] Log-and-succeed contradicts auto-event-generation's "projection current". Resolved: MODIFIED delta for "Generated events append, bounded and attributable".
- [x] [major] The best-effort episode date contradicts youtube-audio-import and the freeze's YouTube success row. Resolved: MODIFIED deltas for "Publish-date opt-in…" and "YouTube import endpoint behavior".
- [x] [major] The 6.3 `docker pause` check couldn't show "event saved", because the middleware's root reads time out first. Resolved: 6.3 now checks the 5-6 s generic 500 and recovery. Mirror failure after a commit is covered by 4.2.
- [x] [major] The root deadline without a cancel reopens #3 in the mirror chain. Resolved: see the critical finding (the `settled` wait).
- [x] [major] Size is about 550-650, not 400-480. Resolved: owner (2026-10-01) keeps one PR, with `size-override` and a ceiling of about 650; past that, stop and split (proposal, tasks header, R5).
- [x] [minor] The create purge should also delete settings. Resolved: D2 step 5.
- [x] [minor] The purge is redundant with the re-check. Kept on purpose as the ADR's named remedy and for non-route writers. The tests prove the re-check path.
- [ ] [minor] The early root `requireTeamAdmin` could be dropped for delete and revoke. Declined: kept on every route for one uniform status order. That costs one root read.
- [x] [minor] Mirror coalescing isn't needed. Resolved: removed (D6).
- [x] [minor] D2 overstated SSI, and gates must hold the request before the role read and stay open on retry. Resolved: FOR SHARE (A13), and D1 one-shot gates.
- [x] [minor] "The status an unknown team gets" was ambiguous. Resolved: pinned to `400 Unknown studio id.`.
- [x] [minor] The OAuth "Unexpected internal error stays 500" needed a narrowing note. Resolved: the ADDED sign-in requirement says it narrows that only for this race.
- [x] [minor] The anonymous branch of #5. Resolved: D8.
- [x] [minor] #14 is only partly addressed. Resolved: 6.1 records it as partly done, and D11 lists display names.
- [x] [minor] Task 2.1 bundled six hazards. Resolved: split into 2.1-2.7, each with its own red and green.
- [x] [minor] Contract checks found no issue (the 404s and `{ok:false}` are already frozen defaults). Noted.
