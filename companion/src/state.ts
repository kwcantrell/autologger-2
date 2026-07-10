// Seed for Task 3 (api.ts type-imports ServerStatePayload). Task 4 overwrites this file with
// these same interfaces plus its pure functions — do not add logic here.

export interface SessionState {
  id: string;
  title: string;
  deck_title: string;
  timecode: string;
  frame_rate: number;
  is_rolling: boolean;
  current_take: number;
  is_recording: boolean;
  is_playing: boolean;
  logged_event_count: number;
  events_stream_revision: number;
  show_id: string | null;
  show_name: string | null;
  show_code: string | null;
}

export interface LastCommand {
  id: string;
  type: string;
  ok: boolean;
  error: string | null;
  delivered_to: string | null;
}

export interface ServerStatePayload {
  connected_clients: number;
  active_session_id: string | null;
  session: SessionState | null;
  last_command: LastCommand | null;
}
