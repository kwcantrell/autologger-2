// The provider connection test (byo-ai-providers design D5; provider-credentials "The connection
// test reports without leaking"). One request per test, which costs no model usage except
// DeepGram's quarter second of silence. Every outcome is one of the fixed PROVIDER_TEST_DETAIL
// strings: an upstream body is read only to find a model id or Google's key-error reason, and is
// never returned or logged.
//
// The fixed-host providers' hosts come from the constructor. `createBindings` always builds the
// tester with the frozen PROVIDER_HOSTS constants and reads no environment or config for it
// (provider-credentials "Fixed hosts can't be overridden in production"); only tests pass other
// hosts. Fixed hosts are constants, so the private-address policy applies to `openai-compatible`
// base URLs only.

import { PROVIDER_TEST_DETAIL } from '@autologger/contract';
import type { ProviderKind } from '@autologger/ports';
import {
  type LookupFn,
  OutboundFailure,
  PROVIDER_HOSTS,
  type ProviderHosts,
  providerRequest,
} from './providerOutbound';

// The frozen host table lives beside the guarded model fetch, which also uses it (ai-sdk-agent-harness D4).
export { PROVIDER_HOSTS, type ProviderHosts } from './providerOutbound';

const TEST_TIMEOUT_MS = 10_000;

export interface ProviderTestInput {
  kind: ProviderKind;
  provider: string;
  /** The stored base URL (`openai-compatible` only), or null. */
  baseUrl: string | null;
  model: string;
  /** The decrypted key. Sent only in the provider's auth header. */
  key: string;
  /** Production mode (provider-credentials "Development mode is explicit"). */
  production: boolean;
}

export interface ProviderTestResult {
  ok: boolean;
  detail: string;
}

/** 0.25 s of 16 kHz mono 16-bit PCM silence as a WAV file (44-byte header, 8000 data bytes). */
function silentWav(): Uint8Array {
  const rate = 16_000;
  const data = (rate / 4) * 2;
  const b = Buffer.alloc(44 + data);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + data, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(data, 40);
  return new Uint8Array(b);
}
const SILENT_WAV = silentWav();

const ok = (): ProviderTestResult => ({ ok: true, detail: PROVIDER_TEST_DETAIL.connected });
const fail = (detail: string): ProviderTestResult => ({ ok: false, detail });

function parse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/** Google's invalid-key answer: 400 with an ErrorInfo detail whose reason is API_KEY_INVALID. */
function googleKeyInvalid(body: string): boolean {
  const details = (parse(body) as { error?: { details?: unknown } } | null)?.error?.details;
  return (
    Array.isArray(details) &&
    details.some((d) => (d as { reason?: unknown } | null)?.reason === 'API_KEY_INVALID')
  );
}

export class ProviderTester {
  readonly hosts: ProviderHosts;

  constructor(
    hosts: ProviderHosts = PROVIDER_HOSTS,
    private readonly opts: { timeoutMs?: number; lookup?: LookupFn } = {},
  ) {
    this.hosts = Object.freeze({ ...hosts });
  }

  async test(input: ProviderTestInput): Promise<ProviderTestResult> {
    const model = encodeURIComponent(input.model);
    let url: string;
    let method: 'GET' | 'POST' = 'GET';
    let headers: Record<string, string>;
    let body: Uint8Array | undefined;
    let production = false;
    switch (input.provider) {
      case 'openai-compatible':
        if (input.baseUrl === null) return fail(PROVIDER_TEST_DETAIL.unreachable);
        url = `${input.baseUrl.replace(/\/+$/, '')}/models`;
        headers = { authorization: `Bearer ${input.key}` };
        production = input.production;
        break;
      case 'openai':
        url = `${this.hosts.openai}/v1/models/${model}`;
        headers = { authorization: `Bearer ${input.key}` };
        break;
      case 'anthropic':
        url = `${this.hosts.anthropic}/v1/models/${model}`;
        headers = { 'x-api-key': input.key, 'anthropic-version': '2023-06-01' };
        break;
      case 'google':
        url = `${this.hosts.google}/v1beta/models/${model}`;
        headers = { 'x-goog-api-key': input.key };
        break;
      case 'deepgram':
        url = `${this.hosts.deepgram}/v1/listen?model=${model}`;
        method = 'POST';
        headers = { authorization: `Token ${input.key}`, 'content-type': 'audio/wav' };
        body = SILENT_WAV;
        break;
      default:
        return fail(PROVIDER_TEST_DETAIL.unexpected(0));
    }

    let res: { status: number; body: string };
    try {
      res = await providerRequest({
        url,
        method,
        headers,
        body,
        production,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? TEST_TIMEOUT_MS),
        lookup: this.opts.lookup,
      });
    } catch (e) {
      const kind = e instanceof OutboundFailure ? e.kind : 'unreachable';
      return fail(
        kind === 'timeout' ? PROVIDER_TEST_DETAIL.timeout : PROVIDER_TEST_DETAIL.unreachable,
      );
    }

    const { status } = res;
    if (status === 401 || status === 403) return fail(PROVIDER_TEST_DETAIL.rejected);
    if (input.provider === 'google' && status === 400 && googleKeyInvalid(res.body)) {
      return fail(PROVIDER_TEST_DETAIL.rejected);
    }
    const success = status >= 200 && status < 300;
    if (input.provider === 'openai-compatible') {
      if (!success) return fail(PROVIDER_TEST_DETAIL.unexpected(status));
      const data = (parse(res.body) as { data?: unknown } | null)?.data;
      if (!Array.isArray(data) || data.length === 0) return ok();
      const listed = data.some((m) => (m as { id?: unknown } | null)?.id === input.model);
      return listed ? ok() : fail(PROVIDER_TEST_DETAIL.modelNotFound);
    }
    if (success) return ok();
    if (status === 404 && input.kind === 'llm') return fail(PROVIDER_TEST_DETAIL.modelNotFound);
    return fail(PROVIDER_TEST_DETAIL.unexpected(status));
  }
}
