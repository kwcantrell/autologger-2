## Context

This change replaces `sdlc-retro-loop`, which was blocked by eight reviewers across two panels and
abandoned rather than reworked. Its panel reports are carried in this change's `.apply/` as the
evidence base.

**The owner's stated purpose (2026-08-09)** — the lens everything here is judged against. The SDLC
exists **exclusively for AI agents**; following it should produce **high-quality code**; and it
enables (1) a human to state a feature with as little context as possible, (2) the receiving agent —
that feature's orchestrator — to compare the feature against current repo state and work with the
human to resolve conflicts, and (3) the orchestrator to flesh the feature out with the human first.

**Current state, measured on `main` @ `f83265d`:**

```
CLAUDE.md            329 lines   "How we work (SDLC)" = 162.  Auto-loads for EVERY agent,
                                 including subagents.  ~96% of it governs post-proposal work.
apply skill          510 lines   Reaches only the orchestrator, only at apply time.
openspec/config.yaml  38 lines   Reaches only the drafting agent.
openspec/specs/        —         Reaches nobody by default.
openspec-explore     290 lines   ZERO repo-specific content: no mention of this repo, the frozen
                                 contract, or openspec/specs.
openspec-propose     —           Line 123 instructs "prefer making reasonable decisions to keep
                                 momentum" — the opposite of purpose 3.
```

**Constraints inherited and verified:** `sdlc-process` names three encodings as the normative
record, forbids a parallel rulebook alongside them, and makes process-rule changes design-bearing
(panel + gate). It carries no rules itself. Its three-encoding enumeration is **already inaccurate**
— the propose and archive skills carry repo process rules today — which this change notes but does
not attempt to fix.

## Goals / Non-Goals

**Goals:** close purpose 2's zero-line gap at the moment it is cheapest; stop the propose skill from
instructing against purpose 3; make repo claims verifiable before they propagate.

**Non-Goals:** a rule-inclusion test; tracked retro evidence; an index; cutting existing text (D5);
any runtime code change; correcting `sdlc-process`'s already-inaccurate three-encoding enumeration.

