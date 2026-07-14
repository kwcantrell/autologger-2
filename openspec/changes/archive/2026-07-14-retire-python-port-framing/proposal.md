# Proposal: retire-python-port-framing

## Why

The repo's docs and OpenSpec config still frame it as a *present-tense* port of a Python
backend at `../autologger`. That framing is wrong in two ways. First, the pointer is
broken: the origin repo lives at `~/AutoLog` (moved/renamed; verified 2026-07-14), so
every `../autologger` path in the docs dangles. Second — and the real problem — the origin
repo is out-of-workspace, unlinked, not a dependency, and superseded by this repo as the
canonical implementation, yet "Maintain Python parity" is still the **normative anchor**
that freezes the API contract. The repo's strongest invariant derives its authority from a
codebase that is no longer authoritative. Deleting the references without a replacement
anchor would weaken that invariant; keeping them leaves broken pointers and a false
present-tense identity.

## What Changes

Decisions (exploration 2026-07-13; panel + gate 2026-07-14): **demote the port to
past-tense provenance, don't erase it**, and **re-anchor the freeze on the full published
surface** — consumers are the reason for the freeze, not its measuring stick. Port history
stays where it explains structure (module-for-module layout, `durable/` and `d1.ts`
naming); what goes away is the port as a present-tense normative frame and every
`../autologger` pointer.

- **Replace the parity anchor with the `api-contract-freeze` capability** (single
  requirement; gate-trimmed): the server's entire published HTTP/WS contract — endpoint
  inventory (README route table normative), JSON shapes, status codes, CSV/JSONL export
  bodies, header/range semantics, WS message shapes *and emission semantics* — is frozen;
  observable changes require an authorizing delta spec. Explicit non-loopholes: an
  unconsumed endpoint/field stays frozen; co-mutating in-repo consumers does not exempt
  the server delta (deployed Companion installs lag the repo).
- **`openspec/config.yaml`**: rewrite `context` (drop the port framing and
  `../autologger`; state the frozen-surface anchor and the past-tense-provenance posture)
  and reword the proposal rule ("this is a port, so call out…" → "the contract is frozen,
  so call out any observable HTTP/WS change (usually 'none')").
- **`CLAUDE.md`**: overview becomes past-tense provenance ("originally a faithful port of
  the Python AutoLogger backend; this repo is now the canonical implementation" — no
  path). **Promote the freeze into the "Invariants (spec)" section** (session-start
  readers look there, and the capability spec itself is not loaded at session start), with
  the clause that shape/status-code edits are *never* "small, obvious fixes". Replace the
  "Maintain Python parity" convention accordingly; add a convention line that origin
  headers are deliberate past-tense provenance (don't strip, don't re-normativize). Fix
  the workspaces claim (`server`/`web`/`companion`; `e2e/` is not a workspace). Reword
  "mirrors the Python backend module-for-module" / "each file notes its Python origin" to
  match audited reality.
- **`README.md`**: past-tense reframe of the intro; the endpoint table's **route column
  stays normative** (it is the frozen inventory) while the Python-module column is
  relabeled historical origin; re-anchor only *Python-anchored* parity prose ("parity"
  also means crash-consistency, auth-mode, visual, and test-suite parity in this repo —
  those stay verbatim).
- **Source comments (audited 2026-07-14)**: 21 `server/src/**/*.ts` origin headers plus
  mid-file mentions, 2 SQL migrations, and 1 `web/` CSS note reference the origin. Nearly
  all are already past-tense provenance and **stay verbatim**; the expected edits are the
  handful of present-tense parity claims (e.g. "byte-compatible with the Python server's
  /api/profile JSON" in `profileAssembler.ts`, "matches the Python server's" in
  `0001_init.sql`) — roughly 4–6 lines.
- **Closing guard**: repo-wide sweep with patterns that actually match the references
  (`../autologger`, case-insensitive `python`, `.py` paths, `src/autologger/`), exempting
  `docs/superpowers/**` and `openspec/changes/**`.
- **Ordering (gate decision)**: this change lands **before** `de-cloudflare-strong-core`
  implementation begins; that change's docs phase re-checks the rewritten CLAUDE.md/README
  paragraphs after its `durable/` → `session/` and `d1.ts` → `catalog.ts` renames (its own
  rename-sweep does not cover CLAUDE.md/README).

## Capabilities

### New Capabilities
- `api-contract-freeze`: the server's full published HTTP/WS contract is frozen; any
  observable change requires an authorizing OpenSpec delta spec. Consumers (`web/`,
  Companion module, `e2e/`, external API clients) are the rationale, not the extent.
  This is the durable replacement for the Python-parity anchor and lands in
  `openspec/specs/` on archive. (Gate-trimmed to this single requirement: doc-wording and
  provenance-tense governance live in `config.yaml` + CLAUDE.md conventions, and the
  pointer sweep is a one-time task — not durable spec scenarios.)

### Modified Capabilities

_None — `openspec/specs/` is currently empty; no existing capability requirements change._

## Impact

- **Behavior-parity impact: none.** Docs, config, and code comments only — no observable
  HTTP/WS change, no runtime, dependency, or test-behavior change.
- Affected files: `openspec/config.yaml`, `CLAUDE.md`, `README.md`, ~4–6 comment lines
  across `server/src/**` (audit surface: 21 headers + mid-file mentions + 2 SQL
  migrations + 1 `web/` CSS note, nearly all kept verbatim), new
  `specs/api-contract-freeze/spec.md` delta in this change.
- **Prerequisite**: `npm test` is currently red in this checkout from a better-sqlite3
  native-ABI mismatch (verified 2026-07-14); `npm rebuild better-sqlite3` first, so the
  per-commit gate is meaningful.
- **Process**: comment edits touch code files, so this ships on a feature branch per
  CLAUDE.md (the docs-only exception does not apply).
- **Self-reference caveat**: `config.yaml` `context` is injected into artifact
  generation, so this change's artifacts were drafted under the old context; the gate
  read them knowing the anchor is being replaced mid-flight.

## Non-Goals

- **`docs/superpowers/specs|plans/`** — frozen historical records per CLAUDE.md; their
  Python/port references stay verbatim.
- **`openspec/changes/de-cloudflare-strong-core/`** — gate-passed, mid-flight; its
  artifacts are not edited by this change. Its delta spec contains no *Python-anchored*
  parity phrasing, but it does carry a refactor-parity requirement ("HTTP/WS surface
  parity is preserved and verified", anchored on `AUTH-API.md`) that will sync into
  `openspec/specs/` on its archive. **Gate decision (2026-07-14)**: reconcile that
  requirement with `api-contract-freeze` during that change's archive sync (archive-time
  editing is normal `opsx:archive` work); until then the dual anchor is accepted.
- **Cloudflare-era naming** (`durable/` dir, `d1.ts`, SessionDO/D1/Worker mentions in
  comments) — owned by the de-cloudflare work; not touched here.
- **No erasure of history** — past-tense provenance (file headers, "originally a port"
  phrasing, the README table's origin column) is retained deliberately; this change
  removes only present-tense normative framing and broken pointers.
- **No code, API, schema, or test changes** of any kind.
