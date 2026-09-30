# 0016: tasks.md-only edits to existing archives are not a change

- Date: 2026-09-29
- Status: Accepted
- Rule: check `change` (`exempt_archives`); changed paths read NUL-separated with `--no-renames`;
  artifacts-first and size read git paths the same way (exact-git-paths)

## Context

autologger-2 adopted the lifecycle with 26 unticked tasks across six archived changes. The tasks
were deferred, dropped, or owed to a human. `openspec validate --archived` fails on them, and the
only fix is to edit those `tasks.md` files. But `change` counts every edited archive as the branch's
change. Editing six fails "one change per branch", and editing one fails because a pre-lifecycle
proposal has no `Tier:` line. No PR could carry the edit.

The panel then found that the changed-file list the gates share was unsafe for every gate:
- it split paths on whitespace;
- with rename detection on, a moved file hid its old path.

## Decision

`change` does not count `openspec/changes/archive/<name>/` when all of these hold:
- `<name>` is `YYYY-MM-DD-<lowercase id>`;
- the directory is on the merge-base;
- its only difference from the merge-base is one in-place modification (`M`, regular file on both
  sides) of its `tasks.md`, with no untracked file beside it.

Every `change` result names the archives it did not count. Changed paths are read NUL-separated
with rename detection off, so a path is read whole and a move lists both sides.

The owner chose this over skipping `--archived` validation for pre-adoption archives. That route
avoids history edits, but it needs a new config key and leaves invalid archives in the tree.

## Evidence

- autologger-2's adoption (2026-09-29): the tick commit failed `change` with six archives found.
- The archived-task-edits panel (19 findings, two critical: whitespace splitting and hidden
  renames, both reproduced).

## Consequences

A tier 0 PR can tick archived tasks that weren't done. The owner accepted that as a residual, with
these controls: the `change` message lists every exempted archive, CODEOWNERS covers
`openspec/changes/`, and `docs/security.md` records it. `risk-floor` now also sees high-risk files
moved out of their directory.

Retire the exemption if the quarterly review finds it used for anything but adoption clean-up.
