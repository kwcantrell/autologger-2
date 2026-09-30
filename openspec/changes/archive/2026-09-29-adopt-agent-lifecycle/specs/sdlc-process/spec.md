## REMOVED Requirements

### Requirement: The operational encodings are the normative SDLC record
**Reason**: The three encodings it names (the long `CLAUDE.md` SDLC section, the customized `openspec-apply-change` skill, and the old `openspec/config.yaml` rules) are replaced by agent-lifecycle-template. Its rulebook is `AGENTS.md`, its reasons are in `docs/decisions/`, and it is enforced by hooks and CI.
**Migration**: Process rules live in `AGENTS.md`, with the Claude-specific ones in `CLAUDE.md`. `scripts/check-change.sh` enforces them. The old encodings are in git history and in the local, git-ignored `old-lifecycle/`.

### Requirement: A rule lands on the encoding the acting agent loads at the moment it applies
**Reason**: This was a placement rule for the retired three-encoding model. The template has its own placement rules: AGENTS.md rule 8 (rules that must always hold are hooks or CI checks) and rule 10 (reasons live in ADRs).
**Migration**: A new rule goes through a tier 2 change, with an ADR under `docs/decisions/`, enforced by a check in `scripts/lib/check_change.py` where it can be.
