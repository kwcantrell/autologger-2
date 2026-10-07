-- Session run leases (ADR 0021 slice 8b, OpenSpec change `session-run-leases`, design D1).
--
-- - `catalog.session_leases` gains three run kinds beside `recording`: `ai-turn` (shared by AI
--   chat, AI v2 design, topic generation and event generation), `transcript-generation` and
--   `youtube-import`. The server writes them silently (design D2): they never count toward the
--   session revision.
-- - Only the named kind check is replaced. Re-adding it validates the existing rows, which are all
--   `recording`. No row, policy or grant changes.

alter table catalog.session_leases drop constraint session_leases_kind_check;
alter table catalog.session_leases add constraint session_leases_kind_check
  check (kind in ('recording', 'ai-turn', 'transcript-generation', 'youtube-import'));
