import { CircleCheckIcon, KeyRoundIcon, PlugZapIcon, TriangleAlertIcon } from 'lucide-react';
import { useState } from 'react';
import {
  useDeleteProvider,
  useProviders,
  useSaveProvider,
  useTestProvider,
} from '../../../../api/hooks/useProviders';
import type {
  ProviderCredential,
  ProviderKind,
  ProviderSaveBody,
  ProviderTestResponse,
} from '../../../../api/types';
import { Alert, AlertDescription } from '../../../../shared/components/ui/alert';
import { Badge } from '../../../../shared/components/ui/badge';
import { Button } from '../../../../shared/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from '../../../../shared/components/ui/card';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
} from '../../../../shared/components/ui/empty';
import { FieldGroup, FieldSeparator } from '../../../../shared/components/ui/field';
import { Input } from '../../../../shared/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../../shared/components/ui/select';
import { Spinner } from '../../../../shared/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../../shared/components/ui/tabs';
import { useConfirm } from '../../../../shared/ui/ConfirmDialog';
import { SectionSaveBar, SettingRow, SettingsSectionHeader } from './settingsParts';
import { useInlineDraft } from './settingsScopes';

// --- Settings › Advanced (byo-ai-providers task 6.1, design D6; web-ui-system "Settings manages
// the user's AI providers") ---
//
// The signed-in user's own provider credentials: a language model (OpenAI-compatible with a base
// URL, or Anthropic, OpenAI or Google) and speech to text (DeepGram), each in its own tab with its
// own save bar. Both tabs stay mounted, and one section-level draft holds both slices, so an unsaved
// edit survives a tab switch and the view's discard guard sees either. A key is write-only: a typed
// key lives only in the draft and the save request, the list never returns it, and after a save the
// row shows its last four characters. A stored key is bound to its provider and host, so changing
// either asks for the key again.

type Kind = ProviderKind;

interface ProviderDraft {
  provider: string;
  baseUrl: string;
  model: string;
  /** A newly typed key; never the saved one, which the server does not return. */
  newKey: string;
}
type Drafts = Record<Kind, ProviderDraft>;

const LLM_PROVIDERS = [
  { value: 'openai-compatible', label: 'OpenAI-compatible', model: 'gpt-4o-mini', key: 'sk-…' },
  { value: 'anthropic', label: 'Anthropic', model: 'claude-sonnet-4-5', key: 'sk-ant-…' },
  { value: 'openai', label: 'OpenAI', model: 'gpt-5.5', key: 'sk-…' },
  { value: 'google', label: 'Google', model: 'gemini-flash-latest', key: 'AIza…' },
] as const;

/** The keyless operator choice (ai-sdk-agent-harness D2, D8): offered only to allowlisted accounts,
 * or shown as the current choice when it is the saved one. The server stores its model as the
 * provider id itself. */
const CLAUDE_CLI = 'claude-cli';
const CLAUDE_CLI_LABEL = 'Claude CLI (operator)';
const CLAUDE_CLI_HELP =
  "Runs on this server's Claude CLI login. Available only to operator accounts.";

const APPROVAL_NOTE = 'Transcription and AI features are limited to approved users on this server.';

function fromSaved(kind: Kind, c: ProviderCredential | null): ProviderDraft {
  return {
    provider: c?.provider ?? (kind === 'llm' ? 'openai-compatible' : 'deepgram'),
    baseUrl: c?.base_url ?? '',
    model: c?.model ?? (kind === 'stt' ? 'nova-3' : ''),
    newKey: '',
  };
}

