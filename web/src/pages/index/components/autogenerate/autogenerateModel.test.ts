import { describe, expect, it } from 'vitest';
import type {
  AutogenerateStep,
  ProviderCredential,
  ProvidersResponse,
} from '../../../../api/types';
import {
  AUTOGENERATE_STEPS,
  BLOCKED_TEXT,
  blockedFromProviders,
  defaultAutogenerateSteps,
  maxRuns,
  orderedSteps,
  stepLabel,
  WIKI_MODE_LABEL,
} from './autogenerateModel';

// playlist-import-autogenerate task 1.1 (design D6, D8): the step/wiki model shared by Settings →
// Batch autogenerate and the Batch Import modal, and the provider-derived up-front warning.

const cred = (kind: 'llm' | 'stt', provider: string): ProviderCredential => ({
  kind,
  provider,
  base_url: null,
  model: 'm',
  key_last4: provider === 'claude-cli' ? null : 'abcd',
  updated_at: '2026-11-11T00:00:00.000Z',
});

const configured = (over: Partial<ProvidersResponse> = {}): ProvidersResponse => ({
  llm: cred('llm', 'anthropic'),
  stt: cred('stt', 'deepgram'),
  run_features_allowed: true,
  claude_cli_allowed: false,
  ...over,
});

const ALL: AutogenerateStep[] = ['transcript', 'events', 'topics', 'wiki'];

describe('autogenerateModel', () => {
  it('lists the four steps in run order with Settings labels', () => {
    expect(AUTOGENERATE_STEPS).toEqual([
      { id: 'transcript', label: 'Transcripts' },
      { id: 'events', label: 'Log events' },
      { id: 'topics', label: 'Topics' },
      { id: 'wiki', label: 'Wiki' },
    ]);
    expect(stepLabel('topics')).toBe('Topics');
    expect(stepLabel('unknown')).toBe('unknown');
  });

  it('defaults to all four steps', () => {
    expect([...defaultAutogenerateSteps()]).toEqual(ALL);
  });

  it('orders a step set in run order', () => {
    expect(orderedSteps(new Set<AutogenerateStep>(['wiki', 'transcript', 'topics']))).toEqual([
      'transcript',
      'topics',
      'wiki',
    ]);
  });

  it('holds the wiki mode labels and the three blocked texts verbatim', () => {
    expect(WIKI_MODE_LABEL).toEqual({
      accept: 'Add new pages and additions to the wiki',
      pending: 'Leave all as suggestions to review',
    });
    expect(BLOCKED_TEXT).toEqual({
      'unconfigured-stt':
        'Add a speech-to-text key in Settings → Advanced to generate transcripts.',
      'unconfigured-llm': 'Add a language model in Settings → Advanced to autogenerate.',
      'not-approved':
        'Batch autogenerate is limited to approved users on this server. Ask the operator for approval.',
    });
  });

  it('maxRuns is sessions × steps', () => {
    expect(maxRuns(12, ['transcript', 'topics'])).toBe(24);
    expect(maxRuns(3, new Set(ALL))).toBe(12);
    expect(maxRuns(0, ALL)).toBe(0);
  });
});

describe('blockedFromProviders (mirrors the start route: stt, then llm, then approval)', () => {
  it('unconfigured-stt for Transcripts with no stt credential', () => {
    expect(blockedFromProviders(['transcript'], configured({ stt: null }))).toBe(
      'unconfigured-stt',
    );
  });

  it('unconfigured-llm for an LLM step with no llm credential', () => {
    for (const step of ['events', 'topics', 'wiki'] as const) {
      expect(blockedFromProviders([step], configured({ llm: null }))).toBe('unconfigured-llm');
    }
  });

  it('a claude-cli llm counts only while claude_cli_allowed', () => {
    const cli = cred('llm', 'claude-cli');
    expect(blockedFromProviders(['topics'], configured({ llm: cli }))).toBe('unconfigured-llm');
    expect(
      blockedFromProviders(['topics'], configured({ llm: cli, claude_cli_allowed: true })),
    ).toBeNull();
  });

  it('not-approved when run features are not allowed', () => {
    expect(blockedFromProviders(ALL, configured({ run_features_allowed: false }))).toBe(
      'not-approved',
    );
  });

  it('the first reason in order when several apply', () => {
    const none = configured({ stt: null, llm: null, run_features_allowed: false });
    expect(blockedFromProviders(ALL, none)).toBe('unconfigured-stt');
    expect(blockedFromProviders(['events', 'wiki'], none)).toBe('unconfigured-llm');
  });

  it('null for a configured user, and when only steps that need nothing missing are ticked', () => {
    expect(blockedFromProviders(ALL, configured())).toBeNull();
    expect(blockedFromProviders(['transcript'], configured({ llm: null }))).toBeNull();
    expect(blockedFromProviders(['topics'], configured({ stt: null }))).toBeNull();
  });
});
