-- Phase 3: grow the D1 sessions index so listing + status + cheap rolling-timecode
-- need no SessionDO wake. The DO owns the hot tables (events, transport, …); the
-- Worker mirrors a few live fields here after each DO mutation (projectSessionLive).

-- Durable session metadata (was on the Python sessions row).
ALTER TABLE sessions ADD COLUMN frame_rate REAL NOT NULL DEFAULT 24.0;
ALTER TABLE sessions ADD COLUMN start_offset_frames INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN episode TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN notes TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN started_at_utc TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN created_at_utc TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN episode_date TEXT;
ALTER TABLE sessions ADD COLUMN ui_hidden INTEGER NOT NULL DEFAULT 0;

-- Live projection mirrored from the SessionDO (kept in sync by the Worker).
ALTER TABLE sessions ADD COLUMN event_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN max_timecode_total_frames INTEGER;
ALTER TABLE sessions ADD COLUMN is_rolling INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN current_take INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN transport_elapsed_frames INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN roll_started_at_utc TEXT;
