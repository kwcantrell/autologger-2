# Design: adopt the agent-lifecycle-template

Revised after the panel (see panel.md). Finding ids are in brackets.

## Context

- **The install branch:** built on the unmerged `adopt-agent-lifecycle`, 7 commits on `main` @
  794c107. On it, the refreshed checker (template 44b75ac) passes `change` at tier 0, exempting the
  six archives. It fails `risk-floor` (the install needs a tier 2 change) and `size` (4,332 lines).
- **Why a new branch:** the template's `artifacts-first` gate requires a branch's first commit to
  be the approved artifacts only.

## Decisions

1. **Branch.** A fresh `lifecycle-install` off `main`.
   - Commit 1 is this change's approved artifacts only [S-10].
   - Then `git cherry-pick main..adopt-agent-lifecycle` replays the 7 install commits unchanged.
     A scratch replay gave an identical tree outside this change's directory [A: verified].
   - Then this change's own commits follow.
   - `adopt-agent-lifecycle` is deleted after merge.

   Rebasing the old branch would need the same artifacts commit inserted first, which is the same
   operation with more rewriting.
2. **Repo rules in `AGENTS.md`** [S-4, F-invariants-deferred]. This is the owner's decision; the
   single-process rule is excluded at the owner's request. `AGENTS.md` is loaded by Claude (through
   `@AGENTS.md`) and by Codex. The following section is appended to it verbatim, which takes it to
   about 95 of its 150 lines:

   ```markdown
   ## This repo (autologger)

   - **`server/data` is live production data.** Never read, copy into, mount, or point
     `DATA_DIR` at it. `server/.env.example` sets `DATA_DIR=./data`, which is `server/data`, so set
     `DATA_DIR` to a scratch path before starting the server.
   - **The HTTP/WS contract is frozen:**
     - the README endpoint table is the route list;
     - JSON shapes, status codes, export bodies, header and range semantics, and WebSocket
       messages are all fixed.

     An observable change needs an OpenSpec change whose delta amends `api-contract-freeze`, and
     `packages/contract/**` and `server/src/routers/**` force tier 2.
   - **Keep dev on loopback.** `npm run dev` binds `127.0.0.1`. Test LAN devices against
     `npm run build && npm run start` instead.
   - **`npm run e2e:container` uses fixed container names** and clashes with a running prod stack.
     Check `docker ps` first.
   ```
3. **Contract paths are high-risk.** `lifecycle.high_risk_paths` gains `packages/contract/**` and
   `server/src/routers/**` [F-risk-floor-blind-to-contract]. `openspec/config.yaml` is itself
   high-risk, so this change is the reviewed place to do it.
4. **Remove `release.yml`** [F-release-broken, A-3, S-11, F-release-npmci-idtoken].
   - Also remove `lifecycle.release_artifacts` and `lifecycle.commands.build`, which only
     `release.yml` used (`--only build`).
   - This repo releases GHCR images through `make prod-push`, not a `dist/` artifact.
   - This also removes the job that ran `npm ci` with `id-token: write`.
   - Reinstating a release workflow is a separate change.
5. **Size override** [S-7]. The `size` gate counts 4,332 lines: the vendored template scripts, the
   ADRs 0000-0018, docs, generated skills, and the replayed commits.
   - Splitting out "remove old lifecycle" alone would pass, but it would leave `main` with no
     process and no guard test in between.
   - Splitting the vendored files further gains nothing a reviewer needs.
   - The owner applies `size-override`; the PR body gives the reason.
6. **CI stack setup on Node 22** (`lifecycle.yml` only). In the "Stack setup" slot, after the gate
   tooling install:
   - `actions/setup-node` at the SHA `lifecycle.yml` already pins
     (`820762786026740c76f36085b0efc47a31fe5020`), with `node-version: 22` and `cache: npm`;
   - `npm ci`.

   The assumption tester ran `npm ci`, typecheck, test and build under node:22 in Docker (npm 10),
   all passing in about 2 min [A: verified]. `openspec` 1.13.2 works on Node 22 as well.
   `pull_request` (not `_target`), read-only permissions and `persist-credentials: false` keep fork
   PRs safe [F-ci-fork-safe].
7. **`.gitleaksignore`** holds the four historical fingerprints [F-gitleaks-history]:
   - `78231a41443ffa56ff6c97bf307515c95f3c8ae3:docker/scripts/check-envs.sh:generic-api-key:91`
     (the placeholder `WEB_TAG=abcdef123456`);
   - `956114c00496f8be55d3c362d33e79af178efdfe:server/src/routers/apiToken.int.test.ts:generic-api-key:122`;
   - `83094b9066979f52d8d381ae0a6790ba6445a675:e2e/containerHarness.ts:generic-api-key:139`;
   - `4ba309c2c24327843d05771fad2cdd4425aee0c8:server/src/upgradeDispatch.int.test.ts:generic-api-key:94`.

   The last three are the RFC 6455 sample key `dGhlIHNhbXBsZSBub25jZQ==` ("the sample nonce").
8. **Specs** [A-1, A-2, S-1, S-2, S-3].
   - `sdlc-process` is retired through `retire_capabilities: true` in `.openspec.yaml`.
     `openspec archive` refuses to empty a spec without the flag, and with it the spec is deleted
     [A: verified in a scratch archive, validate 26/26].
   - `cursor-agent-adapters`:
     - REMOVED: the routing and drift-guard requirements;
     - MODIFIED: the MCP-config and restart-rule requirements, with the guard clauses dropped;
     - the main spec's Purpose is rewritten directly (a delta can't change it), with this text:
       "Governs the two remaining Cursor-side files: the untracked `.cursor/mcp.json` with its
       tracked portable example, and the `restart-server-yourself` rule. Cursor and Codex agents
       read the lifecycle from `AGENTS.md`; the former pointer adapters and their drift guard were
       retired by `adopt-agent-lifecycle`."
9. **ADR 0018, `docs/decisions/0018-adopt-agent-lifecycle.md`** [S-9]. It records:
   - why the repo adopted the template (prose-only enforcement);
   - the verbatim-copy approach;
   - lint and audit left blank;
   - the repo rules block;
   - the contract paths;
   - the release removal;
   - the Stop hook needing `npm ci` on a fresh clone [A-5];
   - the owner's choice not to change settings.

## Accepted residuals

- **Refresh conflicts:** `AGENTS.md` now differs from the template. A future template refresh must
  merge the "This repo" section back.
- **Stop hook cost:** on a fresh clone the Stop hook fails `commands` until `npm ci` is run
  [A-5, F-stop-hook-cost]. The hook stops blocking after 3 tries; ADR 0018 notes it.
- **Single code owner:** `@kwcantrell` owns everything, so "Require review from Code Owners" is met
  only by an admin bypass [F-codeowners-single-owner]. This is a known template gap
  (`docs/security.md`).
- **Nothing blocks `server/data` mechanically.** No settings deny rule protects it (the owner kept
  the settings); only the `AGENTS.md` rule does [F-settings-no-datadir-protection].
- **The `impeccable` plugin setting is dropped** [F-settings-plugin-dropped].
- **`size-override` is a full bypass,** set by label [F-size-override-routine]. The controls are
  CODEOWNERS and the PR-body reason.
- **`old-lifecycle/` is local only** [F-old-lifecycle-loss]. The authoritative copy is `main` @
  794c107 in history.

## Assumptions

| Assumption | Command | Observed |
| --- | --- | --- |
| `main` hasn't moved since the install branch | `git merge-base main adopt-agent-lifecycle`; `git rev-parse main` | both `794c107` |
| The replay is exact | scratch clone: commit the change dir, `git cherry-pick origin/main..origin/adopt-agent-lifecycle`, then `git diff origin/adopt-agent-lifecycle HEAD --stat -- . ':!openspec/changes/adopt-agent-lifecycle'` (assumption tester) | rc 0, 7 commits, empty diff |
| On the replay, `change` is tier 2 and `risk-floor` and `artifacts-first` pass | `scripts/check-change.sh --stage hook`, then `--stage pr`, in that clone (assumption tester) | `change` tier 2 (6 archives not counted), `risk-floor` PASS, `artifacts-first` PASS, `size` 4332 |
| Node 22 CI works | `docker run node:22 bash -c "npm ci && npm run typecheck && npm test && npm run build"` on a scratch clone (assumption tester) | all rc 0, about 2 min, npm 10.9.9 |
| Retiring an emptied spec needs the flag | `openspec archive` in a scratch clone, without and then with `retire_capabilities: true` (assumption tester) | aborts without it; with it, `Retiring openspec/specs/sdlc-process/spec.md`, validate 26/26 |
| The gitleaks history hits are false positives | `gitleaks git --redact --report-format json` (v8.30.1, docker) on a scratch clone; `git show <commit>:<file>` at each line | 4 hits: the RFC 6455 sample key ×3 and the placeholder `WEB_TAG` |
| Only `release.yml` uses `release_artifacts` and `--only build` | `git show adopt-agent-lifecycle:scripts/lib/check_change.py \| grep -n build` | `"build": ... # release workflow only` |
| `DATA_DIR` defaults to `server/data` | `grep DATA_DIR server/.env.example` | `DATA_DIR=./data` |