function originOf(url: string): string | null {
  try {
    return new URL(url.trim()).origin;
  } catch {
    return null;
  }
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function AdvancedSection() {
  const list = useProviders();
  const { confirm, confirmElement } = useConfirm();
  const data = list.data ?? null;
  const draft = useInlineDraft<Drafts>(
    'advanced',
    data ? 'advanced' : null,
    data ? { llm: fromSaved('llm', data.llm), stt: fromSaved('stt', data.stt) } : null,
  );

  return (
    <>
      <SettingsSectionHeader
        title="Advanced"
        description="Use your own AI and transcription accounts. Keys are stored encrypted, used only for your requests, and never shown again after you save them."
      />
      {list.isError ? (
        <Alert variant="destructive">
          <TriangleAlertIcon aria-hidden="true" />
          <AlertDescription>
            {errorText(list.error, 'Could not load your providers.')}
          </AlertDescription>
        </Alert>
      ) : data === null || draft.value === null || draft.baseline === null ? (
        <Empty aria-busy="true">
          <EmptyHeader>
            <EmptyMedia>
              <Spinner aria-hidden="true" />
            </EmptyMedia>
            <EmptyDescription>Loading your providers…</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          {!data.run_features_allowed && (
            <Alert role="status" data-slot="settings-approval-note">
              <AlertDescription>{APPROVAL_NOTE}</AlertDescription>
            </Alert>
          )}
          <Tabs defaultValue="llm" className="gap-4">
            <TabsList variant="line" aria-label="Providers">
              <TabsTrigger value="llm">Language model</TabsTrigger>
              <TabsTrigger value="stt">Speech to text</TabsTrigger>
            </TabsList>
            {(['llm', 'stt'] as const).map((kind) => {
              const value = draft.value?.[kind];
              const baseline = draft.baseline?.[kind];
              if (!value || !baseline) return null;
              return (
                // Both panels stay mounted (forceMount) so an unsaved draft survives a tab switch.
                <TabsContent
                  key={kind}
                  value={kind}
                  forceMount
                  className="data-[state=inactive]:hidden"
                >
                  <ProviderPanel
                    kind={kind}
                    saved={data[kind]}
                    offerClaudeCli={
                      kind === 'llm' &&
                      (data.claude_cli_allowed || data.llm?.provider === CLAUDE_CLI)
                    }
                    value={value}
                    baseline={baseline}
                    onChange={(patch) =>
                      draft.update({ [kind]: { ...value, ...patch } } as Partial<Drafts>)
                    }
                    onSaved={(next) => {
                      draft.update({ [kind]: next } as Partial<Drafts>);
                      draft.markSaved({ [kind]: next } as Partial<Drafts>);
                    }}
                    confirm={confirm}
                  />
                </TabsContent>
              );
            })}
          </Tabs>
        </>
      )}
      {confirmElement}
    </>
  );
}

const COPY: Record<Kind, { title: string; description: string }> = {
  llm: {
    title: 'Language model',
    description:
      'Your own model provider. It powers AI chat, topic generation and event generation.',
  },
  stt: {
    title: 'Speech to text',
    description: 'Transcribes recordings and labels who is speaking.',
  },
};

function ProviderPanel({
  kind,
  saved,
  offerClaudeCli,
  value,
  baseline,
  onChange,
  onSaved,
  confirm,
}: {
  kind: Kind;
  saved: ProviderCredential | null;
  offerClaudeCli: boolean;
  value: ProviderDraft;
  baseline: ProviderDraft;
  onChange: (patch: Partial<ProviderDraft>) => void;
  onSaved: (next: ProviderDraft) => void;
  confirm: ReturnType<typeof useConfirm>['confirm'];
}) {
  const id = (field: string) => `settings-advanced-${kind}-${field}`;
  const save = useSaveProvider(kind);
  const remove = useDeleteProvider(kind);
  const test = useTestProvider(kind);
  const [replacing, setReplacing] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProviderTestResponse | null>(null);

  const configured = saved !== null;
  const cli = kind === 'llm' && value.provider === CLAUDE_CLI;
  const needsBaseUrl = kind === 'llm' && value.provider === 'openai-compatible';
  const llm = LLM_PROVIDERS.find((p) => p.value === value.provider);
  // A stored key is bound to its provider and host: a new one needs the key entered again.
  const destinationChanged =
    saved !== null &&
    kind === 'llm' &&
    (value.provider !== saved.provider ||
      (needsBaseUrl && originOf(value.baseUrl) !== originOf(saved.base_url ?? '')));
  const keyInput = !cli && (!configured || replacing || destinationChanged);
  const dirty = JSON.stringify(value) !== JSON.stringify(baseline);
  // The Claude CLI takes no typed field: it runs on the server's own login.
  const valid =
    cli ||
    (value.model.trim() !== '' &&
      (!needsBaseUrl || value.baseUrl.trim() !== '') &&
      (!keyInput || value.newKey.trim() !== ''));

  function change(patch: Partial<ProviderDraft>) {
    setResult(null);
    setSaveError(null);
    onChange(patch);
  }

  async function handleSave() {
    setSaveError(null);
    const body: ProviderSaveBody = cli
      ? { provider: CLAUDE_CLI }
      : {
          provider: value.provider as Exclude<ProviderSaveBody['provider'], typeof CLAUDE_CLI>,
          model: value.model.trim(),
          ...(needsBaseUrl ? { base_url: value.baseUrl.trim() } : {}),
          ...(value.newKey.trim() ? { api_key: value.newKey.trim() } : {}),
        };
    try {
      const credential = await save.mutateAsync(body);
      save.reset();
      setReplacing(false);
      onSaved(fromSaved(kind, credential));
    } catch (err) {
      save.reset();
      setSaveError(errorText(err, 'Could not save the provider.'));
    }
  }

  async function handleRemove() {
    const ok = await confirm({
      title: cli ? 'Remove Claude CLI' : 'Remove key',
      message: cli
        ? 'Stop using the Claude CLI as your language model? AI chat, topics and events stop working until you choose a model again.'
        : `Remove your ${COPY[kind].title.toLowerCase()} key? Features that use it stop working until you add one again.`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    setError(null);
    try {
      await remove.mutateAsync();
      setReplacing(false);
      setResult(null);
      onSaved(fromSaved(kind, null));
    } catch (err) {
      setError(errorText(err, 'Could not remove the key.'));
    }
  }

  async function handleTest() {
    setResult(null);
    setError(null);
    try {
      setResult(await test.mutateAsync());
      test.reset();
    } catch (err) {
      test.reset();
      setError(errorText(err, 'Could not run the test.'));
    }
  }

  const removeButton = (
    <Button
      variant="ghost"
      size="sm"
      disabled={remove.isPending}
      onClick={() => void handleRemove()}
    >
      {remove.isPending && <Spinner data-icon="inline-start" aria-hidden="true" />}
      Remove
    </Button>
  );

  return (
    <Card data-slot="settings-provider" data-kind={kind} aria-label={COPY[kind].title}>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardDescription>{COPY[kind].description}</CardDescription>
          {configured ? (
            <Badge variant="secondary">
              <CircleCheckIcon aria-hidden="true" />
              Connected
            </Badge>
          ) : (
            <Badge variant="outline">Not set up</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <FieldGroup className="gap-4">
          <SettingRow
            label="Provider"
            htmlFor={id('provider')}
            description={
              cli
                ? CLAUDE_CLI_HELP
                : kind === 'llm'
                  ? 'Where AI chat, topics and events run, on your own account.'
                  : 'DeepGram for now. More providers are coming.'
            }
          >
            <Select
              value={value.provider}
              onValueChange={(v) =>
                // The saved CLI row's model is its provider id: don't carry it to a real provider.
                change(
                  value.model === CLAUDE_CLI && v !== CLAUDE_CLI
                    ? { provider: v, model: '' }
                    : { provider: v },
                )
              }
            >
              <SelectTrigger id={id('provider')} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {kind === 'llm' ? (
                  <>
                    {LLM_PROVIDERS.map((p) => (
                      <SelectItem key={p.value} value={p.value}>
                        {p.label}
                      </SelectItem>
                    ))}
                    {offerClaudeCli && (
                      <SelectItem value={CLAUDE_CLI}>{CLAUDE_CLI_LABEL}</SelectItem>
                    )}
                  </>
                ) : (
                  <SelectItem value="deepgram">DeepGram</SelectItem>
                )}
              </SelectContent>
            </Select>
          </SettingRow>
          {needsBaseUrl && (
            <SettingRow
              label="Base URL"
              htmlFor={id('base-url')}
              description="The API root, for example https://api.openai.com/v1 or your own gateway."
            >
              <Input
                id={id('base-url')}
                type="url"
                inputMode="url"
                spellCheck={false}
                placeholder="https://api.openai.com/v1"
                value={value.baseUrl}
                onChange={(e) => change({ baseUrl: e.target.value })}
              />
            </SettingRow>
          )}
          {!cli && (
            <>
              <SettingRow
                label="Model"
                htmlFor={id('model')}
                description={
                  kind === 'llm'
                    ? `The model id, for example ${llm?.model ?? 'gpt-4o-mini'}.`
                    : 'nova-3 supports speaker labels.'
                }
              >
                <Input
                  id={id('model')}
                  spellCheck={false}
                  placeholder={kind === 'llm' ? (llm?.model ?? 'gpt-4o-mini') : 'nova-3'}
                  value={value.model}
                  onChange={(e) => change({ model: e.target.value })}
                />
              </SettingRow>
              <FieldSeparator />
              <SettingRow
                label="API key"
                htmlFor={keyInput ? id('key') : undefined}
                description={
                  destinationChanged
                    ? 'A new provider or host needs its key entered again.'
                    : keyInput
                      ? 'Paste the key. It is encrypted when you save.'
                      : `Key set, ending in ••${saved?.key_last4}.`
                }
              >
                {keyInput ? (
                  <Input
                    id={id('key')}
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={kind === 'llm' ? (llm?.key ?? 'sk-…') : 'DeepGram API key'}
                    value={value.newKey}
                    onChange={(e) => change({ newKey: e.target.value })}
                  />
                ) : (
                  <>
                    <Button variant="outline" size="sm" onClick={() => setReplacing(true)}>
                      <KeyRoundIcon data-icon="inline-start" aria-hidden="true" />
                      Replace
                    </Button>
                    {removeButton}
                  </>
                )}
              </SettingRow>
            </>
          )}
          <SettingRow
            label="Connection"
            description={
              dirty
                ? 'Save your changes first: the test checks the saved key and model.'
                : cli
                  ? "Checks that this account can use the server's Claude CLI."
                  : kind === 'stt'
                    ? 'Checks the saved key and model with a quarter second of silence.'
                    : 'Checks the saved key and model without using any credit.'
            }
          >
            <Button
              variant="outline"
              size="sm"
              disabled={!configured || dirty || test.isPending}
              onClick={() => void handleTest()}
            >
              {test.isPending ? (
                <Spinner data-icon="inline-start" aria-hidden="true" />
              ) : (
                <PlugZapIcon data-icon="inline-start" aria-hidden="true" />
              )}
              {test.isPending ? 'Testing…' : 'Test connection'}
            </Button>
            {/* The keyless CLI row has no key row, so its Remove sits here (D8). */}
            {cli && saved?.provider === CLAUDE_CLI && removeButton}
          </SettingRow>
          {result && (
            <Alert role="status" variant={result.ok ? 'default' : 'destructive'}>
              {result.ok ? (
                <CircleCheckIcon aria-hidden="true" />
              ) : (
                <TriangleAlertIcon aria-hidden="true" />
              )}
              <AlertDescription>{result.detail}</AlertDescription>
            </Alert>
          )}
          {error && (
            <Alert variant="destructive">
              <TriangleAlertIcon aria-hidden="true" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </FieldGroup>
      </CardContent>
      <SectionSaveBar
        dirty={dirty}
        saving={save.isPending}
        valid={valid}
        error={saveError}
        onSave={() => void handleSave()}
      />
    </Card>
  );
}
