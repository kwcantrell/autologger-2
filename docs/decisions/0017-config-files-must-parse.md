# 0017: YAML files must parse

- Date: 2026-09-29
- Status: Accepted
- Rule: check `yaml`
- Note: merged as 0016 in PR #9, alongside `0016-archived-task-edits` from PR #8, and renumbered
  because #8 merged first. yaml-parse-gate's archived records use the old number and path.

## Context

From the initial commit until PR #6, `.pre-commit-config.yaml` didn't parse: a hook name contained
an unquoted `: `. pre-commit couldn't load it, so the pre-commit and pre-push gates never ran, and
CI, which never parsed that file, stayed green. It was found by hand while installing the template
into autologger-2. A config file that fails to load silently disables whatever it configures.

## Decision

Every tracked `.yml`/`.yaml` file must parse. Untracked ones are checked too, locally. Unknown tags
(`!Ref`, `!vault`) are read as plain values, and `!!python` tags stay rejected.
`.pre-commit-config.yaml` must also have a loadable shape. The PR stage fails on any broken file.
The commit and hook stages fail on files the change touched, and warn on untouched ones, so a repo
with pre-existing broken YAML doesn't deadlock the Stop hook.

## Evidence

- The initial commit's `.pre-commit-config.yaml` -> `:26: mapping values are not allowed here`
  under this check.
- The yaml-parse-gate panel (16 findings).

## Consequences

Templated YAML (Helm `{{ }}`) doesn't parse, so repos with Helm templates will fail the PR stage.
There is no exclusion list yet, on purpose, because an unbounded exclusion is a bypass. Add a
bounded one when the first real repo needs it. Duplicate keys still pass (PyYAML keeps the last);
catching them is a possible follow-up.
