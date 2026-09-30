# 0012: Pinned actions, scoped tokens, dependency review, attested releases

- Date: 2026-09-29
- Status: Accepted
- Rule: checks `workflows`, `audit`; jobs `secrets`, `dependency-review`; `release.yml`

## Context

Agents add dependencies and edit workflows readily. A moved tag or an over-scoped token turns
one bad change into a supply chain compromise.

## Decision

Actions are pinned to full commit SHAs, and Dependabot updates them. Workflows default to
`contents: read`. PRs that add dependencies with high-severity advisories fail. Secrets are
blocked by push protection and gitleaks. Releases carry SLSA build provenance and a signed SBOM
attestation.

## Evidence

- "Pinning an action to a full-length commit SHA is currently the only way to use an action as
  an immutable release"
  ([GitHub hardening](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions)).
- OpenSSF Scorecard checks Pinned-Dependencies, Token-Permissions, Branch-Protection and
  Code-Review ([checks](https://github.com/ossf/scorecard/blob/main/docs/checks.md)).
- NIST SSDF PS.3.2: keep provenance for every release component, e.g. SBOM or SLSA
  ([SP 800-218](https://nvlpubs.nist.gov/nistpubs/specialpublications/nist.sp.800-218.pdf)).
- GitHub artifact attestations
  ([docs](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds));
  SLSA Build L2 means provenance from a hosted build platform ([SLSA](https://slsa.dev/spec/v1.0/levels)).

## Consequences

Dependency review needs the dependency graph, which private repos get with GitHub Advanced
Security. Without it, drop that job and rely on `lifecycle.commands.audit`.
