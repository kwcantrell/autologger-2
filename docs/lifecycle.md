# The agent lifecycle, explained

AGENTS.md is the rulebook agents load. This file is for humans: why the loop looks the way it
does, and how to set it up. Agents don't need to read it.

## The loop

```
Explore -> Tier -> Propose -> Panel -> APPROVE -> Branch -> Implement (TDD) -> Verify -> REVIEW + CI -> Archive
                                         ^ human                                          ^ human, hard gate
```

The shape follows vendor guidance that converges on explore, plan, implement, verify
([Anthropic](https://code.claude.com/docs/en/best-practices),
[OpenAI Codex](https://developers.openai.com/codex/learn/best-practices)), with two hard
gates added: human approval before code and green CI before merge. DORA 2025 found AI raises
throughput but lowers stability unless testing, version control and small batches are strong
([DORA](https://cloud.google.com/blog/products/ai-machine-learning/announcing-the-2025-dora-report)).
The gates are how this template supplies those controls.

Loop-backs:

- Panel finds a critical issue: back to Propose.
- Implementation shows the spec is wrong: stop, update the artifacts, re-panel the delta, re-approve.
- Verify fails: back to Implement.
- Review asks for changes outside scope: a new change, not this one.

## Tiers

See AGENTS.md for the table and ADR 0001 for the reasoning. The short version: a typo shouldn't
need a panel, and an auth change shouldn't skip one. The path floor in `openspec/config.yaml`
stops anyone from calling a guardrail change trivial.

## Spec-driven, but light

OpenSpec keeps specs durable: a change's spec deltas merge into `openspec/specs/` on archive.
Thoughtworks warns that spec-driven development can slide back into waterfall, with days spent
perfecting a spec ([podcast](https://www.thoughtworks.com/insights/podcasts/technology-podcasts/what-is-spec-driven-development)).
Size the proposal to the change: a tier 1 proposal can be ten lines.

## What the checks do

`scripts/check-change.sh` is the single implementation. Stages:

| Check | commit | hook | pr | Fails when |
| --- | --- | --- | --- | --- |
| openspec | x | x | x | `openspec validate --strict` or `--archived` fails |
| workflows | x | x | x | An action isn't SHA-pinned, or a workflow lacks top-level `permissions:` |
| skills-sync | x | x | x | `.agents/skills` differs from `.claude/skills` |
| guide-size | x | x | x | AGENTS.md is over its line budget |
| change | x | x | x | More than one change on the branch, no `Tier:` line, tier 1-2 without a change, or a tier 0 change dir. A grandfathered change WARNs, and in CI fails unless the PR body says `Grandfathered: <id>` |
| risk-floor | x | x | x | A high-risk path is touched below tier 2 (a grandfathered change WARNs with the paths) |
| evidence | | x | x | A ticked task has no `Evidence:` |
| commands | | x | x | lint, typecheck or test fails |
| approval | | | x | Tier 1-2 proposal lacks `Approved-by:` |
| panel | | | x | Tier 2 lacks panel.md. Or panel.md has no `- [ ] [severity]` findings and no `No findings.` line, a finding lacks a `[critical\|major\|minor]` tag, a critical is open, or a ticked critical or major lacks `Resolved:` or `Declined` |
| tasks | | | x | An unticked task remains |
| artifacts-first | | | x | The branch's first commit holds more than the change artifacts |
| tests-with-code | | | x | Source changed without a test change. Test folders count at any depth; `managed_paths` files are ignored (label `no-test-needed` overrides) |
| size | | | x | Over `size_budget` changed lines, excluding tests, `managed_paths` and `size_exclude` (label `size-override` overrides; skipped for a grandfathered change) |
| audit | | | x | `lifecycle.commands.audit` fails |

`managed_paths`, `test_globs`, `size_exclude` and `size_budget` are read from the base branch's
config, so a PR can't exempt itself. Changes to them apply from the next PR.

The Stop hook runs the `hook` stage. pre-commit runs `commit` on commit and `hook` on push.
CI runs `pr` on pull requests.

## Setup

1. `scripts/init.sh --owner @you /path/to/repo`, which asks for your stack commands and source
   globs. It renders `.github/CODEOWNERS` for that owner. It never touches an existing
   CODEOWNERS; it prints the paths to add instead. With no owner, it skips CODEOWNERS.
2. Add toolchain setup to the "Stack setup" steps in both workflows.
3. Do the forge settings in `docs/security.md` "Setup a human must do".
4. `pre-commit install --hook-type pre-commit --hook-type pre-push`
5. Commit the install as a tier 2 change, run through the lifecycle itself.

Presets for common stacks may come later. Until then, init.sh asks for the commands.

### Grandfathering in-flight changes

Changes already in flight when a repo adopts the lifecycle have no `Tier:` line or checklist
panel, so they would fail every gate. To let one finish (ADR 0014):

1. A PR of its own adds the id to `lifecycle.grandfathered_changes` in `openspec/config.yaml`.
   It touches a high-risk path, so it's tier 2 and a human approves it. The change's directory
   must already be on main.
2. The change's branch merges main, so its merge-base has both the list and the directory.
3. The change's PR body says `Grandfathered: <id>`.

The change then skips the tier, approval, panel, tasks, evidence, artifacts-first and size gates.
Every other gate runs, and risk-floor warns about any high-risk paths it touches. Once it's
archived and merged, the entry no longer matches anything. Remove it in a later PR.

## Operating

- Release: `docs/templates/release-checklist.md`. Tagging `v*` runs `release.yml`, which builds,
  generates an SBOM and attests provenance.
- Rollback: rehearse with `docs/templates/rollback-drill.md` each quarter.
- Incidents: `docs/templates/postmortem.md`. A postmortem that finds a process gap proposes a
  rule with an ADR. One that finds a gate never fires proposes retiring it (ADR 0011).
