import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from '../../../../api/client';
import type {
  ProfilePayload,
  ProviderCredential,
  ProviderSaveBody,
  ProvidersResponse,
  ProviderTestResponse,
} from '../../../../api/types';
import { renderStrict } from '../../../../test/renderStrict';
import { SettingsView } from './SettingsView';

// --- Settings › Advanced (byo-ai-providers task 6.1, design D6; web-ui-system "Settings manages
// the user's AI providers") ---
//
// The real view, section and hooks over a real QueryClient; `apiFetch` is the one seam (the
// CompanionDevicesSection.test.tsx idiom). Each provider panel has its own save bar; a key is
// write-only and never lands in the query or mutation cache.

vi.mock('../../../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../api/client')>();
  return { ...actual, apiFetch: vi.fn() };
});
vi.mock('../../utils/toast', () => ({ showToast: vi.fn() }));

// Radix Select (open) calls pointer-capture and scrollIntoView, which jsdom lacks.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
}
Element.prototype.scrollIntoView ??= () => {};

const mockedApiFetch = vi.mocked(apiFetch);

const PROFILE = {
  active_studio_id: 'studio-1',
  active_show_id: null,
  active_studio: { id: 'studio-1', name: 'Studio One', categories: [] },
  studios: [{ id: 'studio-1', name: 'Studio One', categories: [] }],
  studio_settings: { 'studio-1': { default_frame_rate: 25, title_format: 'x' } },
  shows: [],
  new_session_defaults: { title_prefix: '', default_frame_rate: 25 },
  admin: { restart_supported: false, restart_needs_token: false },
  auth: {
    logged_in: true,
    oauth_configured: true,
    user: {
      email: 'ada@example.com',
      given_name: 'Ada',
      family_name: 'Lovelace',
      teams: [{ id: 'studio-1', name: 'Studio One', role: 'member' }],
    },
  },
} as unknown as ProfilePayload;

const T = '2026-10-11T10:00:00.000Z';
const SAVED_STT: ProviderCredential = {
  kind: 'stt',
  provider: 'deepgram',
  base_url: null,
  model: 'nova-3',
  key_last4: 'abcd',
  updated_at: T,
};
const SAVED_LLM: ProviderCredential = {
  kind: 'llm',
  provider: 'openai-compatible',
  base_url: 'https://api.example.com/v1',
  model: 'gpt-4o-mini',
  key_last4: '9f2c',
  updated_at: T,
};

const SAVED_CLI: ProviderCredential = {
  kind: 'llm',
  provider: 'claude-cli',
  base_url: null,
  model: 'claude-cli',
  key_last4: null,
  updated_at: T,
};
const CLI_LABEL = 'Claude CLI (operator)';
const CLI_HELP = "Runs on this server's Claude CLI login. Available only to operator accounts.";

let state: ProvidersResponse;
let testResult: ProviderTestResponse;
let saveError: ApiError | null;

const calls = (method: string, path?: string) =>
  mockedApiFetch.mock.calls.filter(
    ([p, o]) =>
      String(p).startsWith('me/providers') &&
      (o?.method ?? 'GET') === method &&
      (path === undefined || p === path),
  );

function route() {
  mockedApiFetch.mockImplementation(async (path: string, opts?: RequestInit) => {
    const method = opts?.method ?? 'GET';
    if (path === 'me/providers' && method === 'GET') return structuredClone(state);
    const m = /^me\/providers\/(llm|stt)(\/test)?$/.exec(path);
    if (m) {
      const kind = m[1] as 'llm' | 'stt';
      if (m[2] && method === 'POST') return testResult;
      if (method === 'PUT') {
        if (saveError) throw saveError;
        const body = JSON.parse(String(opts?.body)) as ProviderSaveBody;
        const prev = state[kind];
        // ai-sdk-agent-harness D2: the keyless claude-cli row stores the fixed model and no key.
        const saved: ProviderCredential =
          body.provider === 'claude-cli'
            ? { ...SAVED_CLI, updated_at: T }
            : {
                kind,
                provider: body.provider,
                base_url: ('base_url' in body ? body.base_url : null) ?? null,
                model: 'model' in body ? body.model : '',
                key_last4:
                  'api_key' in body && body.api_key
                    ? body.api_key.slice(-4)
                    : (prev?.key_last4 ?? '????'),
                updated_at: T,
              };
        state = { ...state, [kind]: saved };
        return saved;
      }
      if (method === 'DELETE') {
        state = { ...state, [kind]: null };
        return '';
      }
    }
    if (path.startsWith('shows')) return { shows: [] };
    throw new Error(`unexpected apiFetch: ${method} ${path}`);
  });
}

