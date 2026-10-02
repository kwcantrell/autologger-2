## REMOVED Requirements

### Requirement: Open-network refusal
**Reason**: Login is always required (`require-login`), so a deployment with authentication
disabled on a reachable network can no longer exist and this `503` can never fire.
**Migration**: None. Imports come only from signed-in members; unauthenticated calls get the
general `401`. The configuration gate and URL validation are unchanged.
