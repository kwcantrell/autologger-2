# Panel: fix-dependency-vulns

Tier: 2 · Reviewers: assumption tester (A), failure and abuse (F), scope and simplicity (S), each a separate Sonnet subagent · Date: 2026-09-29

No critical findings. Four decisions went to the owner (2026-09-29):
- the audit gate stays at `high`, with a waiver path;
- Dependabot gets a weekly, grouped npm entry;
- the floors are raised;
- the images are rebuilt with `make prod-push` after merge.

- [x] [major] F-AUDIT-DOS / A-1 (F, A): the live-registry audit gate blocks every PR when a new high advisory has no fix, or the registry is down; there was no waiver path. Resolved: owner decision. ADR 0019 documents a waiver: a reviewed tier 2 PR relaxes `commands.audit` with a dated reason, and a later PR restores it (design 4, 7).
- [x] [major] F-IMG-EXPOSURE (F): the deployed images keep the critical `next` RCE until they are rebuilt. Resolved: owner decision. Claude runs `make prod-push` after merge; the PR states the exposure window (design 8, tasks after-merge list).
- [x] [major] S-1 (S): the gate is a new rule, and it reverses ADR 0018 without an ADR. Resolved: ADR 0019 (design 7, task 2.3).
- [x] [major] S-2 (S): `dependabot.yml` has no npm entry, so this recurs. Resolved: owner decision; a weekly, grouped npm entry (design 5, task 2.3).
- [x] [major] S-3 / A-2 (S, A): task 2.5 ran `--stage hook`, which omits `audit`. Resolved: the new task 2.6 runs `--stage pr`; tasks 1.1 and 2.2 run `--only audit`.
- [x] [minor] A-4 (A): the `package.json` floors admitted the vulnerable versions. Resolved: owner decision; the floors are raised (design 2).
- [x] [minor] A-3 (A): the eslint side effect was understated (`brace-expansion` 5 → 1, `minimatch` 10 → 3, 20 added). Resolved: the proposal lists it in full. All of it is dev-only and unused.
- [x] [minor] A-5 / F-HONO-MINOR (A, F): the `hono` 4.13.5+ behaviour changes weren't named. Resolved: design "Risks" names `parseBody` (unused), the query fragment and `toSSG`, and cites the WS upgrade tests. Task 2.5 adds the e2e.
- [x] [minor] A-6 (A): the `postcss` recipe wasn't reproducible from the tasks. Resolved: design 3 gives the exact steps, and task 2.2 follows them.
- [x] [minor] F-NPM-VER (F): npm 10 can't run the lockfile fix. Resolved: design Context and 1 record that npm 11 resolves and npm 10 installs (`npm ci` verified).
- [x] [minor] S-6 / F-POSTCSS-OVERRIDE (S, F): the override has no removal trigger, and the accept-residual option wasn't recorded. Resolved: design 3 adds the trigger (the `next` 16 change) and the rejected alternative; ADR 0019 records both.
- [x] [minor] S-5 (S): no `--omit=dev` rationale. Resolved: design 4.
- [x] [minor] S-7 (S): where the gate rule lives. Resolved: in `config.yaml` and ADR 0019; `skip_specs` stays.
- [x] [minor] S-4 (S): 1.1 was a weak failing-first check. Resolved: it runs on the unchanged lockfile, and its FAIL line is recorded as evidence.
- [x] [minor] S-8 (S): the e2e task was underspecified. Resolved: task 2.5 names the image derivation, a fresh clone (no `server/data`), the `main` baseline, and the port and `DATA_DIR`.
- [x] [minor] S-9 (S): the counts had no derivations. Resolved: the proposal's Why carries the commands.
- [x] [minor] S-10 (S): `sharp` 0.35 compatibility. Resolved: `next@15.5.26` accepts `^0.35.4`; the image build at `prod-push` exercises it.
- [x] [minor] F-UUID-FUTURE (F): a `high`-level gate won't surface a `uuid` regression. Accepted by the owner (the `uuid` decision); recorded as a residual (design 6).