function Harness() {
  const [section, setSection] = useState<'advanced'>('advanced');
  return (
    <SettingsView
      section={section}
      onSectionChange={(s) => setSection(s as 'advanced')}
      onClose={vi.fn()}
      onCloseSession={vi.fn()}
      backLabel="Back to sessions"
    />
  );
}

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['profile'], PROFILE);
  renderStrict(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
  return client;
}

const panel = () => document.getElementById('settings-section-advanced') as HTMLElement;
const card = (kind: 'llm' | 'stt') =>
  panel().querySelector(`[data-slot="settings-provider"][data-kind="${kind}"]`) as HTMLElement;
const tab = (name: string) => within(panel()).getByRole('tab', { name });
const saveIn = (kind: 'llm' | 'stt') => within(card(kind)).getByRole('button', { name: /^Save/ });
const typeInto = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

async function choose(trigger: HTMLElement, option: string) {
  act(() => {
    trigger.focus();
  });
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  const item = await screen.findByRole('option', { name: option });
  fireEvent.keyDown(item, { key: 'Enter' });
  await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
}

function cacheText(client: QueryClient): string {
  const queries = client
    .getQueryCache()
    .getAll()
    .map((q) => q.state.data);
  const mutations = client
    .getMutationCache()
    .getAll()
    .map((m) => [m.state.data, m.state.variables]);
  return JSON.stringify([queries, mutations]);
}

beforeEach(() => {
  mockedApiFetch.mockReset();
  // ai-sdk-agent-harness D9 category 5: the GET shape gains claude_cli_allowed (typing only).
  state = { llm: null, stt: SAVED_STT, run_features_allowed: true, claude_cli_allowed: false };
  testResult = { ok: true, detail: 'Connected.' };
  saveError = null;
  route();
});

