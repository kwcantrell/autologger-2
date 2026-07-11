import { type CompanionFeedbackDefinitions, combineRgb } from '@companion-module/base';
import type { toFeedbackFlags } from './state.js';

const WHITE = combineRgb(255, 255, 255);
const RED = combineRgb(200, 40, 40);
const DEEP_RED = combineRgb(150, 0, 0);
const GREEN = combineRgb(40, 160, 60);
const AMBER = combineRgb(180, 120, 0);

export function feedbackDefinitions(
  getFlags: () => ReturnType<typeof toFeedbackFlags>,
): CompanionFeedbackDefinitions {
  return {
    rolling: {
      type: 'boolean',
      name: 'Take is rolling',
      defaultStyle: { bgcolor: RED, color: WHITE },
      options: [],
      callback: () => getFlags().rolling,
    },
    recording: {
      type: 'boolean',
      name: 'Recording',
      defaultStyle: { bgcolor: DEEP_RED, color: WHITE },
      options: [],
      callback: () => getFlags().recording,
    },
    playing: {
      type: 'boolean',
      name: 'Playing (best-effort — browser-reported)',
      defaultStyle: { bgcolor: GREEN, color: WHITE },
      options: [],
      callback: () => getFlags().playing,
    },
    session_active: {
      type: 'boolean',
      name: 'No active session (warn)',
      defaultStyle: { bgcolor: AMBER, color: WHITE },
      options: [],
      // True when NOT active, so the button warns.
      callback: () => !getFlags().session_active,
    },
  };
}
