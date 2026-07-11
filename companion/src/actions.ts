import type { CompanionActionDefinitions } from '@companion-module/base';
import { ApiError, type AutologgerApi, type CategoriesResponse } from './api.js';

export interface ActionHost {
  api(): AutologgerApi;
  refreshNow(): void;
  log(level: 'warn' | 'error', msg: string): void;
  parseVariablesInString(text: string): Promise<string>;
}

function reportError(host: ActionHost, verb: string, err: unknown): void {
  if (err instanceof ApiError) {
    if (err.kind === 'no_session') {
      host.log('warn', `${verb}: no active session — open AutoLogger in a browser and open a session.`);
      return;
    }
    if (err.kind === 'bad_category') {
      host.log('warn', `${verb}: unknown category for the active show — re-pick the category (the show may have changed).`);
      return;
    }
    host.log('error', `${verb}: ${err.message}`);
    return;
  }
  host.log('error', `${verb}: ${String(err)}`);
}

export function actionDefinitions(
  host: ActionHost,
  categories: CategoriesResponse | null,
): CompanionActionDefinitions {
  const choices = (categories?.categories ?? []).map((c) => ({ id: c.id, label: c.label }));
  return {
    log_event: {
      name: 'Log event',
      options: [
        {
          type: 'dropdown',
          id: 'category',
          label: 'Category',
          default: choices[0]?.id ?? '',
          choices: choices.length ? choices : [{ id: '', label: '(no active show)' }],
        },
        { type: 'textinput', id: 'message', label: 'Message', default: '', useVariables: true },
      ],
      callback: async (action) => {
        try {
          const message = await host.parseVariablesInString(String(action.options.message ?? ''));
          await host.api().log({ category_id: String(action.options.category ?? ''), message });
          host.refreshNow();
        } catch (err) {
          reportError(host, 'log event', err);
        }
      },
    },
    transport: {
      name: 'Transport (roll/stop)',
      options: [
        {
          type: 'dropdown',
          id: 'action',
          label: 'Action',
          default: 'toggle',
          choices: [
            { id: 'toggle', label: 'Toggle' },
            { id: 'start', label: 'Roll' },
            { id: 'stop', label: 'Stop' },
          ],
        },
      ],
      callback: async (action) => {
        try {
          await host.api().transport(action.options.action as 'start' | 'stop' | 'toggle');
          host.refreshNow();
        } catch (err) {
          reportError(host, 'transport', err);
        }
      },
    },
    record: {
      name: 'Record',
      options: [
        {
          type: 'dropdown',
          id: 'type',
          label: 'Command',
          default: 'record-toggle',
          choices: [
            { id: 'record-toggle', label: 'Toggle' },
            { id: 'record-start', label: 'Start' },
            { id: 'record-stop', label: 'Stop' },
          ],
        },
      ],
      callback: async (action) => {
        try {
          await host.api().command(
            action.options.type as 'record-start' | 'record-stop' | 'record-toggle',
          );
          host.refreshNow();
        } catch (err) {
          reportError(host, 'record', err);
        }
      },
    },
    play_toggle: {
      name: 'Play (toggle)',
      options: [],
      callback: async () => {
        try {
          await host.api().command('play-toggle');
          host.refreshNow();
        } catch (err) {
          reportError(host, 'play', err);
        }
      },
    },
  };
}
