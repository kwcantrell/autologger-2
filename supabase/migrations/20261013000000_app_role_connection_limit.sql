-- The app role's connection limit (ADR 0021 slice 9a, OpenSpec change `session-frame-bus`,
-- design D7).
--
-- - The limit counts every server process together. One process holds 14 connections: 12 pool
--   connections (3 root, 5 transaction, 4 session) plus the frame bus's listener and publisher.
--   45 fits three processes (42). A fourth process raises it in its own change.
-- - The catalog schema migration's `connection limit 20` is left as it is: each migration runs
--   once, and this one supersedes it.
-- - A server with `max_connections` below 100 is refused: Postgres's connections are shared with
--   Supabase's own services and the migration runner, and 45 for the app role would leave them too
--   few there.
-- `begin`/`end` stay indented: migrate.sh refuses a line that starts with transaction control.

do $$
  begin
    if current_setting('max_connections')::int < 100 then
      raise exception 'max_connections is %, below the 100 the app role''s connection limit of 45 needs',
        current_setting('max_connections');
    end if;
  end
$$;

alter role autologger_app connection limit 45;