**One spec requirement, and why the reviewers' "zero spec delta" is not quite right.** Reviewers
recommended no spec delta, and for the *three rules* that is correct — they are content, and content
belongs in the encodings. But D1's finding (reach, not length) is a **placement** property, and
placement is exactly what `sdlc-process` governs. It is recorded as one requirement carrying no rule
content, which is also the shape the purpose-fit reviewer proposed ("replace it with a placement
principle, ~+8 lines not ~+95").

## Decisions

### D1 — Reach, not length, is the variable

The abandoned proposal diagnosed **accretion**: the encodings are long, so rules get lost. Reviewers
falsified it — **zero** of nineteen observed failures show a rule missed because the encodings are
long. Every one is a rule that existed on a surface the acting agent never loaded at that moment.

`ts.createSourceFile` is the clean case: the recommendation existed, in an archived audit and in
memory, both readable. It never reached the agent writing the sixth regex scanner, because neither
surface is in that agent's context.

**Consequence adopted here:** both additions land in `CLAUDE.md`, the only surface that auto-loads
for every agent including subagents; the third edit is a deletion from the propose skill. The abandoned draft would have put rule content into
`openspec/specs/` — the lowest-reach surface in the repo, and exactly backwards.

### D1b — The placement principle is the durable form of D1

D1's finding would otherwise live only in this change's design, which does not sync — the failure
mode this whole line of work keeps hitting. It is recorded in `sdlc-process` as a placement
principle: a rule lands on the encoding the acting agent loads at the moment it applies, judged by
reach. It carries no rule content and cannot be cited for what any rule says.

It does **not** correct the capability's three-encoding enumeration, which reviewers established is
already inaccurate (the propose and archive skills carry repo process rules today). Correcting it
requires evaluating those surfaces properly, which is a separate change.

### D2 — Premise-checking is a re-timing of an existing check, not new machinery

The fact-check pass already compares claims to the repo. Its limit is *what* and *when*: it verifies
**stated** claims, after the artifacts exist. A framing premise the artifacts never assert is
checked by nothing.

The gap is precise: **a premise the framing carries but the artifacts never assert.** "web split"
was never a claim in any artifact — it was a name, inherited as a deferral pointer through five
changes, and it passed five panels and five gates untested. `router-directory-decomposition` E2 made
a real decision contingent on it ("only step 5 can determine"); step 5 declined the split, leaving
`clientAggregates.ts` orphaned with its pinning test still reaching into `packages/`.

**Bounded to two closed sets, and the bound is what makes the rule falsifiable:** the nouns the
framing names, and any inherited deferral pointer the framing relies on. Without an enumeration the
obligation is unbounded and unfalsifiable — strike the bound and the rule should be struck with it.

**Earliness buys cost, not correctness — stated because the draft would have overclaimed it.** Seven
Class-A false framings appear across 39 archived changes; the panel caught **six of seven**. The
rule mostly saves review cycles. The `web split` case is the one genuine correctness save, and one
instance is thin evidence for a correctness claim — the same stretch that got the abandoned draft's
standing-recommendation rule blocked. The honest justification is cost, with correctness as an
occasional bonus.

**Known failure mode, unfixed:** the orchestrator grades its own framing. In `web-coordination-seam`
the orchestrator did measure and did surface the conflict — and D0's *supporting* premises were
still false; the panel caught them. This rule moves where the unverified claim sits; it does not
eliminate it. The published `Current state` block is what makes a later reviewer able to check.

### D3 — Escalation discipline was drafted, approved, and then removed when its evidence collapsed

A fourth rule was drafted: a question reaches the human only if it is irreversible,
preference-bearing, or trades off something only they can weigh; and every escalation ships with
priced options. The owner approved it (2026-08-09).

**Its headline evidence did not survive the fact-check.** The draft asserted escalations ran 0-2
across 35 changes then 4/5/6/10 across the last four, and that ~9 of the last 20 were
agent-decidable. The first is a **grep artifact** — the instrument matched only escalations labelled
`**En —**`, a style only the last four changes use. Actual escalation sections give **14 of 39** in
the 0-2 bucket and **25 carrying 3-6 across the entire history**, day-one changes included.
*Derivation:* I re-ran the label instrument myself and reproduced 35, confirming the fault was the
instrument. The "~9 of 20" figure came from the same report and is unverified.

**What survived was one instance**: `ai-runtime-package` escalated E9 (phase partition) and E10 (TDD
pairing), both answered verbatim by CLAUDE.md text the agent reads every session.

**The owner, re-deciding on corrected evidence, removed the rule (2026-08-09).** One instance plus
principle is the same thin basis that got the abandoned `sdlc-retro-loop` draft's
standing-recommendation rule blocked; admitting it here would have applied a standard this line of
work has twice refused. The instance is recorded so a later change can re-derive the rule against
real evidence.

**The corrected escalation data is worth keeping for whoever does.** Escalation counts have been
3-6 throughout the repo's history, not rising. Any future case for filtering must rest on
*which* escalations are agent-decidable, not on how many there are.

### D4 — The fact-check widening is one edit covering five observed defect classes

Five candidate rules from the abandoned draft share one root cause: **a claim entered an artifact
without verification.** Rather than five rules, three classes are added to an enumeration that
already exists — precedent citations, capability/coverage claims, and characterizations relayed
from subagents — plus a requirement that counts carry their derivation inline.

Instances behind it, and the count is stated honestly: a false motivating defect; a false precedent
citation; four wrong counts from four different instruments; one relayed characterization; and a
capability claim corrected three times and still incomplete. Reviewers established these are **not
all causally independent** — the four counts share a habit, and the capability claim plus its three
corrections are one claim, not four. An honest count is **five to eight**, not the eleven an earlier
draft asserted after correcting ten.

**One instance the rule would not have caught, disclosed:** the relayed "623 sites" characterization
entered a **commit message**, which the fact-check pass never reads. The rule reduces the class; it
does not close it.

### D5 — Deletions are a separate change

Reviewers named `CLAUDE.md:292-304` ("Research artifacts feed specs") as 13 lines that have never
fired — "OKF" appears nowhere else in the repo, and zero of 39 archived designs record either
mandated review shape. Also named: eight `(decided …)` stamps and a five-line evidence block
carrying archived-design rationale on the highest-reach, highest-cost surface.

Cutting text from the surface every agent loads is a real improvement under purpose 1. It is not
bundled here because a deletion needs its own evidence that nothing depends on the text, and mixing
deletions with additions makes both harder to review. Recorded so the next change has the pointer.

## Risks / Trade-offs

- [Premise-checking becomes a box-ticking "no conflicts found"] → the published `Current state` block
  with branch and SHA is the artifact a reviewer can check; the enumeration bounds what must be
  measured. ~80% of the time "no conflict" will be the true answer, and that is fine — the cost is
  one paragraph.
- [Three additions to a 162-line section] → net +9 lines, one deletion, on the only surface that
  reaches every agent. D5 names the offsetting cuts for a follow-up.
- [This change's own claims] → it makes several repo claims (line counts, escalation counts, the
  momentum line, the orphaned mirror). All were located by content and verified before drafting;
  the fact-check pass re-derives them independently.

## Migration Plan

Documentation only. No data migration, no deployment step, no runtime surface. Rollback is reverting
the branch.

## Open Questions

None escalated. The remaining choices — exact wording,
paragraph placement, whether the `Current state` block is a heading or a sentence — are the agent's,
and the encodings or the panel can settle them.

Recorded as a decision rather than a question: **this change does not get a third full panel.** It
is the converged recommendation of eight reviewers across two panels, and CLAUDE.md warrants a full
re-panel only for structural rework that reviewers have not seen. It gets a fact-check pass (its
claims are mechanical) and a post-gate consistency read. If the owner wants a third panel, that is
one instruction and costs nothing but time.

## Invariants a future reader must not "helpfully" undo

- **Rules land where the acting agent already loads them.** `CLAUDE.md` reaches every agent;
  `openspec/specs/` reaches nobody by default (D1). A future change that moves process rule content
  into a capability spec has made it unreachable at the moment it applies.
- **The premise-check's enumeration is what makes it falsifiable** (D2). An unbounded "check
  everything" obligation is unenforceable and should be struck rather than widened.
- **Earliness buys cost, not correctness** (D2). Do not restate the premise-check as a defect
  preventer; the panel catches six of seven.
- **The escalation rule was removed on corrected evidence, not forgotten** (D3). Reinstating it
  needs evidence about *which* escalations are agent-decidable — not a count, which has been flat at
  3-6 for the repo's whole history.
- **The fact-check widening reduces a class, it does not close it** (D4) — a claim entering a commit
  message is still unchecked.
