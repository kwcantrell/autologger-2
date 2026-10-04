# 0025: Stack secrets move from Infisical to OpenBao

- Date: 2026-10-03
- Status: Accepted (supersedes ADR 0021's "Secrets live in a shared Infisical instance, with a separate machine identity per environment" Operations bullet)
- Rule: none. This records a direction; the OpenSpec change `openbao-secrets` implements it.

## Context

ADR 0021 put every stack's secrets in a shared, self-hosted Infisical instance, with one machine
identity per environment. Slice 1.1 (`infisical-secrets`, archived 2026-09-30) built that: the
compose wrapper `docker/scripts/compose-run.mjs` logs in, reads the environment's secrets into
memory and runs compose with them.

Two things changed:
- **The stacks are moving off the Spark host,** into one LXD VM per environment, built from a new
  Ansible repo (`~/spark-infra`). Each VM has a fixed address on `lxdbr0`.
- **Infisical's free plan refuses Trusted IPs,** so a machine identity's client secret works from
  anywhere on the LAN. `docs/security.md` (ASI03) recorded that as an accepted risk.

The project is still small, so the switch is cheap now.

## Decision

The owner decided on 2026-10-03:
- **OpenBao replaces Infisical** as the secret store for the dev, stage and prod stacks.
- **OpenBao is self-hosted** on the Spark host's `openbao` LXD VM, with integrated (raft)
  storage and a static-key auto-unseal, so a restart needs no human step. `~/spark-infra`
  installs, configures, backs up and unseals it.
- **Secrets live in KV v2,** one mount `kv`, one secret per stack: `kv/autologger/<env>`
  (`dev`, `stage`, `prod`), with the same keys the Infisical environments held.
- **One AppRole per environment.** Its policy is `read` on `kv/data/autologger/<env>` only. Its
  secret ids are CIDR-bound to that environment's VM, so a copied credentials file is useless from
  any other host. The wrapper revokes its token right after the one read.
- **Infisical is not migrated as a service.** Its secrets are exported into OpenBao, and it is
  decommissioned after a soak period.

The rest of ADR 0021 stands.

## Evidence

- **Owner decision,** 2026-10-03 (recorded in `openspec/changes/openbao-secrets/proposal.md`).
- **Infisical free plan:** no Trusted IPs; accepted as a risk in `docs/security.md` ASI03 under
  `infisical-secrets`.
- **The `openbao-secrets` adversarial panel** (`openspec/changes/openbao-secrets/panel.md`) found
  this clause of ADR 0021 still in force, which this record resolves.

## Consequences

- **Availability:** starting or restarting a stack through `make` needs OpenBao reachable and
  unsealed. Running containers are unaffected by an OpenBao outage.
- **Operators** render `.env.openbao.<env>` (Ansible on the VMs) in place of
  `.env.infisical.<env>`.
- **Out of scope here,** each its own follow-up change: dynamic Postgres credentials from
  OpenBao's database engine, and rotating the app's database password through OpenBao.
- **What would reverse it:** OpenBao proving unreliable to run on one VM, or a hosted store
  becoming the owner's choice. Reverting means restoring the Infisical code paths from git and the
  `.env.infisical.<env>` files.
