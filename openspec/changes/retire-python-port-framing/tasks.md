# Tasks: retire-python-port-framing

> Panel + gate passed 2026-07-14 (see design.md "Panel & review log") — this plan is the
> plan of record. Lands **before** de-cloudflare-strong-core implementation (design D7).
> file:line anchors are orientation only — locate quoted text by content before editing.

## 1. Branch & baseline

- [x] 1.1 Create feature branch off `main` (e.g. `chore/retire-python-port-framing`); no
      worktrees
- [x] 1.2 `npm rebuild better-sqlite3`, then confirm `npm run typecheck` + `npm test` are
      green before any edit (checkout currently red from a native-ABI mismatch)
- [x] 1.3 Baseline grep (working reference only, not committed): repo-wide, excluding
      `node_modules`/`dist`/`.git`/`docs/superpowers`/`openspec/changes`, patterns
      `\.\./autologger`, case-insensitive `python`, `\.py\b`, `src/autologger`

## 2. Re-anchor the normative documents

- [x] 2.1 `openspec/config.yaml` `context`: drop "port of a Python backend
      (`../autologger`)"; state past-tense provenance in one clause and the frozen
      full-published-surface anchor (README route table normative; consumers `web/` +
      Companion + `e2e/` are the rationale; no observable change without a delta spec)
- [x] 2.2 `openspec/config.yaml` proposal rule: "this is a port, so call out…" → "the
      contract is frozen, so call out any observable HTTP/WS change (usually 'none')"
- [x] 2.3 `CLAUDE.md` overview: past-tense reframe ("originally a faithful port of the
      Python AutoLogger backend; this repo is now the canonical implementation"), no
      `../autologger` path; fix the workspaces list (`server`/`web`/`companion`; `e2e/`
      is not a workspace)
- [x] 2.4 `CLAUDE.md` "Invariants (spec)": add the contract freeze — full published
      surface frozen (shapes, status codes, export bodies, header/range semantics, WS
      emission), authorizing delta spec required, non-consumption and consumer
      co-mutation are not exemptions, and shape/status-code edits are **never** "small,
      obvious fixes"
- [x] 2.5 `CLAUDE.md` conventions: replace "**Maintain Python parity.**…" with a pointer
      to the invariant; add the provenance line ("origin headers are deliberate
      past-tense provenance — don't strip, don't re-normativize")
- [x] 2.6 `CLAUDE.md` source layout: reword "mirrors the Python backend
      module-for-module" / "each file notes its Python origin" to past-tense provenance
      matching audited reality (origin headers where files were ported, not universally)

## 3. README

- [x] 3.1 Intro: same past-tense reframe as 2.3; remove `../autologger`
- [x] 3.2 Endpoint table: route column stays normative (it is the frozen inventory,
      design D3); relabel only the Python-module column as historical origin, keeping the
      per-route paths
- [x] 3.3 Re-anchor **only Python-anchored** parity prose (intro, "Verify parity"
      heading/lead-in). Leave non-Python "parity" senses verbatim: "Known parity windows"
      (crash-consistency), "Anonymous parity" (auth modes), tailwind.css visual-parity
      cross-reference

## 4. Source comments (minimal-touch, design D4)

- [x] 4.1 From the 1.3 baseline, classify every hit across `server/src/**` (21 `.ts`
      headers + mid-file mentions + `db/migrations/*.sql`) and `web/src/**` (tailwind.css
      note): past-tense provenance → keep verbatim; present-tense parity claim → edit
      (expected ~4–6 lines, e.g. `profileAssembler.ts` "byte-compatible with the Python
      server's", `0001_init.sql` "matches the Python server's")
- [x] 4.2 Apply the edits — comment-only diffs; `npm run typecheck` + `npm test` green

## 5. Closing sweep & validation

- [x] 5.1 Re-run the 1.3 grep: remaining matches only in `docs/superpowers/**`,
      `openspec/changes/**`, and past-tense provenance comments deliberately kept by 4.1
- [x] 5.2 `npm run typecheck` + `npm test` +
      `openspec validate retire-python-port-framing --strict` all green
- [x] 5.3 Consistency read over the final CLAUDE.md + config.yaml + README as one set —
      no stale port-tense sentences; the invariant reads with equal force in all three
