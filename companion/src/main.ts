import {
  InstanceBase,
  InstanceStatus,
  runEntrypoint,
  type SomeCompanionConfigField,
} from '@companion-module/base';
import { actionDefinitions } from './actions.js';
import { ApiError, AutologgerApi, type CategoriesResponse } from './api.js';
import { clampPollMs, getConfigFields, type ModuleConfig } from './config.js';
import { feedbackDefinitions } from './feedbacks.js';
import { Poller } from './poller.js';
import { presetDefinitions } from './presets.js';
import {
  showIdChanged,
  toFeedbackFlags,
  toVariableValues,
  type ServerStatePayload,
} from './state.js';
import { UpgradeScripts } from './upgrades.js';
import { variableDefinitions } from './variables.js';

class AutologgerInstance extends InstanceBase<ModuleConfig> {
  private config!: ModuleConfig;
  private controller: AbortController | null = null;
  private poller: Poller<ServerStatePayload> | null = null;
  private lastState: ServerStatePayload | null = null;
  private categories: CategoriesResponse | null = null;
  private destroyed = false;

  async init(config: ModuleConfig): Promise<void> {
    this.destroyed = false;
    this.config = config;
    this.setVariableDefinitions(variableDefinitions());
    this.setFeedbackDefinitions(feedbackDefinitions(() => toFeedbackFlags(this.lastState ?? EMPTY)));
    this.setPresetDefinitions(presetDefinitions());
    this.rebuildActions();
    this.updateStatus(InstanceStatus.Connecting);
    this.startPolling();
  }

  async configUpdated(config: ModuleConfig): Promise<void> {
    this.config = config;
    this.teardown();
    this.updateStatus(InstanceStatus.Connecting);
    this.startPolling();
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.teardown();
  }

  getConfigFields(): SomeCompanionConfigField[] {
    return getConfigFields();
  }

  private newApi(): AutologgerApi {
    if (!this.controller) this.controller = new AbortController();
    return new AutologgerApi({
      url: this.config.url,
      token: this.config.token,
      signal: this.controller.signal,
    });
  }

  private teardown(): void {
    this.poller?.stop();
    this.poller = null;
    this.controller?.abort();
    this.controller = null;
  }

  private startPolling(): void {
    this.controller = new AbortController();
    this.poller = new Poller<ServerStatePayload>({
      intervalMs: clampPollMs(this.config.pollMs),
      fetchState: (signal) =>
        new AutologgerApi({ url: this.config.url, token: this.config.token, signal }).getState(),
      onState: (s) => this.applyState(s),
      onError: (err) => this.applyError(err),
    });
    this.poller.start();
    void this.refreshCategories();
  }

  private applyState(s: ServerStatePayload): void {
    if (this.destroyed) return;
    const showChanged = showIdChanged(this.lastState, s);
    this.lastState = s;
    this.setVariableValues(toVariableValues(s));
    this.checkFeedbacks('rolling', 'recording', 'playing', 'session_active');
    this.updateStatus(InstanceStatus.Ok);
    if (showChanged) void this.refreshCategories();
  }

  private applyError(err: unknown): void {
    if (this.destroyed) return;
    if (err instanceof ApiError && err.kind === 'auth') {
      this.updateStatus(InstanceStatus.BadConfig, 'Check API token / login');
    } else {
      this.updateStatus(InstanceStatus.ConnectionFailure, 'Cannot reach AutoLogger server');
    }
  }

  private async refreshCategories(): Promise<void> {
    try {
      const cats = await this.newApi().getCategories();
      if (this.destroyed) return;
      this.categories = cats;
      this.rebuildActions();
    } catch {
      // 409 (no session) etc. — leave the last-known dropdown in place.
    }
  }

  private rebuildActions(): void {
    this.setActionDefinitions(
      actionDefinitions(
        {
          api: () => this.newApi(),
          refreshNow: () => this.poller?.refreshNow(),
          log: (level, msg) => this.log(level, msg),
          parseVariablesInString: (t) => this.parseVariablesInString(t),
        },
        this.categories,
      ),
    );
  }
}

const EMPTY: ServerStatePayload = {
  connected_clients: 0,
  active_session_id: null,
  session: null,
  last_command: null,
};

runEntrypoint(AutologgerInstance, UpgradeScripts);
