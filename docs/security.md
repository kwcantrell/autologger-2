# Agent threat model

Controls for coding agents, mapped to the
[OWASP Top 10 for Agentic Applications 2026](https://genai.owasp.org/2025/12/09/owasp-top-10-for-agentic-applications-the-benchmark-for-agentic-security-in-the-age-of-autonomous-ai/).
The OWASP list covers agents in general; the rows below are how each risk shows up when the
agent writes code in this repo. Review this table in the quarterly rule review.

| Risk | How it shows up here | Controls |
| --- | --- | --- |
| ASI01 Agent Goal Hijack | Instructions hidden in an issue, PR comment, web page, dependency README or test fixture | AGENTS.md rule 9 (content is data); human approval of scope; panel's failure-and-abuse reviewer |
| ASI02 Tool Misuse | Agent runs a destructive or exfiltrating command | Sandbox; `deny` for curl, wget, force-push, `--no-verify`; `ask` for commit and push |
| ASI03 Identity & Privilege Abuse | Agent uses the developer's credentials beyond the task | Secrets unreadable (`Read(**/.env)` denied); workflows default to `contents: read`; no push to main |
| ASI04 Agentic Supply Chain Vulnerabilities | Agent adds a malicious or vulnerable package, or a workflow uses a moved tag | Dependency review; `lifecycle.commands.audit`; SHA-pinned actions; Dependabot |
| ASI05 Unexpected Code Execution | Agent runs untrusted code from a dependency or a fetched script | Sandbox filesystem and network isolation; CI in ephemeral runners |
| ASI06 Memory & Context Poisoning | A poisoned spec, ADR or skill steers future changes | CODEOWNERS on openspec/, docs/decisions/, .claude/; generated skills can't be edited |
| ASI07 Insecure Inter-Agent Communication | A subagent's report carries injected instructions to the parent | Panel reviewers return findings, not actions; the parent treats reports as data |
| ASI08 Cascading Failures | One bad change propagates through many files or services | Size budget; tier 2 for contracts; CI required before merge |
| ASI09 Human-Agent Trust Exploitation | A confident summary gets approved without reading | Evidence rule (command + output); human reviews the diff, not the summary |
| ASI10 Rogue Agents | Agent weakens its own guardrails | Settings, hooks and approval lines are agent-unwritable; CODEOWNERS on .claude/ and .github/ |

## Setup a human must do

These live in the forge, not the repo, so the template can't apply them:

1. Main branch ruleset: require a pull request, required status checks `gates`, `secrets` and
   `dependency-review`, code owner review, and no bypass for agents or bots.
2. Secret scanning with push protection
   ([docs](https://docs.github.com/en/code-security/secret-scanning/introduction/about-push-protection)).
3. Dependency graph (needed by dependency review).
4. Workflow permissions: default `GITHUB_TOKEN` to read-only in repo settings.
5. If you use GitHub's Copilot coding agent, keep its defaults: it pushes only to `copilot/`
   branches, and workflows wait for human approval
   ([docs](https://docs.github.com/en/copilot/concepts/agents/coding-agent/risks-and-mitigations)).
6. Sandbox network: add your package registries to the Claude Code sandbox network allow list
   ([docs](https://code.claude.com/docs/en/sandboxing)).

## Known gaps

- `Approved-by:` is a text line. Code owner review is the real control (ADR 0002).
- With a single collaborator, code owner review can only be met through the admin's
  bypass on PRs, since GitHub doesn't count an author's own approval. Anything holding the
  admin's token, an agent included, has that bypass. Real separation needs a second reviewer.
- The panel gate checks structure, not honesty. A real critical tagged `[minor]`, or
  `No findings.` written over findings discussed in prose, passes. The human approver is the
  control.
- Files under test folders count as tests and are left out of the size budget, so source hidden
  in a `tests/` folder evades both gates. Code review is the control.
- Exemptions (`managed_paths`, `test_globs`, `size_exclude`, `size_budget`) come from the base
  branch, so a PR can't exempt itself. A later PR can still widen them where no human owns
  `openspec/config.yaml`. A modified copy of the vendored checker isn't detected.
- A grandfathered change (ADR 0014) skips the size and review-artifact gates, so its branch has
  no size cap. High-risk paths it touches only warn. Any `archive/<date>-<id>` for a listed id
  qualifies while main still has the id. The controls are human review, the
  `Grandfathered: <id>` line in the PR, and the rule that the change must already be on main.
  A tasks.md-only edit to such an archive is exempt like any other (next point) and needs no
  `Grandfathered:` line.
- A tasks.md-only edit to an archive already on the base branch is not a change (ADR 0016). A tier 0 PR can
  therefore tick archived tasks that weren't done, or drop their `Evidence:` lines. The controls
  are the `change` message, which names every such archive, CODEOWNERS on `openspec/changes/`
  (a repo that keeps its own CODEOWNERS must add it), and human review.
- Adopting into a repo with its own settings leaves the lifecycle hooks unwired until a human
  merges `.lifecycle-adoption/settings.json` (ADR 0015). Until then, the Stop and approval hooks
  don't run there.
- The adoption blocks' precedence line ("the lifecycle gates win") is advisory text. Codex reads
  AGENTS.md but not `@` imports. An agent could apply the proposals despite the README telling
  it not to; the install PR's human review is the control.
- Deny rules match command prefixes. A determined agent can reach the network another way,
  which is why the sandbox, not the deny list, is the boundary
  ([Claude Code security](https://code.claude.com/docs/en/security)).
