<!--
Factory PRs: /factory:ship opens this PR with the job's ship.md as the body, so this template is
only for a PR opened by hand. No gate reads the body; CI checks the code, not this text.
-->

Factory job: <job id, e.g. 012-short-slug> (`factory/jobs/<id>/`: task.md, build.md, proof.md, review-*.md)

## What and why

<!-- One or two sentences. task.md holds the acceptance criteria. -->

## Evidence

<!-- Where the proof lives: proof.md, files under factory/jobs/<id>/evidence/, and anything a
     reviewer should see run (the tail of `scripts/check-change.sh`, test output). -->

## Overrides

<!-- Only if you applied the `no-test-needed` label: the reason, in one line. -->

## Reviewer checklist

- [ ] The diff does what task.md's acceptance criteria ask, and nothing out of scope
- [ ] Each criterion has a test that fails without the change, or saved evidence (proof.md)
- [ ] Behavior changes update the matching spec under `openspec/specs/` in this PR
- [ ] No observable change to the frozen HTTP/WS contract; auth, secrets and PII work was human-led
- [ ] Blocking review findings are fixed or answered