describe('Settings › Advanced (web-ui-system "Settings manages the user\'s AI providers")', () => {
  it('shows the Language model and Speech to text tabs with status badges', async () => {
    renderSection();
    await waitFor(() => expect(card('stt')).not.toBeNull());
    expect(tab('Language model')).not.toBeNull();
    expect(tab('Speech to text')).not.toBeNull();
    expect(within(card('llm')).getByText('Not set up')).not.toBeNull();
    expect(within(card('stt')).getByText('Connected')).not.toBeNull();
    expect(within(card('stt')).getByText('Key set, ending in ••abcd.')).not.toBeNull();
  });

  it('saving a key shows only its last four characters, and the key is in no cache', async () => {
    const client = renderSection();
    await waitFor(() => expect(card('llm')).not.toBeNull());
    const llm = card('llm');
    typeInto(within(llm).getByLabelText('Base URL'), 'https://api.example.com/v1');
    typeInto(within(llm).getByLabelText('Model'), 'gpt-4o-mini');
    typeInto(within(llm).getByLabelText('API key'), 'sk-test-9f2c');
    fireEvent.click(saveIn('llm'));
    await waitFor(() => expect(calls('PUT', 'me/providers/llm')).toHaveLength(1));
    expect(JSON.parse(String(calls('PUT')[0]?.[1]?.body))).toEqual({
      provider: 'openai-compatible',
      base_url: 'https://api.example.com/v1',
      model: 'gpt-4o-mini',
      api_key: 'sk-test-9f2c',
    });
    await within(llm).findByText('Key set, ending in ••9f2c.');
    expect(within(llm).getByText('Connected')).not.toBeNull();
    expect(llm.textContent).not.toContain('sk-test-9f2c');
    await waitFor(() => expect(cacheText(client)).not.toContain('sk-test-9f2c'));
  });

  it('a draft survives a tab switch', async () => {
    renderSection();
    await waitFor(() => expect(card('llm')).not.toBeNull());
    typeInto(within(card('llm')).getByLabelText('Model'), 'typed-model');
    fireEvent.mouseDown(tab('Speech to text'));
    fireEvent.click(tab('Speech to text'));
    fireEvent.mouseDown(tab('Language model'));
    fireEvent.click(tab('Language model'));
    expect((within(card('llm')).getByLabelText('Model') as HTMLInputElement).value).toBe(
      'typed-model',
    );
    expect(saveIn('llm').textContent).toBe('Save');
  });

  it('a fixed-host provider hides the base URL and is not sent it', async () => {
    renderSection();
    await waitFor(() => expect(card('llm')).not.toBeNull());
    const llm = card('llm');
    expect(within(llm).getByLabelText('Base URL')).not.toBeNull();
    await choose(within(llm).getByLabelText('Provider'), 'Anthropic');
    expect(within(llm).queryByLabelText('Base URL')).toBeNull();
    typeInto(within(llm).getByLabelText('Model'), 'claude-sonnet-4-5');
    typeInto(within(llm).getByLabelText('API key'), 'sk-ant-test-1234');
    fireEvent.click(saveIn('llm'));
    await waitFor(() => expect(calls('PUT', 'me/providers/llm')).toHaveLength(1));
    expect(JSON.parse(String(calls('PUT')[0]?.[1]?.body))).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      api_key: 'sk-ant-test-1234',
    });
  });

  it('changing the provider or host asks for the key again, and Save waits for it', async () => {
    state = { ...state, llm: SAVED_LLM };
    renderSection();
    await waitFor(() => within(card('llm')).getByText('Key set, ending in ••9f2c.'));
    const llm = card('llm');
    typeInto(within(llm).getByLabelText('Base URL'), 'https://other.example/v1');
    await within(llm).findByText('A new provider or host needs its key entered again.');
    const key = within(llm).getByLabelText('API key') as HTMLInputElement;
    expect(key.value).toBe('');
    expect((saveIn('llm') as HTMLButtonElement).disabled).toBe(true);
    typeInto(key, 'sk-new-host-key');
    expect((saveIn('llm') as HTMLButtonElement).disabled).toBe(false);
    // The same origin written differently keeps the saved key.
    typeInto(key, '');
    typeInto(within(llm).getByLabelText('Base URL'), 'https://api.example.com/v2');
    await within(llm).findByText('Key set, ending in ••9f2c.');
  });

  it('a model-only save keeps the saved key', async () => {
    renderSection();
    await waitFor(() => expect(card('stt')).not.toBeNull());
    fireEvent.mouseDown(tab('Speech to text'));
    fireEvent.click(tab('Speech to text'));
    typeInto(within(card('stt')).getByLabelText('Model'), 'nova-2');
    fireEvent.click(saveIn('stt'));
    await waitFor(() => expect(calls('PUT', 'me/providers/stt')).toHaveLength(1));
    expect(JSON.parse(String(calls('PUT')[0]?.[1]?.body))).toEqual({
      provider: 'deepgram',
      model: 'nova-2',
    });
  });

  it('Remove asks first: declining sends nothing; confirming deletes', async () => {
    renderSection();
    await waitFor(() => expect(card('stt')).not.toBeNull());
    const stt = card('stt');
    fireEvent.click(within(stt).getByRole('button', { name: 'Remove' }));
    let confirm = await screen.findByRole('alertdialog');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(calls('DELETE')).toHaveLength(0);

    fireEvent.click(within(stt).getByRole('button', { name: 'Remove' }));
    confirm = await screen.findByRole('alertdialog');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(calls('DELETE', 'me/providers/stt')).toHaveLength(1));
    await within(card('stt')).findByText('Not set up');
    expect((within(card('stt')).getByLabelText('API key') as HTMLInputElement).value).toBe('');
  });

  it('Test connection shows the server’s result, and editing clears it', async () => {
    renderSection();
    await waitFor(() => expect(card('stt')).not.toBeNull());
    const stt = card('stt');
    testResult = { ok: false, detail: 'The provider rejected the API key.' };
    fireEvent.click(within(stt).getByRole('button', { name: /Test connection/ }));
    await within(stt).findByText('The provider rejected the API key.');
    expect(calls('POST', 'me/providers/stt/test')).toHaveLength(1);
    typeInto(within(stt).getByLabelText('Model'), 'nova-2');
    expect(within(stt).queryByText('The provider rejected the API key.')).toBeNull();
    // 6.3: the test checks the saved credential, so it waits while the panel has unsaved edits.
    expect(
      (within(stt).getByRole('button', { name: /Test connection/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('a failed save shows the server’s detail and changes nothing else', async () => {
    renderSection();
    await waitFor(() => expect(card('llm')).not.toBeNull());
    saveError = new ApiError(422, 'base_url must use https', null);
    const llm = card('llm');
    typeInto(within(llm).getByLabelText('Base URL'), 'http://api.example.com/v1');
    typeInto(within(llm).getByLabelText('Model'), 'm');
    typeInto(within(llm).getByLabelText('API key'), 'sk-test-1234');
    fireEvent.click(saveIn('llm'));
    await within(llm).findByText('base_url must use https');
    expect(within(llm).getByText('Not set up')).not.toBeNull();
  });

  it('a user who is not approved is told, and the fields still work', async () => {
    state = { ...state, run_features_allowed: false };
    renderSection();
    await within(panel()).findByText(
      'Transcription and AI features are limited to approved users on this server.',
    );
    expect((within(card('llm')).getByLabelText('Model') as HTMLInputElement).disabled).toBe(false);
  });
});

// ai-sdk-agent-harness task 8.1 (design D8; web-ui-system "Settings manages the user's AI
// providers", "The Claude CLI option").
describe('Settings › Advanced — the Claude CLI option (ai-sdk-agent-harness D8)', () => {
  async function optionNames(): Promise<string[]> {
    const trigger = within(card('llm')).getByLabelText('Provider');
    act(() => {
      trigger.focus();
    });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const list = await screen.findByRole('listbox');
    const names = within(list)
      .getAllByRole('option')
      .map((o) => o.textContent ?? '');
    fireEvent.keyDown(list, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    return names;
  }

  it('a user who is not allowlisted, with no saved claude-cli, is not offered it', async () => {
    renderSection();
    await waitFor(() => expect(card('llm')).not.toBeNull());
    expect(await optionNames()).toEqual(['OpenAI-compatible', 'Anthropic', 'OpenAI', 'Google']);
  });

  it('an allowlisted user is offered it after the four providers', async () => {
    state = { ...state, claude_cli_allowed: true };
    renderSection();
    await waitFor(() => expect(card('llm')).not.toBeNull());
    expect(await optionNames()).toEqual([
      'OpenAI-compatible',
      'Anthropic',
      'OpenAI',
      'Google',
      CLI_LABEL,
    ]);
  });

  it('selecting it hides Base URL, Model and API key, shows the help line, and saves {provider} alone', async () => {
    state = { ...state, claude_cli_allowed: true };
    renderSection();
    await waitFor(() => expect(card('llm')).not.toBeNull());
    const llm = card('llm');
    await choose(within(llm).getByLabelText('Provider'), CLI_LABEL);
    expect(within(llm).queryByLabelText('Base URL')).toBeNull();
    expect(within(llm).queryByLabelText('Model')).toBeNull();
    expect(within(llm).queryByLabelText('API key')).toBeNull();
    expect(within(llm).queryByText('API key')).toBeNull();
    expect(within(llm).getByText(CLI_HELP)).not.toBeNull();
    // Save is enabled with no typed field.
    expect((saveIn('llm') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(saveIn('llm'));
    await waitFor(() => expect(calls('PUT', 'me/providers/llm')).toHaveLength(1));
    expect(JSON.parse(String(calls('PUT')[0]?.[1]?.body))).toEqual({ provider: 'claude-cli' });
    await waitFor(() => expect(within(card('llm')).getByText('Connected')).not.toBeNull());
    expect(
      (within(card('llm')).getByRole('button', { name: /Test connection/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it('the saved state shows Connected with no key row, and offers Test connection and Remove', async () => {
    state = { ...state, llm: SAVED_CLI, claude_cli_allowed: true };
    renderSection();
    await waitFor(() => expect(within(card('llm')).getByText('Connected')).not.toBeNull());
    const llm = card('llm');
    expect(within(llm).queryByText('API key')).toBeNull();
    expect(within(llm).queryByText(/Key set, ending in/)).toBeNull();
    expect(llm.textContent).not.toContain('null');
    expect(within(llm).getByText(CLI_HELP)).not.toBeNull();
    expect(within(llm).getByRole('button', { name: /Test connection/ })).not.toBeNull();
    fireEvent.click(within(llm).getByRole('button', { name: 'Remove' }));
    const confirm = await screen.findByRole('alertdialog');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(calls('DELETE', 'me/providers/llm')).toHaveLength(1));
    await within(card('llm')).findByText('Not set up');
  });

  it('a saved claude-cli user later removed from the list still sees it as the current choice', async () => {
    state = { ...state, llm: SAVED_CLI, claude_cli_allowed: false };
    renderSection();
    await waitFor(() => expect(within(card('llm')).getByText('Connected')).not.toBeNull());
    expect(within(card('llm')).getByLabelText('Provider').textContent).toContain(CLI_LABEL);
    expect(await optionNames()).toContain(CLI_LABEL);
  });

  it('switching from a saved Claude CLI to another provider needs a model and a key', async () => {
    state = { ...state, llm: SAVED_CLI, claude_cli_allowed: true };
    renderSection();
    await waitFor(() => expect(within(card('llm')).getByText('Connected')).not.toBeNull());
    const llm = card('llm');
    await choose(within(llm).getByLabelText('Provider'), 'Anthropic');
    const model = within(llm).getByLabelText('Model') as HTMLInputElement;
    expect(model.value).toBe('');
    await within(llm).findByText('A new provider or host needs its key entered again.');
    typeInto(model, 'claude-sonnet-4-5');
    expect((saveIn('llm') as HTMLButtonElement).disabled).toBe(true);
    typeInto(within(llm).getByLabelText('API key'), 'sk-ant-test-1234');
    expect((saveIn('llm') as HTMLButtonElement).disabled).toBe(false);
  });
});
