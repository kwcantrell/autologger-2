import { InstanceBase, runEntrypoint, type SomeCompanionConfigField } from '@companion-module/base';
import { UpgradeScripts } from './upgrades.js';

interface ModuleConfig {
  url: string;
  token: string;
  pollMs: number;
}

class AutologgerInstance extends InstanceBase<ModuleConfig> {
  async init(_config: ModuleConfig): Promise<void> {}
  async destroy(): Promise<void> {}
  async configUpdated(_config: ModuleConfig): Promise<void> {}
  getConfigFields(): SomeCompanionConfigField[] {
    return [];
  }
}

runEntrypoint(AutologgerInstance, UpgradeScripts);
