# session-title-suffix — tasks

Gate passed 2026-08-02 (D3=max+1, D1=soft-retain next_episode, D7=existing→episode /
new→date, D8=ignore stale next_episode). Ready for `opsx:apply`.

## Phase 1 — Schema + title derivation (server)

- [ ] 1.1 Add catalog migration: `shows.title_suffix TEXT NOT NULL` with create
      default `date`; backfill **existing** rows to `episode`; **retain**
      `shows.next_episode` column (unused; comment in migration/store); do not
      bump on create.
- [ ] 1.2 Implement pure title helpers (pad episode incl. `0`/`9999`/`10000`/
      `00001`, `CODE_YYMMDD`, max-occupied-slot+1 collision `_002+`) with unit
      tests; literal match must not treat `_`/`%` in show codes as wildcards;
      gap case `base`+`_003` → next `_004`.
- [ ] 1.3 Wire create path in one catalog transaction: when `title` blank,
      derive from show `code` + `title_suffix` + episode/date; reject blank
      trimmed show code on derivation (`400`); stop next-episode bump; Date
      stores `episode=''`; Episode requires non-blank episode unless explicit
      title; trim explicit titles as today.
- [ ] 1.4 Update shared `showApiDict` + profile/show schemas: emit/accept
      `title_suffix`; omit `next_episode` from responses; ignore legacy
      `next_episode` on updates; regenerate profile/show fixtures; new show
      create defaults `title_suffix` to `date`.
- [ ] 1.5 Point shared `sessionDeckDisplayTitle` (Companion, session list/detail,
      session status) at stored session `title` (blank → `"—"`); update fixtures
      / tests that expect `CODE - episode`; update Companion variable label.

## Phase 2 — Web: settings + new session + timeline

- [ ] 2.1 Settings: after Code, add Suffix select (`Date` / `Episode Number`);
      remove Next Ep control; persist via profile `title_suffix`.
- [ ] 2.2 New Session modal: remove Bonus toggle; show Episode field only when
      show `title_suffix === 'episode'`; stop seeding from `next_episode`; let
      omitted title/episode rely on server derivation for Date mode; clear
      stale episode when switching to a Date show.
- [ ] 2.3 Timeline meta: replace Episode display with session `title` (same slot /
      styling intent as today).
- [ ] 2.4 Update web types/fixtures/tests that assume `next_episode` or
      `Episode N` meta / Bonus UI.

## Phase 3 — Verification

- [ ] 3.1 Server unit + integration tests for create derivation, collision
      (incl. gap/rename), concurrent same-clock creates, profile + `/api/shows`
      round-trip, migration on populated DB (existing→episode), Companion/
      `deck_title` emitters, batch-import still sends stem title+episode with
      no counter bump.
- [ ] 3.2 Web tests for settings suffix, conditional episode field (no stale
      episode when switching shows), timeline title; Companion label/test if
      touched.
- [ ] 3.3 Repo-wide sweep: no live Next Ep UI / `next_episode` wire writers;
      column may still exist in SQL; `npm test`, companion tests if touched,
      web vitest, `npm run typecheck` green for touched surfaces.
