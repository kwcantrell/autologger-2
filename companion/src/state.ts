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

const DASH = '—';

export function toVariableValues(s: ServerStatePayload): Record<string, string | number> {
  const sess = s.session;
  const lc = s.last_command;
  return {
    timecode: sess?.timecode ?? DASH,
    take: sess?.current_take ?? DASH,
    session_title: sess?.title ?? DASH,
    deck_title: sess?.deck_title ?? DASH,
    show_name: sess?.show_name ?? DASH,
    show_code: sess?.show_code ?? DASH,
    event_count: sess?.logged_event_count ?? 0,
    frame_rate: sess?.frame_rate ?? DASH,
    connected_clients: s.connected_clients,
    active_session_id: s.active_session_id ?? DASH,
    command_delivered: lc ? (lc.ok ? 'yes' : 'no') : DASH,
    command_error: lc?.error ?? '',
  };
}

export function toFeedbackFlags(s: ServerStatePayload): {
  rolling: boolean;
  recording: boolean;
  playing: boolean;
  session_active: boolean;
} {
  const sess = s.session;
  return {
    rolling: sess?.is_rolling ?? false,
    recording: sess?.is_recording ?? false,
    playing: sess?.is_playing ?? false,
    session_active: sess !== null,
  };
}

export function showIdChanged(
  prev: ServerStatePayload | null,
  next: ServerStatePayload,
): boolean {
  const prevId = prev?.session?.show_id ?? null;
  const nextId = next.session?.show_id ?? null;
  return prevId !== nextId;
}
