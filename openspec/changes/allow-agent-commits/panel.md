# Panel: allow-agent-commits

Tier: 2 · Reviewers: assumption tester (A), failure and abuse (F), scope and simplicity (S), each a separate Sonnet subagent · Date: 2026-09-29

No critical findings. Three decisions went to the owner (2026-09-29): add a local `main` guard hook, reword AGENTS.md rule 9, and record the settings gaps as residuals rather than harden `.claude/settings.json`.

- [x] [major] F-1 / A-1 (F, A): the `deny` rule matches only the literal `git commit --no-verify …`; `git commit -n`, `git -c core.hooksPath=… commit`, `SKIP=… git commit` and `commit-tree` skip the hooks unprompted. The proposal's claim "agents can't skip the hooks" was false. Evidence: the settings deny list. Declined by human: no settings hardening. Resolved in part: the proposal wording is corrected, and ADR 0020 records the gap as a residual.
- [x] [major] F-3 / A-2 / S-3 (F, A, S): nothing mechanical stops a commit on local `main`; rule 9 is prose, and AGENTS.md rule 8 wants such rules as hooks. Evidence: `.pre-commit-config.yaml` has no `no-commit-to-branch`. Resolved: the owner chose to add `no-commit-to-branch --branch main` (task 1.1, tested failing first).
- [x] [major] F-4 (F): `git commit --amend`, `reset`, `rebase` and `filter-branch` are unprompted and undenied, so the pinned artifacts commit can be rewritten locally. Declined by human: recorded as a residual in ADR 0020. CI `artifacts-first` still checks what is pushed.
- [x] [major] F-2 (F): the push `ask` is prefix-matched; `git -C dir push`, `git -c k=v push` and `gh api` don't match it. Declined by human: recorded as a residual in ADR 0020; the security row now says "prefix-matched".
- [x] [major] A-3 (A): `main-protect` exempts repo admins (`bypass_mode: exempt`), and agents use the owner's credentials, so the ruleset isn't an independent control against an agent. Evidence: `gh api repos/kwcantrell/autologger-2/rulesets/19850235`. Resolved: the proposal and ADR 0020 say so (see also docs/security.md, the single-collaborator note).
- [x] [major] S-1 (S): the tasks didn't protect artifacts-first against the uncommitted settings edit. Resolved: the tasks now open with a note to stage the change directory by path.
- [x] [major] S-2 (S): the change conflicts with ADR 0018's settings line, and a template refresh would restore the commit `ask`. Resolved: ADR 0020 amends 0018, and its Consequences say so.
- [x] [minor] F-7 / S-3 (F, S): rule 9 contradicted the new settings. Resolved: the owner chose to reword it.
- [x] [minor] F-5 / A-4 (F, A): hook files and `core.hooksPath` aren't protected, and `git add -f` isn't blocked. Declined by human: settings unchanged; ADR 0020 records the residual.
- [x] [minor] F-6 (F): the Stop hook only checks uncommitted work, so committed failures skip it. Accepted: the pre-push hook and CI re-run the gates, and ADR 0020 notes it.
- [x] [minor] F-8 / S-5 / S-6 / A-7 (F, S, A): the tasks' tests were loose. Resolved: task 1.1 is a failing-first hook test; task 1.2 checks the exact ask and deny entries; the settings edit is marked human-authored.
- [x] [minor] S-4 (S): an ADR is warranted; keep it short. Resolved: task 1.3 names the headers and the evidence.
- [x] [minor] A-5 / A-6 / S-7 (A, S): hook coverage is as stated, `docs/security.md:11` is the only stale doc, and ADR 0020 is free. Informational.
