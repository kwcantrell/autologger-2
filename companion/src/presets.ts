import { type CompanionPresetDefinitions, combineRgb } from '@companion-module/base';

const BLACK = combineRgb(0, 0, 0);
const WHITE = combineRgb(255, 255, 255);

export function presetDefinitions(): CompanionPresetDefinitions {
  return {
    roll_stop: {
      type: 'button',
      category: 'AutoLogger',
      name: 'Roll / Stop',
      style: {
        text: '$(autologger:deck_title)\n$(autologger:timecode)',
        size: 'auto',
        color: WHITE,
        bgcolor: BLACK,
      },
      steps: [{ down: [{ actionId: 'transport', options: { action: 'toggle' } }], up: [] }],
      feedbacks: [{ feedbackId: 'rolling', options: {} }],
    },
    record: {
      type: 'button',
      category: 'AutoLogger',
      name: 'Record',
      style: {
        text: 'REC\n$(autologger:deck_title)',
        size: 'auto',
        color: WHITE,
        bgcolor: BLACK,
      },
      steps: [{ down: [{ actionId: 'record', options: { type: 'record-toggle' } }], up: [] }],
      feedbacks: [{ feedbackId: 'recording', options: {} }],
    },
    play: {
      type: 'button',
      category: 'AutoLogger',
      name: 'Play',
      style: {
        text: 'PLAY\n$(autologger:deck_title)',
        size: 'auto',
        color: WHITE,
        bgcolor: BLACK,
      },
      steps: [{ down: [{ actionId: 'play_toggle', options: {} }], up: [] }],
      feedbacks: [{ feedbackId: 'playing', options: {} }],
    },
    log_event: {
      type: 'button',
      category: 'AutoLogger',
      name: 'Log event',
      style: {
        text: 'LOG\n$(autologger:deck_title)',
        size: 'auto',
        color: WHITE,
        bgcolor: BLACK,
      },
      steps: [
        { down: [{ actionId: 'log_event', options: { category: '', message: '' } }], up: [] },
      ],
      feedbacks: [{ feedbackId: 'session_active', options: {} }],
    },
  };
}
