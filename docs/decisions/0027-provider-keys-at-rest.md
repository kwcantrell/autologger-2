# 0027: Users' provider keys are encrypted in the server under an OpenBao secret

- Date: 2026-10-11
- Status: Accepted
- Rule: provider-credentials "Provider keys are encrypted at rest and write-only", "A stored key is
  bound to its destination", and the `PROVIDER_KEYS_SECRET` boot and compose checks

## Context

Every production user shared the operator's one `DEEPGRAM_API_KEY` and `claude` login, so a team
that wanted AI or transcription had the operator pay for it, and usage couldn't be attributed
(byo-ai-providers proposal, "Why"). Users now bring their own provider accounts, which means the
server stores third-party API keys for the first time. Nothing in the codebase encrypted anything
at rest before (`grep -rn "createCipheriv\|pgp_sym" server packages supabase` found nothing), and
the server must decrypt each key to call the provider with it, so a one-way hash (the Companion
device-token pattern) can't be used.

## Decision

- **AES-256-GCM in the server** (owner decision 2), with keys derived by HKDF-SHA256 from
  `PROVIDER_KEYS_SECRET`, base64 of 32 bytes held in OpenBao per environment. Supabase Vault or
  pgsodium was rejected: it ties the keys to the database extension and its setup in every stack.
- **Bind each ciphertext to its destination.** The additional data is the user id, the kind, the
  provider and the OpenAI-compatible base URL origin, and a save that changes the provider or host
  needs the key again (the panel's critical finding: otherwise a stolen session could redirect a
  stored key to an attacker's host).
- **Write-only keys.** Only the last four characters are ever returned; provider errors are
  classified, never logged.
- **Refuse a wrong secret at boot** against a stored keyed check value, rather than run with every
  key unreadable.
- **Production mode is the default.** The development-mode relaxations (the `DEEPGRAM_API_KEY`
  fallback, local model URLs) apply only when `NODE_ENV` is exactly `development` or `test`.

Change: `openspec/changes/byo-ai-providers` (design D1-D5, the panel, re-panels and consistency
reads).

## Consequences

- Losing `PROVIDER_KEYS_SECRET` loses every stored key; the reset (`docs/openbao-secrets.md`) is to
  clear the two tables and have users re-enter their keys.
- A compromised app process can decrypt every key while it runs; `docs/security.md` records this
  residual.
- `key_version` lets a later change rotate the secret; no rotation tooling ships.

## Evidence

- Panel and re-panel findings and their resolutions: `openspec/changes/byo-ai-providers/panel.md`.
- `server/src/auth/providerKeyCrypto.test.ts` (tamper, wrong user, kind, provider, origin and
  secret each fail to decrypt), `server/src/bootProviderKeys.int.test.ts` (a different secret is
  refused at boot).
