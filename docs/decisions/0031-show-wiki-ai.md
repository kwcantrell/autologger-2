# 0031: The wiki AI proposes, people accept; its quotes are checked and its reads run as the caller

- Date: 2026-10-14
- Status: Accepted
- Rule: wiki-generation (gates, the wiki turn and its tools, proposal checks, store-only-on-success, bounds), show-wiki ("AI suggestions", "Accepting a suggestion is a compare-and-set edit", "Suggestions inbox"), catalog-database ("Wiki suggestions table", "Wiki suggestions row-level security"), api-contract-freeze (the suggestion endpoints and `wiki/generate`), ai-topics-chat ("Session-scoped MCP toolset", "Subprocess security lockdown"), auto-event-generation ("Generation-density transcript rendering"), and the tests `server/src/test/pg/wikiSuggestions.pg.test.ts`, `server/src/test/pg/wikiSuggestionStore.pg.test.ts`, `packages/ai-runtime/src/wikiTools.test.ts`, `packages/ai-runtime/src/wikiGenerate.test.ts`, `packages/contract/src/wikiLinks.test.ts` and `server/src/routers/wikiSuggestions.int.test.ts`

## Context

ADR 0030 built a hand-edited wiki for each show and left AI drafting to this change. The owner wants "Update wiki from this session": the AI, on the producer's own model, reads a session and proposes page rewrites and new pages, which a person reviews as line diffs.

Four facts shaped the design:

- **The AI is fed untrusted text.** Transcripts and pages written by other show members go into the prompt, and a provider could be hostile. Whatever the model writes must be harmless until a person accepts it.
- **A wiki claim needs a real source.** A model readily invents quotes. Show-wiki stores citations as `[quote](cite:<session>@<seconds>)`, so the quote can be checked against the transcript.
- **No AI tool read the catalog before.** The existing tools see one session through the session hub. The wiki tools need pages and pending suggestions, and must not see more than the producer can.
- **Runs are long and synchronous,** like topic generation, and a run that fails part way must leave nothing behind.

## Decision

- **Suggestions, never writes.**
  - The tools can't change a page. `propose_page` records a proposal in the run's memory.
  - Only a run that finishes, has read every transcript page and has drained its tool bodies stores its proposals, all in one transaction, as `pending` rows in `catalog.wiki_suggestions`. Any other ending is a fixed `502` that stores nothing.
  - A newer run supersedes the older pending suggestion for the same target. The run reads that suggestion first and builds on it, so unreviewed work is carried forward, not dropped.
- **Accepting is the person's edit.**
  - Accept runs the wiki store's own create or compare-and-set edit step inside one transaction, with every rule of a manual save. The revision's author is the reviewer, noted `accepted suggestion <id>` (or `… (edited)`, or `created from suggestion <id>`).
  - The diff is always against the page as it is now. A suggestion written against an older revision is marked stale.
- **Every new quote is checked.**
  - `citationsOf` (contract) parses with the same `mdast-util-from-markdown` the page renders with, and returns every *rendered* citation: inline and autolinks, and full, collapsed and shortcut references to a `cite:` definition, with their rendered text. The panel showed a reference `[made up][r]` slipped past a check that read only link nodes.
  - A citation not already in the page's current body must cite the run's session, or a session the target's pending suggestion cites. Its normalised words must appear contiguously in that session's transcript, starting within 30 s of the cited time.
  - Normalisation is the database's `catalog.search_norm` plus folding punctuation, so case and accents match the wiki's own name rules.
  - The clock is the `session_time` timecode the model reads; `start_sec` is unreliable for edited words.
  - A failing proposal is sent back to the model with its problems; the server never rewrites Markdown.
- **Reads run as the caller, through an injected port.** `ai-runtime` declares `WikiToolPort`; the server implements it over the catalog bound to the producer, filtered to the run's show (and to pending rows for suggestions), so RLS and the show filter both apply. No system binding is created, and `ai-runtime` still doesn't import the catalog.
- **Rows can't be forged or rewritten.** `catalog_user` may insert only `pending` rows authored by itself, may update only the status and resolution columns, only from `pending`, and may not delete.
- **Bounds of its own.** `WIKI_GENERATE_TIMEOUT_SEC` (900), `WIKI_GENERATE_MAX_BUDGET_USD` (5.0), `WIKI_GENERATE_MAX_STEPS` (80), `WIKI_GENERATE_MAX_TOKENS` (6,000,000). An AI rewrite is at most 30,000 characters, at most 20 pages per run, and every tool result stays under the CLI's 45,000-character bound.

*Alternatives considered.*
- **Strip failing citations and keep the rest.** The owner chose rejection back to the model.
- **Trust a pending suggestion's citations as already checked.** Rejected at the re-panel: a pending body can hold citations its own run kept unchecked from an older page, and the database can't prove a row passed the check.
- **Search the whole show from the run.** Cut by the panel: it shared the two-slot search pool with people, and "from this session" doesn't need it.
- **Refuse reference-style citations.** People already write them, and they render as citations.
- **Change the other AI routes' busy `409` text to name the wiki update.** Kept frozen to keep the contract delta small; the advice in them is still right.

## Evidence

- The panel and re-panel are in `openspec/changes/archive/<date>-show-wiki-ai/panel.md` (4 critical and 15 major findings, then 8 major at the re-panel, all resolved), and the measured assumptions are in that change's `design.md`.
- **Access and rows:** owner, granted member, ungranted member and outsider for select, insert, update and delete; forged authors, reopened rows and rewritten bodies refused (`wikiSuggestions.pg.test.ts`).
- **Checks:** reference-style misquotes, the ±30 s edges, carried-forward citations re-checked and misquotes refused, other-session limits, adversarial result sizes (`wikiTools.test.ts`).
- **End to end:** the gate order, both AI routes, no-store on provider failure, unread pages, a failed store and a timeout with a running tool body, and the real port's show and status filters (`wikiSuggestions.int.test.ts`).
- **Dev stack:** a run on the dev SGLang model produced verified suggestions, and accept, edit-then-accept, dismiss and a stale accept all wrote reviewer-authored revisions (task 6.5).

## Consequences

- **Long sessions can fail on a reasoning model.** On the dev SGLang model a 1,362-word session failed twice at the 16,000-token per-step output cap (`GENERATE_MAX_OUTPUT_TOKENS`), because the model reasons before it answers. Such a failure stores nothing. Raising the cap is a configuration decision.
- **A true quote can still support a false claim.** The reviewer is the check; the diff and the stale flag help.
- **The quote check is a pass/fail oracle** over the transcripts of sessions a target's pending suggestion cites. Since a member could insert such a row directly, it reaches any session of the show, but never beyond what the producer can already read.
- **Suggestions accumulate.** One pending per target; retention is a later change.
- **Drop or revisit if:** reviewers routinely reject citations that pass the check, real runs often fail the quote match on noisy transcripts, or a background run is wanted (that would need a non-human author and a different credential story).
