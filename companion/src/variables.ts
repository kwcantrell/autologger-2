import type { CompanionVariableDefinition } from '@companion-module/base';

export function variableDefinitions(): CompanionVariableDefinition[] {
  return [
    { variableId: 'timecode', name: 'Session timecode' },
    { variableId: 'take', name: 'Current take' },
    { variableId: 'session_title', name: 'Session title' },
    { variableId: 'deck_title', name: 'Deck title (show + episode)' },
    { variableId: 'show_name', name: 'Show name' },
    { variableId: 'show_code', name: 'Show code' },
    { variableId: 'event_count', name: 'Logged event count' },
    { variableId: 'frame_rate', name: 'Frame rate' },
    { variableId: 'connected_clients', name: 'Connected browser clients' },
    { variableId: 'active_session_id', name: 'Active session id' },
    { variableId: 'command_delivered', name: 'Last record/play command delivered (yes/no)' },
    { variableId: 'command_error', name: 'Last command error' },
  ];
}
