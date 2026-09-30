<!-- CI reads the Tier and Change lines. Keep them on their own lines. -->
Tier: 1
Change: <openspec change id, or "none" for tier 0>

## What and why

<!-- One or two sentences. Link the proposal for anything longer. -->

## Evidence

<!-- Paste the tail of `scripts/check-change.sh` and anything a reviewer should see run. -->

## Overrides

<!-- Only if you applied the `no-test-needed` or `size-override` label: the reason, in one line. -->

## Reviewer checklist

- [ ] Tier matches the risk (tier 2 for contracts, auth, secrets, migrations, concurrency, destructive ops, the process)
- [ ] Diff matches the approved proposal; nothing out of scope
- [ ] Tests fail without the change and pass with it
